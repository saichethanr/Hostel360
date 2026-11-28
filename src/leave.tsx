import { useEffect, useState, type FormEvent } from "react";
import { ChevronLeft, ChevronRight, FileText } from "lucide-react";
import { api, dateName, type Workspace } from "./lib";
import { useConfirm } from "./operations";

type Holiday = { id: number; date: string; name: string };

type Leave = {
  id: number;
  student_id: number;
  name: string;
  code: string;
  room: string;
  type: "Casual" | "Medical";
  start_date: string;
  end_date: string;
  reason: string;
  status: "Pending" | "Approved" | "Rejected" | "Cancelled";
  document_id: number | null;
  document_name: string | null;
  decision_reason: string;
  decided_name: string | null;
  // 1: approved days are free of mess charges; 0: they are charged.
  concession: number;
  requested_name: string | null;
  requested_role: string | null;
};

const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong.";
const shift = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const dayCount = (start: string, end: string) =>
  start && end && end >= start
    ? Math.round(
        (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
          86_400_000,
      ) + 1
    : 0;
const covers = (l: Leave, date: string) =>
  l.start_date <= date && l.end_date >= date;
const live = (l: Leave) => l.status === "Approved" || l.status === "Pending";
const readFile = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(Error("Could not read the file."));
    reader.readAsDataURL(file);
  });

// One page per role: students apply and see their own days; the Warden or Admin
// decides requests; Admin and Managers see who is on leave each day.
export function LeavePage({
  data,
  onSaved,
}: {
  data: Workspace;
  onSaved: (message: string) => Promise<void>;
}) {
  const [leaves, setLeaves] = useState<Leave[] | null>(null);
  const [error, setError] = useState("");
  const role = data.user.role;
  const reload = async () => {
    try {
      setLeaves(await api<Leave[]>("/leaves"));
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    void reload();
  }, [data]);
  const saved = async (message: string) => {
    await reload();
    await onSaved(message);
  };
  if (!leaves)
    return (
      <section className="panel">
        <p className="empty">{error || "Loading leave…"}</p>
      </section>
    );
  return (
    <div className="leave-page">
      {error && <p className="notice danger">{error}</p>}
      {role === "Student" && (
        <ApplyLeave data={data} leaves={leaves} onSaved={saved} />
      )}
      {(role === "Warden" || role === "Admin") && (
        <>
          <Decisions leaves={leaves} onSaved={saved} />
          <ApplyLeave data={data} leaves={leaves} onSaved={saved} staff />
        </>
      )}
      <LeaveCalendar
        today={data.today}
        leaves={leaves}
        holidays={data.holidays ?? []}
        own={role === "Student"}
      />
      <LeaveHistory leaves={leaves} own={role === "Student"} onSaved={saved} />
    </div>
  );
}

