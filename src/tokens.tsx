import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import { Printer, QrCode, Search, Ticket } from "lucide-react";
import { api, money, HOSTEL, type Workspace } from "./lib";
import { useConfirm, ThemeToggle } from "./operations";
import { loadCheckout } from "./gateway";

const meals = ["Breakfast", "Lunch", "Dinner"] as const;
type Token = {
  id: number;
  number: string;
  meal: string;
  amount: number;
  name: string;
  status: "Pending" | "Open" | "Closed" | "Expired";
  created_at: string;
  opened_at: string | null;
  expires_at: string | null;
  closed_at: string | null;
  phone?: string;
  mode?: string;
  reference?: string;
  issued_name?: string | null;
  closed_name?: string | null;
};
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong.";
const time = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-IN", {
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";
const left = (iso: string | null, nowMs: number) => {
  if (!iso) return "";
  const mins = Math.max(0, Math.round((Date.parse(iso) - nowMs) / 60_000));
  return mins >= 60
    ? `${Math.floor(mins / 60)} h ${mins % 60} min`
    : `${mins} min`;
};
const buyLink = () => `${window.location.origin}/token`;

function useNow(ms = 30_000) {
  const [nowMs, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return nowMs;
}

function QrImage({ text, size = 280 }: { text: string; size?: number }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    void QRCode.toDataURL(text, { width: size * 2, margin: 1 }).then(setSrc);
  }, [text, size]);
  return src ? (
    <img src={src} width={size} height={size} alt={`QR code for ${text}`} />
  ) : null;
}

// The big token card a visitor shows at the counter.
export function TokenCard({ t, children }: { t: Token; children?: ReactNode }) {
  const nowMs = useNow(15_000);
  const label =
    t.status === "Open"
      ? "OPEN"
      : t.status === "Closed"
        ? "SERVED · CLOSED"
        : t.status === "Expired"
          ? "EXPIRED"
          : "CONFIRMING PAYMENT";
  return (
    <div className={`token-card token-${t.status.toLowerCase()}`}>
      <div className="token-state">{label}</div>
      <div className="token-number">{t.number}</div>
      <div className="token-meal">
        {t.meal} · {money(t.amount)}
      </div>
      {t.name && <div className="token-name">{t.name}</div>}
      {t.status === "Open" && (
        <div className="token-time">
          Valid until {time(t.expires_at)} · {left(t.expires_at, nowMs)} left
        </div>
      )}
      {t.status === "Closed" && (
        <div className="token-time">Served at {time(t.closed_at)}</div>
      )}
      {t.status === "Expired" && (
        <div className="token-time">Expired at {time(t.expires_at)}</div>
      )}
      {t.status === "Pending" && (
        <div className="token-time">
          This updates by itself once Razorpay confirms your payment.
        </div>
      )}
      {children}
    </div>
  );
}

// ── Public: scan the mess QR, pay, show the token ──
const savedKeys = () => {
  try {
    return JSON.parse(localStorage.getItem("jss_tokens") || "[]") as string[];
  } catch {
    return [];
  }
};
const saveKey = (key: string) =>
  localStorage.setItem(
    "jss_tokens",
    JSON.stringify([key, ...savedKeys().filter((k) => k !== key)].slice(0, 10)),
  );

