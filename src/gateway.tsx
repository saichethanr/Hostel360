import { useEffect, useState } from "react";
import { CreditCard, ShieldCheck } from "lucide-react";
import { api, money, type Workspace } from "./lib";

type Order = {
  id: string;
  student_id: number;
  category: string;
  amount: number;
  status: string;
  detail: string;
  payment_id: number | null;
  receipt: string | null;
  provider_payment_id: string | null;
  refunded_amount: number;
  checked_at: string | null;
  last_error: string;
  key_id?: string;
  order_id?: string;
  test?: boolean;
};
type GatewayState = {
  enabled: boolean;
  test?: boolean;
  orders: Order[];
  next_cursor?: string;
  health?: {
    review_count: number;
    error_count: number;
    next_check_at: string | null;
  };
};
type CheckoutResult = {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
};
declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => {
      open: () => void;
      on: (event: string, handler: () => void) => void;
    };
  }
}
let loading: Promise<void> | undefined;
async function loadCheckout() {
  if (window.Razorpay) return;
  if (!loading)
    loading = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      const timer = window.setTimeout(() => {
        script.remove();
        reject(
          new Error(
            "Checkout could not load. Check your connection and try again.",
          ),
        );
      }, 15_000);
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      script.onerror = () => {
        clearTimeout(timer);
        script.remove();
        reject(
          new Error(
            "Checkout could not load. Check your connection and try again.",
          ),
        );
      };
      document.head.appendChild(script);
    }).catch((error) => {
      loading = undefined;
      throw error;
    });
  await loading;
  if (!window.Razorpay)
    throw new Error("Checkout is unavailable. Please try again.");
}

