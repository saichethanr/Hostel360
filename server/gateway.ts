import express, { type Express, type Response } from "express";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  ApiError,
  admin,
  categories,
  ensure,
  integer,
  me,
  now,
  text,
} from "./http.js";
import type { Row, Store } from "./store.js";

type Credentials = {
  key_id: string;
  key_secret: string;
  webhook_secret: string;
};
type Services = {
  demands: (student?: number) => Promise<Row[]>;
  record: (body: Row, actor: { id: number; name: string }) => Promise<Row>;
};

// Each hostel uses its own merchant account. Secrets are server environment
// values, never settings rows, browser responses, backups or application logs.
export class Gateway {
  constructor(
    private db: Store,
    private services: Services,
    private transport: typeof fetch = fetch,
  ) {}

  credentials(
    keyId?: string,
  ): (Credentials & { enabled?: boolean; api_key_id?: string }) | undefined {
    if (!this.db.communities || !process.env.RAZORPAY_COMMUNITIES) return;
    let entries;
    try {
      entries = JSON.parse(process.env.RAZORPAY_COMMUNITIES);
    } catch {
      throw new ApiError(
        503,
        "Payment configuration needs administrator attention.",
      );
    }
    // "*" is a shared merchant for communities without their own entry.
    const current = entries?.[String(this.db.communityId)] ?? entries?.["*"];
    if (!current) return;
    const c =
      !keyId || current.key_id === keyId
        ? current
        : (Array.isArray(current.previous) ? current.previous : []).find(
            (item: Credentials) => item.key_id === keyId,
          );
    ensure(
      c,
      "Merchant credentials for this payment are missing. Restore its original key configuration.",
      503,
    );
    ensure(
      /^rzp_(test|live)_[\w]+$/.test(c.key_id) &&
        text(c.key_secret, 500) &&
        text(c.webhook_secret, 500),
      "Payment configuration needs administrator attention.",
      503,
    );
    return c;
  }

  private configured(keyId?: string) {
    const c = this.credentials(keyId);
    ensure(c, "Online payments are not enabled for this community.", 503);
    return c;
  }

  private signature(
    payload: string | Buffer,
    signature: unknown,
    secret: string,
  ) {
    ensure(
      typeof signature === "string" && /^[a-f0-9]{64}$/.test(signature),
      "Invalid payment signature.",
      403,
    );
    const expected = createHmac("sha256", secret).update(payload).digest();
    ensure(
      timingSafeEqual(expected, Buffer.from(signature, "hex")),
      "Invalid payment signature.",
      403,
    );
  }

  private async provider(
    path: string,
    c: Credentials & { api_key_id?: string },
    body?: Row,
    deadline = Date.now() + 30_000,
  ): Promise<Row> {
    try {
      if (Date.now() >= deadline) throw Error("Time budget exceeded");
      // Retain the old secret for callbacks, but use an explicitly configured
      // replacement API key from the same merchant/mode after key revocation.
      const auth = c.api_key_id ? this.configured(c.api_key_id) : c;
      ensure(
        auth.key_id.split("_")[1] === c.key_id.split("_")[1],
        "Cannot mix test and live merchant credentials.",
        503,
      );
      const response = await this.transport(
        `https://api.razorpay.com/v1${path}`,
        {
          method: body ? "POST" : "GET",
          headers: {
            Authorization: `Basic ${Buffer.from(`${auth.key_id}:${auth.key_secret}`).toString("base64")}`,
            "Content-Type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(8_000, deadline - Date.now())),
          ),
        },
      );
      if (!response.ok) throw Error("Provider rejected request");
      return await response.json();
    } catch {
      throw new ApiError(
        503,
        "Payment provider is unavailable. Check payment status before trying again.",
      );
    }
  }

  private async owned(id: string, res: Response) {
    const order = await this.db.get(
      "SELECT * FROM gateway_orders WHERE id=?",
      id,
    );
    ensure(
      order &&
        (me(res).role !== "Student" || order.student_id === me(res).student_id),
      "Payment order not found.",
      404,
    );
    return order;
  }

