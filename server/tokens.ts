import type { Express, Response } from "express";
import { randomBytes } from "node:crypto";
import type { Store, Row } from "./store.js";
import { ensure, me, admin, staff, text, integer, now } from "./http.js";
import type { Gateway } from "./gateway.js";

export const meals = ["Breakfast", "Lunch", "Dinner"] as const;
// A token stays Open this long after payment unless the buyer or staff close
// it first.
export const tokenHours = 2;
const phonePattern = /^\+?[0-9][0-9 -]{7,18}$/;

// Admin-set price per meal in paise; 0 means tokens are not sold for it.
export const mealPrices = (value: string | undefined) => {
  let saved: Record<string, unknown> = {};
  try {
    saved = JSON.parse(value || "{}");
  } catch {
    saved = {};
  }
  return Object.fromEntries(
    meals.map((m) => [m, integer(saved[m]) ? (saved[m] as number) : 0]),
  ) as Record<(typeof meals)[number], number>;
};

// What a token looks like to its buyer and to staff. Expired is not stored:
// an Open token past its expiry time reads as Expired.
const view = (t: Row) => ({
  id: t.id,
  number: `T-${String(t.id).padStart(4, "0")}`,
  meal: t.meal,
  amount: t.amount,
  name: t.name,
  status: t.status === "Open" && t.expires_at < now() ? "Expired" : t.status,
  created_at: t.created_at,
  opened_at: t.opened_at,
  expires_at: t.expires_at,
  closed_at: t.closed_at,
});

