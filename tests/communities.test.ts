import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import pg from "pg";
import ExcelJS from "exceljs";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { hashPassword } from "../server/db.ts";

test(
  "community membership, isolation and shared identities on restricted PostgreSQL",
  { skip: !process.env.COMMUNITY_TEST_DATABASE_URL },
  async (t) => {
    const owner = new pg.Pool({
      connectionString: process.env.COMMUNITY_TEST_DATABASE_URL,
    });
    const name = (await owner.query("SELECT current_database() AS name"))
      .rows[0].name;
    assert(
      name.endsWith("_test"),
      "Use a disposable database ending in _test; its hostel360 schema is replaced",
    );
    const role = process.env.COMMUNITY_TEST_ROLE || "hostel360_community_test";
    assert(/^[a-z_][a-z0-9_]*$/.test(role));
    const pool = new pg.Pool({
      connectionString: process.env.COMMUNITY_TEST_DATABASE_URL,
      options: `-c role=${role}`,
      max: 4,
    });
    t.after(async () => {
      await pool.end();
      await owner.end();
    });
    await owner.query("DROP SCHEMA IF EXISTS hostel360 CASCADE");
    await owner.query(
      await readFile(
        new URL(
          "../supabase/migrations/20261111000000_hostel360.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await owner.query(
      "INSERT INTO hostel360.students (id,code,roll,name,department,year,room,phone,joined) VALUES (500,'OLD-500','LEGACY','Legacy resident','CS',1,'L1','9999999999','2025-01-01')",
    );
    await owner.query(
      "INSERT INTO hostel360.users (name,email,password,role) VALUES ('Legacy Admin','legacy@test.local',$1,'Admin')",
      [hashPassword("LegacyPassword12!")],
    );
    await owner.query(
      await readFile(
        new URL(
          "../supabase/migrations/20261111010000_communities.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await owner.query(
      await readFile(
        new URL(
          "../supabase/migrations/20261121010000_parent_details.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    for (const name of [
      "20261115010000_gateway",
      "20261115020000_payment_recovery",
    ])
      await owner.query(
        await readFile(
          new URL(`../supabase/migrations/${name}.sql`, import.meta.url),
          "utf8",
        ),
      );
    await owner.query(
      `GRANT USAGE ON SCHEMA hostel360 TO ${role}; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA hostel360 TO ${role}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA hostel360 TO ${role}; GRANT DELETE ON hostel360.sessions,hostel360.login_attempts,hostel360.onboarding_attempts TO ${role}`,
    );
    const permission = (
      await pool.query(
        "SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    assert.equal(permission.current_user, role);
    assert.equal(permission.rolsuper, false);
    assert.equal(permission.rolbypassrls, false);
    const db = new Store(pool, true);
    const server = createApp(db).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const address = server.address();
    assert(address && typeof address !== "string");
    const request = async (
      path: string,
      code = "",
      cookie = "",
      body?: unknown,
    ) => {
      const r = await fetch(
        `http://127.0.0.1:${address.port}/api${path}${path.includes("?") ? "&" : "?"}community=${code}`,
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
        body: r.headers.get("content-type")?.includes("json")
          ? await r.json()
          : Buffer.from(await r.arrayBuffer()),
        cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
      };
    };
    const password = "CommunityTest12!";
    const login = async (code: string, email: string, pass = password) => {
      const r = await request("/login", code, "", { email, password: pass });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.cookie;
    };
    const create = async (name: string, email: string) => {
      const r = await request("/communities", "", "", {
        name: `${name} Admin`,
        community_name: name,
        email,
        password,
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return {
        ...r.body.community,
        cookie: await login(r.body.community.code, email),
      };
    };
    const a = await create("Cedar House", "cedar@test.local"),
      b = await create("River House", "river@test.local");
    const join = async (community: typeof a, email: string, role: string) =>
      request("/communities/join", "", "", {
        code: community.code,
        name: email.split("@")[0],
        email,
        password,
        role,
        ...(role === "Student"
          ? {
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
            }
          : {}),
      });
    const members = async (c: typeof a) =>
      (await request("/accounts", c.code, c.cookie)).body;
    const approve = async (c: typeof a, email: string, extra = {}) => {
      const u = (await members(c)).find((u: any) => u.email === email);
      const r = await request(`/accounts/${u.id}`, c.code, c.cookie, {
        status: "Approved",
        ...extra,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return u.id;
    };
    let managerId: number,
      studentId: number,
      studentA: number,
      studentB: number;
    await t.test(
      "migration preserves existing records; missing context denies reads and writes",
      async () => {
        const legacy = await db.get("SELECT code FROM communities WHERE id=1");
        const cookie = await login(
          legacy.code,
          "legacy@test.local",
          "LegacyPassword12!",
        );
        assert.equal(
          (await request("/workspace", legacy.code, cookie)).body.students[0]
            .name,
          "Legacy resident",
        );
        assert.deepEqual(await db.all("SELECT * FROM students"), []);
        await assert.rejects(
          db.run("INSERT INTO settings (key,value) VALUES ('escape','bad')"),
        );
        assert.equal((await request("/workspace", "", a.cookie)).status, 401);
        assert.equal(
          (await request("/workspace", b.code, a.cookie)).status,
          401,
        );
        assert.equal((await request("/setup", "", "", {})).status, 410);
      },
    );
    await t.test(
      "communities get readable unique IDs and can be found by name",
      async () => {
        // Names become IDs; a second hostel with the same name gets a suffix.
        assert.equal(a.code, "cedar-house");
        const twin = await request("/communities", "", "", {
          name: "Twin Admin",
          community_name: "Cedar House",
          email: "twin@test.local",
          password,
        });
        assert.equal(twin.status, 201, JSON.stringify(twin.body));
        assert.equal(twin.body.community.code, "cedar-house-2");
        const chosen = await request("/communities", "", "", {
          name: "Chosen Admin",
          community_name: "Sai’s Hostel",
          code: "Sai Boys Hostel",
          custom_code: true,
          email: "chosen@test.local",
          password,
        });
        assert.equal(chosen.body.community.code, "sai-boys-hostel");
        const taken = await request("/communities", "", "", {
          name: "Late Admin",
          community_name: "Another",
          code: "sai-boys-hostel",
          custom_code: true,
          email: "late@test.local",
          password,
        });
        assert.equal(taken.status, 409);
        // A taken suggestion (not typed by the Admin) never blocks creation.
        const suggested = await request("/communities", "", "", {
          name: "Suggested Admin",
          community_name: "Sai Boys Hostel",
          code: "sai-boys-hostel",
          email: "suggested@test.local",
          password,
        });
        assert.equal(suggested.status, 201, JSON.stringify(suggested.body));
        assert.equal(suggested.body.community.code, "sai-boys-hostel-2");
        assert.deepEqual(
          (await request("/communities/available?code=Sai Boys Hostel", "", ""))
            .body,
          {
            code: "sai-boys-hostel",
            valid: true,
            available: false,
            suggestion: "sai-boys-hostel-3",
          },
        );
        // One existing account can create a second community with its password.
        const second = await request("/communities", "", "", {
          name: "Cedar Admin",
          community_name: "Cedar Annex",
          email: "cedar@test.local",
          password,
        });
        assert.equal(second.status, 201, JSON.stringify(second.body));
        assert.equal(
          (await db.get("SELECT id FROM identities WHERE email='late@test.local'")),
          undefined,
          "a rejected ID must not leave a half-created account",
        );
        const found = (await request("/communities/search?q=cedar", "", ""))
          .body;
        assert.deepEqual(
          found.map((c: any) => c.code),
          ["cedar-annex", "cedar-house", "cedar-house-2"],
        );
        assert.deepEqual(Object.keys(found[0]).sort(), ["code", "name"]);
        assert.deepEqual(
          (await request("/communities/search?q=sai-boys-hostel", "", ""))
            .body[0],
          { code: "sai-boys-hostel", name: "Sai’s Hostel" },
        );
        assert.deepEqual(
          (await request("/communities/search?q=legacy", "", "")).body,
          [],
        );
      },
    );
    await t.test(
      "only creators become Admin; pending managers and students cannot see or change records",
      async () => {
        assert.equal((await join(a, "evil@test.local", "Admin")).status, 400);
        for (const [email, role] of [
          ["manager@test.local", "Manager"],
          ["student@test.local", "Student"],
        ]) {
          assert.equal((await join(a, email, role)).status, 201);
          assert.equal(
            (await request("/workspace", a.code, a.cookie)).body
              .pending_members,
            role === "Manager" ? 1 : 2,
          );
          const cookie = await login(a.code, email);
          assert.equal(
            (await request("/membership", a.code, cookie)).body.status,
            "Pending",
          );
          for (const path of [
            "/workspace",
            "/accounts",
            "/backup",
            "/export/students",
            "/documents/1",
            "/backups",
          ])
            assert.equal(
              (await request(path, a.code, cookie)).status,
              403,
              path,
            );
          assert.equal(
            (
              await request("/accounts/1", a.code, cookie, {
                status: "Approved",
              })
            ).status,
            403,
          );
        }
        assert.equal(
          (await join(a, "student@test.local", "Manager")).status,
          409,
        );
        managerId = await approve(a, "manager@test.local");
        assert.equal(
          (await request("/workspace", a.code, a.cookie)).body.pending_members,
          1,
        );
        const manager = await login(a.code, "manager@test.local");
        assert.equal((await request("/accounts", a.code, manager)).status, 403);
        assert.equal(
          (
            await request(`/accounts/${managerId}`, a.code, manager, {
              status: "Approved",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await request(`/accounts/${managerId}`, b.code, b.cookie, {
              status: "Approved",
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await request(`/accounts/${managerId}`, a.code, a.cookie, {
              password: "ResetSomeone12!",
            })
          ).status,
          403,
        );
      },
    );
    await t.test(
      "concurrent communities can reuse rolls, fee names, periods, receipts and idempotency keys without mixing ledgers",
      async () => {
        const setup = async (c: typeof a, name: string, amount: number) => {
          const s = await request("/students", c.code, c.cookie, {
            name,
            roll: "SHARED-ROLL",
            department: "CS",
            year: 1,
            room: "A1",
            phone: "9999999999",
            guardian: "Guardian",
            admission_type: "Fresher",
            joined: "2025-01-01",
            course: "B.E.",
            academic_year: "2025-2026",
          });
          assert.equal(s.status, 201, JSON.stringify(s.body));
          assert(s.body.id > 500);
          assert.equal(
            (
              await request("/components", c.code, c.cookie, {
                category: "Fund",
                name: "Annual fund",
                amount,
                academic_year: "2025-2026",
                applicability: "All",
                active: 1,
              })
            ).status,
            200,
          );
          const input = {
            academic_year: "2025-2026",
            period: "2025-01",
            student_ids: [s.body.id],
          };
          const preview = await request(
            "/admission/preview",
            c.code,
            c.cookie,
            input,
          );
          assert.equal(preview.body.total, amount);
          assert.equal(
            (
              await request("/admission/finalize", c.code, c.cookie, {
                ...input,
                expected_rows: preview.body.rows,
              })
            ).status,
            201,
          );
          const demand = (await request("/workspace", c.code, c.cookie)).body
            .demands[0];
          const payment = {
            student_id: s.body.id,
            amount: amount - 1700,
            date: "2025-02-01",
            mode: "Cash",
            reference: "Paid",
            idempotency_key: "same-key-across-communities",
            allocations: [{ demand_id: demand.id, amount: amount - 1700 }],
          };
          const p = await request("/payments", c.code, c.cookie, payment);
          assert.equal(p.status, 201, JSON.stringify(p.body));
          assert.equal(p.body.receipt, "FUND-000001");
          assert.equal(
            (await request("/payments", c.code, c.cookie, payment)).status,
            200,
          );
          return { student: s.body.id, payment: p.body.id };
        };
        const [aa, bb] = await Promise.all([
          setup(a, "Cedar Resident", 21700),
          setup(b, "River Resident", 53700),
        ]);
        studentA = aa.student;
        studentB = bb.student;
        assert.notEqual(studentA, studentB);
        for (let i = 0; i < 8; i++) {
          const [wa, wb] = await Promise.all([
            request("/workspace", a.code, a.cookie),
            request("/workspace", b.code, b.cookie),
          ]);
          assert.deepEqual(
            wa.body.students.map((s: any) => s.name),
            ["Cedar Resident"],
          );
          assert.deepEqual(
            wb.body.students.map((s: any) => s.name),
            ["River Resident"],
          );
          assert.equal(wa.body.payments[0].amount, 20000);
          assert.equal(wb.body.payments[0].amount, 52000);
        }
        assert.equal(
          (await request(`/receipts/${bb.payment}`, a.code, a.cookie)).status,
          404,
        );
        assert.equal(
          (
            await request(`/students/${studentB}/update`, a.code, a.cookie, {
              reason: "attack",
            })
          ).status,
          404,
        );
        const archive = await request("/backup", a.code, a.cookie);
        assert.equal(archive.body.community.id, a.id);
        assert.equal(archive.body.students.length, 1);
        assert.equal(archive.body.students[0].id, studentA);
        assert(!JSON.stringify(archive.body).includes("River Resident"));
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(
          (await request("/export/students", a.code, a.cookie)).body,
        );
        assert(
          JSON.stringify(workbook.worksheets[0].getSheetValues()).includes(
            "Cedar Resident",
          ),
        );
        assert(
          !JSON.stringify(workbook.worksheets[0].getSheetValues()).includes(
            "River Resident",
          ),
        );
        await assert.rejects(
          db.inCommunity(a.id, () =>
            db.run(
              "INSERT INTO attendance (student_id,date,status,recorded_by,updated_at) VALUES (?,'2025-01-02','Present',?,?)",
              studentB,
              managerId,
              new Date().toISOString(),
            ),
          ),
          (e: any) => e.code === "23503",
        );
        assert.notEqual(
          db.inCommunity(a.id, () => db.backupFolder),
          db.inCommunity(b.id, () => db.backupFolder),
        );
      },
    );
    await t.test(
      "student linking is community-local; rejected and disabled members remain locked out",
      async () => {
        const u = (await members(a)).find(
          (u: any) => u.email === "student@test.local",
        );
        studentId = u.id;
        assert.equal(
          (
            await request(`/accounts/${studentId}`, a.code, a.cookie, {
              status: "Approved",
              student_id: studentB,
            })
          ).status,
          400,
        );
        assert.equal(
          (await members(a)).find((u: any) => u.id === studentId)
            .membership_status,
          "Pending",
        );
        await approve(a, "student@test.local", { student_id: studentA });
        let cookie = await login(a.code, "student@test.local");
        assert.deepEqual(
          (await request("/workspace", a.code, cookie)).body.students.map(
            (s: any) => s.id,
          ),
          [studentA],
        );
        assert.equal(
          (
            await request(`/accounts/${studentId}`, a.code, a.cookie, {
              status: "Rejected",
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await request(`/accounts/${studentId}`, a.code, a.cookie, {
              status: "Rejected",
              reason: "Wrong resident",
            })
          ).status,
          200,
        );
        assert.equal((await request("/workspace", a.code, cookie)).status, 401);
        cookie = await login(a.code, "student@test.local");
        assert.equal(
          (await request("/membership", a.code, cookie)).body.reason,
          "Wrong resident",
        );
        assert.equal((await request("/workspace", a.code, cookie)).status, 403);
        await approve(a, "student@test.local", { student_id: studentA });
        cookie = await login(a.code, "student@test.local");
        assert.equal(
          (
            await request(`/accounts/${studentId}`, a.code, a.cookie, {
              active: 0,
            })
          ).status,
          200,
        );
        assert.equal((await request("/workspace", a.code, cookie)).status, 401);
        const disabled = await login(a.code, "student@test.local");
        assert.equal(
          (await request("/membership", a.code, disabled)).body.status,
          "Disabled",
        );
        assert.equal(
          (await request("/workspace", a.code, disabled)).status,
          403,
        );
      },
    );
    await t.test(
      "one identity has independent approvals; password changes revoke every community session",
      async () => {
        assert.equal(
          (await join(b, "manager@test.local", "Student")).status,
          201,
        );
        let cb = await login(b.code, "manager@test.local");
        assert.equal(
          (await request("/membership", b.code, cb)).body.status,
          "Pending",
        );
        // Approving a student who sent details takes a room, in one step.
        const request0 = (await members(b)).find(
          (u: any) => u.email === "manager@test.local",
        );
        // Parent details reach the Admin; no college ID is collected.
        assert.deepEqual(
          [request0.guardian, request0.guardian_phone, request0.roll],
          ["Parent", "9123456780", undefined],
        );
        assert.equal(
          (
            await request(`/accounts/${request0.id}`, b.code, b.cookie, {
              status: "Approved",
            })
          ).status,
          409,
        );
        const decided = await request(
          `/applications/${request0.application_id}/review`,
          b.code,
          b.cookie,
          { status: "Approved", room: "R-12", joined: "2026-01-05" },
        );
        assert.equal(decided.status, 200, JSON.stringify(decided.body));
        assert.equal(
          (await members(b)).find((u: any) => u.id === request0.id)
            .membership_status,
          "Approved",
        );
        cb = await login(b.code, "manager@test.local");
        const ca = await login(a.code, "manager@test.local");
        assert.equal(
          (await request("/workspace", a.code, ca)).body.user.role,
          "Manager",
        );
        const wb = (await request("/workspace", b.code, cb)).body;
        assert.equal(wb.user.role, "Student");
        // The hostel code stands in for the college ID; parent phone carries over.
        assert.deepEqual(
          wb.students.map((s: any) => [s.roll === s.code, s.room, s.guardian_phone]),
          [[true, "R-12", "9123456780"]],
        );
        assert.equal(
          (
            await request("/account/password", a.code, ca, {
              current: password,
              password: "ChangedEverywhere12!",
            })
          ).status,
          200,
        );
        assert.equal((await request("/workspace", a.code, ca)).status, 401);
        assert.equal((await request("/workspace", b.code, cb)).status, 401);
        const fresh = await login(
          b.code,
          "manager@test.local",
          "ChangedEverywhere12!",
        );
        assert.equal((await request("/workspace", b.code, fresh)).status, 200);
        assert.equal(
          (
            await request("/login", a.code, "", {
              email: "manager@test.local",
              password,
            })
          ).status,
          401,
        );
      },
    );
  },
);
