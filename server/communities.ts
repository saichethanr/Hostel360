import type { Express, Request, Response } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { checkPassword, hashPassword } from "./db.js";
import { admin, ensure, me, now, supabase, text, integer } from "./http.js";
import type { Store, Row } from "./store.js";
import { applicationInput, submitApplication } from "./operations.js";

// Identity belongs to the person; role, approval and student link belong to a
// community. No community administrator can reset another person's password.
export function registerCommunities(app: Express, db: Store) {
  const digest = (value: string) =>
    createHash("sha256").update(value).digest("hex");
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
  async function session(res: Response, user: Row, version: number) {
    const value = randomBytes(32).toString("hex");
    await db.run("DELETE FROM sessions WHERE expires<?", Date.now());
    await db.run(
      "INSERT INTO sessions (token,user_id,expires,auth_version) VALUES (?,?,?,?)",
      digest(value),
      user.id,
      Date.now() + 8 * 3600_000,
      version,
    );
    res.cookie("h360_session", value, { ...cookie, maxAge: 8 * 3600_000 });
  }
  async function limit(email: string) {
    await db.run(
      "DELETE FROM onboarding_attempts WHERE reset_at<?",
      Date.now(),
    );
    const attempt = await db.get(
      "INSERT INTO onboarding_attempts (key,count,reset_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=onboarding_attempts.count+1 RETURNING count",
      digest(email),
      Date.now() + 15 * 60_000,
    );
    ensure(
      attempt.count <= 20,
      "Too many attempts. Try again in 15 minutes.",
      429,
    );
  }
  // Email ownership check for new addresses. Supabase Auth generates, emails
  // and expires the one-time code; Hostel360 never stores it. Requires a
  // production SMTP provider in Supabase, so it is switched on explicitly.
  const verification = process.env.EMAIL_VERIFICATION === "on";
  async function verifyEmailCode(email: string, code: unknown) {
    ensure(
      typeof code === "string" && /^\d{6,10}$/.test(code.trim()),
      "Enter the verification code sent to your email.",
      428,
    );
    const result = await supabase().auth.verifyOtp({
      email,
      token: code.trim(),
      type: "email",
    });
    ensure(
      !result.error,
      "That code is incorrect or has expired. Request a new code.",
      400,
    );
  }
  async function identity(b: Row, signup = false) {
    ensure(
      text(b.email) &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email) &&
        text(b.password, 200),
      "Enter your email and password.",
    );
    const email = b.email.trim().toLowerCase();
    await limit(email);
    let person = await db.get("SELECT * FROM identities WHERE email=?", email);
    if (process.env.SUPABASE_URL) {
      const auth = supabase().auth;
      let result = await auth.signInWithPassword({
        email,
        password: b.password,
      });
      if (signup && !person && result.error) {
        ensure(
          b.password.length >= 12,
          "Use a password of at least 12 characters.",
        );
        // A new email must prove ownership with the code Supabase sends to it
        // before an account exists. Existing accounts sign in as usual.
        if (verification) await verifyEmailCode(email, b.email_code);
        // Accounts are created confirmed by the server: Hostel360 does not
        // depend on verification email delivery. A pre-existing confirmed
        // Auth account keeps its own password; an abandoned unconfirmed sign-up
        // with no Hostel360 identity is completed with the submitted password.
        const created = await auth.admin.createUser({
          email,
          password: b.password,
          email_confirm: true,
        });
        if (created.error) {
          const found = await auth.admin.generateLink({
            type: "magiclink",
            email,
          });
          const existing = found.data?.user;
          // A verified code proves ownership of an Auth user that has no
          // Hostel360 identity yet (sending the code created it).
          ensure(
            existing && (verification || !existing.email_confirmed_at),
            "This email already has an account. Use its existing password.",
            409,
          );
          const updated = await auth.admin.updateUserById(existing.id, {
            password: b.password,
            email_confirm: true,
          });
          ensure(!updated.error, "Could not register. Try again.", 503);
        }
        result = await auth.signInWithPassword({ email, password: b.password });
      }
      ensure(
        !result.error && result.data.user,
        person
          ? "This email already has an account, and the password doesn’t match. Enter that account’s password, or use a different email."
          : "Email or password is incorrect.",
        401,
      );
      const authId = result.data.user.id;
      ensure(
        !person || person.auth_id === authId,
        "Account identity does not match.",
        403,
      );
      if (!person && signup) {
        await db.run(
          "INSERT INTO identities (id,email,password,auth_id) VALUES (?,?,'supabase',?) ON CONFLICT(email) DO NOTHING",
          authId,
          email,
          authId,
        );
        person = await db.get("SELECT * FROM identities WHERE email=?", email);
        ensure(
          person?.auth_id === authId,
          "Account identity does not match.",
          403,
        );
      }
    } else {
      ensure(!process.env.VERCEL, "Supabase Auth is required.", 503);
      if (!person && signup) {
        ensure(
          b.password.length >= 12,
          "Use a password of at least 12 characters.",
        );
        await db.run(
          "INSERT INTO identities (id,email,password) VALUES (?,?,?) ON CONFLICT(email) DO NOTHING",
          randomUUID(),
          email,
          hashPassword(b.password),
        );
        person = await db.get("SELECT * FROM identities WHERE email=?", email);
      }
      ensure(
        person && checkPassword(b.password, person.password),
        "Email or password is incorrect.",
        401,
      );
    }
    ensure(
      person,
      "No community membership found. Request to join first.",
      401,
    );
    return person;
  }
  // A single-hostel deployment serves only this community code.
  const only = () => process.env.HOSTEL_COMMUNITY?.trim().toLowerCase();
  const multi = () => ensure(!only(), "This site serves a single hostel.", 404);
  const communityByCode = async (code: unknown) => {
    ensure(text(code, 80), "Choose your community.");
    ensure(
      !only() || code.trim().toLowerCase() === only(),
      "Community not found.",
      404,
    );
    const community = await db.get(
      "SELECT id,code,name FROM communities WHERE code=?",
      code.trim().toLowerCase(),
    );
    ensure(
      community,
      "Community not found. Search for it by name, or check the ID with your Admin.",
      404,
    );
    return community;
  };
  const slug = (value: string) =>
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "");
  const validCode = (code: string) =>
    /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(code) &&
    !["api", "admin", "assets", "legacy", "hostel360"].includes(code);
  const log2 = (a: { name: string }, action: string, detail: string) =>
    log(a.name, action, detail);
  const log = (actor: string, action: string, detail: string) =>
    db.run(
      "INSERT INTO audit (actor,action,detail,created_at) VALUES (?,?,?,?)",
      actor,
      action,
      detail,
      now(),
    );
  app.post("/api/communities", async (req, res) => {
    multi();
    const b = req.body;
    ensure(
      text(b.name) && text(b.community_name),
      "Enter your name and community name.",
    );
    // An ID typed by the Admin must be exactly theirs; otherwise the hostel
    // name becomes the ID and a numbered suffix resolves any collision.
    const custom = b.custom_code === true;
    const requested = text(b.code) ? slug(b.code) : "";
    ensure(
      !custom || validCode(requested),
      "Community ID must be 3–40 letters, numbers or hyphens.",
    );
    if (custom)
      ensure(
        !(await db.get("SELECT id FROM communities WHERE code=?", requested)),
        `The community ID “${requested}” is already used by another hostel. Pick a different ID.`,
        409,
      );
    const person = await identity(b, true);
    const community = await db.transaction(async () => {
      const code = custom
        ? requested
        : await freeCode(
            validCode(requested) ? requested : slug(b.community_name),
          );
      const c = await db.get(
        "INSERT INTO communities (code,name,created_at) VALUES (?,?,?) ON CONFLICT(code) DO NOTHING RETURNING id,code,name",
        code,
        b.community_name.trim(),
        now(),
      );
      ensure(c, "That community ID was just taken. Try again.", 409);
      await db.inCommunity(c.id, async () => {
        await db.insertRows(
          "settings",
          ["key", "value"],
          [
            ["hostel_name", c.name],
            ["daily_rate", "11000"],
            ["demo", "false"],
          ],
        );
        await db.run(
          "INSERT INTO users (name,email,password,role,auth_id,identity_id,membership_status) VALUES (?,?,'identity','Admin',?,?,'Approved')",
          b.name.trim(),
          person.email,
          person.auth_id,
          person.id,
        );
        await log(b.name.trim(), "Community created", c.name);
      });
      return c;
    });
    res.status(201).json({ community });
  });
  // Sends a one-time code to a new email address. Existing accounts are told
  // to use their password instead, without sending anything.
  app.post("/api/email/code", async (req, res) => {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    ensure(
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
      "Enter a valid email address.",
    );
    if (!verification) return res.json({ required: false });
    await limit(`code:${email}`);
    if (await db.get("SELECT id FROM identities WHERE email=?", email))
      return res.json({ required: false, existing: true });
    const sent = await supabase().auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    ensure(
      !sent.error,
      sent.error?.status === 429
        ? "Too many codes requested. Wait a minute and try again."
        : "Could not send the verification email. Try again shortly.",
      sent.error?.status === 429 ? 429 : 503,
    );
    res.json({ required: true, sent: true });
  });
  app.get("/api/email/verification", (_req, res) =>
    res.json({ required: verification }),
  );
  app.post("/api/communities/join", async (req, res) => {
    const b = req.body;
    ensure(
      text(b.name) && ["Admin", "Manager", "Student"].includes(b.role),
      "Enter your name and request Admin, Manager or Student access.",
    );
    const community = await communityByCode(b.code);
    // Students send their hostel details now, so approval is a single step.
    const details =
      b.role === "Student"
        ? {
            ...b.application,
            name: b.name,
            email: String(b.email || "")
              .trim()
              .toLowerCase(),
          }
        : null;
    if (details) applicationInput(details);
    const person = await identity(b, true);
    await db.inCommunity(community.id, () =>
      db.transaction(async () => {
        const existing = await db.get(
          "SELECT id FROM users WHERE identity_id=?",
          person.id,
        );
        ensure(
          !existing,
          "You already have a request or membership here. Sign in to check its status.",
          409,
        );
        const user = await db.get(
          "INSERT INTO users (name,email,password,role,auth_id,identity_id,membership_status) VALUES (?,?,'identity',?,?,?,'Pending') RETURNING id",
          b.name.trim(),
          person.email,
          b.role,
          person.auth_id,
          person.id,
        );
        if (details)
          await submitApplication(
            db,
            log2,
            { ...details, email: person.email },
            user.id,
            { name: b.name.trim() },
          );
        await log(
          b.name.trim(),
          "Membership requested",
          `${person.email} · ${b.role}`,
        );
      }),
    );
    res.status(201).json({ community, status: "Pending" });
  });
  const freeCode = async (base: string) => {
    const root = validCode(base) ? base : "hostel";
    for (let i = 1; ; i++) {
      const candidate = i === 1 ? root : `${root.slice(0, 36)}-${i}`;
      if (
        validCode(candidate) &&
        !(await db.get("SELECT id FROM communities WHERE code=?", candidate))
      )
        return candidate;
    }
  };
  // Live check while the Admin types: is this ID free, and what is a free one?
  app.get("/api/communities/available", async (req, res) => {
    multi();
    const code = slug(String(req.query.code || ""));
    if (!validCode(code))
      return res.json({ code, valid: false, available: false, suggestion: "" });
    const taken = !!(await db.get(
      "SELECT id FROM communities WHERE code=?",
      code,
    ));
    res.json({
      code,
      valid: true,
      available: !taken,
      suggestion: taken ? await freeCode(code) : code,
    });
  });
  // Public directory search: names and IDs only, never members or records.
  app.get("/api/communities/search", async (req, res) => {
    multi();
    const q = String(req.query.q || "")
      .trim()
      .toLowerCase()
      .slice(0, 80);
    if (q.length < 2) return res.json([]);
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    res.json(
      await db.all(
        "SELECT code,name FROM communities WHERE id<>1 AND (lower(name) LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\') ORDER BY CASE WHEN code=? THEN 0 WHEN lower(name) LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END,name LIMIT 8",
        like,
        like,
        q,
        `${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`,
      ),
    );
  });
  app.post("/api/setup", (_req, res) =>
    res.status(410).json({
      error:
        "Create a community instead. A private setup key is no longer needed.",
    }),
  );
  app.use("/api", async (req, res, next) => {
    const code = req.get("X-Community") || req.query.community;
    if (!code && req.path === "/config")
      return res.json({
        communities: true,
        demo: false,
        setup: false,
        hostel_name: "JSS Polytechnic for Differently Abled Students",
      });
    ensure(code, "Choose a community to continue.", 401);
    const community = await communityByCode(code);
    res.locals.community = community;
    db.inCommunity(community.id, next);
  });
  app.get("/api/config", (_req, res) =>
    res.json({
      communities: true,
      community: res.locals.community,
      demo: false,
      setup: false,
      hostel_name: res.locals.community.name,
    }),
  );
  app.post("/api/login", async (req, res) => {
    const person = await identity(req.body);
    const user = await db.get(
      "SELECT * FROM users WHERE identity_id=?",
      person.id,
    );
    ensure(
      user,
      "You have not joined this community. Request access first.",
      403,
    );
    await session(res, user, person.version);
    res.json({ ok: true });
  });
  app.use("/api", async (req, res, next) => {
    const user = await db.get(
      "SELECT u.id,u.name,u.email,u.role,u.student_id,u.auth_id,u.identity_id,u.active,u.membership_status,u.membership_reason,u.must_change_password FROM sessions s JOIN users u ON u.id=s.user_id JOIN identities i ON i.id=u.identity_id WHERE s.token=? AND s.expires>? AND s.auth_version=i.version",
      token(req),
      Date.now(),
    );
    ensure(user, "Please sign in to continue.", 401);
    res.locals.user = user;
    if (!["/membership", "/logout", "/account/password"].includes(req.path)) {
      ensure(
        user.membership_status === "Approved" && user.active === 1,
        "Your community Admin must approve and enable your membership before you can access records.",
        403,
      );
      ensure(
        !user.must_change_password || req.path === "/workspace",
        "Change your temporary password before continuing.",
        403,
      );
    }
    next();
  });
  app.get("/api/membership", (_req, res) => {
    const u = res.locals.user;
    res.json({
      community: res.locals.community,
      name: u.name,
      role: u.role,
      status: u.active ? u.membership_status : "Disabled",
      reason: u.membership_reason,
    });
  });
  app.post("/api/account/password", async (req, res) => {
    const b = req.body,
      u = res.locals.user;
    ensure(
      text(b.password, 200) && b.password.length >= 12,
      "Use a new password of at least 12 characters.",
    );
    const person = await identity({ email: u.email, password: b.current });
    if (person.auth_id) {
      const result = await supabase().auth.admin.updateUserById(
        person.auth_id,
        { password: b.password },
      );
      ensure(!result.error, "Password update failed. Try again.");
    }
    await db.transaction(async () => {
      await db.run(
        "UPDATE identities SET password=?,version=version+1 WHERE id=?",
        person.auth_id ? "supabase" : hashPassword(b.password),
        person.id,
      );
      await db.run("UPDATE users SET must_change_password=0 WHERE id=?", u.id);
      await log(
        u.name,
        "Password changed",
        "Sessions in all communities revoked.",
      );
    });
    res.clearCookie("h360_session", cookie).json({ ok: true });
  });
  app.get("/api/accounts", async (_req, res) => {
    admin(res);
    res.json(
      await db.all(
        "SELECT u.id,u.name,u.email,u.role,u.student_id,u.active,u.membership_status,u.membership_reason,a.id AS application_id,a.phone,a.department,a.course,a.year,a.academic_year,a.guardian,a.guardian_phone,a.address,a.admission_type FROM users u LEFT JOIN applications a ON a.user_id=u.id AND a.status IN ('Submitted','Under Review') ORDER BY CASE WHEN u.membership_status='Pending' THEN 0 ELSE 1 END,u.id",
      ),
    );
  });
  app.post("/api/accounts", (_req, res) => {
    admin(res);
    res.status(409).json({
      error:
        "Share your community code. People choose their own password and request access; you approve their membership here.",
    });
  });
  app.post("/api/accounts/:id", async (req, res) => {
    admin(res);
    const id = Number(req.params.id),
      b = req.body;
    ensure(id !== me(res).id, "You cannot change your own community access.");
    ensure(
      !b.password && b.role === undefined,
      "Community Admins cannot change another person's password or requested role.",
      403,
    );
    await db.transaction(async () => {
      const user = await db.get("SELECT * FROM users WHERE id=?", id);
      ensure(user, "Member not found.", 404);
      // A pending Admin request is decided by an existing Admin; an approved
      // Admin's access cannot be changed by another Admin.
      ensure(
        user.role !== "Admin" ||
          (user.membership_status === "Pending" && b.status !== undefined),
        "Another Admin’s access cannot be changed here.",
        403,
      );
      if (b.status !== undefined) {
        ensure(
          ["Approved", "Rejected"].includes(b.status),
          "Choose approve or reject.",
        );
        ensure(
          b.status !== "Rejected" || text(b.reason, 500),
          "Give a reason for rejecting access.",
        );
        // A student who sent hostel details is approved by assigning a room.
        const application = await db.get(
          "SELECT id FROM applications WHERE user_id=? AND status IN ('Submitted','Under Review')",
          id,
        );
        ensure(
          !application || b.status !== "Approved" || integer(b.student_id),
          "Assign a room to approve this student, or link an existing student record.",
          409,
        );
        if (application && b.status === "Rejected")
          await db.run(
            "UPDATE applications SET status='Rejected',reason=? WHERE id=?",
            b.reason.trim(),
            application.id,
          );
        await db.run(
          "UPDATE users SET membership_status=?,membership_reason=?,active=1 WHERE id=?",
          b.status,
          b.status === "Rejected" ? b.reason.trim() : "",
          id,
        );
      } else {
        ensure(
          [0, 1].includes(b.active) && user.membership_status === "Approved",
          "Approve membership before changing access.",
        );
        await db.run("UPDATE users SET active=? WHERE id=?", b.active, id);
      }
      if (b.student_id !== undefined) {
        ensure(
          user.role === "Student",
          "Only Student members can link to a student record.",
        );
        ensure(
          b.student_id === null ||
            (integer(b.student_id) &&
              (await db.get(
                "SELECT id FROM students WHERE id=?",
                b.student_id,
              ))),
          "Choose a student from this community.",
        );
        ensure(
          b.student_id === null ||
            !(await db.get(
              "SELECT id FROM users WHERE student_id=? AND id<>?",
              b.student_id,
              id,
            )),
          "That student is already linked to another member.",
        );
        await db.run(
          "UPDATE users SET student_id=? WHERE id=?",
          b.student_id,
          id,
        );
      }
      await db.run("DELETE FROM sessions WHERE user_id=?", id);
      await log(
        me(res).name,
        "Membership updated",
        `${user.email} · ${b.status || (b.active ? "Enabled" : "Disabled")} · ${b.reason || ""}`,
      );
    });
    res.json({ ok: true });
  });
}
