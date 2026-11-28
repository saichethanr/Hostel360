import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { Store, type Row } from "../server/store.ts";
import { createApp } from "../server/app.ts";
import { periodRange, rupeesInWords } from "../server/challan.ts";

const url =
  process.env.TOKEN_TEST_DATABASE_URL ||
  process.env.COMMUNITY_TEST_DATABASE_URL;

test("mess challans write amounts in Indian words and name the months covered", () => {
  assert.equal(rupeesInWords(804_600), "Eight Thousand Forty Six Only");
  assert.equal(
    rupeesInWords(12_500_050),
    "One Lakh Twenty Five Thousand and Fifty Paise Only",
  );
  assert.equal(rupeesInWords(1_100), "Eleven Only");
  assert.equal(
    periodRange(["2026-10", "2026-05", "2026-07", "2026-05"]),
    "May 2026 to October 2026",
  );
  assert.equal(periodRange(["2026-11"]), "November 2026");
});

test(
  "visitors buy meal tokens without signing in; staff see, issue and close them",
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
      connectionString: url,
      options: `-c role=${role}`,
    });
    const db = new Store(pool, true);
    // Razorpay stand-in: orders, and payments the test marks as captured.
    const secret = "token-test-secret";
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
                  contact: "+919000000001",
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
    const password = "TokenExample12!";
    const join = (email: string, role: string) =>
      request("/communities/join", "", {
        code: "jss",
        name: email.split("@")[0],
        email,
        password,
        role,
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
        key_id: "rzp_test_tokens",
        key_secret: secret,
        webhook_secret: "hook",
      },
    });
    await join("admin@test.local", "Manager");
    await join("manager@test.local", "Manager");
    await join("warden@test.local", "Warden");
    await db.inCommunity(community.id, async () => {
      await db.run("UPDATE users SET membership_status='Approved'");
      await db.run(
        "UPDATE users SET role='Admin' WHERE email='admin@test.local'",
      );
    });
    const admin = await login("admin@test.local"),
      manager = await login("manager@test.local"),
      warden = await login("warden@test.local");

    // Nothing is on sale until the Admin sets prices; only the Admin can.
    assert.deepEqual((await request("/public/tokens/menu")).body.meals, []);
    assert.equal(
      (
        await request("/meal-prices", manager, {
          Breakfast: 3000,
          Lunch: 6000,
          Dinner: 0,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/meal-prices", admin, {
          Breakfast: 3000,
          Lunch: 6000,
          Dinner: 100_001,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/meal-prices", admin, {
          Breakfast: 3000,
          Lunch: 6000,
          Dinner: 0,
        })
      ).status,
      200,
    );
    assert.deepEqual((await request("/public/tokens/menu")).body.meals, [
      { meal: "Breakfast", amount: 3000 },
      { meal: "Lunch", amount: 6000 },
    ]);

    // A visitor buys lunch from the QR page; the price comes from the Admin,
    // not from the request.
    assert.equal(
      (await request("/public/tokens", "", { meal: "Dinner" })).status,
      409,
    );
    // No name or phone: paying is all a visitor does.
    const bought = await request("/public/tokens", "", {
      meal: "Lunch",
      amount: 1,
    });
    assert.equal(bought.status, 201, JSON.stringify(bought.body));
    assert.equal(bought.body.amount, 6000);
    // Unpaid tokens are not open and staff do not see them.
    assert.equal(
      (await request(`/public/tokens/${bought.body.key}`)).body.status,
      "Pending",
    );
    assert.deepEqual((await request("/tokens", manager)).body.tokens, []);
    const sign = (o: string, p: string) =>
      createHmac("sha256", secret).update(`${o}|${p}`).digest("hex");
    const confirm = (payment: string, signature: string) =>
      request(`/public/tokens/${bought.body.key}/confirm`, "", {
        razorpay_order_id: bought.body.order_id,
        razorpay_payment_id: payment,
        razorpay_signature: signature,
      });
    assert.equal(
      (await confirm("pay_1", sign(bought.body.order_id, "pay_other"))).status,
      403,
    );
    orders.get(bought.body.order_id)!.paid = "pay_1";
    const token = (await confirm("pay_1", sign(bought.body.order_id, "pay_1")))
      .body;
    assert.equal(token.status, "Open");
    assert.equal(token.number, `T-${String(token.id).padStart(4, "0")}`);
    assert.equal(
      Date.parse(token.expires_at) - Date.parse(token.opened_at),
      2 * 3600_000,
    );
    assert.equal(
      (await confirm("pay_1", sign(bought.body.order_id, "pay_1"))).body.status,
      "Open",
    );
    // The buyer's page shows the token but not their phone or the payment.
    const page = (await request(`/public/tokens/${bought.body.key}`)).body;
    for (const key of [
      "phone",
      "reference",
      "access_key",
      "provider_payment_id",
    ])
      assert.equal(key in page, false, key);
    assert.equal((await request("/public/tokens/not-a-real-key")).status, 404);

    // Staff see it open; the workspace badge counts it.
    assert.equal((await request("/tokens", warden)).status, 403);
    const list = (await request("/tokens", manager)).body.tokens;
    assert.deepEqual(
      list.map((x: Row) => [x.number, x.status, x.phone, x.mode]),
      [[token.number, "Open", "+919000000001", "Online"]],
    );
    assert.equal((await request("/workspace", manager)).body.open_tokens, 1);

    // The manager sells breakfast at the counter; UPI needs its reference.
    assert.equal(
      (
        await request("/tokens", manager, {
          meal: "Breakfast",
          name: "Elder visitor",
          mode: "UPI",
        })
      ).status,
      400,
    );
    // Name and phone are optional at the counter too.
    const counter = await request("/tokens", manager, {
      meal: "Breakfast",
      mode: "Cash",
    });
    assert.equal(counter.status, 201, JSON.stringify(counter.body));
    assert.deepEqual(
      [counter.body.status, counter.body.amount],
      ["Open", 3000],
    );
    assert.equal((await request("/workspace", admin)).body.open_tokens, 2);

    // Served: the visitor closes their own token, once; nobody else's key works.
    assert.equal(
      (await request("/public/tokens/not-a-real-key/close", "", {})).status,
      404,
    );
    const mine = await request(
      `/public/tokens/${bought.body.key}/close`,
      "",
      {},
    );
    assert.equal(mine.body.status, "Closed");
    assert.equal(
      (await request(`/public/tokens/${bought.body.key}/close`, "", {})).status,
      409,
    );
    assert.equal(
      (await request("/tokens", manager)).body.tokens.find(
        (x: Row) => x.id === token.id,
      ).closed_name,
      null,
    );
    // Staff can close a token too, once.
    assert.equal(
      (await request(`/tokens/${counter.body.id}/close`, manager, {})).body
        .status,
      "Closed",
    );
    assert.equal(
      (await request(`/tokens/${counter.body.id}/close`, manager, {})).status,
      409,
    );

    // Two hours later an unclosed token reads as Expired, leaves the count,
    // and its buyer can no longer close it.
    const late = (
      await request("/tokens", manager, { meal: "Lunch", mode: "Cash" })
    ).body;
    await db.inCommunity(community.id, () =>
      db.run(
        "UPDATE meal_tokens SET expires_at=? WHERE id=?",
        new Date(Date.now() - 1000).toISOString(),
        late.id,
      ),
    );
    assert.equal(
      (await request("/tokens", manager)).body.tokens.find(
        (x: Row) => x.id === late.id,
      ).status,
      "Expired",
    );
    assert.equal((await request("/workspace", manager)).body.open_tokens, 0);
    assert.equal(
      (await request(`/public/tokens/${late.access_key}/close`, "", {})).status,
      409,
    );
  },
);
