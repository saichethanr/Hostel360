import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import { Store, type Row } from "../server/store.ts";
import { feeDefaults } from "../server/operations.ts";
import { createApp } from "../server/app.ts";
import { hashPassword } from "../server/db.ts";

test(
  "verified gateway payments settle only the correct community and student",
  { skip: !process.env.GATEWAY_TEST_DATABASE_URL },
  async (t) => {
    const owner = new pg.Pool({
      connectionString: process.env.GATEWAY_TEST_DATABASE_URL,
    });
    assert(
      (
        await owner.query("SELECT current_database() AS name")
      ).rows[0].name.endsWith("_test"),
    );
    const role = "hostel360_community_test";
    await owner.query("DROP SCHEMA IF EXISTS hostel360 CASCADE");
    for (const migration of [
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
          new URL(`../supabase/migrations/${migration}.sql`, import.meta.url),
          "utf8",
        ),
      );
    await owner.query(
      `GRANT USAGE ON SCHEMA hostel360 TO ${role}; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA hostel360 TO ${role}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA hostel360 TO ${role}; GRANT DELETE ON hostel360.sessions,hostel360.login_attempts,hostel360.onboarding_attempts TO ${role}`,
    );
    const pool = new pg.Pool({
      connectionString: process.env.GATEWAY_TEST_DATABASE_URL,
      options: `-c role=${role}`,
    });
    const db = new Store(pool, true);
    const privileges = (
      await pool.query(
        "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    assert.equal(privileges.rolsuper, false);
    assert.equal(privileges.rolbypassrls, false);
    const previous = process.env.RAZORPAY_COMMUNITIES;
    t.after(async () => {
      if (previous === undefined) delete process.env.RAZORPAY_COMMUNITIES;
      else process.env.RAZORPAY_COMMUNITIES = previous;
      await pool.end();
      await owner.end();
    });
    const communities: Row[] = [];
    const password = "GatewayExample12!";
    for (const code of ["cedar", "river"]) {
      const community = await db.get(
        "INSERT INTO communities (code,name,created_at) VALUES (?,?,?) RETURNING *",
        code,
        code,
        new Date().toISOString(),
      );
      communities.push(community);
      await db.inCommunity(community.id, async () => {
        community.users = [];
        for (const role of ["Admin", "Student", "Student", "Manager"]) {
          const identity = randomUUID(),
            email = `${identity}@example.com`;
          await db.run(
            "INSERT INTO identities (id,email,password) VALUES (?,?,?)",
            identity,
            email,
            hashPassword(password),
          );
          const student =
            role === "Student"
              ? await db.get(
                  "INSERT INTO students (code,roll,name,department,year,room,phone,joined) VALUES (?,?,?,'CS',1,'A1','9000000000','2025-01-01') RETURNING *",
                  identity,
                  identity,
                  `Student ${community.users.length}`,
                )
              : null;
          const user = await db.get(
            "INSERT INTO users (name,email,password,role,student_id,identity_id) VALUES (?,?,'unused',?,?,?) RETURNING *",
            role,
            email,
            role,
            student?.id || null,
            identity,
          );
          community.users.push(user);
        }
        for (const [student, category, amount, period] of [
          [community.users[1].student_id, "Mess", 11234, "2026-09"],
          [community.users[1].student_id, "Mess", 2266, "2026-10"],
          [community.users[1].student_id, "Fund", 4200, "2026-10"],
          [community.users[2].student_id, "Mess", 9800, "2026-10"],
        ])
          await db.run(
            "INSERT INTO demands (student_id,category,period,description,amount,created_at) VALUES (?,?,?,'Test fees',?,?)",
            student,
            category,
            period,
            amount,
            new Date().toISOString(),
          );
      });
    }
    process.env.RAZORPAY_COMMUNITIES = JSON.stringify(
      Object.fromEntries(
        communities.map((c) => [
          c.id,
          {
            key_id: `rzp_test_${c.code}`,
            key_secret: `test-${c.code}`,
            webhook_secret: `webhook-${c.code}`,
            ...(c === communities[0]
              ? { mess_account: "acc_MessBank001" }
              : {}),
          },
        ]),
      ),
    );
    const providerOrders = new Map<string, Row>(),
      providerPayments = new Map<string, Row>();
    let failProvider = false,
      loseOrderResponse = false,
      hideRefunds = false,
      revokeOldKey = false;
    const providerFetch: typeof fetch = async (input, init) => {
      if (failProvider) return Response.json({}, { status: 503 });
      const path = new URL(String(input)).pathname.replace("/v1", "");
      const auth = (init!.headers as Record<string, string>).Authorization;
      const authorized = (o: Row | undefined) =>
        o &&
        (revokeOldKey &&
        o.auth ===
          `Basic ${Buffer.from("rzp_test_cedar:test-cedar").toString("base64")}`
          ? auth ===
            `Basic ${Buffer.from("rzp_test_rotated:rotated-test-secret").toString("base64")}`
          : o.auth === auth);
      if (path === "/orders" && init!.method === "POST") {
        const body = JSON.parse(String(init!.body));
        const order = { ...body, id: `order_${providerOrders.size + 1}`, auth };
        providerOrders.set(order.id, order);
        if (loseOrderResponse)
          throw new Error("Simulated disconnect after provider commits");
        return Response.json(order);
      }
      if (path === "/orders")
        return Response.json({
          items: [...providerOrders.values()].filter(
            (o) =>
              authorized(o) &&
              o.receipt === new URL(String(input)).searchParams.get("receipt"),
          ),
        });
      if (path.startsWith("/payments/")) {
        const p = providerPayments.get(path.split("/")[2]);
        return p && authorized(providerOrders.get(p.order_id))
          ? Response.json(
              path.endsWith("/refunds")
                ? {
                    items: hideRefunds
                      ? []
                      : (p.refunds || []).slice(
                          Number(
                            new URL(String(input)).searchParams.get("skip"),
                          ),
                          Number(
                            new URL(String(input)).searchParams.get("skip"),
                          ) + 100,
                        ),
                  }
                : p,
            )
          : Response.json({}, { status: 404 });
      }
      const order = providerOrders.get(path.split("/")[2]);
      return authorized(order)
        ? Response.json({
            items: [...providerPayments.values()].filter(
              (p) => p.order_id === order!.id,
            ),
          })
        : Response.json({}, { status: 404 });
    };
    const server = createApp(db, { gatewayFetch: providerFetch }).listen(
      0,
      "127.0.0.1",
    );
    await once(server, "listening");
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const address = server.address();
    assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api`;
    async function request(
      path: string,
      community: Row,
      user?: Row,
      body?: Row,
      status = 200,
    ) {
      const r = await fetch(
        `${base}${path}${path.includes("?") ? "&" : "?"}community=${community.code}`,
        {
          method: body ? "POST" : "GET",
          headers: {
            "Content-Type": "application/json",
            "X-Hostel360": "1",
            cookie: user?.cookie || "",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      const data = await r.json();
      assert.equal(r.status, status, `${path}: ${JSON.stringify(data)}`);
      return { data, cookie: r.headers.get("set-cookie")?.split(";")[0] };
    }
    for (const c of communities)
      for (const u of c.users)
        u.cookie = (
          await request("/login", c, undefined, { email: u.email, password })
        ).cookie;
    const [a, b] = communities,
      [admin, student, other, manager] = a.users;
    const create = async (u: Row, category = "Mess") =>
      (
        await request(
          "/gateway/orders",
          a,
          u,
          {
            student_id: u.student_id,
            category,
            request_key: randomUUID(),
          },
          201,
        )
      ).data;
    const payment = (o: Row, method = "upi", status = "captured") => {
      const p = {
        id: `pay_${providerPayments.size + 1}`,
        order_id: o.order_id,
        amount: o.amount,
        currency: "INR",
        status,
        captured: status === "captured",
        method,
        created_at: Math.floor(Date.now() / 1000),
        amount_refunded: 0,
      };
      providerPayments.set(p.id, p);
      return p;
    };
    const confirmation = (o: Row, p: Row) => ({
      razorpay_order_id: o.order_id,
      razorpay_payment_id: p.id,
      razorpay_signature: createHmac("sha256", "test-cedar")
        .update(`${o.order_id}|${p.id}`)
        .digest("hex"),
    });
    const refund = (p: Row, amount: number, status = "processed") => {
      const r = {
        id: `rfnd_${randomUUID().replaceAll("-", "")}`,
        payment_id: p.id,
        currency: "INR",
        amount,
        status,
        created_at: Math.floor(Date.now() / 1000),
      };
      (p.refunds ||= []).push(r);
      p.amount_refunded = p.refunds
        .filter((r: Row) => r.status !== "failed")
        .reduce((sum: number, r: Row) => sum + r.amount, 0);
      if (p.amount_refunded === p.amount) p.status = "refunded";
      return r;
    };
    async function webhook(
      p: Row,
      event = "payment.captured",
      valid = true,
      code = a.code,
    ) {
      const body = JSON.stringify({
        event,
        payload: {
          payment: { entity: p },
          refund: { entity: { payment_id: p.id } },
        },
      });
      const r = await fetch(`${base}/gateway/webhook/${code}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Razorpay-Signature": valid
            ? createHmac("sha256", "webhook-cedar").update(body).digest("hex")
            : "0".repeat(64),
        },
        body,
      });
      return r.status;
    }

    await t.test(
      "UPI capture, not browser claims or authorisation, creates one receipt under duplicate delivery",
      async () => {
        const order = await create(student);
        assert.equal(order.amount, 13500); // Never trusts the browser's amount=1.
        assert(!JSON.stringify(order).includes("test-cedar"));
        const duplicate = (
          await request("/gateway/orders", a, student, {
            category: "Mess",
            request_key: randomUUID(),
          })
        ).data;
        assert.equal(duplicate.id, order.id);
        const p = payment(order, "upi", "authorized");
        await request(
          `/gateway/orders/${order.id}/confirm`,
          a,
          student,
          { ...confirmation(order, p), razorpay_signature: "0".repeat(64) },
          403,
        );
        await request(
          `/gateway/orders/${order.id}/confirm`,
          a,
          other,
          confirmation(order, p),
          404,
        );
        await request(
          `/gateway/orders/${order.id}/confirm`,
          b,
          b.users[0],
          confirmation(order, p),
          404,
        );
        assert.equal(await webhook(p, "payment.captured", false), 403);
        assert.equal(await webhook(p, "payment.captured", true, b.code), 403);
        assert.equal(
          (
            await request(
              `/gateway/orders/${order.id}/confirm`,
              a,
              student,
              confirmation(order, p),
            )
          ).data.status,
          "authorized",
        );
        assert.equal(
          (await request("/workspace", a, student)).data.payments.length,
          0,
        );
        p.status = "captured";
        p.captured = true;
        const [callback, notification] = await Promise.all([
          request(
            `/gateway/orders/${order.id}/confirm`,
            a,
            student,
            confirmation(order, p),
          ),
          webhook(p),
        ]);
        assert.equal(notification, 200);
        assert.equal(callback.data.status, "paid");
        assert.equal(await webhook(p), 200);
        const workspace = (await request("/workspace", a, student)).data;
        assert.equal(workspace.payments.length, 1);
        assert.equal(workspace.payments[0].mode, "UPI");
        assert.deepEqual(
          workspace.demands
            .filter((d: Row) => d.category === "Mess")
            .map((d: Row) => d.balance),
          [0, 0],
        );
        const receipt = (
          await request(`/receipts/${callback.data.payment_id}`, a, student)
        ).data;
        assert.equal(receipt.amount, 13500);
        assert.equal(receipt.received_name, "Razorpay online payment");
        assert.deepEqual(
          receipt.allocations.map((r: Row) => r.amount),
          [11234, 2266],
        );
        await request(
          `/receipts/${callback.data.payment_id}`,
          a,
          other,
          undefined,
          404,
        );
        await request(
          `/payments/${callback.data.payment_id}/reverse`,
          a,
          admin,
          { reason: "Must refund at provider" },
          409,
        );
        assert.equal(
          (await request("/workspace", b, b.users[1])).data.payments.length,
          0,
        );
      },
    );
    await t.test(
      "card capture is recovered without a browser callback; mismatched amounts are rejected",
      async () => {
        const order = await create(other),
          p = payment(order, "card");
        p.amount = 9801;
        await request(
          `/gateway/orders/${order.id}/confirm`,
          a,
          other,
          confirmation(order, p),
          409,
        );
        p.amount = 9800;
        assert.equal(await webhook(p), 200);
        const checked = (
          await request(`/gateway/orders/${order.id}/check`, a, other, {})
        ).data;
        assert.equal(checked.status, "paid");
        const workspace = (await request("/workspace", a, other)).data;
        assert.equal(workspace.payments[0].mode, "Card");
        assert.equal(
          workspace.payments[0].received_name,
          "Razorpay online payment",
        );
        assert.equal(workspace.demands[0].balance, 0);
        const report = (
          await request("/reports?from=2026-01-01&to=2099-12-31", a, admin)
        ).data;
        assert.equal(
          report.modes.find((m: Row) => m.mode === "Card").amount,
          9800,
        );
        assert.equal(report.total, 23300);
        const archive = (await request("/backup", a, admin)).data;
        assert.equal(archive.gateway_orders.length, 2);
        assert(!JSON.stringify(archive).includes("webhook-cedar"));
      },
    );
    await t.test(
      "late capture after an offline payment settles the rest and keeps the excess as credit",
      async () => {
        const order = await create(student, "Admission");
        const demand = (
          await request("/workspace", a, student)
        ).data.demands.find((d: Row) => d.category === "Fund");
        await request(
          "/payments",
          a,
          manager,
          {
            student_id: student.student_id,
            amount: 1000,
            date: new Date().toISOString().slice(0, 10),
            mode: "Cash",
            reference: "",
            allocations: [{ demand_id: demand.id, amount: 1000 }],
            idempotency_key: randomUUID(),
          },
          201,
        );
        const p = payment(order);
        assert.equal(await webhook(p), 200);
        const checked = (
          await request(`/gateway/orders/${order.id}/check`, a, student, {})
        ).data;
        // The offline payment already covered 1000; the rest settles the due
        // and the excess 1000 stays as the student's Fund credit.
        assert.equal(checked.status, "paid");
        assert.equal(checked.provider_payment_id, p.id);
        let workspace = (await request("/workspace", a, student)).data;
        assert.equal(
          workspace.demands.find((d: Row) => d.id === demand.id).balance,
          0,
        );
        assert.deepEqual(
          workspace.credits.map((c: Row) => [c.category, c.credit]),
          [["Admission", 1000]],
        );
        refund(p, p.amount);
        assert.equal(await webhook(p, "refund.processed"), 200);
        assert.equal(
          (await request(`/gateway/orders/${order.id}/check`, a, student, {}))
            .data.status,
          "refunded",
        );
        // A full refund removes both the payment and the credit.
        workspace = (await request("/workspace", a, student)).data;
        assert.equal(
          workspace.demands.find((d: Row) => d.id === demand.id).balance,
          3200,
        );
        assert.deepEqual(workspace.credits, []);
      },
    );
    await t.test(
      "Mess payments go to the Mess linked account; other fees stay with the main account",
      async () => {
        // Every order sent to Razorpay so far, by its fee category.
        const sent = await db.inCommunity(a.id, () =>
          db.all(
            "SELECT category,provider_order_id FROM gateway_orders WHERE provider_order_id IS NOT NULL",
          ),
        );
        const byCategory = (category: string) =>
          sent
            .filter((o: Row) => o.category === category)
            .map((o: Row) => providerOrders.get(o.provider_order_id)!);
        assert(
          byCategory("Mess").length > 0 && byCategory("Admission").length > 0,
        );
        for (const o of byCategory("Mess"))
          assert.deepEqual(o.transfers, [
            {
              account: "acc_MessBank001",
              amount: o.amount,
              currency: "INR",
              notes: { purpose: "Mess" },
            },
          ]);
        for (const o of byCategory("Admission"))
          assert.equal(o.transfers, undefined);
      },
    );
    await t.test(
      "provider failures, disabled/pending access and refunds never create phantom receipts",
      async () => {
        failProvider = true;
        await request(
          "/gateway/orders",
          a,
          student,
          { category: "Admission", request_key: randomUUID() },
          503,
        );
        failProvider = false;
        const paid = (await request("/gateway", a, other)).data.orders[0];
        const p = providerPayments.get(paid.provider_payment_id)!;
        refund(p, 500);
        assert.equal(await webhook(p, "refund.processed"), 200);
        assert.equal(
          (await request(`/gateway/orders/${paid.id}/check`, a, other, {})).data
            .status,
          "partially_refunded",
        );
        const partial = (await request("/workspace", a, other)).data;
        assert.equal(partial.demands[0].balance, 500);
        assert.equal(partial.payments[0].refunded_amount, 500);
        assert.equal(partial.payments[0].reversed_at, null);
        refund(p, p.amount - 500);
        assert.equal(await webhook(p, "refund.processed"), 200);
        assert.equal(await webhook(p, "payment.captured"), 200); // Out-of-order event must not repay the fees.
        const workspace = (await request("/workspace", a, other)).data;
        assert.equal(workspace.demands[0].balance, 9800);
        assert(workspace.payments[0].reversed_at);
        await db.inCommunity(a.id, () =>
          db.run(
            "UPDATE users SET membership_status='Pending' WHERE id=?",
            other.id,
          ),
        );
        await request("/gateway", a, other, undefined, 403);
        assert.equal((await db.all("SELECT * FROM gateway_orders")).length, 0); // RLS default deny.
      },
    );
    await t.test(
      "partial refunds reopen exactly the refunded credit, newest periods first, without rewriting receipts",
      async () => {
        const o = (await request("/gateway", a, student)).data.orders.find(
          (o: Row) => o.category === "Mess",
        );
        const p = providerPayments.get(o.provider_payment_id)!;
        const original = (
          await request(`/receipts/${o.payment_id}`, a, student)
        ).data;
        const r = refund(p, 2500, "pending");
        assert.equal(await webhook(p, "refund.created"), 200);
        assert.equal(
          (await request("/workspace", a, student)).data.demands.find(
            (d: Row) => d.category === "Mess",
          ).balance,
          0,
        );
        r.status = "processed";
        assert.equal(await webhook(p, "refund.processed"), 200);
        assert.equal(await webhook(p, "refund.processed"), 200);
        hideRefunds = true;
        assert.equal(await webhook(p), 200); // A stale fetch must not erase a known refund.
        hideRefunds = false;
        const ws = (await request("/workspace", a, student)).data;
        assert.deepEqual(
          ws.demands
            .filter((d: Row) => d.category === "Mess")
            .map((d: Row) => [d.period, d.balance]),
          [
            ["2026-10", 2266],
            ["2026-09", 234],
          ],
        );
        const receipt = (await request(`/receipts/${o.payment_id}`, a, student))
          .data;
        assert.equal(receipt.amount, 13500);
        assert.equal(receipt.refunded_amount, 2500);
        assert.deepEqual(receipt.allocations, original.allocations);
        const report = (
          await request("/reports?from=2026-01-01&to=2099-12-31", a, admin)
        ).data;
        assert.equal(report.total, 12000); // ₹110 net UPI plus ₹10 offline Fund.
        assert.equal(
          report.modes.find((m: Row) => m.mode === "UPI").amount,
          11000,
        );
        const archive = (await request("/backup", a, admin)).data;
        assert(
          archive.gateway_refunds.some(
            (stored: Row) => stored.id === r.id && stored.amount === 2500,
          ),
        );
        assert.equal((await db.all("SELECT * FROM gateway_refunds")).length, 0);
      },
    );
    await t.test(
      "interrupted order creation recovers by receipt and stale checkout amounts are replaced",
      async () => {
        let unfinished = (
          await request("/gateway", a, student)
        ).data.orders.find((o: Row) => o.status === "creating");
        assert(unfinished);
        await db.inCommunity(a.id, () =>
          db.run(
            "UPDATE gateway_orders SET created_at=? WHERE id=?",
            new Date(Date.now() - 120000).toISOString(),
            unfinished.id,
          ),
        );
        assert.equal(
          (
            await request(
              `/gateway/orders/${unfinished.id}/check`,
              a,
              student,
              {},
            )
          ).data.status,
          "creation_failed",
        );
        loseOrderResponse = true;
        await request(
          "/gateway/orders",
          a,
          student,
          { category: "Admission", request_key: randomUUID() },
          503,
        );
        loseOrderResponse = false;
        unfinished = (await request("/gateway", a, student)).data.orders.find(
          (o: Row) => o.status === "creating",
        );
        await db.inCommunity(a.id, () =>
          db.run(
            "UPDATE gateway_orders SET created_at=? WHERE id=?",
            new Date(Date.now() - 120000).toISOString(),
            unfinished.id,
          ),
        );
        const providerCount = providerOrders.size;
        const recovered = (
          await request(
            `/gateway/orders/${unfinished.id}/check`,
            a,
            student,
            {},
          )
        ).data;
        assert.equal(recovered.status, "open");
        assert.equal(recovered.amount, 3200);
        const retry = (
          await request("/gateway/orders", a, student, {
            category: "Admission",
            request_key: randomUUID(),
          })
        ).data;
        assert.equal(retry.id, recovered.id);
        assert.equal(providerOrders.size, providerCount);
        const demand = (
          await request("/workspace", a, student)
        ).data.demands.find((d: Row) => d.category === "Fund");
        await request(
          "/payments",
          a,
          manager,
          {
            student_id: student.student_id,
            amount: 200,
            date: new Date().toISOString().slice(0, 10),
            mode: "Cash",
            reference: "",
            allocations: [{ demand_id: demand.id, amount: 200 }],
            idempotency_key: randomUUID(),
          },
          201,
        );
        const replacement = await create(student, "Admission");
        assert.equal(replacement.amount, 3000);
        assert.notEqual(replacement.id, recovered.id);
        assert.equal(
          (await request("/gateway", a, student)).data.orders.find(
            (o: Row) => o.id === recovered.id,
          ).status,
          "superseded",
        );
        // A superseded checkout paid late still counts: 3000 settles the due
        // and the 200 excess becomes Fund credit, with no Admin review.
        const late = payment(recovered);
        assert.equal(await webhook(late), 200);
        const settled = (
          await request(`/gateway/orders/${recovered.id}/check`, a, student, {})
        ).data;
        assert.equal(settled.status, "paid");
        const fund = async () => {
          const w = (await request("/workspace", a, student)).data;
          return {
            balance: w.demands.find((d: Row) => d.id === demand.id).balance,
            credit: w.credits
              .filter((c: Row) => c.category === "Admission")
              .reduce((sum: number, c: Row) => sum + c.credit, 0),
          };
        };
        assert.deepEqual(await fund(), { balance: 0, credit: 200 });
        const receipt = (
          await request(`/receipts/${settled.payment_id}`, a, student)
        ).data;
        assert.equal(receipt.amount, 3200);
        // Reconciliation stays Admin-only and only for unallocated payments.
        for (const [community, user, status] of [
          [a, manager, 403],
          [a, student, 403],
          [b, b.users[0], 404],
          [a, admin, 409],
        ] as const)
          await request(
            `/gateway/orders/${recovered.id}/reconcile`,
            community,
            user,
            { reason: "Check" },
            status,
          );
        // A refund returns the credit first, then reopens the latest fees.
        refund(late, 200);
        assert.equal(await webhook(late, "refund.processed"), 200);
        assert.deepEqual(await fund(), { balance: 0, credit: 0 });
        refund(late, 700);
        assert.equal(await webhook(late, "refund.processed"), 200);
        assert.deepEqual(await fund(), { balance: 700, credit: 0 });
      },
    );
    await t.test(
      "authenticated recovery survives missed webhooks, rotates keys and preserves history when paused",
      async () => {
        const savedSecret = process.env.CRON_SECRET;
        process.env.CRON_SECRET = "disposable-gateway-cron-test";
        try {
          assert.equal((await fetch(`${base}/cron/payments`)).status, 401);
          const o = await create(student, "Mess"),
            p = payment(o, "card");
          const settings = JSON.parse(process.env.RAZORPAY_COMMUNITIES!);
          settings[a.id] = {
            key_id: "rzp_test_rotated",
            key_secret: "rotated-test-secret",
            webhook_secret: "rotated-test-webhook",
            enabled: false,
            previous: [settings[a.id]],
          };
          settings[a.id].previous[0].api_key_id = "rzp_test_rotated";
          revokeOldKey = true;
          process.env.RAZORPAY_COMMUNITIES = JSON.stringify(settings);
          await request(
            "/gateway/orders",
            a,
            student,
            { category: "Mess", request_key: randomUUID() },
            503,
          );
          const paused = (await request("/gateway", a, student)).data;
          assert.equal(paused.enabled, false);
          assert(paused.orders.length > 0);
          const response = await fetch(`${base}/cron/payments`, {
            headers: { Authorization: "Bearer disposable-gateway-cron-test" },
          });
          assert.equal(
            response.status,
            200,
            JSON.stringify(await response.json()),
          );
          const checked = (
            await request(`/gateway/orders/${o.id}/check`, a, student, {})
          ).data;
          assert.equal(checked.status, "paid");
          assert.equal(checked.provider_payment_id, p.id);
          const ws = (await request("/workspace", a, student)).data;
          assert(
            ws.demands
              .filter((d: Row) => d.category === "Mess")
              .every((d: Row) => d.balance === 0),
          );
          const count = ws.payments.length;
          await request(
            `/gateway/orders/${o.id}/confirm`,
            a,
            student,
            confirmation(o, p),
          );
          assert.equal(
            (await request("/workspace", a, student)).data.payments.length,
            count,
          );
          failProvider = true;
          await db.inCommunity(a.id, () =>
            db.run(
              "UPDATE gateway_orders SET next_check_at='' WHERE id=?",
              o.id,
            ),
          );
          assert.equal(
            (
              await fetch(`${base}/cron/payments`, {
                headers: {
                  Authorization: "Bearer disposable-gateway-cron-test",
                },
              })
            ).status,
            503,
          );
          failProvider = false;
          const failed = (await request("/gateway", a, student)).data;
          assert(failed.health.error_count > 0);
          assert(
            failed.orders
              .find((r: Row) => r.id === o.id)
              .last_error.includes("unavailable"),
          );
          await request(`/gateway/orders/${o.id}/check`, a, student, {});
          assert.equal(
            (await request("/gateway", a, student)).data.orders.find(
              (r: Row) => r.id === o.id,
            ).last_error,
            "",
          );
        } finally {
          if (savedSecret === undefined) delete process.env.CRON_SECRET;
          else process.env.CRON_SECRET = savedSecret;
        }
      },
    );
    await t.test(
      "refund pagination and older payment history retain complete tenant-scoped totals",
      async () => {
        revokeOldKey = false;
        const saved = JSON.parse(process.env.RAZORPAY_COMMUNITIES!);
        saved[a.id] = saved[a.id].previous[0];
        delete saved[a.id].api_key_id;
        process.env.RAZORPAY_COMMUNITIES = JSON.stringify(saved);
        const original = (
          await request("/gateway", a, student)
        ).data.orders.find(
          (o: Row) => o.category === "Mess" && o.amount === 13500,
        );
        const p = providerPayments.get(original.provider_payment_id)!;
        for (let i = 0; i < 101; i++) refund(p, 1);
        refund(p, 99, "failed");
        assert.equal(await webhook(p, "refund.processed"), 200);
        const receipt = (
          await request(`/receipts/${original.payment_id}`, a, student)
        ).data;
        assert.equal(receipt.refunded_amount, 2601);
        const ws = (await request("/workspace", a, student)).data;
        assert.equal(
          ws.demands.find(
            (d: Row) => d.category === "Mess" && d.period === "2026-09",
          ).balance,
          101,
        );
        const older = randomUUID();
        await db.inCommunity(a.id, async () => {
          for (let i = 0; i < 52; i++)
            await db.run(
              "INSERT INTO gateway_orders (id,user_id,student_id,request_key,key_id,amount,category,allocations,status,created_at,updated_at) VALUES (?,?,?,?,?,1,'Mess','[]',?,?,?)",
              i === 0 ? older : randomUUID(),
              student.id,
              student.student_id,
              randomUUID(),
              "rzp_test_cedar",
              i === 0 ? "review" : "creation_failed",
              i === 0 ? "2000-01-01T00:00:00.000Z" : "2020-01-01T00:00:00.000Z",
              new Date().toISOString(),
            );
        });
        const first = (
          await request(`/gateway?student_id=${other.student_id}`, a, student)
        ).data;
        assert.equal(first.orders.length, 50);
        assert.equal(first.health.review_count, 1);
        assert(
          first.orders.every((o: Row) => o.student_id === student.student_id),
        );
        assert(!first.orders.some((o: Row) => o.id === older));
        const second = (
          await request(`/gateway?before=${first.next_cursor}`, a, student)
        ).data;
        assert(second.orders.some((o: Row) => o.id === older));
        assert.equal(
          new Set([...first.orders, ...second.orders].map((o) => o.id)).size,
          first.orders.length + second.orders.length,
        );
        assert.equal(second.next_cursor, null);
        await request(
          "/gateway/orders",
          a,
          student,
          { category: "Mess", request_key: randomUUID() },
          409,
        );
        const otherHistory = (
          await request(`/gateway?student_id=${other.student_id}`, a, admin)
        ).data;
        assert(otherHistory.orders.length > 0);
        assert(
          otherHistory.orders.every(
            (o: Row) => o.student_id === other.student_id,
          ),
        );
        await request(
          `/gateway?before=${otherHistory.orders[0].id}`,
          a,
          student,
          undefined,
          404,
        );
        await request(
          `/gateway?before=${original.id}`,
          b,
          b.users[0],
          undefined,
          404,
        );
        await assert.rejects(
          db.inCommunity(b.id, () =>
            db.run(
              "INSERT INTO gateway_refunds (key_id,id,order_id,amount,created_at,observed_at) VALUES ('rzp_test_river','rfnd_wrong_tenant',?,1,?,?)",
              original.id,
              new Date().toISOString(),
              new Date().toISOString(),
            ),
          ),
        );
      },
    );
    await t.test(
      "students choose the amount: less stays due, more is credit that settles the next dues; staff cannot check out",
      async () => {
        await request(
          "/gateway/orders",
          a,
          admin,
          {
            student_id: student.student_id,
            category: "Mess",
            request_key: randomUUID(),
          },
          403,
        );
        // Earlier subtests leave a payment in review, which blocks checkout.
        await db.inCommunity(a.id, () =>
          db.run(
            "UPDATE gateway_orders SET status='refunded' WHERE status='review'",
          ),
        );
        // One Management due of ₹30 from the fee structure via promotion.
        await request("/fee-structure", a, admin, {
          ...Object.fromEntries(Object.keys(feeDefaults).map((k) => [k, 0])),
          fee_existing_management_development: 3000,
        });
        const promote = (academic_year: string) =>
          request("/students/promote", a, admin, {
            academic_year,
            student_ids: [student.student_id],
          });
        // Admission dues (any of Management, Fund, Establishment) are paid
        // together, oldest first; earlier subtests leave some Fund due.
        const admission = async () => {
          const w = (await request("/workspace", a, student)).data;
          return {
            balance: w.demands
              .filter((d: Row) => d.category !== "Mess")
              .reduce((sum: number, d: Row) => sum + d.balance, 0),
            credit: w.credits
              .filter((c: Row) => c.category === "Admission")
              .reduce((sum: number, c: Row) => sum + c.credit, 0),
          };
        };
        const { balance: older } = await admission();
        await promote("2026-2027");
        assert.deepEqual(await admission(), {
          balance: older + 3000,
          credit: 0,
        });
        const pay = async (amount: number) => {
          const o = (
            await request(
              "/gateway/orders",
              a,
              student,
              { category: "Admission", request_key: randomUUID(), amount },
              201,
            )
          ).data;
          assert.equal(o.amount, amount);
          assert.equal(await webhook(payment(o)), 200);
          const checked = (
            await request(`/gateway/orders/${o.id}/check`, a, student, {})
          ).data;
          assert.equal(checked.status, "paid");
          return checked;
        };
        await request(
          "/gateway/orders",
          a,
          student,
          { category: "Admission", request_key: randomUUID(), amount: 50 },
          400,
        );
        await pay(1000);
        assert.deepEqual(await admission(), {
          balance: older + 2000,
          credit: 0,
        });
        const over = await pay(older + 2500);
        assert.deepEqual(await admission(), { balance: 0, credit: 500 });
        const receipt = (
          await request(`/receipts/${over.payment_id}`, a, student)
        ).data;
        assert.equal(receipt.category, "Admission");
        assert.equal(receipt.amount, older + 2500);
        assert.equal(receipt.advance, 500);
        // The next year's due is raised and the credit settles part of it.
        await promote("2027-2028");
        assert.deepEqual(await admission(), { balance: 2500, credit: 0 });
      },
    );
  },
);