// Meal tokens for visitors. The mess QR code opens a public page where anyone
// buys a token without signing in; staff see tokens as they open, verify and
// close them, and issue tokens for cash or UPI.
export function registerTokens(
  app: Express,
  {
    db,
    gateway,
    audit,
  }: {
    db: Store;
    gateway: Gateway;
    audit: (
      actor: { name: string },
      action: string,
      detail: string,
    ) => Promise<unknown>;
  },
) {
  const prices = async () =>
    mealPrices(
      (await db.get("SELECT value FROM settings WHERE key='meal_prices'"))
        ?.value,
    );
  const details = (b: Row) => {
    ensure(meals.includes(b.meal), "Choose a meal.");
    ensure(
      !b.name || (typeof b.name === "string" && b.name.length <= 80),
      "Keep the name under 80 characters.",
    );
    ensure(
      !b.phone || phonePattern.test(b.phone),
      "Enter a valid phone number.",
    );
  };
  const open = async (id: number, extra: Row = {}) => {
    const opened = new Date();
    const expires = new Date(opened.getTime() + tokenHours * 3600_000);
    await db.run(
      `UPDATE meal_tokens SET status='Open',opened_at=?,expires_at=?${extra.provider_payment_id ? ",provider_payment_id=?" : ""} WHERE id=? AND status='Pending'`,
      opened.toISOString(),
      expires.toISOString(),
      ...(extra.provider_payment_id ? [extra.provider_payment_id] : []),
      id,
    );
  };

  app.post("/api/meal-prices", async (req, res) => {
    admin(res);
    const b = req.body;
    ensure(
      meals.every((m) => b[m] === 0 || (integer(b[m]) && b[m] <= 100_000)),
      "Enter a price from ₹1 to ₹1,000 for each meal, or 0 to stop selling it.",
    );
    const value = JSON.stringify(
      Object.fromEntries(meals.map((m) => [m, b[m]])),
    );
    await db.transaction(async () => {
      await db.run(
        `INSERT INTO settings (key,value) VALUES ('meal_prices',?) ON CONFLICT(${db.key("key")}) DO UPDATE SET value=excluded.value`,
        value,
      );
      await audit(
        me(res),
        "Meal token prices updated",
        meals.map((m) => `${m} ${b[m] / 100} INR`).join(" · "),
      );
    });
    res.json({ ok: true });
  });

  // ── Public: buying a token from the mess QR code ──
  app.get("/api/public/tokens/menu", async (_req, res) => {
    const p = await prices();
    res.json({
      hostel: res.locals.community?.name ?? "",
      online: !!gateway.credentials(),
      hours: tokenHours,
      meals: meals
        .filter((m) => p[m] > 0)
        .map((meal) => ({ meal, amount: p[meal] })),
    });
  });

  app.post("/api/public/tokens", async (req, res) => {
    // Visitors only choose the meal and pay; the token number is the receipt.
    const b = req.body;
    ensure(meals.includes(b.meal), "Choose a meal.");
    const amount = (await prices())[b.meal as (typeof meals)[number]];
    ensure(amount > 0, "Tokens for this meal are not on sale.", 409);
    const c = gateway.credentials();
    ensure(
      c,
      "Online payment is not available. Please pay at the counter.",
      503,
    );
    // Unpaid checkouts are cheap to start, so cap them per hostel.
    const recent = await db.get(
      "SELECT COUNT(*) AS count FROM meal_tokens WHERE status='Pending' AND created_at>?",
      new Date(Date.now() - 10 * 60_000).toISOString(),
    );
    ensure(
      Number(recent.count) < 60,
      "Many people are buying tokens right now. Try again in a few minutes.",
      429,
    );
    const key = randomBytes(18).toString("base64url");
    const token = await db.get(
      "INSERT INTO meal_tokens (access_key,meal,amount,name,phone,mode,status,key_id,created_at) VALUES (?,?,?,'','','Online','Pending',?,?) RETURNING id",
      key,
      b.meal,
      amount,
      c.key_id,
      now(),
    );
    const order = await gateway.provider("/orders", c, {
      amount,
      currency: "INR",
      receipt: `token-${token.id}`,
      notes: { purpose: "Meal token", meal: b.meal },
    });
    ensure(
      typeof order.id === "string" && order.amount === amount,
      "Payment provider returned an unexpected order.",
      503,
    );
    await db.run(
      "UPDATE meal_tokens SET provider_order_id=? WHERE id=?",
      order.id,
      token.id,
    );
    res.status(201).json({ key, key_id: c.key_id, order_id: order.id, amount });
  });

  // Only Razorpay's captured payment opens a token, once.
  const settle = async (t: Row) => {
    if (t.status !== "Pending" || !t.provider_order_id) return;
    const c = gateway.credentials(t.key_id);
    if (!c) return;
    const found = await gateway.provider(
      `/orders/${t.provider_order_id}/payments`,
      c,
    );
    const paid = (Array.isArray(found.items) ? found.items : []).find(
      (p: Row) => p.status === "captured" && p.amount === t.amount,
    );
    if (!paid) return;
    await db.transaction(async () => {
      const current = await db.get(
        "SELECT status FROM meal_tokens WHERE id=?",
        t.id,
      );
      if (current.status !== "Pending") return;
      await open(t.id, { provider_payment_id: paid.id });
      // Keep the phone Razorpay's checkout collected, for staff records.
      if (typeof paid.contact === "string")
        await db.run(
          "UPDATE meal_tokens SET phone=? WHERE id=? AND phone=''",
          paid.contact.slice(0, 20),
          t.id,
        );
      await audit(
        { name: "Visitor" },
        "Meal token bought online",
        `T-${String(t.id).padStart(4, "0")} · ${t.meal} · ${t.amount / 100} INR · ${paid.id}`,
      );
    });
  };
  gateway.otherOrders.push(async (providerOrderId, keyId) => {
    const t = await db.get(
      "SELECT * FROM meal_tokens WHERE provider_order_id=? AND key_id=?",
      providerOrderId,
      keyId,
    );
    if (t) await settle(t);
  });
  const byKey = async (key: string) => {
    const t = await db.get(
      "SELECT * FROM meal_tokens WHERE access_key=?",
      String(key),
    );
    ensure(t, "Token not found.", 404);
    return t;
  };

  app.post("/api/public/tokens/:key/confirm", async (req, res) => {
    const t = await byKey(req.params.key),
      b = req.body,
      c = gateway.credentials(t.key_id);
    ensure(c && t.provider_order_id, "Token not found.", 404);
    ensure(
      b.razorpay_order_id === t.provider_order_id &&
        typeof b.razorpay_payment_id === "string",
      "Payment does not match this token.",
      400,
    );
    gateway.signature(
      `${t.provider_order_id}|${b.razorpay_payment_id}`,
      b.razorpay_signature,
      c.key_secret,
    );
    await settle(t);
    res.json(view(await byKey(req.params.key)));
  });

  // The buyer closes their own token once the food is served; staff can too.
  app.post("/api/public/tokens/:key/close", async (req, res) => {
    const closed = await db.transaction(async () => {
      const t = await byKey(req.params.key);
      ensure(t.status !== "Pending", "This token is not paid yet.", 409);
      ensure(t.status === "Open", "This token is already closed.", 409);
      ensure(t.expires_at > now(), "This token has expired.", 409);
      await db.run(
        "UPDATE meal_tokens SET status='Closed',closed_at=? WHERE id=? AND status='Open'",
        now(),
        t.id,
      );
      await audit(
        { name: "Visitor" },
        "Meal token closed by visitor",
        `T-${String(t.id).padStart(4, "0")} · ${t.meal}`,
      );
      return byKey(req.params.key);
    });
    res.json(view(closed));
  });

  // The buyer's token page polls this; a checkout closed before confirming
  // still opens the token once Razorpay reports the payment.
  app.get("/api/public/tokens/:key", async (req, res) => {
    let t = await byKey(req.params.key);
    if (
      t.status === "Pending" &&
      t.created_at > new Date(Date.now() - 86_400_000).toISOString()
    ) {
      await settle(t).catch(() => undefined);
      t = await byKey(req.params.key);
    }
    res.json(view(t));
  });

  // ── Staff: live tokens, verification, closing and counter sales ──
  const staffOnly = (res: Response) => staff(res);
  app.get("/api/tokens", async (req, res) => {
    staffOnly(res);
    const date =
      typeof req.query.date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
        ? req.query.date
        : new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    // Tokens opened on that day (by IST date) and any still open from before.
    const from = new Date(`${date}T00:00:00+05:30`).toISOString(),
      to = new Date(
        new Date(`${date}T00:00:00+05:30`).getTime() + 86_400_000,
      ).toISOString();
    const rows = await db.all(
      `SELECT t.*,u.name AS issued_name,c.name AS closed_name FROM meal_tokens t
      LEFT JOIN users u ON u.id=t.issued_by LEFT JOIN users c ON c.id=t.closed_by
      WHERE t.status<>'Pending' AND ((t.opened_at>=? AND t.opened_at<?) OR (t.status='Open' AND t.expires_at>?))
      ORDER BY t.id DESC LIMIT 1000`,
      from,
      to,
      now(),
    );
    res.json({
      date,
      prices: await prices(),
      tokens: rows.map((t) => ({
        ...view(t),
        phone: t.phone,
        mode: t.mode,
        reference: t.reference,
        issued_name: t.issued_name,
        closed_name: t.closed_name,
      })),
    });
  });

  // Polled by staff screens: how many are open and the newest opened token.
  app.get("/api/tokens/live", async (_req, res) => {
    staffOnly(res);
    const open = await db.get(
      "SELECT COUNT(*) AS count FROM meal_tokens WHERE status='Open' AND expires_at>?",
      now(),
    );
    const newest = await db.get(
      "SELECT * FROM meal_tokens WHERE status<>'Pending' ORDER BY opened_at DESC, id DESC LIMIT 1",
    );
    res.json({
      open: Number(open.count),
      newest: newest ? view(newest) : null,
    });
  });

  app.post("/api/tokens", async (req, res) => {
    staffOnly(res);
    const b = req.body;
    details(b);
    ensure(["Cash", "UPI"].includes(b.mode), "Choose Cash or UPI.");
    ensure(
      b.mode === "Cash" || text(b.reference, 120),
      "Enter the UPI transaction reference.",
    );
    const amount = (await prices())[b.meal as (typeof meals)[number]];
    ensure(amount > 0, "Set a price for this meal in Settings first.", 409);
    const t = await db.transaction(async () => {
      const row = await db.get(
        "INSERT INTO meal_tokens (access_key,meal,amount,name,phone,mode,reference,status,issued_by,created_at) VALUES (?,?,?,?,?,?,?,'Pending',?,?) RETURNING id",
        randomBytes(18).toString("base64url"),
        b.meal,
        amount,
        String(b.name || "").trim(),
        String(b.phone || "").trim(),
        b.mode,
        String(b.reference || "").trim(),
        me(res).id,
        now(),
      );
      await open(row.id);
      await audit(
        me(res),
        "Meal token issued",
        `T-${String(row.id).padStart(4, "0")} · ${b.meal} · ${amount / 100} INR · ${b.mode}`,
      );
      return db.get("SELECT * FROM meal_tokens WHERE id=?", row.id);
    });
    res.status(201).json({ ...view(t), access_key: t.access_key });
  });

  app.post("/api/tokens/:id/close", async (req, res) => {
    staffOnly(res);
    const id = Number(req.params.id);
    const closed = await db.transaction(async () => {
      const t = await db.get("SELECT * FROM meal_tokens WHERE id=?", id);
      ensure(t && t.status !== "Pending", "Token not found.", 404);
      ensure(t.status === "Open", "This token is already closed.", 409);
      await db.run(
        "UPDATE meal_tokens SET status='Closed',closed_at=?,closed_by=? WHERE id=? AND status='Open'",
        now(),
        me(res).id,
        id,
      );
      await audit(
        me(res),
        "Meal token closed",
        `T-${String(id).padStart(4, "0")} · ${t.meal}${t.expires_at < now() ? " · after expiry" : ""}`,
      );
      return db.get("SELECT * FROM meal_tokens WHERE id=?", id);
    });
    res.json(view(closed));
  });
}