  private async publicOrder(order: Row) {
    const payment =
      order.payment_id &&
      (await this.db.get(
        "SELECT receipt FROM payments WHERE id=?",
        order.payment_id,
      ));
    return {
      id: order.id,
      student_id: order.student_id,
      amount: order.amount,
      category: order.category,
      status: order.status,
      detail: order.detail,
      payment_id: order.payment_id,
      receipt: payment?.receipt || null,
      provider_payment_id: order.provider_payment_id,
      refunded_amount: order.refunded_amount,
      checked_at: order.checked_at,
      last_error: order.last_error,
      created_at: order.created_at,
      ...(order.status === "open"
        ? {
            key_id: order.key_id,
            order_id: order.provider_order_id,
            currency: "INR",
            test: order.key_id.startsWith("rzp_test_"),
          }
        : {}),
    };
  }

  // Both webhook delivery and the browser confirmation use this transaction.
  // Only the provider's current captured state can create a ledger receipt.
  private async settle(
    id: string,
    paymentId: string,
    reconciliation?: { reason: string; actor: string },
    deadline = Date.now() + 30_000,
  ) {
    ensure(/^pay_[\w]+$/.test(paymentId), "Invalid payment identifier.");
    const before = await this.db.get(
      "SELECT * FROM gateway_orders WHERE id=?",
      id,
    );
    ensure(before, "Payment order not found.", 404);
    const c = this.configured(before.key_id);
    const p = await this.provider(
      `/payments/${paymentId}`,
      c,
      undefined,
      deadline,
    );
    // Payment.amount_refunded can include refunds still pending at the bank.
    // Only individually verified processed refunds affect fee credit.
    const refunds: Row[] = [];
    if (
      p.amount_refunded > 0 ||
      p.status === "refunded" ||
      before.refunded_amount > 0
    ) {
      for (let skip = 0; ; skip += 100) {
        const page = await this.provider(
          `/payments/${paymentId}/refunds?count=100&skip=${skip}`,
          c,
          undefined,
          deadline,
        );
        ensure(Array.isArray(page.items), "Invalid refund response.", 502);
        for (const r of page.items) {
          ensure(
            /^rfnd_[\w]+$/.test(r.id) &&
              r.payment_id === paymentId &&
              r.currency === "INR" &&
              integer(r.amount) &&
              Number.isSafeInteger(r.created_at) &&
              r.created_at > 0,
            "Refund does not match the payment.",
            502,
          );
          if (r.status === "processed") refunds.push(r);
        }
        if (page.items.length < 100) break;
      }
    }
    return this.db.transaction(async () => {
      const o = await this.db.get(
        "SELECT * FROM gateway_orders WHERE id=?",
        id,
      );
      ensure(
        o &&
          o.key_id === c.key_id &&
          p.id === paymentId &&
          p.order_id === o.provider_order_id &&
          p.amount === o.amount &&
          p.currency === "INR",
        "Payment does not match this order.",
        409,
      );
      ensure(
        !o.provider_payment_id || o.provider_payment_id === p.id,
        "Order already has another payment.",
        409,
      );
      // Merge immutable refund IDs, not a possibly stale total fetched before
      // another callback. Neither replay nor out-of-order responses can undo credit.
      for (const r of refunds) {
        await this.db.run(
          "INSERT INTO gateway_refunds (key_id,id,order_id,amount,created_at,observed_at) VALUES (?,?,?,?,?,?) ON CONFLICT(key_id,id) DO NOTHING",
          c.key_id,
          r.id,
          id,
          r.amount,
          new Date(r.created_at * 1000).toISOString(),
          now(),
        );
        const stored = await this.db.get(
          "SELECT * FROM gateway_refunds WHERE key_id=? AND id=?",
          c.key_id,
          r.id,
        );
        ensure(
          stored.order_id === id && stored.amount === r.amount,
          "Refund identity conflict.",
          409,
        );
      }
      const refunded = (
        await this.db.get(
          "SELECT COALESCE(SUM(amount),0) AS total FROM gateway_refunds WHERE order_id=?",
          id,
        )
      ).total;
      ensure(
        refunded <= o.amount,
        "Refund total exceeds the captured amount.",
        409,
      );
      let status = o.status,
        detail = o.detail,
        payment = o.payment_id,
        baseline = o.refund_baseline;
      const captured =
        p.status === "refunded" ||
        (p.status === "captured" && p.captured === true);
      if (
        captured &&
        !payment &&
        refunded < o.amount &&
        (status !== "review" || reconciliation)
      ) {
        const ds = (await this.services.demands(o.student_id))
          .filter((d) => d.category === o.category)
          .sort((a, b) => a.period.localeCompare(b.period) || a.id - b.id);
        const requested: Row[] = reconciliation
          ? ds.map((d) => ({ demand_id: d.id, amount: Math.max(0, d.balance) }))
          : JSON.parse(o.allocations).sort((a: Row, b: Row) => {
              const left = ds.find((d) => d.id === a.demand_id),
                right = ds.find((d) => d.id === b.demand_id);
              return (
                String(left?.period).localeCompare(String(right?.period)) ||
                a.demand_id - b.demand_id
              );
            });
        let remaining = o.amount - refunded;
        const allocations = requested
          .map((a) => {
            const amount = Math.min(a.amount, remaining);
            remaining -= amount;
            return { demand_id: a.demand_id, amount };
          })
          .filter((a) => a.amount > 0);
        const fits =
          remaining === 0 &&
          allocations.every((a) =>
            ds.some((d) => d.id === a.demand_id && d.balance >= a.amount),
          );
        if (!fits || !["upi", "card"].includes(p.method)) {
          ensure(
            !reconciliation,
            "Retained money exceeds outstanding fees or uses an unsupported method. Refund the excess in Razorpay, then reconcile again.",
            409,
          );
          status = "review";
          detail =
            "Money received but not allocated. Do not pay again. Admin can reconcile current fees or refund the excess in Razorpay.";
        } else {
          ensure(
            Number.isSafeInteger(p.created_at) && p.created_at > 0,
            "Invalid payment timestamp.",
            502,
          );
          const result = await this.services.record(
            {
              student_id: o.student_id,
              amount: o.amount - refunded,
              date: new Intl.DateTimeFormat("en-CA", {
                timeZone: "Asia/Kolkata",
              }).format(new Date(p.created_at * 1000)),
              mode: p.method === "upi" ? "UPI" : "Card",
              reference: p.id,
              allocations,
              idempotency_key: `gateway-${o.id}`,
              gateway: { charged: o.amount, refunded_before_receipt: refunded },
            },
            { id: o.user_id, name: "Razorpay online payment" },
          );
          payment = result.id;
          baseline = refunded;
          detail = refunded
            ? "Receipt issued for the retained amount after refunds."
            : "";
        }
      }
      if (payment) {
        let remaining = refunded - baseline;
        ensure(remaining >= 0, "Refund history is incomplete.", 409);
        // Refund the latest fee period first; original allocations/snapshot stay
        // immutable. Each aggregate is replaced with its monotonic verified value.
        const allocations = await this.db.all(
          "SELECT a.*,d.period FROM allocations a JOIN demands d ON d.id=a.demand_id WHERE a.payment_id=? ORDER BY d.period DESC,d.id DESC",
          payment,
        );
        for (const a of allocations) {
          const amount = Math.min(remaining, a.amount);
          remaining -= amount;
          ensure(
            amount >= a.refunded_amount,
            "Refund history cannot move backwards.",
            409,
          );
          await this.db.run(
            "UPDATE allocations SET refunded_amount=? WHERE payment_id=? AND demand_id=?",
            amount,
            payment,
            a.demand_id,
          );
        }
        ensure(remaining === 0, "Refund exceeds allocated credit.", 409);
        status =
          refunded === o.amount
            ? "refunded"
            : refunded > 0
              ? "partially_refunded"
              : "paid";
        if (status === "refunded") {
          await this.db.run(
            "UPDATE payments SET reversed_at=COALESCE(reversed_at,?),reversal_reason='Full Razorpay refund confirmed' WHERE id=?",
            now(),
            payment,
          );
          detail =
            "Full refund confirmed. Previously credited fees are outstanding again.";
        } else if (refunded > baseline)
          detail =
            "Processed refund applied to the latest fee periods first. Remaining credit is retained.";
      } else if (captured && refunded === o.amount) {
        status = "refunded";
        detail =
          "Fully refunded before allocation. No collection was credited.";
      } else if (
        p.status === "authorized" &&
        ![
          "paid",
          "partially_refunded",
          "review",
          "refunded",
          "superseded",
        ].includes(status)
      ) {
        status = "authorized";
        detail = "Payment authorized, awaiting capture. Do not pay again.";
      }
      await this.db.run(
        "UPDATE gateway_orders SET status=?,detail=?,provider_payment_id=?,payment_id=?,refunded_amount=?,refund_baseline=?,checked_at=?,next_check_at=?,last_error='',updated_at=? WHERE id=?",
        status,
        detail,
        captured ? p.id : o.provider_payment_id,
        payment,
        refunded,
        baseline,
        now(),
        new Date(Date.now() + (payment ? 6 * 3600_000 : 300_000)).toISOString(),
        now(),
        id,
      );
      const updated = await this.db.get(
        "SELECT * FROM gateway_orders WHERE id=?",
        id,
      );
      if (
        updated.status !== o.status ||
        refunded !== o.refunded_amount ||
        reconciliation
      )
        await this.db.run(
          "INSERT INTO audit (actor,action,detail,created_at) VALUES ('Razorpay',?,?,?)",
          `Online payment ${updated.status}`,
          `${p.id} · charged ${o.amount / 100} INR · refunded ${refunded / 100} INR${reconciliation ? ` · ${reconciliation.actor}: ${reconciliation.reason}` : ""}`,
          now(),
        );
      return this.publicOrder(updated);
    });
  }