export function PublicTokenPage({ tokenKey }: { tokenKey?: string }) {
  const [key, setKey] = useState(tokenKey);
  const go = (next?: string) => {
    window.history.pushState({}, "", next ? `/token/${next}` : "/token");
    setKey(next);
  };
  useEffect(() => {
    const back = () =>
      setKey(window.location.pathname.split("/token/")[1] || undefined);
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  return (
    <div className="appeal-page token-page">
      <header className="appeal-header">
        <a href="/token" className="appeal-brand">
          {HOSTEL.short} <span>Mess</span>
        </a>
        <ThemeToggle />
      </header>
      <main className="appeal-card">
        {key ? (
          <TokenView tokenKey={key} onBuy={() => go()} />
        ) : (
          <Buy onBought={go} />
        )}
      </main>
    </div>
  );
}

function TokenView({
  tokenKey,
  onBuy,
}: {
  tokenKey: string;
  onBuy: () => void;
}) {
  const [t, setT] = useState<Token | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let stop = false;
    const load = () =>
      api<Token>(`/public/tokens/${tokenKey}`)
        .then((token) => !stop && setT(token))
        .catch((e) => !stop && setError(errorText(e)));
    void load();
    const timer = setInterval(load, 10_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [tokenKey]);
  if (error)
    return (
      <section className="panel appeal-cta">
        <h2>Token not found</h2>
        <p>{error}</p>
        <button className="button" onClick={onBuy}>
          Buy a meal token
        </button>
      </section>
    );
  if (!t) return <div className="loader" />;
  return (
    <>
      <TokenCard t={t} />
      <section className="panel appeal-cta">
        <p>
          Show this screen at the mess counter. Staff close the token when your
          meal is served. An unused token expires 2 hours after payment.
        </p>
        <button className="button secondary" onClick={onBuy}>
          Buy another token
        </button>
      </section>
    </>
  );
}

function Buy({ onBought }: { onBought: (key: string) => void }) {
  const [menu, setMenu] = useState<{
    hostel: string;
    online: boolean;
    hours: number;
    meals: { meal: string; amount: number }[];
  } | null>(null);
  const [meal, setMeal] = useState("");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [mine, setMine] = useState<{ key: string; token: Token }[]>([]);
  useEffect(() => {
    api<NonNullable<typeof menu>>("/public/tokens/menu")
      .then((m) => {
        setMenu(m);
        setMeal(m.meals[0]?.meal ?? "");
      })
      .catch((e) => setError(errorText(e)));
    // Tokens bought earlier on this phone that are still usable.
    void Promise.all(
      savedKeys().map((key) =>
        api<Token>(`/public/tokens/${key}`)
          .then((token) => ({ key, token }))
          .catch(() => null),
      ),
    ).then((list) =>
      setMine(
        list.filter(
          (x): x is { key: string; token: Token } =>
            !!x && ["Open", "Pending"].includes(x.token.status),
        ),
      ),
    );
  }, []);
  if (!menu)
    return error ? (
      <p className="notice danger">{error}</p>
    ) : (
      <div className="loader" />
    );
  const price = menu.meals.find((m) => m.meal === meal)?.amount ?? 0;
  return (
    <>
      {!!mine.length && (
        <section className="panel appeal-cta">
          <h2>Your open tokens</h2>
          <div className="token-mine">
            {mine.map(({ key, token }) => (
              <button
                key={key}
                className="button secondary"
                onClick={() => onBought(key)}
              >
                <Ticket size={15} /> {token.number} · {token.meal} ·{" "}
                {token.status}
              </button>
            ))}
          </div>
        </section>
      )}
      <section className="panel appeal-cta">
        <div className="eyebrow">MEAL TOKEN</div>
        <h1 className="token-title">Buy a meal token</h1>
        <p>
          {menu.hostel || HOSTEL.name} mess. Choose your meal and pay with UPI
          or card. You get a token number right away, valid for {menu.hours}{" "}
          hours.
        </p>
        {!menu.meals.length ? (
          <p className="notice">Meal tokens are not on sale right now.</p>
        ) : !menu.online ? (
          <p className="notice">
            Online payment is not available. Please pay at the counter; staff
            will give you a token.
          </p>
        ) : (
          <form
            className="settings-form token-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await loadCheckout();
                const order = await api<{
                  key: string;
                  key_id: string;
                  order_id: string;
                  amount: number;
                }>("/public/tokens", { meal });
                saveKey(order.key);
                new window.Razorpay!({
                  key: order.key_id,
                  order_id: order.order_id,
                  amount: order.amount,
                  currency: "INR",
                  name: `${HOSTEL.short} Mess`,
                  description: `${meal} token`,
                  method: {
                    card: true,
                    upi: true,
                    netbanking: false,
                    wallet: false,
                    emi: false,
                    paylater: false,
                  },
                  theme: { color: "#16634b" },
                  handler: async (result: Record<string, string>) => {
                    try {
                      await api(`/public/tokens/${order.key}/confirm`, result);
                    } finally {
                      onBought(order.key);
                    }
                  },
                  modal: {
                    ondismiss: () => {
                      setBusy(false);
                      setError(
                        "Payment was not completed. No money was taken.",
                      );
                    },
                  },
                }).open();
              } catch (err) {
                setError(errorText(err));
                setBusy(false);
              }
            }}
          >
            <fieldset className="token-meals">
              <legend>Meal</legend>
              {menu.meals.map((m) => (
                <label
                  key={m.meal}
                  className={meal === m.meal ? "selected" : ""}
                >
                  <input
                    type="radio"
                    name="meal"
                    value={m.meal}
                    checked={meal === m.meal}
                    onChange={() => setMeal(m.meal)}
                  />
                  <span>{m.meal}</span>
                  <strong>{money(m.amount)}</strong>
                </label>
              ))}
            </fieldset>
            {error && (
              <p className="notice danger" role="alert">
                {error}
              </p>
            )}
            <button className="button token-pay" disabled={busy || !price}>
              {busy
                ? "Opening payment…"
                : `Pay ${money(price)} with UPI or card`}
            </button>
          </form>
        )}
      </section>
    </>
  );
}

