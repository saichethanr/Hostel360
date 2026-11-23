import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { Store } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { openDatabase, hashPassword } from "../server/db.ts";
import type { Workspace, Preview, Receipt, Student } from "../src/lib.ts";

async function fixture(t: TestContext) {
  const db = openDatabase(":memory:");
  const password = hashPassword("test-password");
  for (const id of [1, 2])
    db.prepare(
      "INSERT INTO students (id,code,roll,name,department,year,room,phone,joined) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      `JSSPDA-2025-000${id}`,
      `ROLL-${id}`,
      `Student ${id}`,
      "Computer Science",
      1,
      "A-101",
      "9000012345",
      "2025-01-29",
    );
  for (const [id, role, active] of [
    [1, "Admin", 1],
    [2, "Manager", 1],
    [3, "Student", 1],
    [4, "Admin", 0],
  ] as const)
    db.prepare(
      "INSERT INTO users (id,name,email,password,role,student_id,active) VALUES (?,?,?,?,?,?,?)",
    ).run(
      id,
      role,
      `${role.toLowerCase()}${id}@test.local`,
      password,
      role,
      role === "Student" ? 1 : null,
      active,
    );
  // Independent ledger fixture: three asymmetric monthly demands and another student's demand.
  for (const [id, sid, period, amount] of [
    [1, 1, "2024-10", 300000],
    [2, 1, "2024-11", 320000],
    [3, 1, "2024-12", 280000],
    [4, 2, "2024-10", 125000],
  ] as const)
    db.prepare(
      "INSERT INTO demands (id,student_id,category,period,description,amount,days,rate,finalized_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      sid,
      "Mess",
      period,
      "Monthly mess charges",
      amount,
      30,
      10000,
      1,
      "2024-12-31T12:00:00Z",
    );
  let store: Store | undefined;
  let pool: pg.Pool | undefined;
  if (process.env.TEST_DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const name = (await pool.query("SELECT current_database() AS name")).rows[0]
      .name;
    assert(
      name.endsWith("_test"),
      "PostgreSQL tests require a disposable database ending in _test",
    );
    await pool.query("DROP SCHEMA IF EXISTS hostel360 CASCADE");
    await pool.query(
      await readFile(
        new URL(
          "../supabase/migrations/20261111000000_hostel360.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await pool.query(
      await readFile(
        new URL(
          "../supabase/migrations/20261121010000_parent_details.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    for (const table of ["students", "users", "demands"]) {
      for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
        const keys = Object.keys(row);
        await pool.query(
          `INSERT INTO hostel360.${table} (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
          Object.values(row),
        );
      }
      await pool.query(
        `SELECT setval(pg_get_serial_sequence('hostel360.${table}','id'),(SELECT MAX(id) FROM hostel360.${table}))`,
      );
    }
    await pool.query(
      "UPDATE hostel360.settings SET value='Greenfield Student Hostel' WHERE key='hostel_name'",
    );
    store = new Store(pool);
  }
  const server = createApp(store || db).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    db.close();
    await pool?.end();
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api`;
  const request = async (path: string, cookie = "", body?: unknown) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hostel360": "1",
        cookie,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
    };
  };
  const login = async (role: string, id: number) => {
    const response = await request("/login", "", {
      email: `${role.toLowerCase()}${id}@test.local`,
      password: "test-password",
    });
    assert.equal(response.status, 200);
    return response.cookie;
  };
  return { request, login };
}

function payment(overrides: Record<string, unknown> = {}) {
  return {
    student_id: 1,
    amount: 900000,
    date: "2025-01-10",
    mode: "UPI",
    reference: "TXN-TEST-1",
    idempotency_key: randomUUID(),
    allocations: [
      { demand_id: 1, amount: 300000 },
      { demand_id: 2, amount: 320000 },
      { demand_id: 3, amount: 280000 },
    ],
    ...overrides,
  };
}

test("roles are enforced at the API; students see only their own records; inactive users cannot sign in", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/workspace")).status, 401);
  assert.equal(
    (
      await f.request("/login", "", {
        email: "admin4@test.local",
        password: "test-password",
      })
    ).status,
    401,
  );
  const manager = await f.login("Manager", 2);
  for (const path of ["/mess/preview", "/mess/finalize", "/settings"])
    assert.equal(
      (await f.request(path, manager, { period: "2025-01" })).status,
      403,
    );
  const student = await f.login("Student", 3);
  const workspace: Workspace = (await f.request("/workspace", student)).body;
  assert.deepEqual(
    workspace.students.map((s) => s.id),
    [1],
  );
  assert.equal(workspace.demands.length, 3);
  assert(workspace.demands.every((d) => d.student_id === 1));
  assert.deepEqual(workspace.audit, []);
  for (const path of [
    "/students",
    "/attendance",
    "/payments",
    "/settings",
    "/mess/preview",
  ])
    assert.equal((await f.request(path, student, {})).status, 403);
  const otherPayment = await f.request(
    "/payments",
    manager,
    payment({
      student_id: 2,
      amount: 125000,
      allocations: [{ demand_id: 4, amount: 125000 }],
    }),
  );
  assert.equal(otherPayment.status, 201);
  assert.equal(
    (await f.request(`/receipts/${otherPayment.body.id}`, student)).status,
    404,
  );
  assert.equal(
    (await f.request("/workspace", student)).body.payments.length,
    0,
  );
  await f.request("/logout", manager, {});
  assert.equal((await f.request("/workspace", manager)).status, 401);
});

test("one multi-month payment produces one consolidated receipt; simultaneous retries do not duplicate it", async (t) => {
  const f = await fixture(t);
  const manager = await f.login("Manager", 2);
  const body = payment();
  const results = await Promise.all([
    f.request("/payments", manager, body),
    f.request("/payments", manager, body),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
  assert.equal(results[0].body.id, results[1].body.id);
  assert.equal(results[0].body.receipt, "MESS-000001");
  const receipt: Receipt = (
    await f.request(`/receipts/${results[0].body.id}`, manager)
  ).body;
  assert.equal(receipt.date, "2025-01-10");
  assert.equal(receipt.amount, 900000);
  assert.deepEqual(
    receipt.allocations.map((a) => [a.period, a.amount]),
    [
      ["2024-10", 300000],
      ["2024-11", 320000],
      ["2024-12", 280000],
    ],
  );
  // Opening the receipt repeatedly is a read, never a new collection.
  await f.request(`/receipts/${receipt.id}`, manager);
  const workspace: Workspace = (await f.request("/workspace", manager)).body;
  assert.equal(workspace.payments.length, 1);
  assert.deepEqual(
    workspace.demands.filter((d) => d.student_id === 1).map((d) => d.balance),
    [0, 0, 0],
  );
  assert.equal(workspace.demands.find((d) => d.id === 4)!.balance, 125000);
  assert.equal(
    (await f.request("/payments", manager, { ...body, reference: "DIFFERENT" }))
      .status,
    409,
  );
});

test("partial payments preserve the balance; overpayments, mismatched totals, duplicate rows and cross-student allocations are atomic failures", async (t) => {
  const f = await fixture(t);
  const manager = await f.login("Manager", 2);
  const partial = payment({
    amount: 150000,
    allocations: [{ demand_id: 1, amount: 150000 }],
  });
  assert.equal((await f.request("/payments", manager, partial)).status, 201);
  let w: Workspace = (await f.request("/workspace", manager)).body;
  assert.equal(w.demands.find((d) => d.id === 1)!.balance, 150000);
  assert.equal(w.payments[0].amount, 150000);
  const invalid = [
    { amount: 150001, allocations: [{ demand_id: 1, amount: 150001 }] },
    { amount: 100000, allocations: [{ demand_id: 1, amount: 100001 }] },
    {
      amount: 100000,
      allocations: [
        { demand_id: 1, amount: 50000 },
        { demand_id: 1, amount: 50000 },
      ],
    },
    {
      amount: 100000,
      allocations: [
        { demand_id: 1, amount: 50000 },
        { demand_id: 4, amount: 50000 },
      ],
    },
    {
      amount: 100000,
      allocations: [
        { demand_id: 2, amount: -1 },
        { demand_id: 1, amount: 100001 },
      ],
    },
    { reference: "" },
    { date: "2025-02-30" },
    { amount: 1.5 },
  ];
  for (const overrides of invalid)
    assert.equal(
      (await f.request("/payments", manager, payment(overrides))).status,
      400,
    );
  w = (await f.request("/workspace", manager)).body;
  assert.equal(w.payments.length, 1);
  assert.equal(w.demands.find((d) => d.id === 1)!.balance, 150000);
  const final = await f.request(
    "/payments",
    manager,
    payment({
      amount: 150000,
      mode: "Cash",
      reference: "",
      allocations: [{ demand_id: 1, amount: 150000 }],
    }),
  );
  assert.equal(final.status, 201);
  assert.equal(final.body.receipt, "MESS-000002");
  assert.equal(
    (await f.request("/workspace", manager)).body.demands.find(
      (d: { id: number }) => d.id === 1,
    ).balance,
    0,
  );
});

test("attendance upserts without duplicates, validates the whole batch, and blocks pre-admission entries", async (t) => {
  const f = await fixture(t);
  const manager = await f.login("Manager", 2);
  const date = "2025-01-29";
  assert.equal(
    (
      await f.request("/attendance", manager, {
        date,
        entries: [{ student_id: 1, status: "Present" }],
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/attendance", manager, {
        date,
        entries: [{ student_id: 1, status: "Leave" }],
      })
    ).status,
    200,
  );
  assert.deepEqual(
    (await f.request(`/attendance?date=${date}`, manager)).body,
    [{ student_id: 1, status: "Leave" }],
  );
  assert.equal(
    (
      await f.request("/attendance", manager, {
        date,
        entries: [
          { student_id: 1, status: "Absent" },
          { student_id: 999, status: "Present" },
        ],
      })
    ).status,
    400,
  );
  assert.deepEqual(
    (await f.request(`/attendance?date=${date}`, manager)).body,
    [{ student_id: 1, status: "Leave" }],
  );
  assert.equal(
    (
      await f.request("/attendance", manager, {
        date: "2025-01-28",
        entries: [{ student_id: 1, status: "Present" }],
      })
    ).status,
    400,
  );
});

test("mess finalization checks completeness, preview staleness and month-end; finalized values survive rate changes", async (t) => {
  const f = await fixture(t);
  const admin = await f.login("Admin", 1);
  const finalize = (p: Preview) =>
    f.request("/mess/finalize", admin, {
      period: p.period,
      expected_rate: p.rate,
      expected_total: p.total,
      expected_rows: p.rows,
    });
  for (const day of ["29", "30"])
    await f.request("/attendance", admin, {
      date: `2025-01-${day}`,
      entries: [
        { student_id: 1, status: "Present" },
        { student_id: 2, status: day === "29" ? "Absent" : "Present" },
      ],
    });
  let p: Preview = (
    await f.request("/mess/preview", admin, { period: "2025-01" })
  ).body;
  assert.deepEqual(
    p.rows.map((r) => [r.days, r.missing, r.amount]),
    [
      [2, 1, 22000],
      [1, 1, 11000],
    ],
  );
  assert.equal((await finalize(p)).status, 400);
  await f.request("/attendance", admin, {
    date: "2025-01-31",
    entries: [
      { student_id: 1, status: "Leave" },
      { student_id: 2, status: "Present" },
    ],
  });
  p = (await f.request("/mess/preview", admin, { period: "2025-01" })).body;
  assert.equal(p.total, 44000);
  await f.request("/attendance", admin, {
    date: "2025-01-29",
    entries: [{ student_id: 1, status: "Absent" }],
  });
  assert.equal((await finalize(p)).status, 409);
  p = (await f.request("/mess/preview", admin, { period: "2025-01" })).body;
  assert.equal(p.total, 33000);
  assert.equal((await finalize(p)).status, 201);
  assert.equal((await finalize(p)).status, 409);
  assert.equal(
    (
      await f.request("/attendance", admin, {
        date: "2025-01-29",
        entries: [{ student_id: 1, status: "Present" }],
      })
    ).status,
    409,
  );
  await f.request("/settings", admin, {
    hostel_name: "Changed hostel",
    daily_rate: 13500,
  });
  const w: Workspace = (await f.request("/workspace", admin)).body;
  assert.deepEqual(
    w.demands
      .filter((d) => d.period === "2025-01")
      .map((d) => [d.days, d.rate, d.amount]),
    [
      [1, 11000, 11000],
      [2, 11000, 22000],
    ],
  );
  assert(w.audit.some((a) => a.action === "Mess demands finalized"));
  const current: Preview = (
    await f.request("/mess/preview", admin, { period: w.today.slice(0, 7) })
  ).body;
  assert.equal((await finalize(current)).status, 400);
});

test("student registration retains both identifiers and rejects duplicate roll numbers without adding a second record", async (t) => {
  const f = await fixture(t);
  const manager = await f.login("Manager", 2);
  const body = {
    name: "New Student",
    roll: "UNIQUE-ROLL",
    department: "Civil",
    year: 2,
    room: "B-104",
    phone: "9876543210",
    guardian: "Test Guardian",
    admission_type: "Existing",
    joined: "2025-03-01",
  };
  const created = await f.request("/students", manager, body);
  assert.equal(created.status, 201);
  assert.equal((await f.request("/students", manager, body)).status, 409);
  const w: Workspace = (await f.request("/workspace", manager)).body;
  assert.equal(w.students.length, 3);
  const student = w.students.find((s) => s.id === created.body.id)!;
  assert.equal(student.code, "JSSPDA-2025-0003");
  assert.equal(student.roll, "UNIQUE-ROLL");
  assert.equal(student.guardian, "Test Guardian");
  assert.equal(student.status, "Active");
});

test("approval and year promotion charge the admission fee structure once per academic year; issued dues stay fixed", async (t) => {
  const f = await fixture(t),
    admin = await f.login("Admin", 1),
    manager = await f.login("Manager", 2);
  const a = {
    name: "Maya",
    email: "maya@test.local",
    phone: "9876543210",
    guardian: "Parent",
    guardian_phone: "9123456780",
    department: "Commerce",
    course: "B.Com",
    year: 1,
    academic_year: "2025-2026",
    address: "Test address",
    admission_type: "Existing",
  };
  const created = await f.request("/applications", manager, a);
  assert.equal(created.status, 201);
  const route = `/applications/${created.body.id}/review`;
  // A single Admin decision: Managers cannot approve, and the old
  // intermediate "Under Review" stage no longer exists.
  assert.equal(
    (await f.request(route, manager, { status: "Approved" })).status,
    403,
  );
  assert.equal(
    (await f.request(route, admin, { status: "Under Review" })).status,
    400,
  );
  const admitted = await f.request(route, admin, {
    status: "Approved",
    room: "B-102",
    joined: "2025-01-29",
  });
  assert.equal(admitted.status, 200);
  assert.equal(
    (
      await f.request(route, admin, {
        status: "Approved",
        room: "B-102",
        joined: "2025-01-29",
      })
    ).status,
    409,
  );
  const sid = admitted.body.student_id;
  const admissionDues = async (period: string) =>
    (await f.request("/workspace", admin)).body.demands
      .filter((d: Row) => d.student_id === sid && d.period === period)
      .map((d: Row) => [d.category, d.description, d.amount])
      .sort();
  // Existing students owe Management, Fund and Establishment, for the
  // application's academic year rather than a month.
  assert.deepEqual(await admissionDues("2025-2026"), [
    ["Establishment", "Admission · Establishment fee", 840000],
    ["Fund", "Admission · Hostel fund", 250000],
    ["Management", "Admission · Management fee", 500000],
  ]);
  // Only the Admin edits the structure; new amounts apply to new dues only.
  const fees = {
    fee_fresher_management: 500000,
    fee_fresher_fund: 250000,
    fee_fresher_caution: 400000,
    fee_fresher_establishment: 840000,
    fee_existing_management: 600000,
    fee_existing_fund: 300000,
    fee_existing_establishment: 840000,
  };
  assert.equal((await f.request("/fee-structure", manager, fees)).status, 403);
  assert.equal(
    (
      await f.request("/fee-structure", admin, {
        ...fees,
        fee_existing_fund: -1,
      })
    ).status,
    400,
  );
  assert.equal((await f.request("/fee-structure", admin, fees)).status, 200);
  const promote = (body: Row) => f.request("/students/promote", admin, body);
  assert.equal(
    (await promote({ academic_year: "2026-2028", student_ids: [sid] })).status,
    400,
  );
  const promoted = await promote({
    academic_year: "2026-2027",
    student_ids: [sid],
  });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  assert.deepEqual(promoted.body, {
    promoted: 1,
    repeating: 0,
    total: 1740000,
  });
  assert.deepEqual(await admissionDues("2026-2027"), [
    ["Establishment", "Admission · Establishment fee", 840000],
    ["Fund", "Admission · Hostel fund", 300000],
    ["Management", "Admission · Management fee", 600000],
  ]);
  assert.equal((await admissionDues("2025-2026"))[1][2], 250000);
  // The same academic year is never charged twice, and Year 3 is final.
  assert.equal(
    (await promote({ academic_year: "2026-2027", student_ids: [sid] })).status,
    409,
  );
  assert.equal(
    (await promote({ academic_year: "2027-2028", student_ids: [sid] })).status,
    200,
  );
  assert.equal(
    (await promote({ academic_year: "2028-2029", student_ids: [sid] })).status,
    400,
  );
  // Promotion never moves a student back to an earlier academic year.
  assert.equal(
    (
      await promote({
        academic_year: "2026-2027",
        student_ids: [sid],
        failed_ids: [sid],
      })
    ).status,
    409,
  );
  // A Year 3 student who failed repeats Year 3 in the new academic year.
  assert.deepEqual(
    (
      await promote({
        academic_year: "2028-2029",
        student_ids: [sid],
        failed_ids: [sid],
      })
    ).body,
    { promoted: 0, repeating: 1, total: 1740000 },
  );
  // A fresher's approval adds the mess caution deposit under Fund.
  const fresher = await f.request("/applications", manager, {
    ...a,
    email: "fresh@test.local",
    admission_type: "Fresher",
  });
  const freshId = (
    await f.request(`/applications/${fresher.body.id}/review`, admin, {
      status: "Approved",
      room: "B-103",
      joined: "2025-01-29",
    })
  ).body.student_id;
  const fresh = (await f.request("/workspace", admin)).body.demands.filter(
    (d: Row) => d.student_id === freshId,
  );
  assert.deepEqual(fresh.map((d: Row) => [d.description, d.amount]).sort(), [
    ["Admission · Establishment fee", 840000],
    ["Admission · Hostel fund", 250000],
    ["Admission · Management fee", 500000],
    ["Admission · Mess caution deposit", 400000],
  ]);
  const w = (await f.request("/workspace", admin)).body;
  const s = w.students.find((s: Student) => s.id === admitted.body.student_id);
  assert.equal(s.course, "B.Com");
  assert.equal(s.address, "Test address");
  assert.equal(s.year, 3);
  assert.equal(s.academic_year, "2028-2029");
});

test("rooms come from the Admin's blocks with capacity; approved details stay fixed except the room", async (t) => {
  const f = await fixture(t),
    admin = await f.login("Admin", 1),
    manager = await f.login("Manager", 2);
  // Block A: A1 and A2 for one student each, AC is the common room.
  const layout = [{ gender: "Female", rooms: 3, capacity: 1 }];
  assert.equal(
    (await f.request("/blocks", manager, { blocks: layout })).status,
    403,
  );
  assert.equal(
    (
      await f.request("/blocks", admin, {
        blocks: [{ ...layout[0], rooms: 1 }],
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.request("/blocks", admin, { blocks: layout })).status,
    200,
  );
  const apply = async (email: string) =>
    (
      await f.request("/applications", manager, {
        name: email,
        email,
        phone: "9876543210",
        guardian: "Parent",
        guardian_phone: "9123456780",
        department: "CS",
        course: "Diploma",
        year: 1,
        academic_year: "2025-2026",
        address: "Mysuru",
        admission_type: "Fresher",
      })
    ).body.id;
  const approve = (id: number, room: string) =>
    f.request(`/applications/${id}/review`, admin, {
      status: "Approved",
      room,
      joined: "2025-01-29",
    });
  const first = await apply("one@test.local"),
    second = await apply("two@test.local");
  assert.equal((await approve(first, "AC")).status, 400);
  assert.equal((await approve(first, "Z9")).status, 400);
  const admitted = await approve(first, "A1");
  assert.equal(admitted.status, 200);
  assert.equal((await approve(second, "A1")).status, 409);
  const sid = admitted.body.student_id;
  const move = (room: string, extra: Row = {}) =>
    f.request(`/students/${sid}/update`, admin, {
      room,
      status: "Active",
      reason: "Room change",
      ...extra,
    });
  // Moving works; other details sent along are ignored.
  assert.equal(
    (await move("A2", { name: "Changed", phone: "9000000000", year: 3 }))
      .status,
    200,
  );
  const s = (await f.request("/workspace", admin)).body.students.find(
    (s: Student) => s.id === sid,
  );
  assert.deepEqual(
    [s.room, s.name, s.phone, s.year],
    ["A2", "one@test.local", "9876543210", 1],
  );
  assert.equal((await approve(second, "A1")).status, 200);
  assert.equal((await move("A1")).status, 409);
  // The layout cannot drop a room a resident lives in.
  assert.equal(
    (
      await f.request("/blocks", admin, {
        blocks: [{ ...layout[0], rooms: 2 }],
      })
    ).status,
    409,
  );
});

test("reversal reopens allocations without changing receipt snapshots; adjustment cannot undercut collections", async (t) => {
  const f = await fixture(t),
    admin = await f.login("Admin", 1),
    manager = await f.login("Manager", 2);
  const p = await f.request(
    "/payments",
    manager,
    payment({
      amount: 150000,
      allocations: [{ demand_id: 1, amount: 150000 }],
    }),
  );
  assert.equal(p.status, 201);
  const original = (await f.request(`/receipts/${p.body.id}`, manager)).body;
  await f.request("/settings", admin, {
    hostel_name: "Renamed hostel",
    daily_rate: 25000,
  });
  assert.equal(
    (await f.request(`/receipts/${p.body.id}`, manager)).body.hostel,
    original.hostel,
  );
  assert.equal(
    (
      await f.request("/demands/1/adjust", admin, {
        amount: 149999,
        reason: "Correction",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(`/payments/${p.body.id}/reverse`, manager, {
        reason: "Duplicate cash entry",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(`/payments/${p.body.id}/reverse`, admin, {
        reason: "Duplicate cash entry",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request(`/payments/${p.body.id}/reverse`, admin, {
        reason: "Again",
      })
    ).status,
    409,
  );
  let w = (await f.request("/workspace", admin)).body;
  assert.equal(w.demands.find((d: Row) => d.id === 1).balance, 300000);
  assert.equal(
    (
      await f.request("/demands/1/adjust", admin, {
        amount: 220000,
        reason: "Corrected opening balance",
      })
    ).status,
    200,
  );
  w = (await f.request("/workspace", admin)).body;
  assert.equal(w.demands.find((d: Row) => d.id === 1).amount, 300000);
  assert.equal(w.demands.find((d: Row) => d.id === 1).balance, 220000);
  const receipt = (await f.request(`/receipts/${p.body.id}`, admin)).body;
  assert(receipt.reversed_at);
  assert.equal(receipt.amount, 150000);
  assert.deepEqual(receipt.allocations, original.allocations);
  const report = (
    await f.request("/reports?from=2025-01-01&to=2025-01-31", admin)
  ).body;
  assert.equal(report.total, 0);
  assert.equal(report.payments.length, 1);
});

test("Excel import previews reject the whole invalid batch and revalidate before an atomic, one-time commit", async (t) => {
  const f = await fixture(t),
    admin = await f.login("Admin", 1),
    student = await f.login("Student", 3);
  const rows = [
    {
      roll: "ROLL-1",
      category: "Fund",
      period: "2024-09",
      amount: 137500,
      description: "Legacy dues",
    },
    {
      roll: "MISSING",
      category: "Fund",
      period: "2024-09",
      amount: 50000,
      description: "Legacy dues",
    },
  ];
  assert.equal(
    (await f.request("/imports/preview", student, { kind: "balances", rows }))
      .status,
    403,
  );
  const invalid = (
    await f.request("/imports/preview", admin, { kind: "balances", rows })
  ).body;
  assert.deepEqual(invalid.errors, [
    { row: 3, error: "College roll does not match a registered student." },
  ]);
  assert.equal(
    (await f.request(`/imports/${invalid.id}/commit`, admin, {})).status,
    409,
  );
  assert.equal((await f.request("/workspace", admin)).body.demands.length, 4);
  const valid = (
    await f.request("/imports/preview", admin, {
      kind: "balances",
      rows: [rows[0]],
    })
  ).body;
  const duplicate = (
    await f.request("/imports/preview", admin, {
      kind: "balances",
      rows: [rows[0]],
    })
  ).body;
  assert.equal(
    (await f.request(`/imports/${valid.id}/commit`, admin, {})).body.count,
    1,
  );
  assert.equal(
    (await f.request(`/imports/${valid.id}/commit`, admin, {})).status,
    409,
  );
  assert.equal(
    (await f.request(`/imports/${duplicate.id}/commit`, admin, {})).status,
    409,
  );
  assert.equal(
    (await f.request("/workspace", admin)).body.demands.filter(
      (d: Row) => d.category === "Fund",
    )[0].balance,
    137500,
  );
});

test("departed students retain historical attendance eligibility; zero-charge months are finalized and locked", async (t) => {
  const f = await fixture(t),
    admin = await f.login("Admin", 1),
    manager = await f.login("Manager", 2);
  const students = (await f.request("/workspace", admin)).body.students;
  for (const s of students) {
    const b = {
      ...s,
      guardian: "Guardian",
      status: "Left",
      exited: "2025-01-29",
      reason: "Course completed",
    };
    assert.equal(
      (await f.request(`/students/${s.id}/update`, manager, b)).status,
      403,
    );
    assert.equal(
      (await f.request(`/students/${s.id}/update`, admin, b)).status,
      200,
    );
  }
  assert.equal(
    (
      await f.request("/attendance", manager, {
        date: "2025-01-29",
        entries: [
          { student_id: 1, status: "Leave" },
          { student_id: 2, status: "Absent" },
        ],
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/attendance", manager, {
        date: "2025-01-30",
        entries: [{ student_id: 1, status: "Present" }],
      })
    ).status,
    400,
  );
  const p = (await f.request("/mess/preview", admin, { period: "2025-01" }))
    .body;
  assert.deepEqual(
    p.rows.map((r: Row) => [r.expected, r.missing, r.days]),
    [
      [1, 0, 0],
      [1, 0, 0],
    ],
  );
  assert.equal(
    (
      await f.request("/mess/finalize", admin, {
        period: p.period,
        expected_rate: p.rate,
        expected_total: p.total,
        expected_rows: p.rows,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await f.request("/attendance", manager, {
        date: "2025-01-29",
        entries: [{ student_id: 1, status: "Present" }],
      })
    ).status,
    409,
  );
});

test("applicants submit and see only their own application, then approval links their official record", async (t) => {
  const f = await fixture(t),
    admin = await f.login("Admin", 1);
  const password = "Applicant-initial-123";
  assert.equal(
    (
      await f.request("/accounts", admin, {
        name: "Applicant",
        email: "applicant@test.local",
        role: "Student",
        password,
      })
    ).status,
    201,
  );
  const login = await f.request("/login", "", {
    email: "applicant@test.local",
    password,
  });
  assert.equal(login.status, 200);
  assert.equal((await f.request("/applications", login.cookie)).status, 403);
  const changed = await f.request("/account/password", login.cookie, {
    current: password,
    password: "Applicant-changed-456",
  });
  assert.equal(changed.status, 200);
  const cookie = changed.cookie;
  const before = (await f.request("/workspace", cookie)).body;
  for (const key of ["students", "demands", "payments", "audit", "attendance"])
    assert.deepEqual(before[key], []);
  const body = {
    name: "Applicant",
    email: "spoof@test.local",
    user_id: 1,
    phone: "9876543210",
    guardian: "Parent",
    guardian_phone: "9123456780",
    department: "Civil",
    course: "B.E.",
    year: 1,
    academic_year: "2025-2026",
    address: "Test address",
    admission_type: "Fresher",
  };
  const application = await f.request("/applications", cookie, body);
  assert.equal(application.status, 201);
  assert.equal(
    (await f.request("/applications", cookie, { ...body, name: "Second" }))
      .status,
    409,
  );
  // Parent phone is required.
  assert.equal(
    (
      await f.request("/applications", await f.login("Manager", 2), {
        ...body,
        guardian_phone: "",
      })
    ).status,
    400,
  );
  const own = (await f.request("/applications", cookie)).body;
  assert.equal(own.length, 1);
  assert.equal(own[0].email, "applicant@test.local");
  assert.equal(own[0].user_id, before.user.id);
  assert.deepEqual(
    (await f.request("/applications", await f.login("Student", 3))).body,
    [],
  );
  const route = `/applications/${application.body.id}/review`;
  assert.equal(
    (await f.request(route, cookie, { status: "Approved" })).status,
    403,
  );
  const admitted = await f.request(route, admin, {
    status: "Approved",
    room: "B-202",
    joined: "2025-02-01",
  });
  assert.equal(admitted.status, 200);
  const after = (await f.request("/workspace", cookie)).body;
  assert.equal(after.user.student_id, admitted.body.student_id);
  assert.deepEqual(
    after.students.map((s: Student) => [s.roll === s.code, s.guardian_phone]),
    [[true, "9123456780"]],
  );
  assert.equal(
    (await f.request("/applications", cookie)).body[0].status,
    "Approved",
  );
});

type Row = Record<string, any>;
