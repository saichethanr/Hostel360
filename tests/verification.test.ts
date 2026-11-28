import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import pg from "pg";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";

// A new email must enter the code Supabase Auth sends before it can join.
// A small stand-in for the Supabase Auth API plays the email provider.
test(
  "new emails must verify a code before joining; existing accounts are not asked",
  { skip: !process.env.COMMUNITY_TEST_DATABASE_URL },
  async (t) => {
    const owner = new pg.Pool({
      connectionString: process.env.COMMUNITY_TEST_DATABASE_URL,
    });
    const role = process.env.COMMUNITY_TEST_ROLE || "hostel360_community_test";
    await owner.query("DROP SCHEMA IF EXISTS hostel360 CASCADE");
    for (const m of [
      "20261111000000_hostel360",
      "20261111010000_communities",
      "20261121010000_parent_details",
      "20261123010000_leave_warden",
      "20261124010000_sponsors",
      "20261125010000_meal_tokens",
      "20261128010000_holidays_concession",
      "20261129010000_admission_heads",
    ])
      await owner.query(
        await readFile(
          new URL(`../supabase/migrations/${m}.sql`, import.meta.url),
          "utf8",
        ),
      );
    await owner.query(
      `GRANT USAGE ON SCHEMA hostel360 TO ${role}; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA hostel360 TO ${role}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA hostel360 TO ${role}; GRANT DELETE ON hostel360.sessions,hostel360.login_attempts,hostel360.onboarding_attempts TO ${role}`,
    );
    const pool = new pg.Pool({
      connectionString: process.env.COMMUNITY_TEST_DATABASE_URL,
      options: `-c role=${role}`,
    });

    // Fake Supabase Auth: users keyed by email, one code per email.
    const users = new Map<
      string,
      { id: string; password: string; confirmed: boolean }
    >();
    const codes = new Map<string, string>();
    const sent: string[] = [];
    const auth = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url!, "http://x");
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const user = (email: string) => {
        const u = users.get(email)!;
        return {
          id: u.id,
          email,
          aud: "authenticated",
          email_confirmed_at: u.confirmed ? new Date().toISOString() : null,
        };
      };
      const session = (email: string) => ({
        access_token: "t",
        refresh_token: "r",
        token_type: "bearer",
        expires_in: 3600,
        user: user(email),
      });
      if (url.pathname === "/auth/v1/otp") {
        if (!users.has(body.email))
          users.set(body.email, {
            id: crypto.randomUUID(),
            password: "",
            confirmed: false,
          });
        codes.set(body.email, String(100000 + sent.length));
        sent.push(body.email);
        return json(200, {});
      }
      if (url.pathname === "/auth/v1/verify") {
        if (codes.get(body.email) !== body.token)
          return json(403, {
            code: 403,
            msg: "Token has expired or is invalid",
          });
        codes.delete(body.email);
        users.get(body.email)!.confirmed = true;
        return json(200, session(body.email));
      }
      if (url.pathname === "/auth/v1/token") {
        const u = users.get(body.email);
        if (!u || !u.password || u.password !== body.password)
          return json(400, {
            code: 400,
            error_code: "invalid_credentials",
            msg: "Invalid login credentials",
          });
        return json(200, session(body.email));
      }
      if (url.pathname === "/auth/v1/admin/users" && req.method === "POST") {
        if (users.has(body.email))
          return json(422, {
            code: 422,
            error_code: "email_exists",
            msg: "exists",
          });
        users.set(body.email, {
          id: crypto.randomUUID(),
          password: body.password,
          confirmed: true,
        });
        return json(200, user(body.email));
      }
      if (url.pathname === "/auth/v1/admin/generate_link") {
        if (!users.has(body.email)) return json(404, { msg: "not found" });
        return json(200, { ...user(body.email), properties: {} });
      }
      const match = url.pathname.match(/^\/auth\/v1\/admin\/users\/(.+)$/);
      if (match && req.method === "PUT") {
        const entry = [...users.entries()].find(([, u]) => u.id === match[1]);
        if (!entry) return json(404, { msg: "not found" });
        if (body.password) entry[1].password = body.password;
        if (body.email_confirm) entry[1].confirmed = true;
        return json(200, user(entry[0]));
      }
      json(404, { msg: `unhandled ${req.method} ${url.pathname}` });
    }).listen(0, "127.0.0.1");
    await once(auth, "listening");
    const authAddress = auth.address() as { port: number };

    const saved = {
      url: process.env.SUPABASE_URL,
      key: process.env.SUPABASE_SERVICE_ROLE_KEY,
      flag: process.env.EMAIL_VERIFICATION,
    };
    process.env.SUPABASE_URL = `http://127.0.0.1:${authAddress.port}`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
    process.env.EMAIL_VERIFICATION = "on";
    const server = createApp(new Store(pool, true)).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      for (const [k, v] of [
        ["SUPABASE_URL", saved.url],
        ["SUPABASE_SERVICE_ROLE_KEY", saved.key],
        ["EMAIL_VERIFICATION", saved.flag],
      ] as const)
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      await new Promise<void>((r) => server.close(() => r()));
      await new Promise<void>((r) => auth.close(() => r()));
      await pool.end();
      await owner.end();
    });
    const port = (server.address() as { port: number }).port;
    const call = async (path: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json", "X-Hostel360": "1" },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, body: await r.json() };
    };
    const password = "VerifyTest12!aa";
    const created = await call("/communities", {
      community_name: "Cedar House",
      name: "Admin",
      email: "admin@test.local",
      password,
    });
    // Community creators verify their email too.
    assert.equal(created.status, 428, JSON.stringify(created.body));
    assert.deepEqual(
      (await call("/email/code", { email: "admin@test.local" })).body,
      {
        required: true,
        sent: true,
      },
    );
    const made = await call("/communities", {
      community_name: "Cedar House",
      name: "Admin",
      email: "admin@test.local",
      password,
      email_code: codes.get("admin@test.local"),
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const code = made.body.community.code;

    const student = {
      code,
      name: "New Student",
      email: "new@test.local",
      password,
      role: "Student",
      application: {
        phone: "9876543210",
        department: "CS",
        course: "B.E.",
        year: 1,
        academic_year: "2026-2027",
        guardian: "Parent",
        guardian_phone: "9123456780",
        address: "Test address",
        admission_type: "Fresher",
      },
    };
    // Without a code, nothing is created.
    assert.equal((await call("/communities/join", student)).status, 428);
    assert.equal(users.has("new@test.local"), false);
    assert.deepEqual(
      (await call("/email/code", { email: "new@test.local" })).body,
      {
        required: true,
        sent: true,
      },
    );
    // A wrong code is refused and creates no membership.
    const wrong = await call("/communities/join", {
      ...student,
      email_code: "999999",
    });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /incorrect or has expired/);
    // The right code lets the request through, once.
    const right = await call("/communities/join", {
      ...student,
      email_code: codes.get("new@test.local"),
    });
    assert.equal(right.status, 201, JSON.stringify(right.body));
    assert.equal(users.get("new@test.local")!.password, password);

    // Signing in needs only the password; codes are for registration.
    const before = sent.length;
    const login = await call(`/login?community=${code}`, {
      email: "new@test.local",
      password,
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.equal(sent.length, before);

    // Someone who knows only an email that received a code cannot take it over.
    await call("/email/code", { email: "victim@test.local" });
    const hijack = await call("/communities/join", {
      ...student,
      email: "victim@test.local",
      email_code: "123",
    });
    assert.equal(hijack.status, 428);
    assert.equal(users.get("victim@test.local")!.password, "");

    // Existing accounts are sent a code too: every registration verifies.
    assert.deepEqual(
      (await call("/email/code", { email: "new@test.local" })).body,
      { required: true, sent: true },
    );

    // Forgot password: the emailed code lets the owner choose a new password,
    // and sessions signed in with the old one end.
    const signIn = (pw: string) =>
      fetch(`http://127.0.0.1:${port}/api/login?community=${code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Hostel360": "1" },
        body: JSON.stringify({ email: "new@test.local", password: pw }),
      });
    const cookie = (await signIn(password)).headers
      .get("set-cookie")!
      .split(";")[0];
    const membership = () =>
      fetch(`http://127.0.0.1:${port}/api/membership?community=${code}`, {
        headers: { Cookie: cookie, "X-Hostel360": "1" },
      });
    assert.equal((await membership()).status, 200);
    const fresh = "ResetTest12!bb";
    const badReset = await call("/password/reset", {
      email: "new@test.local",
      email_code: "999999",
      password: fresh,
    });
    assert.equal(badReset.status, 400);
    assert.equal(users.get("new@test.local")!.password, password);
    const reset = await call("/password/reset", {
      email: "new@test.local",
      email_code: codes.get("new@test.local"),
      password: fresh,
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal((await membership()).status, 401);
    assert.equal((await signIn(password)).status, 401);
    assert.equal((await signIn(fresh)).status, 200);
    // A verified email without an account has nothing to reset.
    const none = await call("/password/reset", {
      email: "victim@test.local",
      email_code: codes.get("victim@test.local"),
      password: fresh,
    });
    assert.equal(none.status, 404);
  },
);