// ── Admin: price per meal ──
export function MealPricesSettings({
  data,
  onSaved,
}: {
  data: Workspace;
  onSaved: (message: string) => Promise<void>;
}) {
  let saved: Record<string, number> = {};
  try {
    saved = JSON.parse(data.settings.meal_prices || "{}");
  } catch {
    saved = {};
  }
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <section className="panel operation-form">
      <div className="panel-heading">
        <div>
          <h2>Meal token prices</h2>
          <p>
            What a visitor pays for one meal token, online from the mess QR code
            or at the counter. Leave 0 to stop selling a meal.
          </p>
        </div>
      </div>
      <form
        className="settings-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setBusy(true);
          setError("");
          try {
            await api(
              "/meal-prices",
              Object.fromEntries(
                meals.map((m) => [m, Math.round(Number(f.get(m) || 0) * 100)]),
              ),
            );
            await onSaved("Meal token prices saved.");
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          {meals.map((m) => (
            <label key={m} className="field">
              <span>{m} (₹)</span>
              <input
                name={m}
                type="number"
                min="0"
                max="1000"
                step="1"
                defaultValue={(saved[m] ?? 0) / 100}
              />
            </label>
          ))}
        </div>
        {error && <p className="notice danger">{error}</p>}
        <button className="button" disabled={busy}>
          {busy ? "Saving…" : "Save prices"}
        </button>
      </form>
    </section>
  );
}

