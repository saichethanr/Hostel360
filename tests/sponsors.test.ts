import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { Store, type Row } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { coverMost } from "../server/cover.ts";

const url =
  process.env.SPONSOR_TEST_DATABASE_URL ||
  process.env.COMMUNITY_TEST_DATABASE_URL;

test("the wallet covers the most students by taking the smallest dues first", () => {
  const dues = [10_000, 9_000, 6_000, 5_000].map((outstanding, id) => ({
    id,
    outstanding,
  }));
  // Largest first would fit only 10,000 + 9,000; smallest first fits three.
  assert.deepEqual(
    coverMost(dues, 20_000).map((s) => s.outstanding),
    [5_000, 6_000, 9_000],
  );
  assert.deepEqual(coverMost(dues, 4_999), []);
  assert.deepEqual(
    coverMost([{ outstanding: 0 }, { outstanding: 7 }], 7).map(
      (s) => s.outstanding,
    ),
    [7],
  );
});

test(
  "sponsors fund a wallet the Admin allocates, or pay for one listed student online",
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
      "20261124010000_sponsors",
      "20261125010000_meal_tokens",
    ])
      await owner.query(
        await readFile(
          new URL(`../supabase/migrations/${m}.sql`, import.meta.url),
          "utf8",
        ),
      );
    await owner.query(
      `GRANT USAGE ON SCHEMA hostel360 TO ${role}; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA hostel360 TO ${role}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA hostel360 TO ${role}; GRANT DELETE ON hostel360.sessions,hostel360.login_attempts,hostel360.onboarding_attempts,hostel360.sponsor_files TO ${role}`,
    );
    const pool = new pg.Pool({
      connectionString: url,
      options: `-c role=${role}`,
    });
    const db = new Store(pool, true);
    // Supabase Storage stand-in for photos and documents.
    const storage = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ Key: "ok", signedURL: "/signed?token=1" }));
    }).listen(0, "127.0.0.1");
    await once(storage, "listening");
    // Razorpay stand-in: orders, and payments the test marks as captured.
    const secret = "sponsor-test-secret";
    const orders = new Map<string, { amount: number; paid?: string }>();
    const providerFetch = (async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace("/v1", "");
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), {
          headers: { "Content-Type": "application/json" },
        });
      if (path === "/orders" && init?.method === "POST") {
        const id = `order_${orders.size + 1}`;
        const amount = JSON.parse(String(init.body)).amount;
        orders.set(id, { amount });
        return json({ id, amount, status: "created" });
      }
      const m = path.match(/^\/orders\/(order_\d+)\/payments$/);
      if (m) {
        const o = orders.get(m[1])!;
        return json({
          items: o.paid
            ? [
                {
                  id: o.paid,
                  status: "captured",
                  amount: o.amount,
                  method: "upi",
                  order_id: m[1],
                },
              ]
            : [],
        });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const server = createApp(db, { gatewayFetch: providerFetch }).listen(
      0,
      "127.0.0.1",
    );
    await once(server, "listening");
    t.after(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await new Promise<void>((r) => storage.close(() => r()));
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      delete process.env.RAZORPAY_COMMUNITIES;
      await pool.end();
      await owner.end();
    });
    const port = (server.address() as Row).port;
    const request = async (path: string, cookie = "", body?: unknown) => {
      const r = await fetch(
        `http://127.0.0.1:${port}/api${path}${path.includes("?") ? "&" : "?"}community=jss`,
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
    const password = "SponsorExample12!";
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
    const community = await db.get(
      "INSERT INTO communities (code,name,created_at) VALUES ('jss','JSS PDA',?) RETURNING *",
      new Date().toISOString(),
    );
    process.env.RAZORPAY_COMMUNITIES = JSON.stringify({
      [community.id]: {
        key_id: "rzp_test_sponsor",
        key_secret: secret,
        webhook_secret: "hook-secret",
      },
    });
    assert.equal((await join("admin@test.local", "Manager")).status, 201);
    await db.inCommunity(community.id, () =>
      db.run(
        "UPDATE users SET role='Admin',membership_status='Approved' WHERE email='admin@test.local'",
      ),
    );
    const admin = await login("admin@test.local");
    const approve = async (email: string) => {
      const u = (await request("/accounts", admin)).body.find(
        (u: Row) => u.email === email,
      );
      assert.equal(
        (await request(`/accounts/${u.id}`, admin, { status: "Approved" }))
          .status,
        200,
      );
    };
    // A Sponsor registers like anyone else and waits for the Admin.
    assert.equal((await join("donor@test.local", "Sponsor")).status, 201);
    assert.equal(
      (await request("/sponsorship/students", await login("donor@test.local")))
        .status,
      403,
    );
    await approve("donor@test.local");
    const donor = await login("donor@test.local");
    // Freshers owe 5,000 + 6,500 (fund with caution deposit) + 8,400; existing
    // students 5,000 + 2,500 + 8,400. Amounts are in paise.
    const admit = async (email: string, admission_type: string) => {
      await join(email, "Student", {
        phone: "9876543210",
        department: "CS",
        course: "Diploma",
        year: 1,
        academic_year: "2026-2027",
        guardian: "Parent",
        guardian_phone: "9123456780",
        address: "Mysuru",
        admission_type,
      });
      const a = (await request("/applications", admin)).body.find(
        (a: Row) => a.email === email,
      );
      const r = await request(`/applications/${a.id}/review`, admin, {
        status: "Approved",
        room: "A1",
        joined: "2026-08-01",
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.student_id as number;
    };
    const asha = await admit("asha@test.local", "Fresher"),
      bina = await admit("bina@test.local", "Existing"),
      chitra = await admit("chitra@test.local", "Fresher");
    const overview = async () =>
      (await request("/sponsorship/admin", admin)).body;
    const owed = async (id: number) =>
      (await overview()).dues.find((d: Row) => d.student_id === id)
        ?.outstanding ?? 0;
    const demandsOf = async (id: number) =>
      (await request("/workspace", admin)).body.demands.filter(
        (d: Row) => d.student_id === id && d.balance > 0,
      );
    const cash = async (id: number, category: string, amount: number) => {
      const d = (await demandsOf(id)).find((d: Row) => d.category === category);
      const r = await request("/payments", admin, {
        student_id: id,
        amount,
        date: "2026-11-20",
        mode: "Cash",
        reference: "",
        idempotency_key: crypto.randomUUID(),
        allocations: [{ demand_id: d.id, amount }],
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    };
    // Chitra pays everything except her fund (6,500) in cash.
    await cash(chitra, "Management", 500_000);
    await cash(chitra, "Establishment", 840_000);

    // The due list puts the largest dues first when they began together.
    assert.deepEqual(
      (await overview()).dues.map((d: Row) => [d.student_id, d.outstanding]),
      [
        [asha, 1_990_000],
        [bina, 1_590_000],
        [chitra, 650_000],
      ],
    );

    // Admin records a sponsor's 25,000 and allocates it.
    const saved = await request("/sponsorship/sponsors", admin, {
      name: "Lions Club",
      email: "Lions@Example.org",
      phone: "9988776655",
      amount: 2_500_000,
      received_on: "2026-11-21",
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const lions = saved.body.id;
    const balance = async (id: number) =>
      (await overview()).sponsors.find((s: Row) => s.id === id).balance;
    assert.equal(await balance(lions), 2_500_000);
    // Suggested: the two smallest dues fit (6,500 + 15,900); Asha's does not.
    assert.deepEqual(
      coverMost((await overview()).dues, 2_500_000).map(
        (d: Row) => d.student_id,
      ),
      [chitra, bina],
    );
    const tooMuch = await request(
      `/sponsorship/sponsors/${lions}/grants`,
      admin,
      {
        grants: [{ student_id: chitra, amount: 650_001 }],
      },
    );
    assert.equal(tooMuch.status, 409);
    const given = await request(
      `/sponsorship/sponsors/${lions}/grants`,
      admin,
      {
        grants: [
          { student_id: chitra, amount: 650_000 },
          { student_id: bina, amount: 1_590_000 },
        ],
      },
    );
    assert.equal(given.status, 201, JSON.stringify(given.body));
    // One receipt per fee category: Chitra's fund, Bina's three categories.
    assert.equal(given.body.receipts.length, 4);
    assert.equal(await owed(chitra), 0);
    assert.equal(await owed(bina), 0);
    assert.equal(await balance(lions), 260_000);
    const overdrawn = await request(
      `/sponsorship/sponsors/${lions}/grants`,
      admin,
      {
        grants: [{ student_id: asha, amount: 260_001 }],
      },
    );
    assert.equal(overdrawn.status, 409);
    // A reversed sponsor receipt returns its money to the wallet.
    const binaManagement = (
      await request("/workspace", admin)
    ).body.payments.find(
      (p: Row) => p.student_id === bina && p.category === "Management",
    );
    assert.equal(binaManagement.mode, "Sponsor");
    assert.equal(
      (
        await request(`/payments/${binaManagement.id}/reverse`, admin, {
          reason: "Wrong student",
        })
      ).status,
      200,
    );
    assert.equal(await balance(lions), 760_000);
    assert.equal(await owed(bina), 500_000);

    // Only students with dues can be listed; the Admin prepares Asha's profile.
    assert.equal(
      (
        await request(`/sponsorship/listings/${chitra}`, admin, {
          reason: "Paid up",
          active: 1,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(`/sponsorship/listings/${asha}`, admin, {
          reason: "Father's daily wages stopped after an accident.",
          active: 1,
        })
      ).status,
      200,
    );
    process.env.SUPABASE_URL = `http://127.0.0.1:${(storage.address() as Row).port}`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]).toString(
      "base64",
    );
    assert.equal(
      (
        await request(`/sponsorship/listings/${asha}/photo`, admin, {
          name: "note.pdf",
          content: Buffer.from("%PDF-1.4").toString("base64"),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`/sponsorship/listings/${asha}/photo`, admin, {
          name: "asha.png",
          content: png,
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await request(`/sponsorship/listings/${asha}/files`, admin, {
          kind: "Result",
          label: "Semester 1",
          detail: "SGPA 8.6",
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await request(`/sponsorship/listings/${asha}/files`, admin, {
          kind: "Document",
          label: "Income certificate",
          document: {
            name: "income.pdf",
            content: Buffer.from("%PDF-1.4 x").toString("base64"),
          },
        })
      ).status,
      201,
    );

    // The approved Sponsor sees profiles only.
    const view = (await request("/workspace", donor)).body;
    assert.deepEqual(
      [view.students, view.demands, view.payments],
      [[], [], []],
    );
    assert.equal((await request("/sponsorship/admin", donor)).status, 403);
    assert.equal((await request("/documents/1", donor)).status, 403);
    assert.equal((await request("/leaves", donor)).status, 403);
    const listed = (await request("/sponsorship/students", donor)).body;
    assert.deepEqual(
      listed.map((l: Row) => [
        l.name,
        l.outstanding,
        l.results.map((r: Row) => r.detail),
        l.documents.map((d: Row) => d.label),
      ]),
      [["asha", 1_990_000, ["SGPA 8.6"], ["Income certificate"]]],
    );
    assert.ok(listed[0].photo_url);
    assert.equal(
      (
        await request(
          `/sponsorship/documents/${listed[0].documents[0].document_id}`,
          donor,
        )
      ).status,
      200,
    );

    // The shared public page shows the profile without contact details or IDs.
    const page = await request(`/public/appeals/${listed[0].share_token}`);
    assert.equal(page.status, 200);
    assert.equal(page.body.name, "asha");
    assert.equal(page.body.outstanding, 1_990_000);
    for (const key of ["code", "phone", "email", "student_id", "documents"])
      assert.equal(key in page.body, false, key);

    // Sponsoring Asha online: capped at her dues.
    assert.equal(
      (
        await request("/sponsorship/contribute", donor, {
          amount: 1_990_001,
          phone: "9000000001",
          student_id: asha,
        })
      ).status,
      400,
    );
    const order = await request("/sponsorship/contribute", donor, {
      amount: 1_990_000,
      phone: "9000000001",
      student_id: asha,
    });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    // Meanwhile Asha pays 5,000 in cash; the sponsor's excess stays in the wallet.
    await cash(asha, "Management", 500_000);
    orders.get(order.body.order_id)!.paid = "pay_1";
    const confirm = (payment: string, signature: string) =>
      request(`/sponsorship/contribute/${order.body.id}/confirm`, donor, {
        razorpay_order_id: order.body.order_id,
        razorpay_payment_id: payment,
        razorpay_signature: signature,
      });
    const sign = (o: string, p: string) =>
      createHmac("sha256", secret).update(`${o}|${p}`).digest("hex");
    assert.equal(
      (await confirm("pay_1", sign(order.body.order_id, "pay_x"))).status,
      403,
    );
    assert.deepEqual(
      (await confirm("pay_1", sign(order.body.order_id, "pay_1"))).body,
      { status: "paid" },
    );
    assert.deepEqual(
      (await confirm("pay_1", sign(order.body.order_id, "pay_1"))).body,
      { status: "paid" },
    );
    assert.equal(await owed(asha), 0);
    const mine = (await request("/sponsorship/mine", donor)).body;
    assert.deepEqual(
      [mine.sponsor.contributed, mine.sponsor.given, mine.sponsor.balance],
      [1_990_000, 1_490_000, 500_000],
    );
    assert.deepEqual(
      mine.grants.map((g: Row) => [g.student_name, g.amount]),
      [["asha", 1_490_000]],
    );

    // Giving to the wallet only: the Admin allocates it later.
    const general = await request("/sponsorship/contribute", donor, {
      amount: 100_000,
      phone: "9000000001",
    });
    orders.get(general.body.order_id)!.paid = "pay_2";
    await request(`/sponsorship/contribute/${general.body.id}/confirm`, donor, {
      razorpay_order_id: general.body.order_id,
      razorpay_payment_id: "pay_2",
      razorpay_signature: sign(general.body.order_id, "pay_2"),
    });
    const after = (await request("/sponsorship/mine", donor)).body;
    assert.equal(after.sponsor.balance, 600_000);
    assert.equal(after.grants.length, 1);
    // The Admin allocates it to Bina, who was never listed; the Sponsor sees
    // where it went and can open her profile.
    assert.equal(
      (
        await request(
          `/sponsorship/sponsors/${after.sponsor.id}/grants`,
          admin,
          {
            grants: [{ student_id: bina, amount: 500_000 }],
          },
        )
      ).status,
      201,
    );

    // Hidden profiles leave the Sponsor list and their public page closes.
    await request(`/sponsorship/listings/${asha}`, admin, {
      reason: "Covered",
      active: 0,
    });
    assert.deepEqual((await request("/sponsorship/students", donor)).body, []);
    assert.equal(
      (await request(`/public/appeals/${listed[0].share_token}`)).status,
      404,
    );
    const helped = (await request("/sponsorship/mine", donor)).body;
    assert.deepEqual(
      helped.grants.map((g: Row) => [g.student_name, g.amount]),
      [
        ["bina", 500_000],
        ["asha", 1_490_000],
      ],
    );
    assert.deepEqual(
      helped.students
        .map((s: Row) => [s.name, s.results.map((r: Row) => r.detail)])
        .sort(),
      [
        ["asha", ["SGPA 8.6"]],
        ["bina", []],
      ],
    );
    // Asha is hidden now, but her documents stay open to the sponsor who helped her.
    assert.equal(
      (
        await request(
          `/sponsorship/documents/${listed[0].documents[0].document_id}`,
          donor,
        )
      ).status,
      200,
    );
  },
);
