import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { Store, type Row } from "../server/store.ts";
import { createApp } from "../server/app.ts";

const url =
  process.env.LEAVE_TEST_DATABASE_URL ||
  process.env.COMMUNITY_TEST_DATABASE_URL;

test(
  "students apply for leave, a Warden approved by the Admin decides it, and approved days stay Leave in attendance",
  { skip: !url },
  async (t) => {
    const owner = new pg.Pool({ connectionString: url });
    assert(
      (
        await owner.query("SELECT current_database() AS name")
      ).rows[0].name.endsWith("_test"),
    );
    const role = "hostel360_community_test";
    await owner.query("DROP SCHEMA IF EXISTS hostel360 CASCADE");
    for (const m of [
      "20261111000000_hostel360",
      "20261111010000_communities",
      "20261115010000_gateway",
      "20261115020000_payment_recovery",
      "20261121010000_parent_details",
      "20261123010000_leave_warden",
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
      connectionString: url,
      options: `-c role=${role}`,
    });
    const db = new Store(pool, true);
    // Stands in for Supabase Storage, where medical documents are kept.
    const stored: string[] = [];
    const storage = createServer((req, res) => {
      if (
        req.method === "POST" &&
        req.url?.includes("/object/student-documents/")
      )
        stored.push(req.url);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ Key: "ok", signedURL: "/signed?token=1" }));
    }).listen(0, "127.0.0.1");
    await once(storage, "listening");
    const server = createApp(db).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => storage.close(() => resolve()));
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      await pool.end();
      await owner.end();
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    const request = async (path: string, cookie = "", body?: unknown) => {
      const r = await fetch(
        `http://127.0.0.1:${address.port}/api${path}${path.includes("?") ? "&" : "?"}community=jss`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Hostel360": "1",
            cookie,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      return {
        status: r.status,
        body: await r.json(),
        cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
      };
    };
    const password = "LeaveExample12!";
    const join = (email: string, role: string, application?: Row) =>
      request("/communities/join", "", {
        code: "jss",
        name: email.split("@")[0],
        email,
        password,
        role,
        ...(application ? { application } : {}),
      });
    const login = async (email: string) => {
      const r = await request("/login", "", { email, password });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.cookie;
    };
    // The hostel and its first Admin.
    const community = await db.get(
      "INSERT INTO communities (code,name,created_at) VALUES ('jss','JSS PDA',?) RETURNING *",
      new Date().toISOString(),
    );
    assert.equal((await join("admin@test.local", "Manager")).status, 201);
    await db.inCommunity(community.id, () =>
      db.run(
        "UPDATE users SET role='Admin',membership_status='Approved' WHERE email='admin@test.local'",
      ),
    );
    const admin = await login("admin@test.local");
    const members = async () => (await request("/accounts", admin)).body;
    const approve = async (email: string, extra: Row = {}) => {
      const u = (await members()).find((u: Row) => u.email === email);
      const r = await request(`/accounts/${u.id}`, admin, {
        status: "Approved",
        ...extra,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    };

    // A Warden registers like anyone else and waits for the Admin.
    assert.equal((await join("warden@test.local", "Warden")).status, 201);
    assert.equal(
      (await request("/leaves", await login("warden@test.local"))).status,
      403,
    );
    await approve("warden@test.local");
    const warden = await login("warden@test.local");
    const wardenView = (await request("/workspace", warden)).body;
    assert.equal(wardenView.user.role, "Warden");
    assert.deepEqual([wardenView.demands, wardenView.payments], [[], []]);
    assert.equal(
      (await request("/reports?from=2026-01-01&to=2026-12-31", warden)).status,
      403,
    );

    // Two admitted students, approved with a room in one step.
    const admit = async (email: string) => {
      assert.equal(
        (
          await join(email, "Student", {
            phone: "9876543210",
            department: "CS",
            course: "Diploma",
            year: 1,
            academic_year: "2026-2027",
            guardian: "Parent",
            guardian_phone: "9123456780",
            address: "Mysuru",
            admission_type: "Fresher",
          })
        ).status,
        201,
      );
      const application = (await request("/applications", admin)).body.find(
        (a: Row) => a.email === email,
      );
      const r = await request(`/applications/${application.id}/review`, admin, {
        status: "Approved",
        room: "A1",
        joined: "2026-08-01",
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return { cookie: await login(email), id: r.body.student_id };
    };
    const asha = await admit("asha@test.local"),
      bina = await admit("bina@test.local");
    const apply = (who: { cookie: string }, body: Row) =>
      request("/leaves", who.cookie, body);
    const casual = {
      type: "Casual",
      start_date: "2026-11-02",
      end_date: "2026-11-04",
      reason: "Family function",
    };
    assert.equal((await request("/leaves", admin, casual)).status, 403);
    assert.equal(
      (await apply(asha, { ...casual, end_date: "2026-11-01" })).status,
      400,
    );
    assert.equal((await apply(asha, casual)).status, 201);
    assert.equal(
      (
        await apply(asha, {
          ...casual,
          start_date: "2026-11-04",
          end_date: "2026-11-05",
        })
      ).status,
      409,
    );
    // Medical leave needs a document, which is stored privately.
    const medical = {
      type: "Medical",
      start_date: "2026-11-10",
      end_date: "2026-11-11",
      reason: "Fever",
    };
    assert.equal((await apply(bina, medical)).status, 400);
    process.env.SUPABASE_URL = `http://127.0.0.1:${(storage.address() as Row).port}`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
    assert.equal(
      (
        await apply(bina, {
          ...medical,
          document: {
            name: "note.txt",
            content: Buffer.from("hello").toString("base64"),
          },
        })
      ).status,
      400,
    );
    const pdf = Buffer.from("%PDF-1.4 medical certificate").toString("base64");
    assert.equal(
      (
        await apply(bina, {
          ...medical,
          document: { name: "certificate.pdf", content: pdf },
        })
      ).status,
      201,
    );
    assert.equal(stored.length, 1);

    // Students see only their own requests; the Warden is told what waits.
    const mine = (await request("/leaves", bina.cookie)).body;
    assert.deepEqual(
      mine.map((l: Row) => [l.type, l.status, l.document_name]),
      [["Medical", "Pending", "certificate.pdf"]],
    );
    assert.equal((await request("/workspace", warden)).body.pending_leaves, 2);
    const all = (await request("/leaves", warden)).body;
    const ashaLeave = all.find((l: Row) => l.student_id === asha.id),
      binaLeave = all.find((l: Row) => l.student_id === bina.id);
    assert.equal(
      (
        await request(`/leaves/${ashaLeave.id}/review`, admin, {
          status: "Approved",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(`/leaves/${binaLeave.id}/review`, warden, {
          status: "Rejected",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`/leaves/${ashaLeave.id}/review`, warden, {
          status: "Approved",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`/leaves/${binaLeave.id}/review`, warden, {
          status: "Rejected",
          reason: "Certificate is unreadable",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`/leaves/${ashaLeave.id}/review`, warden, {
          status: "Rejected",
          reason: "x",
        })
      ).status,
      409,
    );
    assert.equal((await request("/workspace", warden)).body.pending_leaves, 0);

    // Approved days are Leave in attendance, even if marked Present later.
    const manager = admin;
    const day = async (date: string) =>
      (await request(`/attendance?date=${date}`, manager)).body.find(
        (r: Row) => r.student_id === asha.id,
      );
    assert.deepEqual(await day("2026-11-02"), {
      student_id: asha.id,
      status: "Leave",
      approved_leave: true,
    });
    assert.equal(
      (
        await request("/attendance", manager, {
          date: "2026-11-03",
          entries: [
            { student_id: asha.id, status: "Present" },
            { student_id: bina.id, status: "Present" },
          ],
        })
      ).status,
      200,
    );
    assert.equal((await day("2026-11-03")).status, "Leave");
    assert.equal(
      (await request("/attendance?date=2026-11-03", manager)).body.find(
        (r: Row) => r.student_id === bina.id,
      ).status,
      "Present",
    );
    assert.equal(await day("2026-11-05"), undefined);

    // Pending requests can be cancelled; finalized mess months are closed.
    await apply(asha, {
      ...casual,
      start_date: "2026-11-20",
      end_date: "2026-11-21",
    });
    const pending = (await request("/leaves", asha.cookie)).body.find(
      (l: Row) => l.status === "Pending",
    );
    assert.equal(
      (await request(`/leaves/${pending.id}/cancel`, bina.cookie, {})).status,
      404,
    );
    assert.equal(
      (await request(`/leaves/${pending.id}/cancel`, asha.cookie, {})).status,
      200,
    );
    assert.equal(
      (await request(`/leaves/${ashaLeave.id}/cancel`, asha.cookie, {})).status,
      409,
    );
    await db.inCommunity(community.id, () =>
      db.run(
        "INSERT INTO billing_periods (period,snapshot,created_at) VALUES ('2026-10','{}',?)",
        new Date().toISOString(),
      ),
    );
    assert.equal(
      (
        await apply(asha, {
          ...casual,
          start_date: "2026-10-30",
          end_date: "2026-11-01",
        })
      ).status,
      409,
    );
  },
);
