import type { Express, Response } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import type { Store, Row } from "./store.js";
import {
  ensure,
  me,
  admin,
  text,
  integer,
  today,
  now,
  validDate,
  supabase,
  categories,
} from "./http.js";
import { storeDocument } from "./operations.js";
import { challanHtml, escape, periodRange, rupeesInWords } from "./challan.js";
import { sendMail } from "./mailer.js";
import type { Gateway } from "./gateway.js";

type Actor = { id: number; name: string };
type Deps = {
  db: Store;
  audit: (
    actor: { name: string },
    action: string,
    detail: string,
  ) => Promise<unknown>;
  demands: (sid?: number) => Promise<Row[]>;
  record: (body: Row, actor: Actor) => Promise<{ id: number; receipt: string }>;
  gateway: Gateway;
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phonePattern = /^\+?[0-9][0-9 -]{7,18}$/;
// One wallet contribution is ₹1 to ₹10,00,000 (amounts are in paise).
const validAmount = (v: unknown): v is number =>
  integer(v) && v >= 100 && v <= 100_000_000;
// Dues are ordered by when they began: an academic year 2026-2027 begins in
// June 2026, so it sorts as 2026-06 among monthly mess periods.
const began = (period: string) =>
  /^\d{4}-\d{4}$/.test(period) ? `${period.slice(0, 4)}-06` : period;

// Sponsor wallet: money comes in from sponsors (recorded by the Admin or paid
// online) and goes out as grants that settle students' dues with receipts.
// The Admin prepares sponsorship profiles; approved Sponsors browse them, and
// each profile has a public page people can share.
export function registerSponsors(app: Express, deps: Deps) {
  const { db, audit, demands, record, gateway } = deps;
  const sponsorOnly = (res: Response) =>
    ensure(me(res).role === "Sponsor", "Only Sponsors can do this.", 403);
  const adminOrSponsor = (res: Response) =>
    ensure(
      ["Admin", "Sponsor"].includes(me(res).role),
      "Only the Admin and Sponsors can open sponsorship profiles.",
      403,
    );

  // Students with dues, oldest and largest first.
  const dues = async () => {
    const byStudent = new Map<number, Row>();
    for (const d of await demands()) {
      if (d.balance <= 0) continue;
      const s = byStudent.get(d.student_id) ?? {
        student_id: d.student_id,
        name: d.name,
        code: d.code,
        department: d.department,
        outstanding: 0,
        oldest: d.period,
        dues: 0,
      };
      s.outstanding += d.balance;
      s.dues += 1;
      if (began(d.period) < began(s.oldest)) s.oldest = d.period;
      byStudent.set(d.student_id, s);
    }
    return [...byStudent.values()].sort(
      (a, b) =>
        began(a.oldest).localeCompare(began(b.oldest)) ||
        b.outstanding - a.outstanding,
    );
  };
  const wallets = async () =>
    db.all(
      `SELECT s.*,
        COALESCE((SELECT SUM(c.amount) FROM sponsor_contributions c WHERE c.sponsor_id=s.id),0) AS contributed,
        COALESCE((SELECT SUM(p.amount) FROM sponsor_grants g JOIN payments p ON p.idempotency_key LIKE 'sponsor-' || g.id || '-%' AND p.reversed_at IS NULL WHERE g.sponsor_id=s.id),0) AS given
      FROM sponsors s ORDER BY s.name`,
    );
  const wallet = async (id: number): Promise<Row> => {
    const w = (await wallets()).find((s) => s.id === id);
    ensure(w, "Sponsor not found.", 404);
    return { ...w, balance: Number(w.contributed) - Number(w.given) };
  };
  // Settles one student's oldest dues from a sponsor's wallet, one receipt per
  // fee category. Runs inside the caller's transaction.
  const giveGrant = async (
    sponsor: Row,
    studentId: number,
    amount: number,
    actor: Actor,
  ) => {
    const open = (await demands(studentId))
      .filter((d) => d.balance > 0)
      .sort(
        (a, b) => began(a.period).localeCompare(began(b.period)) || a.id - b.id,
      );
    const owed = open.reduce((sum, d) => sum + d.balance, 0);
    ensure(
      amount <= owed,
      `${open[0]?.name ?? "This student"} owes ${owed / 100} INR; a grant cannot exceed the dues.`,
      409,
    );
    const grant = await db.get(
      "INSERT INTO sponsor_grants (sponsor_id,student_id,amount,created_by,created_at) VALUES (?,?,?,?,?) RETURNING id",
      sponsor.id,
      studentId,
      amount,
      actor.id,
      now(),
    );
    let left = amount;
    const byCategory = new Map<string, Row[]>();
    for (const d of open) {
      const part = Math.min(left, d.balance);
      if (part <= 0) break;
      left -= part;
      byCategory.set(d.category, [
        ...(byCategory.get(d.category) ?? []),
        { demand_id: d.id, amount: part },
      ]);
    }
    const receipts: { id: number; receipt: string }[] = [];
    for (const category of categories.filter((c) => byCategory.has(c))) {
      const allocations = byCategory.get(category)!;
      const paid = await record(
        {
          student_id: studentId,
          amount: allocations.reduce((sum, a) => sum + a.amount, 0),
          date: today(),
          mode: "Sponsor",
          reference: `Sponsor: ${sponsor.name}`.slice(0, 120),
          idempotency_key: `sponsor-${grant.id}-${category}`,
          allocations,
        },
        actor,
      );
      receipts.push({ id: paid.id, receipt: paid.receipt });
    }
    return receipts;
  };
  // Mess receipts paid by a sponsor go to the student by email as the hostel
  // mess challan. Runs after the payment is saved; a failed email is logged
  // and never undoes the payment.
  const emailMessReceipts = async (ids: number[]) => {
    for (const id of ids) {
      try {
        const p = await db.get(
          "SELECT * FROM payments WHERE id=? AND category='Mess'",
          id,
        );
        if (!p) continue;
        const to = (
          await db.get(
            "SELECT email FROM users WHERE student_id=? AND role='Student' AND active=1",
            p.student_id,
          )
        )?.email;
        if (!to) continue;
        const snap = JSON.parse(p.snapshot || "{}");
        const periods = (snap.allocations ?? []).map((a: Row) => a.period);
        const [y, m, d] = p.date.split("-");
        const challan = {
          receipt: p.receipt,
          date: `${d}/${m}/${y}`,
          name: snap.name,
          className: [snap.year && `Year ${snap.year}`, snap.department]
            .filter(Boolean)
            .join(" · "),
          // Sponsor payments have no UPI reference of their own.
          reference: p.mode === "Sponsor" ? "" : p.reference,
          periods,
          amount: p.amount,
          remitter: p.reference.replace(/^Sponsor: /, ""),
        };
        await sendMail({
          to,
          subject: `JSS PDA Hostel – mess fee receipt ${p.receipt}`,
          html: `<p style="font-family:Arial,sans-serif">Dear ${escape(snap.name)},</p>
<p style="font-family:Arial,sans-serif">A sponsor, ${escape(challan.remitter)}, has paid your hostel mess fees for ${periodRange(periods)}. Your receipt is below and in the Receipts page of the JSS PDA Hostel app.</p>
${challanHtml(challan)}`,
          text: `Dear ${snap.name}, a sponsor (${challan.remitter}) paid your hostel mess fees for ${periodRange(periods)}: Rs. ${p.amount / 100} (${rupeesInWords(p.amount)}). Receipt ${p.receipt}, dated ${challan.date}. You can see it in the Receipts page of the JSS PDA Hostel app.`,
        });
      } catch (e) {
        console.error("Mess receipt email failed", {
          payment: id,
          error: (e as Error).message,
        });
      }
    }
  };
  const grants = async (sponsorId?: number) =>
    db.all(
      `SELECT g.id,g.sponsor_id,g.student_id,g.created_at,sp.name AS sponsor_name,s.name AS student_name,s.code,
        CASE WHEN (SELECT u.role FROM users u WHERE u.id=g.created_by)='Sponsor' THEN 'Sponsor' ELSE 'Admin' END AS chosen_by,
        COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.idempotency_key LIKE 'sponsor-' || g.id || '-%' AND p.reversed_at IS NULL),0) AS amount
      FROM sponsor_grants g JOIN sponsors sp ON sp.id=g.sponsor_id JOIN students s ON s.id=g.student_id
      ${sponsorId !== undefined ? "WHERE g.sponsor_id=?" : ""} ORDER BY g.id DESC LIMIT 500`,
      ...(sponsorId !== undefined ? [sponsorId] : []),
    );
  const contributions = async (sponsorId?: number) =>
    db.all(
      `SELECT c.id,c.sponsor_id,c.amount,c.received_on,c.method,c.note,sp.name AS sponsor_name
      FROM sponsor_contributions c JOIN sponsors sp ON sp.id=c.sponsor_id
      ${sponsorId !== undefined ? "WHERE c.sponsor_id=?" : ""} ORDER BY c.id DESC LIMIT 500`,
      ...(sponsorId !== undefined ? [sponsorId] : []),
    );
  const signedUrl = async (path: string, download?: string) => {
    const r = await supabase()
      .storage.from("student-documents")
      .createSignedUrl(path, 3600, download ? { download } : undefined);
    return r.error || !r.data ? null : r.data.signedUrl;
  };
  // Sponsorship profiles with outstanding dues, results and labelled files.
  const profiles = async (activeOnly: boolean) => {
    const rows = await db.all(
      `SELECT l.student_id,l.reason,l.active,l.share_token,l.listed_at,l.photo_document_id,d.path AS photo_path,
        s.name,s.code,s.course,s.department,s.year,s.academic_year
      FROM sponsor_listings l JOIN students s ON s.id=l.student_id LEFT JOIN documents d ON d.id=l.photo_document_id
      ${activeOnly ? "WHERE l.active=1" : ""} ORDER BY l.listed_at DESC`,
    );
    const files = await db.all(
      "SELECT f.id,f.student_id,f.kind,f.label,f.detail,f.document_id,d.name AS document_name FROM sponsor_files f LEFT JOIN documents d ON d.id=f.document_id ORDER BY f.id",
    );
    const owed = new Map((await dues()).map((d) => [d.student_id, d]));
    return Promise.all(
      rows.map(async ({ photo_path, ...r }): Promise<Row> => ({
        ...r,
        outstanding: owed.get(r.student_id)?.outstanding ?? 0,
        oldest: owed.get(r.student_id)?.oldest ?? null,
        photo_url: photo_path ? await signedUrl(photo_path) : null,
        results: files.filter(
          (f) => f.student_id === r.student_id && f.kind === "Result",
        ),
        documents: files.filter(
          (f) => f.student_id === r.student_id && f.kind === "Document",
        ),
      })),
    );
  };
  const listing = async (sid: number) => {
    const l = await db.get(
      "SELECT * FROM sponsor_listings WHERE student_id=?",
      sid,
    );
    ensure(l, "Prepare this student's sponsorship profile first.", 404);
    return l;
  };
  // The sponsor record of a signed-in Sponsor, matched by email.
  const mySponsor = async (res: Response) =>
    db.get("SELECT * FROM sponsors WHERE email=?", me(res).email);

  app.get("/api/sponsorship/admin", async (_req, res) => {
    admin(res);
    const ws = await wallets();
    res.json({
      dues: await dues(),
      listings: await profiles(false),
      sponsors: ws.map((w) => ({
        ...w,
        balance: Number(w.contributed) - Number(w.given),
      })),
      contributions: await contributions(),
      grants: await grants(),
      online: !!gateway.credentials(),
    });
  });

  // Add a sponsor (or update one by email) with an optional first amount.
  app.post("/api/sponsorship/sponsors", async (req, res) => {
    admin(res);
    const b = req.body;
    const email = String(b.email || "")
      .trim()
      .toLowerCase();
    ensure(
      text(b.name) &&
        emailPattern.test(email) &&
        phonePattern.test(b.phone || ""),
      "Enter the sponsor's name, email and phone number.",
    );
    ensure(
      b.amount === undefined || b.amount === 0 || validAmount(b.amount),
      "Enter an amount from ₹1 to ₹10,00,000.",
    );
    ensure(
      !b.amount || (validDate(b.received_on) && b.received_on <= today()),
      "Choose the date the money was received, not in the future.",
    );
    const id = await db.transaction(async () => {
      const sponsor = await db.get(
        "INSERT INTO sponsors (name,email,phone,created_at) VALUES (?,?,?,?) ON CONFLICT(community_id,email) DO UPDATE SET name=excluded.name,phone=excluded.phone RETURNING id",
        b.name.trim(),
        email,
        b.phone.trim(),
        now(),
      );
      if (b.amount)
        await db.run(
          "INSERT INTO sponsor_contributions (sponsor_id,amount,received_on,method,note,recorded_by,created_at) VALUES (?,?,?,'Recorded',?,?,?)",
          sponsor.id,
          b.amount,
          b.received_on,
          String(b.note || "").slice(0, 300),
          me(res).id,
          now(),
        );
      await audit(
        me(res),
        "Sponsor saved",
        `${b.name.trim()} · ${email}${b.amount ? ` · ${b.amount / 100} INR received` : ""}`,
      );
      return sponsor.id;
    });
    res.status(201).json({ id });
  });

  app.post("/api/sponsorship/sponsors/:id/contributions", async (req, res) => {
    admin(res);
    const b = req.body,
      id = Number(req.params.id);
    ensure(validAmount(b.amount), "Enter an amount from ₹1 to ₹10,00,000.");
    ensure(
      validDate(b.received_on) && b.received_on <= today(),
      "Choose the date the money was received, not in the future.",
    );
    const sponsor = await wallet(id);
    await db.transaction(async () => {
      await db.run(
        "INSERT INTO sponsor_contributions (sponsor_id,amount,received_on,method,note,recorded_by,created_at) VALUES (?,?,?,'Recorded',?,?,?)",
        id,
        b.amount,
        b.received_on,
        String(b.note || "").slice(0, 300),
        me(res).id,
        now(),
      );
      await audit(
        me(res),
        "Sponsor contribution recorded",
        `${sponsor.name} · ${b.amount / 100} INR`,
      );
    });
    res.status(201).json({ ok: true });
  });

  // Give wallet money to students: each grant settles that student's oldest
  // dues first, with one receipt per fee category (mode Sponsor).
  app.post("/api/sponsorship/sponsors/:id/grants", async (req, res) => {
    admin(res);
    const id = Number(req.params.id),
      list = req.body.grants;
    ensure(
      Array.isArray(list) &&
        list.length > 0 &&
        list.length <= 200 &&
        list.every(
          (g: Row) => g && integer(g.student_id) && integer(g.amount),
        ) &&
        new Set(list.map((g: Row) => g.student_id)).size === list.length,
      "Choose students and an amount for each.",
    );
    const actor = me(res);
    const result = await db.transaction(async () => {
      const sponsor = await wallet(id);
      const total = list.reduce((sum: number, g: Row) => sum + g.amount, 0);
      ensure(
        total <= sponsor.balance,
        `This sponsor's wallet has ${sponsor.balance / 100} INR, less than the ${total / 100} INR chosen.`,
        409,
      );
      const receipts: { id: number; receipt: string }[] = [];
      for (const g of list)
        receipts.push(
          ...(await giveGrant(sponsor, g.student_id, g.amount, actor)),
        );
      await audit(
        actor,
        "Sponsor wallet allocated",
        `${sponsor.name} · ${list.length} student(s) · ${total / 100} INR`,
      );
      return receipts;
    });
    await emailMessReceipts(result.map((r) => r.id));
    res.status(201).json({ receipts: result.map((r) => r.receipt) });
  });

  // Sponsorship profiles: the Admin lists a student with dues and explains
  // why they need help; photo, results and labelled documents go with it.
  app.post("/api/sponsorship/listings/:sid", async (req, res) => {
    admin(res);
    const sid = Number(req.params.sid),
      b = req.body;
    ensure(
      typeof b.reason === "string" && b.reason.length <= 2000,
      "Describe the difficulty in paying fees in up to 2000 characters.",
    );
    ensure([0, 1].includes(b.active), "Choose whether the profile is listed.");
    ensure(
      await db.get("SELECT id FROM students WHERE id=?", sid),
      "Student not found.",
      404,
    );
    if (b.active)
      ensure(
        (await dues()).some((d) => d.student_id === sid),
        "Only students with dues can be listed for sponsoring.",
        409,
      );
    await db.transaction(async () => {
      await db.run(
        "INSERT INTO sponsor_listings (student_id,reason,share_token,active,listed_by,listed_at) VALUES (?,?,?,?,?,?) ON CONFLICT(community_id,student_id) DO UPDATE SET reason=excluded.reason,active=excluded.active",
        sid,
        b.reason.trim(),
        randomBytes(12).toString("base64url"),
        b.active,
        me(res).id,
        now(),
      );
      await audit(
        me(res),
        b.active
          ? "Student listed for sponsoring"
          : "Sponsorship listing hidden",
        `Student #${sid}`,
      );
    });
    res.json({ ok: true });
  });

  app.post("/api/sponsorship/listings/:sid/photo", async (req, res) => {
    admin(res);
    const sid = Number(req.params.sid);
    await listing(sid);
    const head = Buffer.from(
      String(req.body.content || "").slice(0, 16),
      "base64",
    );
    ensure(
      head[0] === 255 || head.subarray(1, 4).toString() === "PNG",
      "Choose a JPEG or PNG photo.",
    );
    await storeDocument(db, sid, req.body, me(res), async (documentId) => {
      await db.run(
        "UPDATE sponsor_listings SET photo_document_id=? WHERE student_id=?",
        documentId,
        sid,
      );
      await audit(me(res), "Sponsorship photo updated", `Student #${sid}`);
    });
    res.status(201).json({ ok: true });
  });

  app.post("/api/sponsorship/listings/:sid/files", async (req, res) => {
    admin(res);
    const sid = Number(req.params.sid),
      b = req.body;
    await listing(sid);
    ensure(
      ["Result", "Document"].includes(b.kind) && text(b.label, 120),
      b.kind === "Result"
        ? "Enter the semester, such as Semester 2."
        : "Label the document, such as Income certificate.",
    );
    ensure(
      b.kind !== "Result" || text(b.detail, 120),
      "Enter the result, such as SGPA 8.2 or 76%.",
    );
    ensure(b.kind === "Result" || b.document, "Choose the document to upload.");
    const save = async (documentId: number | null) => {
      await db.run(
        "INSERT INTO sponsor_files (student_id,kind,label,detail,document_id,created_at) VALUES (?,?,?,?,?,?)",
        sid,
        b.kind,
        b.label.trim(),
        String(b.detail || "").trim(),
        documentId,
        now(),
      );
      await audit(
        me(res),
        b.kind === "Result"
          ? "Semester result added"
          : "Sponsorship document added",
        `Student #${sid} · ${b.label.trim()}`,
      );
    };
    if (b.document) await storeDocument(db, sid, b.document, me(res), save);
    else await db.transaction(() => save(null));
    res.status(201).json({ ok: true });
  });

  app.post("/api/sponsorship/files/:id/delete", async (req, res) => {
    admin(res);
    const f = await db.get(
      "SELECT * FROM sponsor_files WHERE id=?",
      Number(req.params.id),
    );
    ensure(f, "Not found.", 404);
    await db.transaction(async () => {
      await db.run("DELETE FROM sponsor_files WHERE id=?", f.id);
      await audit(
        me(res),
        "Sponsorship item removed",
        `Student #${f.student_id} · ${f.label}`,
      );
    });
    res.json({ ok: true });
  });

  // Listed profiles for Sponsors (and the Admin's preview of what they see).
  app.get("/api/sponsorship/students", async (_req, res) => {
    adminOrSponsor(res);
    res.json(await profiles(true));
  });

  // Supporting documents of listed students only.
  app.get("/api/sponsorship/documents/:id", async (req, res) => {
    adminOrSponsor(res);
    const d = await db.get(
      `SELECT d.* FROM documents d JOIN sponsor_files f ON f.document_id=d.id
      JOIN sponsor_listings l ON l.student_id=f.student_id
      WHERE d.id=? ${me(res).role === "Sponsor" ? "AND (l.active=1 OR f.student_id IN (SELECT g.student_id FROM sponsor_grants g JOIN sponsors sp ON sp.id=g.sponsor_id WHERE sp.email=?))" : ""}`,
      Number(req.params.id),
      ...(me(res).role === "Sponsor" ? [me(res).email] : []),
    );
    ensure(d, "Document not found.", 404);
    const url = await signedUrl(d.path, d.name);
    ensure(url, "Could not open document.");
    res.json({ url });
  });

  // A Sponsor's own wallet: what they gave and the students it helped.
  app.get("/api/sponsorship/mine", async (_req, res) => {
    sponsorOnly(res);
    let sponsor = await mySponsor(res);
    if (sponsor) {
      // Checkout may have closed before confirming; settle recent orders.
      for (const o of await db.all(
        "SELECT * FROM sponsor_orders WHERE user_id=? AND status='open' AND created_at>? ORDER BY created_at DESC LIMIT 3",
        me(res).id,
        new Date(Date.now() - 3 * 86_400_000).toISOString(),
      ))
        await settle(o).catch(() => undefined);
      sponsor = await wallet(sponsor.id);
    }
    const given = sponsor ? await grants(sponsor.id) : [];
    // Profiles of every student this sponsor's money reached, listed or not.
    const funded = [...new Set(given.map((g) => g.student_id))];
    const all = funded.length ? await profiles(false) : [];
    const students = funded.length
      ? await db.all(
          `SELECT id AS student_id,name,course,department,year,academic_year FROM students WHERE id IN (${funded.map(() => "?").join(",")})`,
          ...funded,
        )
      : [];
    res.json({
      sponsor: sponsor ?? null,
      contributions: sponsor ? await contributions(sponsor.id) : [],
      grants: given,
      students: students.map(
        (s) =>
          all.find((p) => p.student_id === s.student_id) ?? {
            ...s,
            reason: "",
            photo_url: null,
            results: [],
            documents: [],
            outstanding: null,
          },
      ),
      online: !!gateway.credentials(),
    });
  });

  // Online contribution to the hostel's sponsor wallet (UPI or card).
  app.post("/api/sponsorship/contribute", async (req, res) => {
    sponsorOnly(res);
    const b = req.body,
      user = me(res);
    ensure(validAmount(b.amount), "Enter an amount from ₹1 to ₹10,00,000.");
    ensure(phonePattern.test(b.phone || ""), "Enter your phone number.");
    // Sponsoring one student: only a listed student with dues, up to what
    // they owe. Without a student the money waits in the wallet for the Admin.
    if (b.student_id !== undefined) {
      ensure(integer(b.student_id), "Choose a listed student.");
      const profile = (await profiles(true)).find(
        (p) => p.student_id === b.student_id,
      );
      ensure(profile, "This student is not listed for sponsoring.", 404);
      ensure(
        profile.outstanding > 0,
        "This student's fees are already covered.",
        409,
      );
      ensure(
        b.amount <= profile.outstanding,
        `${profile.name} owes ${profile.outstanding / 100} INR. Enter that amount or less.`,
      );
    }
    const c = gateway.credentials();
    ensure(c, "Online payments are not enabled for this hostel.", 503);
    const sponsor = await db.get(
      "INSERT INTO sponsors (name,email,phone,created_at) VALUES (?,?,?,?) ON CONFLICT(community_id,email) DO UPDATE SET phone=excluded.phone RETURNING id,name,email,phone",
      user.name,
      user.email,
      b.phone.trim(),
      now(),
    );
    const id = randomUUID();
    const order = await gateway.provider("/orders", c, {
      amount: b.amount,
      currency: "INR",
      receipt: `sponsor-${id.slice(0, 30)}`,
      notes: { purpose: "Sponsor wallet", sponsor: sponsor.email },
    });
    ensure(
      typeof order.id === "string" && order.amount === b.amount,
      "Payment provider returned an unexpected order.",
      503,
    );
    await db.run(
      "INSERT INTO sponsor_orders (id,user_id,sponsor_id,student_id,key_id,provider_order_id,amount,status,created_at) VALUES (?,?,?,?,?,?,?,'open',?)",
      id,
      user.id,
      sponsor.id,
      b.student_id ?? null,
      c.key_id,
      order.id,
      b.amount,
      now(),
    );
    res.status(201).json({
      id,
      key_id: c.key_id,
      order_id: order.id,
      amount: b.amount,
      sponsor,
    });
  });

  // Only the provider's captured payment adds money to the wallet, once.
  const settle = async (o: Row) => {
    if (o.status === "paid") return "paid";
    const c = gateway.credentials(o.key_id);
    ensure(c, "Online payments are not enabled for this hostel.", 503);
    const found = await gateway.provider(
      `/orders/${o.provider_order_id}/payments`,
      c,
    );
    const items: Row[] = Array.isArray(found.items) ? found.items : [];
    const paid = items.find(
      (p) => p.status === "captured" && p.amount === o.amount,
    );
    if (!paid)
      return items.some((p) => p.status === "authorized")
        ? "authorized"
        : "open";
    const ids: number[] = [];
    const status = await db.transaction(async () => {
      const current = await db.get(
        "SELECT status FROM sponsor_orders WHERE id=?",
        o.id,
      );
      if (current.status === "paid") return "paid";
      await db.run(
        "INSERT INTO sponsor_contributions (sponsor_id,amount,received_on,method,note,provider_payment_id,created_at) VALUES (?,?,?,'Online',?,?,?)",
        o.sponsor_id,
        o.amount,
        today(),
        `Razorpay ${paid.method === "upi" ? "UPI" : paid.method === "card" ? "card" : "payment"} · ${paid.id}`,
        paid.id,
        now(),
      );
      await db.run("UPDATE sponsor_orders SET status='paid' WHERE id=?", o.id);
      const sponsor = await db.get(
        "SELECT * FROM sponsors WHERE id=?",
        o.sponsor_id,
      );
      await audit(
        { name: sponsor.name },
        "Sponsor paid online",
        `${o.amount / 100} INR · ${paid.id}`,
      );
      // Paid for one student: settle their dues now. If they owe less by now,
      // the rest stays in the sponsor's wallet for the Admin to allocate.
      if (o.student_id) {
        const owed = (await demands(o.student_id)).reduce(
          (sum, d) => sum + Math.max(0, d.balance),
          0,
        );
        const amount = Math.min(owed, o.amount);
        if (amount > 0)
          for (const r of await giveGrant(sponsor, o.student_id, amount, {
            id: o.user_id,
            name: sponsor.name,
          }))
            ids.push(r.id);
      }
      return "paid";
    });
    await emailMessReceipts(ids);
    return status;
  };
  gateway.otherOrders.push(async (providerOrderId, keyId) => {
    const o = await db.get(
      "SELECT * FROM sponsor_orders WHERE provider_order_id=? AND key_id=?",
      providerOrderId,
      keyId,
    );
    if (o) await settle(o);
  });

  app.post("/api/sponsorship/contribute/:id/confirm", async (req, res) => {
    sponsorOnly(res);
    const o = await db.get(
      "SELECT * FROM sponsor_orders WHERE id=? AND user_id=?",
      req.params.id,
      me(res).id,
    );
    ensure(o, "Payment not found.", 404);
    const b = req.body,
      c = gateway.credentials(o.key_id);
    ensure(c, "Online payments are not enabled for this hostel.", 503);
    ensure(
      b.razorpay_order_id === o.provider_order_id &&
        typeof b.razorpay_payment_id === "string",
      "Payment does not match this contribution.",
      400,
    );
    gateway.signature(
      `${o.provider_order_id}|${b.razorpay_payment_id}`,
      b.razorpay_signature,
      c.key_secret,
    );
    res.json({ status: await settle(o) });
  });

  // Public sponsorship page: only what the Admin prepared for sharing. No
  // contact details, documents or student ID leave the hostel.
  app.get("/api/public/appeals/:token", async (req, res) => {
    const l = (await profiles(true)).find(
      (p) => p.share_token === String(req.params.token),
    );
    ensure(l, "This sponsorship page is no longer available.", 404);
    res.json({
      name: l.name,
      course: l.course,
      department: l.department,
      year: l.year,
      academic_year: l.academic_year,
      reason: l.reason,
      outstanding: l.outstanding,
      photo_url: l.photo_url,
      results: l.results.map((r: Row) => ({
        label: r.label,
        detail: r.detail,
      })),
      hostel: res.locals.community?.name ?? "",
    });
  });
}