  private async syncOrder(order: Row, deadline = Date.now() + 30_000) {
    try {
      const c = this.configured(order.key_id);
      if (
        !order.provider_order_id &&
        order.status === "creating" &&
        Date.now() - Date.parse(order.created_at) >= 60_000
      ) {
        const result = await this.provider(
          `/orders?receipt=${encodeURIComponent(order.id)}&count=100`,
          c,
          undefined,
          deadline,
        );
        ensure(
          Array.isArray(result.items),
          "Invalid order recovery response.",
          502,
        );
        const matches = result.items.filter((p: Row) => p.receipt === order.id);
        ensure(
          matches.length <= 1,
          "Multiple provider orders require operator investigation.",
          409,
        );
        const found = matches[0];
        if (found) {
          ensure(
            /^order_[\w]+$/.test(found.id) &&
              found.amount === order.amount &&
              found.currency === "INR",
            "Recovered order does not match this checkout.",
            409,
          );
          await this.db.run(
            "UPDATE gateway_orders SET provider_order_id=?,status='open',detail='',updated_at=? WHERE id=? AND status='creating' AND provider_order_id IS NULL",
            found.id,
            now(),
            order.id,
          );
        } else {
          // No checkout was ever returned to the browser. Retire its unique
          // receipt; a delayed original response cannot reopen it (CAS below).
          await this.db.run(
            "UPDATE gateway_orders SET status='creation_failed',detail='No checkout found. It is safe to start a new payment.',updated_at=? WHERE id=? AND status='creating' AND provider_order_id IS NULL",
            now(),
            order.id,
          );
        }
        order = await this.db.get(
          "SELECT * FROM gateway_orders WHERE id=?",
          order.id,
        );
      }
      if (order.provider_payment_id)
        return await this.settle(
          order.id,
          order.provider_payment_id,
          undefined,
          deadline,
        );
      if (order.provider_order_id) {
        const result = await this.provider(
          `/orders/${order.provider_order_id}/payments`,
          c,
          undefined,
          deadline,
        );
        ensure(
          Array.isArray(result.items),
          "Invalid payment recovery response.",
          502,
        );
        const payment =
          result.items.find((p: Row) =>
            ["captured", "refunded"].includes(p.status),
          ) || result.items.find((p: Row) => p.status === "authorized");
        if (payment)
          return await this.settle(order.id, payment.id, undefined, deadline);
        await this.db.run(
          "UPDATE gateway_orders SET status='open',detail='' WHERE id=? AND status='authorized'",
          order.id,
        );
      }
      await this.db.run(
        "UPDATE gateway_orders SET checked_at=?,next_check_at=?,last_error='' WHERE id=?",
        now(),
        new Date(Date.now() + 300_000).toISOString(),
        order.id,
      );
      return await this.publicOrder(
        await this.db.get("SELECT * FROM gateway_orders WHERE id=?", order.id),
      );
    } catch (error) {
      await this.db.run(
        "UPDATE gateway_orders SET last_error=?,next_check_at=? WHERE id=?",
        error instanceof ApiError
          ? error.message
          : "Payment check failed. Retry or contact your Admin.",
        new Date(Date.now() + 300_000).toISOString(),
        order.id,
      );
      throw error;
    }
  }

