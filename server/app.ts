import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import type { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { checkPassword, hashPassword } from "./db.js";
import { Store, type Row } from "./store.js";
import {
  ApiError,
  ensure,
  today,
  now,
  validDate,
  validMonth,
  integer,
  text,
  me,
  staff,
  admin,
  supabase,
} from "./http.js";
import { feeDefaults, registerOperations } from "./operations.js";
import { saveBackup } from "./backup.js";
import { registerCommunities } from "./communities.js";
import { Gateway } from "./gateway.js";

export function createApp(
  source: Store | DatabaseSync,
  options: { gatewayFetch?: typeof fetch } = {},
) {
  const db = source instanceof Store ? source : new Store(source);
  const app = express();
  app.disable("x-powered-by");
  const audit = async (
    actor: { name: string },
    action: string,
    detail: string,
  ) =>
    db.run(
      "INSERT INTO audit (actor,action,detail,created_at) VALUES (?,?,?,?)",
      actor.name,
      action,
      detail,
      now(),
    );
  const settings = async (): Promise<Record<string, string>> => ({
    ...feeDefaults,
    ...Object.fromEntries(
      (await db.all("SELECT * FROM settings")).map((r) => [r.key, r.value]),
    ),
  });
  const demands = async (sid?: number) =>
    db.all(
      `SELECT d.*,s.name,s.code,s.department,
    COALESCE(a.collected,0) AS collected,d.amount+d.adjustment-COALESCE(a.collected,0) AS balance
    FROM demands d JOIN students s ON s.id=d.student_id
    LEFT JOIN (SELECT a.demand_id,SUM(a.amount${db.communities ? "-a.refunded_amount" : ""}) AS collected FROM allocations a JOIN payments p ON p.id=a.payment_id WHERE p.reversed_at IS NULL GROUP BY a.demand_id) a ON a.demand_id=d.id
    ${sid !== undefined ? "WHERE d.student_id=?" : ""} ORDER BY d.period DESC,s.name,d.id`,
      ...(sid !== undefined ? [sid] : []),
    );
  const payments = async (sid?: number) =>
    db.all(
      `SELECT p.id,p.student_id,p.amount,${db.communities ? "(SELECT COALESCE(SUM(a.refunded_amount),0) FROM allocations a WHERE a.payment_id=p.id)" : "0"} AS refunded_amount,p.date,p.mode,p.reference,p.category,p.receipt,p.reversed_at,p.reversal_reason,s.name,s.code,CASE WHEN p.idempotency_key LIKE 'gateway-%' THEN 'Razorpay online payment' ELSE u.name END AS received_name
    FROM payments p JOIN students s ON s.id=p.student_id JOIN users u ON u.id=p.received_by
    ${sid !== undefined ? "WHERE p.student_id=?" : ""} ORDER BY p.date DESC,p.id DESC`,
      ...(sid !== undefined ? [sid] : []),
    );
  const gateway = new Gateway(
    db,
    { demands, record: (body, actor) => recordPayment(body, actor) },
    options.gatewayFetch,
  );
  gateway.webhook(app);
  app.use(express.json({ limit: "3mb" }));
  const digest = (v: string) => createHash("sha256").update(v).digest("hex");
  const token = (req: Request) =>
    digest(
      req.headers.cookie
        ?.split(";")
        .map((p) => p.trim())
        .find((p) => p.startsWith("h360_session="))
        ?.slice(13) || "",
    );
  const cookie = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.COOKIE_SECURE === "true" || !!process.env.VERCEL,
    path: "/",
  };
  const session = async (res: Response, id: number) => {
    const value = randomBytes(32).toString("hex");
    await db.run("DELETE FROM sessions WHERE expires<?", Date.now());
    await db.run(
      "INSERT INTO sessions (token,user_id,expires) VALUES (?,?,?)",
      digest(value),
      id,
      Date.now() + 8 * 3600_000,
    );
    res.cookie("h360_session", value, { ...cookie, maxAge: 8 * 3600_000 });
  };
  app.use("/api", (req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (!["GET", "HEAD"].includes(req.method) && req.get("X-Hostel360") !== "1")
      return res
        .status(403)
        .json({ error: "Missing request verification header." });
    next();
  });
  app.get("/api/health", async (_req, res) => {
    await db.get("SELECT 1 AS ok");
    res.json({ ok: true });
  });
  app.get("/api/cron/backup", async (req, res) => {
    ensure(
      process.env.CRON_SECRET &&
        req.get("Authorization") === `Bearer ${process.env.CRON_SECRET}`,
      "Unauthorized.",
      401,
    );
    if (db.communities) {
      const results = [];
      for (const community of await db.all("SELECT id FROM communities"))
        results.push(await db.inCommunity(community.id, () => saveBackup(db)));
      return res.json(results);
    }
    res.json(await saveBackup(db));
  });
  if (db.communities) registerCommunities(app, db);
  app.get("/api/config", async (_req, res) => {
    const s = await settings();
    res.json({
      demo: s.demo === "true",
      hostel_name: s.hostel_name,
      setup: !(await db.get("SELECT id FROM users LIMIT 1")),
    });
  });
  app.post("/api/setup", async (req, res) => {
    const b = req.body;
    const expected = process.env.BOOTSTRAP_TOKEN;
    ensure(
      expected &&
        typeof b.token === "string" &&
        timingSafeEqual(
          Buffer.from(digest(expected)),
          Buffer.from(digest(b.token)),
        ),
      "Invalid setup key.",
      403,
    );
    ensure(
      text(b.name) &&
        text(b.email) &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email) &&
        text(b.password, 200) &&
        b.password.length >= 12,
      "Enter your name, email and a password of at least 12 characters.",
    );
    await db.transaction(async () => {
      ensure(
        !(await db.get("SELECT id FROM users LIMIT 1")),
        "Setup has already been completed.",
        409,
      );
      const { data, error } = await supabase().auth.admin.createUser({
        email: b.email.toLowerCase().trim(),
        password: b.password,
        email_confirm: true,
      });
      ensure(
        !error && data.user,
        "Could not create administrator. Check that this email is not already registered.",
      );
      try {
        await db.run(
          "INSERT INTO users (name,email,password,role,auth_id) VALUES (?,?,?,'Admin',?)",
          b.name.trim(),
          b.email.toLowerCase().trim(),
          "supabase",
          data.user.id,
        );
        await audit(
          { name: b.name },
          "Workspace activated",
          "Administrator account created with Supabase Auth.",
        );
      } catch (e) {
        await supabase().auth.admin.deleteUser(data.user.id);
        throw e;
      }
    });
    res.status(201).json({ ok: true });
  });
  app.post("/api/login", async (req, res) => {
    const b = req.body;
    ensure(
      text(b.email) && text(b.password, 200),
      "Enter your email and password.",
    );
    const email = b.email.toLowerCase().trim(),
      key = digest(email);
    const attempt = await db.transaction(async () => {
      await db.run("DELETE FROM login_attempts WHERE reset_at<?", Date.now());
      return db.get(
        "INSERT INTO login_attempts (key,count,reset_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=login_attempts.count+1 RETURNING count",
        key,
        Date.now() + 15 * 60_000,
      );
    });
    ensure(
      attempt.count <= 20,
      "Too many sign-in attempts. Try again in 15 minutes.",
      429,
    );
    const record = await db.get(
      "SELECT * FROM users WHERE email=? AND active=1",
      email,
    );
    let verified = false;
    if (record?.auth_id) {
      const { data, error } = await supabase().auth.signInWithPassword({
        email,
        password: b.password,
      });
      verified = !error && data.user?.id === record.auth_id;
    } else if (record && !process.env.VERCEL && !process.env.SUPABASE_URL)
      verified = checkPassword(b.password, record.password);
    ensure(verified && record, "Email or password is incorrect.", 401);
    await db.run("DELETE FROM login_attempts WHERE key=?", key);
    await session(res, record.id);
    res.json({ ok: true });
  });
  app.use("/api", async (req, res, next) => {
    if (db.communities) return next();
    const record = await db.get(
      "SELECT u.id,u.name,u.email,u.role,u.student_id,u.auth_id,u.must_change_password FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1",
      token(req),
      Date.now(),
    );
    ensure(record, "Please sign in to continue.", 401);
    res.locals.user = record;
    if (
      record.must_change_password &&
      !["/account/password", "/logout", "/workspace"].includes(req.path)
    )
      return res
        .status(403)
        .json({ error: "Change your temporary password before continuing." });
    next();
  });
  app.post("/api/logout", async (req, res) => {
    await db.run("DELETE FROM sessions WHERE token=?", token(req));
    res.clearCookie("h360_session", cookie).json({ ok: true });
  });
  app.post("/api/account/password", async (req, res) => {
    const b = req.body,
      user = await db.get("SELECT * FROM users WHERE id=?", me(res).id);
    ensure(
      text(b.current, 200) && text(b.password, 200) && b.password.length >= 12,
      "Use a new password of at least 12 characters.",
    );
    if (user.auth_id) {
      const check = await supabase().auth.signInWithPassword({
        email: user.email,
        password: b.current,
      });
      ensure(!check.error, "Current password is incorrect.", 403);
      const result = await supabase().auth.admin.updateUserById(user.auth_id, {
        password: b.password,
      });
      ensure(!result.error, "Password update failed. Try again.");
    } else {
      ensure(
        checkPassword(b.current, user.password),
        "Current password is incorrect.",
        403,
      );
      await db.run(
        "UPDATE users SET password=? WHERE id=?",
        hashPassword(b.password),
        user.id,
      );
    }
    await db.transaction(async () => {
      await db.run(
        "UPDATE users SET must_change_password=0 WHERE id=?",
        user.id,
      );
      await db.run("DELETE FROM sessions WHERE user_id=?", user.id);
      await audit(
        { name: user.name },
        "Password changed",
        "All previous sessions revoked.",
      );
    });
    await session(res, user.id);
    res.json({ ok: true });
  });
  app.get("/api/workspace", async (_req, res) => {
    const user = me(res),
      sid = user.role === "Student" ? (user.student_id ?? -1) : undefined;
    const [s, students, ds, ps, attendance, events] = await Promise.all([
      settings(),
      db.all(
        `SELECT * FROM students ${sid !== undefined ? "WHERE id=?" : ""} ORDER BY name`,
        ...(sid !== undefined ? [sid] : []),
      ),
      demands(sid),
      payments(sid),
      db.all(
        `SELECT student_id,status FROM attendance WHERE date=? ${sid !== undefined ? "AND student_id=?" : ""}`,
        today(),
        ...(sid !== undefined ? [sid] : []),
      ),
      sid !== undefined
        ? []
        : db.all("SELECT * FROM audit ORDER BY id DESC LIMIT 100"),
    ]);
    res.json({
      user,
      ...(db.communities ? { community: res.locals.community } : {}),
      settings: s,
      today: today(),
      students,
      demands: ds,
      payments: ps,
      attendance,
      audit: events,
      // Admins see join requests waiting for a decision on every screen.
      ...(db.communities && user.role === "Admin"
        ? {
            pending_members: (
              await db.get(
                "SELECT COUNT(*) AS count FROM users WHERE membership_status='Pending'",
              )
            ).count,
          }
        : {}),
    });
  });
  app.get("/api/attendance", async (req, res) => {
    staff(res);
    ensure(validDate(req.query.date), "Choose a valid date.");
    res.json(
      await db.all(
        "SELECT student_id,status FROM attendance WHERE date=?",
        req.query.date,
      ),
    );
  });
  const locked = async (period: string) =>
    !!(
      (await db.get(
        "SELECT period FROM billing_periods WHERE period=?",
        period,
      )) ||
      (await db.get(
        "SELECT id FROM demands WHERE category='Mess' AND period=? LIMIT 1",
        period,
      ))
    );
  app.post("/api/attendance", async (req, res) => {
    staff(res);
    const { date, entries } = req.body;
    ensure(
      validDate(date) && date <= today(),
      "Attendance date cannot be in the future.",
    );
    ensure(
      Array.isArray(entries) && entries.length > 0 && entries.length <= 5000,
      "Select attendance entries.",
    );
    await db.transaction(async () => {
      ensure(
        !(await locked(date.slice(0, 7))),
        "This month has finalized demands. Attendance is locked.",
        409,
      );
      const students = await db.all(
        "SELECT id FROM students WHERE joined<=? AND (exited IS NULL OR exited>=?)",
        date,
        date,
      );
      const eligible = new Set(students.map((s) => s.id));
      const ids = new Set<number>();
      const previous = new Map(
        (
          await db.all(
            "SELECT student_id,status FROM attendance WHERE date=?",
            date,
          )
        ).map((r) => [r.student_id, r.status]),
      );
      for (const entry of entries) {
        ensure(
          entry &&
            integer(entry.student_id) &&
            !ids.has(entry.student_id) &&
            ["Present", "Absent", "Leave"].includes(entry.status),
          "Invalid or duplicate attendance entry.",
        );
        ids.add(entry.student_id);
        ensure(
          eligible.has(entry.student_id),
          "Student is not active on this date.",
        );
      }
      await db.insertRows(
        "attendance",
        ["student_id", "date", "status", "recorded_by", "updated_at"],
        entries.map((e) => [e.student_id, date, e.status, me(res).id, now()]),
        "ON CONFLICT(student_id,date) DO UPDATE SET status=excluded.status,recorded_by=excluded.recorded_by,updated_at=excluded.updated_at",
      );
      await db.insertRows(
        "audit",
        ["actor", "action", "detail", "created_at"],
        entries
          .filter((e) => previous.get(e.student_id) !== e.status)
          .map((e) => [
            me(res).name,
            previous.has(e.student_id)
              ? "Attendance corrected"
              : "Attendance recorded",
            `${date} · Student #${e.student_id} · ${previous.get(e.student_id) || "Unmarked"} → ${e.status}`,
            now(),
          ]),
      );
      await audit(
        me(res),
        "Attendance saved",
        `${date} · ${entries.length} student entries`,
      );
    });
    res.json({ ok: true });
  });
  const preview = async (period: string) => {
    const end = new Date(
      Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5)), 0),
    )
      .toISOString()
      .slice(0, 10);
    const rate = Number((await settings()).daily_rate);
    const students = await db.all(
      "SELECT * FROM students WHERE joined<=? AND (exited IS NULL OR exited>=?) ORDER BY name,id",
      end,
      `${period}-01`,
    );
    const entries = await db.all(
      "SELECT student_id,date,status FROM attendance WHERE date BETWEEN ? AND ?",
      `${period}-01`,
      end,
    );
    const counts = new Map<number, { recorded: number; days: number }>();
    for (const a of entries) {
      const c = counts.get(a.student_id) || { recorded: 0, days: 0 };
      c.recorded++;
      if (a.status === "Present") c.days++;
      counts.set(a.student_id, c);
    }
    const rows = students.map((s) => {
      const start = s.joined > `${period}-01` ? s.joined : `${period}-01`,
        finish = s.exited && s.exited < end ? s.exited : end;
      const expected =
        Math.round((Date.parse(finish) - Date.parse(start)) / 86400_000) + 1;
      const c = counts.get(s.id) || { recorded: 0, days: 0 };
      return {
        student_id: s.id,
        name: s.name,
        code: s.code,
        days: c.days,
        expected,
        missing: expected - c.recorded,
        rate,
        amount: c.days * rate,
      };
    });
    return {
      period,
      rate,
      rows,
      total: rows.reduce((v, r) => v + r.amount, 0),
      finalized: await locked(period),
      closed: end < today(),
    };
  };
  app.post("/api/mess/preview", async (req, res) => {
    admin(res);
    ensure(validMonth(req.body.period), "Select a valid billing month.");
    res.json(await preview(req.body.period));
  });
  app.post("/api/mess/finalize", async (req, res) => {
    admin(res);
    const b = req.body;
    ensure(
      validMonth(b.period) && integer(b.expected_rate),
      "A billing month and previewed rate are required.",
    );
    await db.transaction(async () => {
      const p = await preview(b.period);
      ensure(!p.finalized, "This month has already been finalized.", 409);
      ensure(p.closed, "Only a completed month can be finalized.");
      ensure(
        p.rate === b.expected_rate,
        "The rate has changed. Preview the demand again.",
        409,
      );
      ensure(p.rows.length > 0, "No eligible students found.");
      ensure(
        p.rows.every((r) => r.missing === 0),
        "Complete missing attendance before finalizing.",
      );
      ensure(
        b.expected_total === p.total &&
          JSON.stringify(b.expected_rows) === JSON.stringify(p.rows),
        "Attendance has changed. Preview the demand again.",
        409,
      );
      await db.insertRows(
        "demands",
        [
          "student_id",
          "category",
          "period",
          "description",
          "amount",
          "days",
          "rate",
          "finalized_by",
          "created_at",
        ],
        p.rows
          .filter((r) => r.amount > 0)
          .map((r) => [
            r.student_id,
            "Mess",
            p.period,
            "Monthly mess charges",
            r.amount,
            r.days,
            r.rate,
            me(res).id,
            now(),
          ]),
      );
      await db.run(
        "INSERT INTO billing_periods (period,snapshot,created_at) VALUES (?,?,?)",
        p.period,
        JSON.stringify(p),
        now(),
      );
      await audit(
        me(res),
        "Mess demands finalized",
        `${p.period} · ${p.rows.length} students · ${p.total / 100} INR`,
      );
    });
    res.status(201).json({ ok: true });
  });
  app.post("/api/payments", async (req, res) => {
    staff(res);
    const b = req.body;
    ensure(
      integer(b.student_id) && integer(b.amount),
      "Select a student and a positive amount in paise.",
    );
    ensure(
      validDate(b.date) && b.date <= today(),
      "Choose a valid payment date, not in the future.",
    );
    ensure(
      ["Cash", "UPI", "Bank"].includes(b.mode),
      "Select a valid payment mode.",
    );
    ensure(
      typeof b.reference === "string" &&
        b.reference.length <= 120 &&
        (b.mode === "Cash" || b.reference.trim().length > 0),
      "A transaction reference is required for UPI and bank payments.",
    );
    ensure(
      typeof b.idempotency_key === "string" &&
        !b.idempotency_key.startsWith("gateway-") &&
        /^[\w-]{16,100}$/.test(b.idempotency_key),
      "A valid payment confirmation key is required.",
    );
    ensure(
      Array.isArray(b.allocations) &&
        b.allocations.length > 0 &&
        b.allocations.length <= 200,
      "Select at least one demand.",
    );
    for (const a of b.allocations)
      ensure(
        a && integer(a.demand_id) && integer(a.amount),
        "Invalid allocation.",
      );
    const result = await recordPayment(b, me(res));
    res.status(result.duplicate ? 200 : 201).json(result);
  });
  const recordPayment = async (b: Row, actor: { id: number; name: string }) =>
    db.transaction(async () => {
      const existing = await db.get(
        "SELECT * FROM payments WHERE idempotency_key=?",
        b.idempotency_key,
      );
      if (existing) {
        const old = await db.all(
          "SELECT demand_id,amount FROM allocations WHERE payment_id=? ORDER BY demand_id",
          existing.id,
        );
        const proposed = b.allocations
          .map((a: Row) => ({ demand_id: a.demand_id, amount: a.amount }))
          .sort((a: Row, c: Row) => a.demand_id - c.demand_id);
        ensure(
          existing.student_id === b.student_id &&
            existing.amount === b.amount &&
            existing.received_by === actor.id &&
            existing.date === b.date &&
            existing.mode === b.mode &&
            existing.reference === b.reference.trim() &&
            JSON.stringify(old) === JSON.stringify(proposed),
          "This confirmation key was already used for a different payment.",
          409,
        );
        return { id: existing.id, receipt: existing.receipt, duplicate: true };
      }
      const selected = await demands(b.student_id),
        ids = new Set<number>();
      let total = 0,
        category = "";
      for (const a of b.allocations) {
        ensure(!ids.has(a.demand_id), "Invalid or duplicate allocation.");
        ids.add(a.demand_id);
        const d = selected.find((d) => d.id === a.demand_id);
        ensure(
          d && a.amount <= d.balance,
          "Allocation exceeds the outstanding balance or belongs to another student.",
        );
        ensure(
          !category || category === d.category,
          "Collect one fee category per payment; each category has its own receipt.",
        );
        category = d.category;
        total += a.amount;
      }
      ensure(
        total === b.amount,
        "Allocated total must equal the payment amount.",
      );
      const seq = await db.get(
        `INSERT INTO receipt_sequences (category,value) VALUES (?,1) ON CONFLICT(${db.key("category")}) DO UPDATE SET value=receipt_sequences.value+1 RETURNING value`,
        category,
      );
      const receipt = `${category.toUpperCase()}-${String(seq.value).padStart(6, "0")}`;
      const student = await db.get(
        "SELECT name,code,roll FROM students WHERE id=?",
        b.student_id,
      );
      const snapshot = {
        ...student,
        hostel: (await settings()).hostel_name,
        received_name: actor.name,
        ...(b.idempotency_key.startsWith("gateway-") && b.gateway
          ? { gateway: b.gateway }
          : {}),
        allocations: b.allocations
          .map((a: Row) => {
            const d = selected.find((d) => d.id === a.demand_id)!;
            return {
              period: d.period,
              description: d.description,
              amount: a.amount,
            };
          })
          .sort((a: Row, c: Row) => a.period.localeCompare(c.period)),
      };
      const p = await db.get(
        "INSERT INTO payments (student_id,amount,date,mode,reference,category,receipt,received_by,idempotency_key,created_at,snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
        b.student_id,
        b.amount,
        b.date,
        b.mode,
        b.reference.trim(),
        category,
        receipt,
        actor.id,
        b.idempotency_key,
        now(),
        JSON.stringify(snapshot),
      );
      for (const a of b.allocations)
        await db.run(
          "INSERT INTO allocations (payment_id,demand_id,amount) VALUES (?,?,?)",
          p.id,
          a.demand_id,
          a.amount,
        );
      await audit(
        actor,
        "Payment received",
        `${receipt} · ${b.amount / 100} INR · ${b.mode}`,
      );
      return { id: p.id, receipt, duplicate: false };
    });
  app.get("/api/receipts/:id", async (req, res) => {
    const p = await db.get(
      "SELECT * FROM payments WHERE id=?",
      Number(req.params.id),
    );
    ensure(
      p && (me(res).role !== "Student" || p.student_id === me(res).student_id),
      "Receipt not found.",
      404,
    );
    const snapshot = p.snapshot
      ? JSON.parse(p.snapshot)
      : {
          ...(await db.get(
            "SELECT name,code,roll FROM students WHERE id=?",
            p.student_id,
          )),
          hostel: (await settings()).hostel_name,
          received_name: (
            await db.get("SELECT name FROM users WHERE id=?", p.received_by)
          ).name,
          allocations: await db.all(
            "SELECT a.amount,d.period,d.description FROM allocations a JOIN demands d ON d.id=a.demand_id WHERE a.payment_id=? ORDER BY d.period",
            p.id,
          ),
        };
    const {
      id,
      student_id,
      amount,
      date,
      mode,
      reference,
      category,
      receipt,
      reversed_at,
      reversal_reason,
    } = p;
    res.json({
      id,
      student_id,
      amount,
      refunded_amount: db.communities
        ? (
            await db.get(
              "SELECT COALESCE(SUM(refunded_amount),0) AS amount FROM allocations WHERE payment_id=?",
              p.id,
            )
          ).amount
        : 0,
      date,
      mode,
      reference,
      category,
      receipt,
      reversed_at,
      reversal_reason,
      ...snapshot,
    });
  });
  app.post("/api/payments/:id/reverse", async (req, res) => {
    admin(res);
    ensure(text(req.body.reason, 500), "A correction reason is required.");
    await db.transaction(async () => {
      const p = await db.get(
        "SELECT * FROM payments WHERE id=?",
        Number(req.params.id),
      );
      ensure(p, "Payment not found.", 404);
      ensure(
        !String(p.idempotency_key).startsWith("gateway-"),
        "Online payments must be refunded in Razorpay. Verified refund notifications update the ledger automatically.",
        409,
      );
      ensure(!p.reversed_at, "Payment is already reversed.", 409);
      await db.run(
        "UPDATE payments SET reversed_at=?,reversal_reason=? WHERE id=?",
        now(),
        req.body.reason.trim(),
        p.id,
      );
      await audit(
        me(res),
        "Payment reversed",
        `${p.receipt} · ${p.amount / 100} INR · ${req.body.reason}`,
      );
    });
    res.json({ ok: true });
  });
  app.post("/api/demands/:id/adjust", async (req, res) => {
    admin(res);
    const b = req.body;
    ensure(
      Number.isSafeInteger(b.amount) &&
        b.amount >= 0 &&
        b.amount < 1_000_000_000 &&
        text(b.reason, 500),
      "A revised total and reason are required.",
    );
    await db.transaction(async () => {
      const d = (await demands()).find((d) => d.id === Number(req.params.id));
      ensure(d, "Demand not found.", 404);
      ensure(
        b.amount >= d.collected,
        "Reverse the affected payments before reducing this demand below its collection.",
      );
      await db.run(
        "UPDATE demands SET adjustment=?,adjustment_reason=? WHERE id=?",
        b.amount - d.amount,
        b.reason,
        d.id,
      );
      await audit(
        me(res),
        "Demand adjusted",
        `#${d.id} · ${d.amount + d.adjustment} → ${b.amount} paise · ${b.reason}`,
      );
    });
    res.json({ ok: true });
  });
  app.post("/api/settings", async (req, res) => {
    admin(res);
    ensure(
      text(req.body.hostel_name) && integer(req.body.daily_rate),
      "Enter a hostel name and a positive daily rate.",
    );
    await db.transaction(async () => {
      for (const [key, value] of Object.entries({
        hostel_name: req.body.hostel_name.trim(),
        daily_rate: String(req.body.daily_rate),
      }))
        await db.run("UPDATE settings SET value=? WHERE key=?", value, key);
      if (db.communities)
        await db.run(
          "UPDATE communities SET name=? WHERE id=?",
          req.body.hostel_name.trim(),
          db.communityId,
        );
      await audit(
        me(res),
        "Settings updated",
        `Daily rate: ${req.body.daily_rate / 100} INR. Finalized demands are unchanged.`,
      );
    });
    res.json({ ok: true });
  });
  gateway.routes(app);
  registerOperations(app, { db, audit, demands, payments, settings });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Endpoint not found." }),
  );
  app.use(
    (
      e: Error & { code?: string; status?: number },
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      if (e instanceof ApiError)
        return res.status(e.status).json({ error: e.message });
      if (e instanceof SyntaxError || e.status === 413)
        return res
          .status(400)
          .json({ error: "Invalid or oversized request body." });
      if (e.code === "23505" || e.message.includes("UNIQUE constraint"))
        return res
          .status(409)
          .json({ error: "A record with these identifiers already exists." });
      console.error("Request failed", { name: e.name, code: e.code });
      res
        .status(500)
        .json({ error: "The request could not be saved. Please try again." });
    },
  );
  return app;
}