export function OnlinePayments({
  data,
  onSaved,
  onReceipt,
}: {
  data: Workspace;
  onSaved: (message: string) => Promise<void>;
  onReceipt: (id: number) => void;
}) {
  const [gateway, setGateway] = useState<GatewayState | null>(null);
  const [student, setStudent] = useState(
    data.user.student_id || data.students[0]?.id || 0,
  );
  const [category, setCategory] = useState("Mess");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [reconciling, setReconciling] = useState<Order | null>(null);
  const [reason, setReason] = useState("");
  const url = `/gateway?student_id=${student}`;
  const reload = async () => setGateway(await api<GatewayState>(url));
  useEffect(() => {
    let cancelled = false;
    void api<GatewayState>(url)
      .then((result) => {
        if (!cancelled) setGateway(result);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [data, student]);
  const outstanding = data.demands
    .filter(
      (d) =>
        d.student_id === student && d.category === category && d.balance > 0,
    )
    .reduce((sum, d) => sum + d.balance, 0);
  const orders = gateway?.orders.filter((o) => o.student_id === student) || [];
  const review = !!gateway?.health?.review_count;
  const pending = orders.some((o) =>
    ["open", "creating", "authorized", "review"].includes(o.status),
  );
  const authorized = orders.some(
    (o) => o.category === category && o.status === "authorized",
  );
  useEffect(() => {
    if (!pending || busy || reconciling || orders.length > 50) return;
    let cancelled = false,
      checking = false;
    const timer = window.setInterval(async () => {
      if (checking || document.hidden) return;
      checking = true;
      try {
        const latest = await api<GatewayState>(url);
        if (cancelled) return;
        setGateway(latest);
        if (
          latest.orders.some(
            (o) =>
              o.student_id === student &&
              ["paid", "review", "refunded", "partially_refunded"].includes(
                o.status,
              ) &&
              orders.some(
                (old) =>
                  old.id === o.id &&
                  (old.status !== o.status ||
                    old.refunded_amount !== o.refunded_amount),
              ),
          )
        ) {
          setMessage(
            "Payment status updated. Your current balance and receipt are shown below.",
          );
          await onSaved("Payment status updated automatically.");
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        checking = false;
      }
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pending, busy, student, gateway, reconciling]);
  const older = async () => {
    if (!gateway?.next_cursor) return;
    setBusy(true);
    setError("");
    try {
      const next = await api<GatewayState>(
        `${url}&before=${gateway.next_cursor}`,
      );
      setGateway({ ...next, orders: [...gateway.orders, ...next.orders] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const reconcile = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!reconciling) return;
    setBusy(true);
    setError("");
    try {
      await settled(
        await api<Order>(`/gateway/orders/${reconciling.id}/reconcile`, {
          reason,
        }),
      );
      setReconciling(null);
      setReason("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const settled = async (order: Order) => {
    if (order.status === "paid") {
      setMessage(
        `Payment recorded. Receipt ${order.receipt} is ready. Fully settled fees are now marked Paid.`,
      );
      await onSaved(
        "Online payment verified. Your balance and receipt are updated.",
      );
    } else {
      setMessage(
        order.detail ||
          "Payment is not confirmed yet. Check status before paying again.",
      );
      await onSaved("Payment status refreshed.");
    }
    await reload();
  };
  const check = async (order: Order) => {
    setBusy(true);
    setError("");
    try {
      await settled(await api<Order>(`/gateway/orders/${order.id}/check`, {}));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pay = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await loadCheckout();
      const order = await api<Order>("/gateway/orders", {
        student_id: student,
        category,
        request_key: crypto.randomUUID(),
      });
      await reload();
      if (order.status !== "open") {
        await settled(order);
        setBusy(false);
        return;
      }
      const profile = data.students.find((s) => s.id === student);
      const checkout = new window.Razorpay!({
        key: order.key_id,
        order_id: order.order_id,
        amount: order.amount,
        currency: "INR",
        name: data.community?.name || data.settings.hostel_name,
        description: `${order.category} fees`,
        prefill: {
          name: profile?.name,
          contact: profile?.phone,
          ...(data.user.role === "Student" ? { email: data.user.email } : {}),
        },
        method: {
          card: true,
          upi: true,
          netbanking: false,
          wallet: false,
          emi: false,
          paylater: false,
        },
        theme: { color: "#16634b" },
        handler: async (result: CheckoutResult) => {
          setBusy(true);
          try {
            await settled(
              await api<Order>(`/gateway/orders/${order.id}/confirm`, result),
            );
          } catch (e) {
            setError(
              `${(e as Error).message} If money was deducted, do not pay again; use Check status.`,
            );
          } finally {
            setBusy(false);
          }
        },
        modal: {
          ondismiss: () => {
            setBusy(false);
            setMessage(
              "Checkout closed. If money was deducted, use Check status before trying again.",
            );
          },
        },
      });
      checkout.on("payment.failed", () =>
        setMessage(
          "Payment attempt failed. No receipt is issued until payment is verified. You can retry in checkout or close it and check status.",
        ),
      );
      checkout.open();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      await reload().catch(() => {});
    }
  };
  return (
    <section className="panel online-payments">
      <div className="panel-heading">
        <div>
          <h2>
            <CreditCard size={20} /> Pay online
          </h2>
          <p>
            UPI or card · Verified payments automatically update fees and
            generate receipts.
          </p>
        </div>
        {gateway?.test && (
          <span className="badge amber">Test mode · no real money</span>
        )}
      </div>
      {!gateway ? (
        <p role="status">
          {error
            ? "Payment status could not be loaded."
            : "Checking payment availability…"}{" "}
          {error && (
            <button
              className="text-button"
              onClick={() => void reload().catch((e) => setError(e.message))}
            >
              Retry
            </button>
          )}
        </p>
      ) : (
        <>
          {!gateway.enabled && (
            <p className="notice">
              New online payments are paused or not configured. Existing payment
              history remains available; contact your Admin.
            </p>
          )}
          {!!gateway.health?.error_count && (
            <p className="notice danger" role="alert">
              {gateway.health.error_count} payment check(s) need attention. Use
              Check status; do not pay again if money was deducted.
            </p>
          )}
          <div className="online-payment-form">
            {data.user.role !== "Student" && (
              <label className="field">
                <span>Student</span>
                <select
                  aria-label="Online payment student"
                  value={student}
                  disabled={busy}
                  onChange={(e) => {
                    setStudent(Number(e.target.value));
                    setMessage("");
                    setReconciling(null);
                    setReason("");
                    setError("");
                    setGateway(null);
                  }}
                >
                  <option value={0}>Select a student</option>
                  {data.students.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {s.roll}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              <span>Fee category</span>
              <select
                aria-label="Online payment category"
                disabled={busy}
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  setMessage("");
                }}
              >
                {["Mess", "Fund", "Management", "Establishment"].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <div>
              <small>Outstanding in this category</small>
              <strong className="online-total">{money(outstanding)}</strong>
            </div>
            <button
              className="button"
              disabled={
                busy ||
                !gateway.enabled ||
                !student ||
                outstanding <= 0 ||
                review ||
                authorized
              }
              onClick={pay}
            >
              {busy
                ? "Processing…"
                : !gateway.enabled
                  ? "Payments paused"
                  : authorized
                    ? "Awaiting capture"
                    : outstanding <= 0
                      ? "No balance due"
                      : `Pay ${money(outstanding)} · UPI / Card`}
            </button>
          </div>
          <p className="online-hint">
            <ShieldCheck size={15} /> Card details and UPI approval are handled
            by Razorpay. Pay one category at a time.
          </p>
          {review && (
            <p className="notice danger" role="alert">
              A payment needs Admin review. Do not pay again. The recorded
              gateway transaction remains available below.
            </p>
          )}
          {reconciling && (
            <form className="notice reconciliation-form" onSubmit={reconcile}>
              <h3>Reconcile captured payment</h3>
              <p>
                Apply {money(reconciling.amount - reconciling.refunded_amount)}{" "}
                retained from {reconciling.provider_payment_id} to this
                student's current {reconciling.category} fees, oldest first. No
                new charge is made. If money exceeds the fees, refund the excess
                in Razorpay before continuing.
              </p>
              <label className="field">
                <span>Reconciliation reason</span>
                <textarea
                  required
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={busy}
                />
              </label>
              <button className="button" disabled={busy || !reason.trim()}>
                Confirm allocation
              </button>{" "}
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => setReconciling(null)}
              >
                Cancel
              </button>
            </form>
          )}
          {!!orders.length && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Online payment</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Receipt / action</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id}>
                      <td>
                        {o.category}
                        <small>
                          {o.provider_payment_id || "Checkout request"}
                        </small>
                        {o.detail && <small>{o.detail}</small>}
                        {o.last_error && (
                          <small className="amber-text">{o.last_error}</small>
                        )}
                        {o.checked_at && (
                          <small>
                            Checked {new Date(o.checked_at).toLocaleString()}
                          </small>
                        )}
                      </td>
                      <td className="amount">
                        {money(o.amount)}
                        {o.refunded_amount > 0 && (
                          <small>
                            Refunded {money(o.refunded_amount)} · Net{" "}
                            {money(o.amount - o.refunded_amount)}
                          </small>
                        )}
                      </td>
                      <td>
                        {{
                          open: "Awaiting confirmation",
                          creating: "Preparing checkout",
                          authorized: "Awaiting capture",
                          paid: "Paid",
                          partially_refunded: "Partly refunded",
                          superseded: "Replaced checkout",
                          review: "Admin review required",
                          refunded: "Refunded",
                          creation_failed: "Not started",
                        }[o.status] || o.status}
                      </td>
                      <td>
                        {o.payment_id && (
                          <button
                            className="text-button"
                            onClick={() => onReceipt(o.payment_id!)}
                          >
                            {o.receipt}
                          </button>
                        )}
                        {[
                          "open",
                          "creating",
                          "authorized",
                          "review",
                          "paid",
                          "partially_refunded",
                          "superseded",
                        ].includes(o.status) && (
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() => void check(o)}
                          >
                            Check status
                          </button>
                        )}
                        {o.status === "review" &&
                          data.user.role === "Admin" && (
                            <button
                              className="text-button"
                              disabled={busy}
                              onClick={() => {
                                setReconciling(o);
                                setReason("");
                                setError("");
                              }}
                            >
                              Reconcile payment
                            </button>
                          )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {gateway.next_cursor && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() => void older()}
            >
              Load older payments
            </button>
          )}
        </>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="notice danger" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