  webhook(app: Express) {
    app.get("/api/cron/payments", async (req, res) => {
      res.set("Cache-Control", "no-store");
      ensure(
        process.env.CRON_SECRET &&
          req.get("Authorization") === `Bearer ${process.env.CRON_SECRET}`,
        "Unauthorized.",
        401,
      );
      ensure(this.db.communities, "Community database required.", 503);
      const deadline = Date.now() + 45_000,
        candidates: Row[] = [];
      for (const community of await this.db.all("SELECT id FROM communities")) {
        if (Date.now() >= deadline) break;
        await this.db.inCommunity(community.id, async () => {
          candidates.push(
            ...(await this.db.all(
              "SELECT * FROM gateway_orders WHERE status NOT IN ('refunded','creation_failed') AND next_check_at<=? ORDER BY next_check_at,created_at LIMIT 5",
              now(),
            )),
          );
        });
      }
      candidates.sort(
        (a, b) =>
          a.next_check_at.localeCompare(b.next_check_at) ||
          a.created_at.localeCompare(b.created_at),
      );
      let checked = 0,
        failed = 0;
      for (const candidate of candidates.slice(0, 25)) {
        if (Date.now() >= deadline) break;
        await this.db.inCommunity(candidate.community_id, async () => {
          const claimed = await this.db.get(
            "UPDATE gateway_orders SET next_check_at=? WHERE id=? AND next_check_at<=? RETURNING *",
            new Date(Date.now() + 300_000).toISOString(),
            candidate.id,
            now(),
          );
          if (!claimed) return;
          try {
            await this.syncOrder(claimed, deadline);
            checked++;
          } catch {
            failed++;
          }
        });
      }
      // Non-2xx makes a failing recovery job observable to the scheduler.
      res.status(failed ? 503 : 200).json({
        checked,
        failed,
        remaining: candidates.length - checked - failed,
      });
    });
    // Register before JSON parsing, session auth and the browser CSRF header.
    // The raw-body HMAC authenticates this server-to-server endpoint instead.
    app.post(
      "/api/gateway/webhook/:code",
      express.raw({ type: "application/json", limit: "256kb" }),
      async (req, res) => {
        ensure(this.db.communities, "Not found.", 404);
        const community = await this.db.get(
          "SELECT id FROM communities WHERE code=?",
          req.params.code,
        );
        ensure(community, "Not found.", 404);
        await this.db.inCommunity(community.id, async () => {
          const c = this.configured(
            typeof req.query.key_id === "string" ? req.query.key_id : undefined,
          );
          ensure(Buffer.isBuffer(req.body), "Expected JSON webhook.");
          this.signature(
            req.body,
            req.get("X-Razorpay-Signature"),
            c.webhook_secret,
          );
          const event = JSON.parse(req.body.toString("utf8"));
          let payment = event.payload?.payment?.entity;
          if (
            ["refund.processed", "refund.created", "refund.failed"].includes(
              event.event,
            )
          ) {
            const paymentId = event.payload?.refund?.entity?.payment_id;
            ensure(
              typeof paymentId === "string" && /^pay_[\w]+$/.test(paymentId),
              "Invalid refund event.",
            );
            payment = await this.provider(`/payments/${paymentId}`, c);
          }
          if (
            [
              "payment.captured",
              "payment.authorized",
              "order.paid",
              "refund.created",
              "refund.failed",
              "refund.processed",
            ].includes(event.event) &&
            payment?.order_id
          ) {
            const order = await this.db.get(
              "SELECT * FROM gateway_orders WHERE provider_order_id=? AND key_id=?",
              payment.order_id,
              c.key_id,
            );
            if (order) await this.syncOrder(order);
          }
          res.json({ ok: true });
        });
      },
    );
  }