// ── Staff: live tokens, counter sales, the mess QR ──
export function TokensPage({
  data,
  onSaved,
}: {
  data: Workspace;
  onSaved: (message: string) => Promise<void>;
}) {
  const [list, setList] = useState<{
    date: string;
    prices: Record<string, number>;
    tokens: Token[];
  } | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("Open");
  const [issued, setIssued] = useState<Token | null>(null);
  const [fresh, setFresh] = useState<Token[]>([]);
  const [qr, setQr] = useState(false);
  const seen = useRef<Set<number> | null>(null);
  const { ask, dialog } = useConfirm();
  const qrRef = useRef<HTMLDialogElement>(null);
  const load = async () => {
    try {
      const next = await api<NonNullable<typeof list>>("/tokens");
      // Tokens that opened since the last look are announced at the top.
      if (seen.current) {
        const added = next.tokens.filter(
          (t) => t.status === "Open" && !seen.current!.has(t.id),
        );
        if (added.length) setFresh((f) => [...added, ...f].slice(0, 5));
      }
      seen.current = new Set(next.tokens.map((t) => t.id));
      setList(next);
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    void load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (qr && qrRef.current && !qrRef.current.open) qrRef.current.showModal();
  }, [qr]);
  if (!list)
    return (
      <section className="panel">
        <p className="empty">{error || "Loading tokens…"}</p>
      </section>
    );
  const priced = meals.filter((m) => list.prices[m] > 0);
  const today = list.tokens;
  const shown = list.tokens.filter(
    (t) =>
      (filter === "All" || t.status === filter) &&
      (!query ||
        `${t.number} ${t.name} ${t.phone}`
          .toLowerCase()
          .includes(query.trim().toLowerCase())),
  );
  const total = (mode?: string) =>
    today
      .filter((t) => !mode || t.mode === mode)
      .reduce((sum, t) => sum + t.amount, 0);
  const close = async (t: Token) => {
    if (
      !(await ask({
        title: `Close ${t.number}?`,
        body: `${t.meal} for ${t.name || "a visitor"}. Close it once the meal is served; it cannot be reopened.`,
        confirm: "Close token",
      }))
    )
      return;
    try {
      await api(`/tokens/${t.id}/close`, {});
      setFresh((f) => f.filter((x) => x.id !== t.id));
      await load();
      await onSaved(`${t.number} closed.`);
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <div className="sponsor-page">
      {dialog}
      {qr &&
        // Rendered on <body> so printing shows just the poster.
        createPortal(
          <dialog
            ref={qrRef}
            className="modal token-qr-modal"
            onCancel={(e) => {
              e.preventDefault();
              setQr(false);
            }}
          >
            <div className="modal-body token-poster">
              <div className="eyebrow">{HOSTEL.short} MESS</div>
              <h2>Scan to buy a meal token</h2>
              <QrImage text={buyLink()} size={300} />
              <p>
                Pay with UPI or card. Show your green token at the counter.
                Tokens are valid for 2 hours.
              </p>
              <p className="share-link">{buyLink()}</p>
              <div className="modal-actions">
                <button
                  className="button secondary"
                  onClick={() => setQr(false)}
                >
                  Close
                </button>
                <button className="button" onClick={() => window.print()}>
                  <Printer size={15} /> Print poster
                </button>
              </div>
            </div>
          </dialog>,
          document.body,
        )}
      {error && <p className="notice danger">{error}</p>}
      {!!fresh.length && (
        <section className="panel token-fresh" role="status">
          <strong>New tokens opened</strong>
          {fresh.map((t) => (
            <span key={t.id}>
              {t.number} · {t.meal} · {t.name || "Visitor"} ·{" "}
              {time(t.opened_at)}
            </span>
          ))}
          <button className="text-button" onClick={() => setFresh([])}>
            Dismiss
          </button>
        </section>
      )}
      <section className="panel sponsor-summary">
        <div>
          <span>Open now</span>
          <strong>
            {list.tokens.filter((t) => t.status === "Open").length}
          </strong>
        </div>
        <div>
          <span>Tokens today</span>
          <strong>{today.length}</strong>
        </div>
        <div>
          <span>Collected today</span>
          <strong>{money(total())}</strong>
          <small className="cell-sub">
            Online {money(total("Online"))} · Cash {money(total("Cash"))} · UPI{" "}
            {money(total("UPI"))}
          </small>
        </div>
      </section>
      <div className="token-tools">
        <button className="button" onClick={() => setQr(true)}>
          <QrCode size={15} /> Show mess QR code
        </button>
        {!priced.length && (
          <p className="notice">
            {data.user.role === "Admin"
              ? "Set meal prices in Settings to start selling tokens."
              : "The Admin has not set meal prices yet."}
          </p>
        )}
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Tokens</h2>
            <p>
              Updates every few seconds. Verify the number the visitor shows,
              then close the token when the meal is served.
            </p>
          </div>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Show"
          >
            {["Open", "Closed", "Expired", "All"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="token-search">
          <Search size={15} />
          <input
            placeholder="Verify a token: number, name or phone"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search tokens"
          />
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th>Meal</th>
                <th>Visitor</th>
                <th>Paid</th>
                <th>Opened</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.id}>
                  <td>
                    <strong>{t.number}</strong>
                  </td>
                  <td>{t.meal}</td>
                  <td>
                    {t.name || "Visitor"}
                    <small className="cell-sub">{t.phone || "—"}</small>
                  </td>
                  <td>
                    {money(t.amount)}
                    <small className="cell-sub">
                      {t.mode}
                      {t.reference ? ` · ${t.reference}` : ""}
                      {t.issued_name ? ` · by ${t.issued_name}` : ""}
                    </small>
                  </td>
                  <td>
                    {time(t.opened_at)}
                    {t.status === "Open" && (
                      <small className="cell-sub">
                        until {time(t.expires_at)}
                      </small>
                    )}
                  </td>
                  <td>
                    <span
                      className={`badge token-badge-${t.status.toLowerCase()}`}
                    >
                      {t.status}
                    </span>
                    {t.closed_name && (
                      <small className="cell-sub">
                        by {t.closed_name} · {time(t.closed_at)}
                      </small>
                    )}
                  </td>
                  <td>
                    {["Open", "Expired"].includes(t.status) && (
                      <button
                        className="button secondary"
                        onClick={() => close(t)}
                      >
                        Close
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!shown.length && (
            <div className="empty">
              <h3>
                {query
                  ? "No token matches"
                  : `No ${filter === "All" ? "" : filter.toLowerCase()} tokens today`}
              </h3>
            </div>
          )}
        </div>
      </section>
      <section className="panel operation-form">
        <div className="panel-heading">
          <div>
            <h2>Issue a token at the counter</h2>
            <p>
              For visitors paying in cash or UPI who can’t use the QR code.
              Their details are recorded with the token.
            </p>
          </div>
        </div>
        {issued && (
          <div className="token-issued">
            <TokenCard t={issued} />
          </div>
        )}
        <form
          className="settings-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            try {
              const t = await api<Token>("/tokens", {
                meal: f.get("meal"),
                name: f.get("name"),
                phone: f.get("phone"),
                mode: f.get("mode"),
                reference: f.get("reference"),
              });
              setIssued(t);
              form.reset();
              await load();
              await onSaved(`${t.number} issued.`);
            } catch (err) {
              setError(errorText(err));
            }
          }}
        >
          <div className="form-grid">
            <label className="field">
              <span>Meal</span>
              <select name="meal" required>
                {priced.map((m) => (
                  <option key={m} value={m}>
                    {m} · {money(list.prices[m])}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Paid by</span>
              <select name="mode">
                <option>Cash</option>
                <option>UPI</option>
              </select>
            </label>
            <label className="field">
              <span>Visitor name — optional</span>
              <input name="name" maxLength={80} />
            </label>
            <label className="field">
              <span>Phone — optional</span>
              <input name="phone" type="tel" />
            </label>
            <label className="field wide">
              <span>UPI reference (for UPI payments)</span>
              <input name="reference" maxLength={120} />
            </label>
          </div>
          <button className="button" disabled={!priced.length}>
            <Ticket size={15} /> Issue token
          </button>
        </form>
      </section>
    </div>
  );
}