// Students apply for themselves; a Warden or Admin records leave for a
// student, approved at once with their concession decision.
function ApplyLeave({
  data,
  leaves,
  onSaved,
  staff = false,
}: {
  data: Workspace;
  leaves: Leave[];
  onSaved: (message: string) => Promise<void>;
  staff?: boolean;
}) {
  const [type, setType] = useState("Casual");
  const [student, setStudent] = useState("");
  const [concession, setConcession] = useState(true);
  const students = data.students.filter(
    (s) => s.status === "Active" && (!s.exited || s.exited >= data.today),
  );
  const [start, setStart] = useState(shift(data.today, 1));
  const [end, setEnd] = useState(shift(data.today, 1));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const days = dayCount(start, end);
  const clash = leaves.find(
    (l) =>
      live(l) &&
      (!staff || l.student_id === Number(student)) &&
      (!staff || student) &&
      l.start_date <= end &&
      l.end_date >= start,
  );
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setError("");
    try {
      // A document is optional for both types of leave.
      const file = f.get("document");
      let document;
      if (file instanceof File && file.size) {
        if (file.size > 2_000_000)
          throw Error("The document must be under 2 MB.");
        document = { name: file.name, content: await readFile(file) };
      }
      await api("/leaves", {
        type,
        start_date: start,
        end_date: end,
        reason: String(f.get("reason") || ""),
        ...(document ? { document } : {}),
        ...(staff ? { student_id: Number(student), concession } : {}),
      });
      form.reset();
      setType("Casual");
      setStart(shift(data.today, 1));
      setEnd(shift(data.today, 1));
      setStudent("");
      setConcession(true);
      await onSaved(
        staff
          ? `Leave recorded for ${students.find((s) => s.id === Number(student))?.name ?? "the student"}.`
          : "Leave request sent. The Warden and Admin have been notified.",
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel operation-form">
      <div className="panel-heading">
        <div>
          <h2>{staff ? "Record leave for a student" : "Apply for leave"}</h2>
          <p>
            {staff
              ? "Approved as soon as you save. The days are marked as Leave in attendance."
              : "The Warden or Admin reviews every request and decides whether the days are free of mess charges."}
          </p>
        </div>
      </div>
      <form className="settings-form" onSubmit={submit}>
        <div className="form-grid">
          {staff && (
            <label className="field wide">
              <span>Student</span>
              <select
                required
                value={student}
                onChange={(e) => setStudent(e.target.value)}
              >
                <option value="">Choose a student…</option>
                {students.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.code} · Room {s.room || "—"}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>Type of leave</span>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option>Casual</option>
              <option>Medical</option>
            </select>
          </label>
          <div className="field leave-days">
            <span>Days</span>
            <strong>
              {days ? `${days} day${days === 1 ? "" : "s"}` : "—"}
            </strong>
          </div>
          <label className="field">
            <span>From</span>
            <input
              type="date"
              required
              value={start}
              onChange={(e) => {
                setStart(e.target.value);
                if (end < e.target.value) setEnd(e.target.value);
              }}
            />
          </label>
          <label className="field">
            <span>To</span>
            <input
              type="date"
              required
              min={start}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
          <label className="field wide">
            <span>Reason</span>
            <textarea name="reason" required maxLength={500} />
          </label>
          <label className="field wide">
            <span>
              {type === "Medical" ? "Medical document" : "Supporting document"}{" "}
              — optional (PDF, JPG or PNG, up to 2 MB)
            </span>
            <input
              type="file"
              name="document"
              accept="application/pdf,image/png,image/jpeg"
            />
          </label>
          {staff && (
            <Concession
              checked={concession}
              onChange={setConcession}
              className="wide"
            />
          )}
        </div>
        {clash && (
          <p className="notice danger">
            {staff ? `${clash.name} already has` : "You already have"} leave
            from {dateName(clash.start_date)} to {dateName(clash.end_date)}.
            Choose other days.
          </p>
        )}
        {error && (
          <p className="notice danger" role="alert">
            {error}
          </p>
        )}
        <button
          className="button"
          disabled={busy || !days || !!clash || (staff && !student)}
        >
          {busy
            ? "Saving…"
            : staff
              ? "Record approved leave"
              : "Send leave request"}
        </button>
      </form>
    </section>
  );
}

function Decisions({
  leaves,
  onSaved,
}: {
  leaves: Leave[];
  onSaved: (message: string) => Promise<void>;
}) {
  const waiting = leaves
    .filter((l) => l.status === "Pending")
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  const [reasons, setReasons] = useState<Record<number, string>>({});
  // Concession is ticked by default; untick to charge mess for the days.
  const [noConcession, setNoConcession] = useState<Set<number>>(new Set());
  const [rejecting, setRejecting] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const decide = async (l: Leave, status: "Approved" | "Rejected") => {
    setBusy(true);
    setError("");
    try {
      await api(`/leaves/${l.id}/review`, {
        status,
        reason: reasons[l.id] || "",
        ...(status === "Approved"
          ? { concession: !noConcession.has(l.id) }
          : {}),
      });
      setRejecting(null);
      await onSaved(
        status === "Approved"
          ? `${l.name}'s leave approved${noConcession.has(l.id) ? " without a mess concession" : " with a mess concession"}.`
          : `${l.name}'s leave rejected.`,
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>
            Waiting for your decision{" "}
            {!!waiting.length && (
              <span className="nav-count alert">{waiting.length}</span>
            )}
          </h2>
          <p>
            Review each request and any document. Decide whether the leave days
            are free of mess charges before approving.
          </p>
        </div>
      </div>
      {error && <p className="notice danger">{error}</p>}
      {!waiting.length && (
        <div className="empty">
          <h3>No requests waiting</h3>
          <p>New leave requests appear here.</p>
        </div>
      )}
      <div className="leave-requests">
        {waiting.map((l) => (
          <article key={l.id} className="leave-request">
            <div>
              <strong>{l.name}</strong>
              <small>
                {l.code} · Room {l.room}
              </small>
            </div>
            <div>
              <span className={`badge leave-${l.type.toLowerCase()}`}>
                {l.type}
              </span>{" "}
              {dateName(l.start_date)} – {dateName(l.end_date)} ·{" "}
              {dayCount(l.start_date, l.end_date)} days
            </div>
            <p>{l.reason}</p>
            {l.document_id && (
              <DocumentButton id={l.document_id} name={l.document_name} />
            )}
            {rejecting === l.id ? (
              <div className="leave-reject">
                <label className="field">
                  <span>Reason for rejecting</span>
                  <input
                    value={reasons[l.id] || ""}
                    maxLength={500}
                    onChange={(e) =>
                      setReasons({ ...reasons, [l.id]: e.target.value })
                    }
                  />
                </label>
                <button
                  className="button danger"
                  disabled={busy || !(reasons[l.id] || "").trim()}
                  onClick={() => decide(l, "Rejected")}
                >
                  Reject
                </button>
                <button
                  className="text-button"
                  onClick={() => setRejecting(null)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="leave-actions">
                <Concession
                  checked={!noConcession.has(l.id)}
                  onChange={(on) => {
                    const next = new Set(noConcession);
                    if (on) next.delete(l.id);
                    else next.add(l.id);
                    setNoConcession(next);
                  }}
                />
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => decide(l, "Approved")}
                >
                  Approve
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setRejecting(l.id)}
                >
                  Reject…
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function Concession({
  checked,
  onChange,
  className = "",
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  className?: string;
}) {
  return (
    <label className={`concession-check ${className}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <strong>Give mess concession</strong>
        <small>
          {checked
            ? "Leave days are not charged for mess."
            : "Mess is charged for these days."}
        </small>
      </span>
    </label>
  );
}

function DocumentButton({ id, name }: { id: number; name: string | null }) {
  const [error, setError] = useState("");
  return (
    <>
      <button
        className="button secondary small"
        onClick={async () => {
          try {
            const r = await api<{ url: string }>(`/documents/${id}`);
            window.open(r.url, "_blank", "noopener");
          } catch (e) {
            setError(errorText(e));
          }
        }}
      >
        <FileText size={14} /> {name || "Document"}
      </button>
      {error && <small className="danger-text"> {error}</small>}
    </>
  );
}

// A month at a glance. Students see their own leave days; staff see how many
// students are on approved leave each day and who they are.
function LeaveCalendar({
  today,
  leaves,
  holidays,
  own,
}: {
  today: string;
  leaves: Leave[];
  holidays: Holiday[];
  own: boolean;
}) {
  const [month, setMonth] = useState(today.slice(0, 7));
  const [picked, setPicked] = useState(today);
  const first = new Date(`${month}-01T00:00:00Z`);
  const lead = (first.getUTCDay() + 6) % 7; // Monday first
  const length = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const cells = [
    ...Array.from({ length: lead }, () => ""),
    ...Array.from(
      { length },
      (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`,
    ),
  ];
  const move = (by: number) => {
    const d = new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + by, 1),
    );
    setMonth(d.toISOString().slice(0, 7));
  };
  const onDay = (date: string) =>
    leaves.filter((l) => live(l) && covers(l, date));
  const pickedLeaves = onDay(picked);
  return (
    <section className="panel leave-calendar">
      <div className="panel-heading">
        <div>
          <h2>{own ? "My leave calendar" : "Leave calendar"}</h2>
          <p>
            {own
              ? "Your approved and pending leave days."
              : "How many students are on leave each day. Pick a day to see who."}
          </p>
        </div>
        <div className="calendar-nav">
          <button
            className="button secondary small"
            aria-label="Previous month"
            onClick={() => move(-1)}
          >
            <ChevronLeft size={16} />
          </button>
          <strong>
            {first.toLocaleDateString("en-IN", {
              month: "long",
              year: "numeric",
              timeZone: "UTC",
            })}
          </strong>
          <button
            className="button secondary small"
            aria-label="Next month"
            onClick={() => move(1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      <div className="calendar-grid" role="grid">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="calendar-head">
            {d}
          </div>
        ))}
        {cells.map((date, i) => {
          if (!date) return <div key={`blank-${i}`} />;
          const list = onDay(date);
          const holiday = holidays.find((h) => h.date === date);
          const approved = list.filter((l) => l.status === "Approved");
          const pending = list.length - approved.length;
          const mine = own ? list[0] : undefined;
          return (
            <button
              key={date}
              className={[
                "calendar-day",
                date === today ? "today" : "",
                date === picked ? "picked" : "",
                holiday ? "holiday" : "",
                mine
                  ? `has-leave ${mine.status.toLowerCase()} ${mine.type.toLowerCase()}`
                  : approved.length
                    ? "has-leave approved"
                    : pending
                      ? "has-leave pending"
                      : "",
              ].join(" ")}
              aria-label={`${dateName(date)}: ${
                own
                  ? mine
                    ? `${mine.type} leave, ${mine.status}`
                    : "no leave"
                  : `${approved.length} on leave, ${pending} pending`
              }`}
              onClick={() => setPicked(date)}
            >
              <span>{Number(date.slice(8))}</span>
              {holiday && (
                <small className="holiday-name">{holiday.name}</small>
              )}
              {own
                ? mine && <small>{mine.type}</small>
                : (approved.length > 0 || pending > 0) && (
                    <small>
                      {approved.length > 0 && `${approved.length} on leave`}
                      {approved.length > 0 && pending > 0 && " · "}
                      {pending > 0 && `${pending} pending`}
                    </small>
                  )}
            </button>
          );
        })}
      </div>
      <div className="calendar-legend">
        <span>
          <i className="approved" /> Approved
        </span>
        <span>
          <i className="pending" /> Waiting for approval
        </span>
        {own && (
          <span>
            <i className="medical" /> Medical
          </span>
        )}
        <span>
          <i className="holiday" /> Holiday
        </span>
      </div>
      {!own && (
        <div className="calendar-day-list">
          <h3>
            {dateName(picked)} ·{" "}
            {pickedLeaves.filter((l) => l.status === "Approved").length} on
            approved leave
          </h3>
          {pickedLeaves.length ? (
            <ul>
              {pickedLeaves.map((l) => (
                <li key={l.id}>
                  <strong>{l.name}</strong> · Room {l.room} · {l.type} ·{" "}
                  <span className="badge">{l.status}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>No one is on leave this day.</p>
          )}
        </div>
      )}
    </section>
  );
}

function LeaveHistory({
  leaves,
  own,
  onSaved,
}: {
  leaves: Leave[];
  own: boolean;
  onSaved: (message: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState("All");
  const [error, setError] = useState("");
  const { ask, dialog } = useConfirm();
  const rows = leaves.filter((l) => filter === "All" || l.status === filter);
  return (
    <section className="panel">
      {dialog}
      <div className="panel-heading">
        <div>
          <h2>{own ? "My leave requests" : "All leave requests"}</h2>
        </div>
      </div>
      <div className="table-toolbar">
        <label>
          Status{" "}
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            {["All", "Pending", "Approved", "Rejected", "Cancelled"].map(
              (s) => (
                <option key={s}>{s}</option>
              ),
            )}
          </select>
        </label>
        <span>{rows.length} requests</span>
      </div>
      {error && <p className="notice danger">{error}</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {!own && <th>Student</th>}
              <th>Dates</th>
              <th>Type</th>
              <th>Reason</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id}>
                {!own && (
                  <td>
                    <strong>{l.name}</strong>
                    <small>
                      {l.code} · Room {l.room}
                    </small>
                  </td>
                )}
                <td>
                  {dateName(l.start_date)} – {dateName(l.end_date)}
                  <small>{dayCount(l.start_date, l.end_date)} days</small>
                </td>
                <td>
                  <span className={`badge leave-${l.type.toLowerCase()}`}>
                    {l.type}
                  </span>
                </td>
                <td>
                  {l.reason}
                  {l.decision_reason && (
                    <small>
                      {l.decided_name || "Reviewer"}: {l.decision_reason}
                    </small>
                  )}
                </td>
                <td>
                  <span className={`badge status-${l.status.toLowerCase()}`}>
                    {l.status}
                  </span>
                  {l.decided_name && <small>by {l.decided_name}</small>}
                  {l.status === "Approved" && (
                    <small>
                      {l.concession
                        ? "Mess concession"
                        : "No concession · mess charged"}
                    </small>
                  )}
                  {l.requested_role && l.requested_role !== "Student" && (
                    <small>Recorded by {l.requested_name}</small>
                  )}
                </td>
                <td>
                  {l.document_id && !own && (
                    <DocumentButton id={l.document_id} name={l.document_name} />
                  )}
                  {own && l.status === "Pending" && (
                    <button
                      className="button secondary small"
                      onClick={async () => {
                        if (
                          !(await ask({
                            title: "Cancel this leave request?",
                            body: `${dateName(l.start_date)} – ${dateName(l.end_date)}`,
                            confirm: "Cancel request",
                            danger: true,
                          }))
                        )
                          return;
                        try {
                          await api(`/leaves/${l.id}/cancel`, {});
                          await onSaved("Leave request cancelled.");
                        } catch (e) {
                          setError(errorText(e));
                        }
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <div className="empty">
            <h3>No leave requests</h3>
          </div>
        )}
      </div>
    </section>
  );
}

// Admin: days the mess is closed. No attendance is taken on holidays and they
// are left out of mess charges.
export function HolidaySettings({
  data,
  onSaved,
}: {
  data: Workspace;
  onSaved: (message: string) => Promise<void>;
}) {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { ask, dialog } = useConfirm();
  const holidays = data.holidays ?? [];
  const upcoming = holidays.filter((h) => h.date >= data.today.slice(0, 7));
  const days = dayCount(start, end);
  return (
    <section className="panel operation-form holiday-settings">
      {dialog}
      <div className="panel-heading">
        <div>
          <h2>Holidays</h2>
          <p>
            Days the mess is closed. No attendance is needed on these days and
            they are not counted in the month’s mess charges.
          </p>
        </div>
      </div>
      <form
        className="settings-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api("/holidays", { start_date: start, end_date: end, name });
            setStart("");
            setEnd("");
            setName("");
            await onSaved(
              `${name.trim()} added: ${days} holiday${days === 1 ? "" : "s"}.`,
            );
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <label className="field wide">
            <span>Holiday name</span>
            <input
              required
              maxLength={80}
              placeholder="Diwali, semester break…"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            <span>From</span>
            <input
              type="date"
              required
              value={start}
              onChange={(e) => {
                setStart(e.target.value);
                if (!end || end < e.target.value) setEnd(e.target.value);
              }}
            />
          </label>
          <label className="field">
            <span>To</span>
            <input
              type="date"
              required
              min={start}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
        </div>
        {error && <p className="notice danger">{error}</p>}
        <button className="button" disabled={busy || !days || !name.trim()}>
          {busy ? "Saving…" : days > 1 ? `Add ${days} holidays` : "Add holiday"}
        </button>
      </form>
      <div className="holiday-list">
        {upcoming.length ? (
          upcoming.map((h) => (
            <div key={h.id} className="holiday-row">
              <span>
                <strong>{dateName(h.date)}</strong> {h.name}
              </span>
              <button
                className="text-button"
                onClick={async () => {
                  if (
                    !(await ask({
                      title: `Remove ${h.name} on ${dateName(h.date)}?`,
                      body: "Attendance will be needed for this day again.",
                      confirm: "Remove holiday",
                      danger: true,
                    }))
                  )
                    return;
                  try {
                    await api(`/holidays/${h.id}/delete`, {});
                    await onSaved("Holiday removed.");
                  } catch (err) {
                    setError(errorText(err));
                  }
                }}
              >
                Remove
              </button>
            </div>
          ))
        ) : (
          <p className="empty">No holidays from this month on.</p>
        )}
      </div>
    </section>
  );
}