  routes(app: Express) {
    app.get("/api/gateway", async (req, res) => {
      const config = this.credentials();
      if (!this.db.communities) return res.json({ enabled: false, orders: [] });
      const studentId =
        me(res).role === "Student"
          ? me(res).student_id || -1
          : req.query.student_id
            ? Number(req.query.student_id)
            : undefined;
      ensure(
        studentId === undefined || Number.isSafeInteger(studentId),
        "Invalid student.",
      );
      const cursor = req.query.before
        ? await this.owned(String(req.query.before), res)
        : null;
      const conditions = ["1=1"],
        args: unknown[] = [];
      if (studentId !== undefined) {
        conditions.push("student_id=?");
        args.push(studentId);
      }
      const health = await this.db.get(
        `SELECT SUM(CASE WHEN status='review' THEN 1 ELSE 0 END) AS review_count,SUM(CASE WHEN last_error<>'' THEN 1 ELSE 0 END) AS error_count,MIN(CASE WHEN status IN ('creating','open','authorized','superseded','review') THEN next_check_at ELSE NULL END) AS next_check_at FROM gateway_orders WHERE ${conditions.join(" AND ")}`,
        ...args,
      );
      if (cursor) {
        conditions.push("(created_at<? OR (created_at=? AND id<?))");
        args.push(cursor.created_at, cursor.created_at, cursor.id);
      }
      const orders = await this.db.all(
        `SELECT * FROM gateway_orders WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC,id DESC LIMIT 51`,
        ...args,
      );
      res.json({
        enabled: !!config && config.enabled !== false,
        test: config?.key_id.startsWith("rzp_test_"),
        health,
        next_cursor: orders.length > 50 ? orders[49].id : null,
        orders: await Promise.all(
          orders.slice(0, 50).map((o) => this.publicOrder(o)),
        ),
      });
    });
    app.post("/api/gateway/orders", async (req, res) => {
      const c = this.configured(),
        b = req.body,
        user = me(res);
      ensure(
        c.enabled !== false,
        "Online checkout is temporarily paused. Existing payments can still be checked.",
        503,
      );
      const studentId =
        user.role === "Student" ? user.student_id : b.student_id;
      ensure(
        integer(studentId) &&
          categories.includes(b.category) &&
          typeof b.request_key === "string" &&
          /^[\w-]{16,100}$/.test(b.request_key),
        "Select a student, category and payment request key.",
      );
      const earlier = await this.db.get(
        "SELECT * FROM gateway_orders WHERE student_id=? AND category=? AND status IN ('creating','open','authorized')",
        studentId,
        b.category,
      );
      if (earlier) await this.syncOrder(earlier);
      const prepared = await this.db.transaction(async () => {
        const ds = (await this.services.demands(studentId)).filter(
          (d) => d.category === b.category && d.balance > 0,
        );
        const allocations = ds
          .map((d) => ({ demand_id: d.id, amount: d.balance }))
          .sort((a, b) => a.demand_id - b.demand_id);
        const currentQuote = (order: Row) =>
          order.key_id === c.key_id &&
          JSON.stringify(
            JSON.parse(order.allocations).sort(
              (a: Row, b: Row) => a.demand_id - b.demand_id,
            ),
          ) === JSON.stringify(allocations);
        const duplicate = await this.db.get(
          "SELECT * FROM gateway_orders WHERE user_id=? AND request_key=?",
          user.id,
          b.request_key,
        );
        if (duplicate) {
          ensure(
            duplicate.student_id === studentId &&
              duplicate.category === b.category,
            "Request key already used for another payment.",
            409,
          );
          if (duplicate.status === "open" && !currentQuote(duplicate)) {
            await this.db.run(
              "UPDATE gateway_orders SET status='superseded',detail='Fee balance changed. Start a new checkout.',updated_at=? WHERE id=?",
              now(),
              duplicate.id,
            );
            return {
              order: await this.db.get(
                "SELECT * FROM gateway_orders WHERE id=?",
                duplicate.id,
              ),
              create: false,
            };
          }
          return { order: duplicate, create: false };
        }
        ensure(
          !(await this.db.get(
            "SELECT id FROM gateway_orders WHERE student_id=? AND status='review'",
            studentId,
          )),
          "A payment needs Admin review. Do not pay again until it is reconciled.",
          409,
        );
        const pending = await this.db.get(
          "SELECT * FROM gateway_orders WHERE student_id=? AND category=? AND status IN ('creating','open','authorized')",
          studentId,
          b.category,
        );
        if (pending) {
          if (pending.status !== "open" || currentQuote(pending))
            return { order: pending, create: false };
          await this.db.run(
            "UPDATE gateway_orders SET status='superseded',detail='Fee balance changed. Do not use this earlier checkout.',updated_at=? WHERE id=?",
            now(),
            pending.id,
          );
        }
        const amount = ds.reduce((sum, d) => sum + d.balance, 0);
        ensure(
          ds.length > 0 && ds.length <= 200 && integer(amount),
          "No payable balance in this category, or the payment exceeds the supported limit.",
        );
        const recent = await this.db.get(
          "SELECT COUNT(*) AS count FROM gateway_orders WHERE user_id=? AND created_at>?",
          user.id,
          new Date(Date.now() - 60_000).toISOString(),
        );
        ensure(
          recent.count < 10,
          "Too many checkout requests. Wait a minute and check existing payments.",
          429,
        );
        const order = await this.db.get(
          "INSERT INTO gateway_orders (id,user_id,student_id,request_key,key_id,amount,category,allocations,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'creating',?,?) RETURNING *",
          randomUUID(),
          user.id,
          studentId,
          b.request_key,
          c.key_id,
          amount,
          b.category,
          JSON.stringify(
            ds.map((d) => ({ demand_id: d.id, amount: d.balance })),
          ),
          now(),
          now(),
        );
        return { order, create: true };
      });
      let o = prepared.order;
      if (prepared.create) {
        try {
          const provider = await this.provider("/orders", c, {
            amount: o.amount,
            currency: "INR",
            receipt: o.id,
            partial_payment: false,
          });
          ensure(
            typeof provider.id === "string" &&
              /^order_[\w]+$/.test(provider.id) &&
              provider.amount === o.amount &&
              provider.currency === "INR",
            "Provider returned an invalid order.",
            502,
          );
          await this.db.run(
            "UPDATE gateway_orders SET provider_order_id=?,status='open',updated_at=? WHERE id=? AND status='creating' AND provider_order_id IS NULL",
            provider.id,
            now(),
            o.id,
          );
          o = await this.db.get(
            "SELECT * FROM gateway_orders WHERE id=?",
            o.id,
          );
          ensure(
            o.provider_order_id === provider.id && o.status === "open",
            "This checkout was retired during recovery. Refresh before paying.",
            409,
          );
        } catch (error) {
          await this.db.run(
            "UPDATE gateway_orders SET detail='Checkout creation is uncertain. Wait one minute, then use Check status before trying again.',updated_at=? WHERE id=? AND status='creating'",
            now(),
            o.id,
          );
          throw error;
        }
      }
      ensure(
        o.key_id === c.key_id,
        "An earlier payment uses a different merchant key. Contact Admin before paying.",
        409,
      );
      ensure(
        o.status !== "creating",
        "Checkout is being prepared. Check status shortly.",
        409,
      );
      res.status(prepared.create ? 201 : 200).json(await this.publicOrder(o));
    });
    app.post("/api/gateway/orders/:id/confirm", async (req, res) => {
      const order = await this.owned(String(req.params.id), res),
        c = this.configured(order.key_id);
      ensure(
        order.key_id === c.key_id &&
          order.provider_order_id === req.body.razorpay_order_id,
        "Checkout does not match the stored order.",
        409,
      );
      ensure(
        typeof req.body.razorpay_payment_id === "string" &&
          /^pay_[\w]+$/.test(req.body.razorpay_payment_id),
        "Invalid payment identifier.",
      );
      this.signature(
        `${order.provider_order_id}|${req.body.razorpay_payment_id}`,
        req.body.razorpay_signature,
        c.key_secret,
      );
      res.json(await this.settle(order.id, req.body.razorpay_payment_id));
    });
    app.post("/api/gateway/orders/:id/check", async (req, res) => {
      res.json(
        await this.syncOrder(await this.owned(String(req.params.id), res)),
      );
    });
    app.post("/api/gateway/orders/:id/reconcile", async (req, res) => {
      admin(res);
      ensure(
        text(req.body.reason, 500),
        "A reconciliation reason is required.",
      );
      const order = await this.owned(String(req.params.id), res);
      ensure(
        order.status === "review" && order.provider_payment_id,
        "Only unallocated captured payments need reconciliation.",
        409,
      );
      res.json(
        await this.settle(order.id, order.provider_payment_id, {
          reason: req.body.reason.trim(),
          actor: me(res).name,
        }),
      );
    });
  }
}
