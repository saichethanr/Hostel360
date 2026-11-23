import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import { Moon, Sun } from "lucide-react";
import {
  blockLetter,
  parseBlocks,
  roomList,
  type Block,
} from "../server/rooms";
import {
  api,
  apiUrl,
  HOSTEL,
  leaveCommunity,
  money,
  dateName,
  type Student,
  type Workspace,
  type Membership,
} from "./lib";

type Row = Record<string, any>;
type FieldSpec = {
  name: string;
  label: string;
  type?: string;
  options?: { value: string; label: string }[];
  optional?: boolean;
  value?: string | number;
  min?: number;
  max?: string | number;
  step?: string;
};
const choices = (values: string[]) =>
  values.map((value) => ({ value, label: value }));
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "Could not save. Please try again.";
const year = (date: string) => {
  const y = Number(date.slice(0, 4)) - (Number(date.slice(5, 7)) < 7 ? 1 : 0);
  return `${y}-${y + 1}`;
};
const field = (
  name: string,
  label: string,
  type = "text",
  value?: string | number,
): FieldSpec => ({ name, label, type, value });

// "Are you sure?" before signing out. Returns the dialog and a function that
// opens it; the action runs only after the person confirms.
export function useSignOutConfirm(action: () => Promise<void> | void) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);
  const dialog = open ? (
    <dialog
      ref={ref}
      className="modal confirm-modal"
      aria-labelledby="sign-out-title"
      onCancel={() => setOpen(false)}
      onClick={(e) => e.target === e.currentTarget && setOpen(false)}
    >
      <div className="modal-body">
        <h2 id="sign-out-title">Are you sure you want to log out?</h2>
        <p>You’ll need your email and password to sign in again.</p>
        <div className="modal-actions">
          <button
            className="button secondary"
            autoFocus
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            Cancel
          </button>
          <button
            className="button danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await action();
              } finally {
                setBusy(false);
                setOpen(false);
              }
            }}
          >
            {busy ? "Logging out…" : "Log out"}
          </button>
        </div>
      </div>
    </dialog>
  ) : null;
  return { dialog, ask: () => setOpen(true) };
}
// Light/dark switch; the choice is remembered on this device.
export function ThemeToggle() {
  const [dark, setDark] = useState(
    document.documentElement.dataset.theme === "dark",
  );
  const label = dark ? "Switch to light mode" : "Switch to dark mode";
  return (
    <button
      className="icon-button theme-toggle"
      aria-label={label}
      title={label}
      onClick={() => {
        const next = dark ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem("h360_theme", next);
        } catch {}
        setDark(!dark);
      }}
    >
      {dark ? <Sun size={19} /> : <Moon size={19} />}
    </button>
  );
}
// In-app confirmation pop-up; `ask` resolves true when confirmed.
type ConfirmRequest = {
  title: string;
  body?: ReactNode;
  confirm: string;
  danger?: boolean;
};
export function useConfirm() {
  const [request, setRequest] = useState<
    (ConfirmRequest & { resolve: (ok: boolean) => void }) | null
  >(null);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (request && dialog && !dialog.open) dialog.showModal();
  }, [request]);
  const close = (ok: boolean) => {
    request?.resolve(ok);
    setRequest(null);
  };
  const dialog = request ? (
    <dialog
      ref={ref}
      className="modal confirm-modal"
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault();
        close(false);
      }}
      onClick={(e) => e.target === e.currentTarget && close(false)}
    >
      <div className="modal-body">
        <h2 id="confirm-title">{request.title}</h2>
        {request.body && <p>{request.body}</p>}
        <div className="modal-actions">
          <button
            className="button secondary"
            autoFocus
            onClick={() => close(false)}
          >
            Cancel
          </button>
          <button
            className={request.danger ? "button danger" : "button"}
            onClick={() => close(true)}
          >
            {request.confirm}
          </button>
        </div>
      </div>
    </dialog>
  ) : null;
  const ask = (options: ConfirmRequest) =>
    new Promise<boolean>((resolve) => setRequest({ ...options, resolve }));
  return { ask, dialog };
}
const today = () => new Date().toISOString().slice(0, 10);
// Student details a join request and the admission desk both collect.
const studentDetailFields = (date: string): FieldSpec[] => [
  field("phone", "Your phone", "tel"),
  field("department", "Department"),
  field("course", "Course", "text", "B.E."),
  { ...field("year", "Year of study", "number", 1), min: 1, max: 6 },
  field("academic_year", "Academic year (YYYY-YYYY)", "text", year(date)),
  field("guardian", "Parent name"),
  field("guardian_phone", "Parent phone", "tel"),
  {
    name: "admission_type",
    label: "Admission type",
    options: choices(["Fresher", "Existing"]),
  },
  field("address", "Address", "textarea"),
];
function FieldInput({ f }: { f: FieldSpec }) {
  return (
    <label className={`field ${f.type === "textarea" ? "wide" : ""}`}>
      <span>{f.label}</span>
      {f.options ? (
        <select name={f.name} defaultValue={f.value} required={!f.optional}>
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : f.type === "textarea" ? (
        <textarea
          name={f.name}
          defaultValue={f.value}
          required={!f.optional}
          maxLength={1000}
        />
      ) : f.type === "password" ? (
        <PasswordInput name={f.name} required={!f.optional} />
      ) : (
        <input
          name={f.name}
          type={f.type || "text"}
          defaultValue={f.value}
          required={!f.optional}
          min={f.min}
          max={f.max}
          step={f.step}
          maxLength={500}
        />
      )}
    </label>
  );
}
function Form({
  title,
  description,
  fields,
  submit = "Save",
  onSubmit,
  children,
  before,
  after,
}: {
  title: string;
  description?: string;
  before?: ReactNode;
  after?: ReactNode;
  fields: FieldSpec[];
  submit?: string;
  onSubmit: (values: Row) => Promise<void>;
  children?: ReactNode;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const values = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await onSubmit(values);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel operation-form">
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
      </div>
      <form className="settings-form" onSubmit={save}>
        <div className="form-grid">
          {before}
          {fields.map((f) => (
            <FieldInput key={f.name} f={f} />
          ))}
        </div>
        {after}
        {children}
        {error && (
          <div className="notice danger" role="alert">
            {error}
          </div>
        )}
        <button className="button" disabled={busy}>
          {busy ? "Saving…" : submit}
        </button>
      </form>
    </section>
  );
}
export function PasswordInput({
  name,
  required,
  autoComplete = "new-password",
  value,
  onChange,
  placeholder,
}: {
  name?: string;
  required?: boolean;
  autoComplete?: string;
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <span className="password-input">
      <input
        name={name}
        type={shown ? "text" : "password"}
        required={required}
        maxLength={200}
        autoComplete={autoComplete}
        placeholder={placeholder}
        {...(onChange
          ? { value, onChange: (e) => onChange(e.target.value) }
          : {})}
      />
      <button
        type="button"
        className="password-toggle"
        aria-label={shown ? "Hide password" : "Show password"}
        aria-pressed={shown}
        onClick={() => setShown(!shown)}
      >
        {shown ? "Hide" : "Show"}
      </button>
    </span>
  );
}
function Table({
  headers,
  rows,
}: {
  headers: ReactNode[];
  rows: ReactNode[][];
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (
        <div className="empty">
          <h3>No records yet</h3>
          <p>New records will appear here.</p>
        </div>
      )}
    </div>
  );
}
function useRows(path: string) {
  const [rows, setRows] = useState<Row[]>([]),
    [error, setError] = useState("");
  const reload = async () => {
    try {
      setRows(await api<Row[]>(path));
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    void reload();
  }, [path]);
  return { rows, reload, error };
}
const exportButton = (kind: string, label: string) => (
  <a className="button secondary" href={apiUrl(`/export/${kind}`)}>
    {label}
  </a>
);

export function CommunityGate({ onLogin }: { onLogin: () => Promise<void> }) {
  const [mode, setMode] = useState("Sign in");
  const [joinRole, setJoinRole] = useState("Student");
  const [joined, setJoined] = useState(false);
  // Registration waiting for its emailed code; details stay put.
  const [verifying, setVerifying] = useState<{
    email: string;
    body: Row;
  } | null>(null);
  const [resent, setResent] = useState("");
  // Forgot password: "email" asks where to send the code; a string is the
  // email the code went to. `reset` confirms the new password on Sign in.
  const [forgot, setForgot] = useState<"email" | string | null>(null);
  const [reset, setReset] = useState("");
  const switchMode = (next: string) => {
    setMode(next);
    setJoined(false);
    setReset("");
  };
  if (forgot === "email")
    return (
      <div className="setup-page community-page">
        <div className="eyebrow">FORGOT PASSWORD</div>
        <h1>Reset your password.</h1>
        <p>
          Enter the email you use for {HOSTEL.short}. We’ll send it a code so
          you can choose a new password.
        </p>
        <Form
          title="Your email"
          fields={[field("email", "Email", "email")]}
          submit="Send code"
          onSubmit={async (v) => {
            const email = String(v.email).trim().toLowerCase();
            await api("/email/code", { email });
            setResent("");
            setForgot(email);
          }}
        >
          <p className="notice">
            Remembered it?{" "}
            <button
              type="button"
              className="text-button"
              onClick={() => setForgot(null)}
            >
              Back to sign in
            </button>
          </p>
        </Form>
      </div>
    );
  if (forgot)
    return (
      <div className="setup-page community-page">
        <div className="eyebrow">FORGOT PASSWORD</div>
        <h1>Check your inbox.</h1>
        <p>
          We sent a code to <strong>{forgot}</strong>. Enter it with your new
          password.
        </p>
        <Form
          title="Choose a new password"
          fields={[
            field("email_code", "Code from your email"),
            field("password", "New password (12+ characters)", "password"),
          ]}
          submit="Change password"
          onSubmit={async (v) => {
            await api("/password/reset", {
              email: forgot,
              email_code: String(v.email_code).trim(),
              password: v.password,
            });
            setForgot(null);
            setMode("Sign in");
            setReset("Password changed. Sign in with your new password.");
          }}
        >
          <p className="notice">
            The code expires in an hour. Didn’t get it? Check spam, or{" "}
            <button
              type="button"
              className="text-button"
              onClick={async () => {
                setResent("");
                try {
                  await api("/email/code", { email: forgot });
                  setResent("A new code has been sent.");
                } catch (e) {
                  setResent(errorText(e));
                }
              }}
            >
              send a new code
            </button>{" "}
            or{" "}
            <button
              type="button"
              className="text-button"
              onClick={() => setForgot("email")}
            >
              change your email
            </button>
            .{resent && <strong> {resent}</strong>}
          </p>
        </Form>
      </div>
    );
  if (verifying)
    return (
      <div className="setup-page community-page">
        <div className="eyebrow">VERIFY YOUR EMAIL</div>
        <h1>Check your inbox.</h1>
        <p>
          We sent a code to <strong>{verifying.email}</strong>. Enter it to send
          your registration to {HOSTEL.short}.
        </p>
        <Form
          title="Enter the code"
          fields={[field("email_code", "Code from your email")]}
          submit="Verify & register"
          onSubmit={async (v) => {
            const email_code = String(v.email_code).trim();
            // Registering signs the new member in.
            await api("/communities/join", { ...verifying.body, email_code });
            setVerifying(null);
            setJoined(true);
          }}
        >
          <p className="notice">
            The code expires in an hour. Didn’t get it? Check spam, or{" "}
            <button
              type="button"
              className="text-button"
              onClick={async () => {
                setResent("");
                try {
                  await api("/email/code", { email: verifying.email });
                  setResent("A new code has been sent.");
                } catch (e) {
                  setResent(errorText(e));
                }
              }}
            >
              send a new code
            </button>{" "}
            or{" "}
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setVerifying(null);
                setResent("");
              }}
            >
              change your email
            </button>
            .{resent && <strong> {resent}</strong>}
          </p>
        </Form>
      </div>
    );
  if (joined)
    return (
      <div className="setup-page community-page">
        <div className="eyebrow">REGISTRATION SENT</div>
        <h1>Your registration is with the Admin.</h1>
        <p>
          The {HOSTEL.short} Admin has been notified. You can sign in now to
          check your status; records open once you are approved.
        </p>
        <button
          className="button"
          onClick={async () => {
            // Approval signs out earlier sessions; sign in again if needed.
            try {
              await api("/membership");
              await onLogin();
            } catch {
              switchMode("Sign in");
            }
          }}
        >
          Check my registration status
        </button>
      </div>
    );
  return (
    <>
      <header className="campus-hero">
        <div className="campus-hero-tools">
          <ThemeToggle />
        </div>
        <div className="campus-hero-caption">
          <div className="eyebrow light">{HOSTEL.short} HOSTEL</div>
          <h1>{HOSTEL.name}</h1>
        </div>
      </header>
      <div className="setup-page community-page campus-form">
        <div className="tabs" aria-label="Hostel access">
          {["Sign in", "Register"].map((label) => (
            <button
              key={label}
              className={mode === label ? "active" : ""}
              onClick={() => switchMode(label)}
            >
              {label}
            </button>
          ))}
        </div>
        <Form
          key={mode}
          title={mode}
          description={
            mode === "Register" && joinRole === "Admin"
              ? "Your Admin request goes to the current Admin. You get full access once they approve it."
              : mode === "Register"
                ? "Students send their hostel details now. The Admin assigns your room and approves you in one step."
                : "Use your own email and password."
          }
          fields={[
            ...(mode === "Register" ? [field("name", "Your full name")] : []),
            field("email", "Email", "email"),
            field(
              "password",
              mode === "Sign in" ? "Password" : "Password (12+ characters)",
              "password",
            ),
          ]}
          before={
            mode === "Register" ? (
              <label className="field">
                <span>I am registering as</span>
                <select
                  name="role"
                  value={joinRole}
                  onChange={(e) => setJoinRole(e.target.value)}
                >
                  <option>Student</option>
                  <option>Manager</option>
                  <option>Warden</option>
                  <option>Admin</option>
                </select>
              </label>
            ) : null
          }
          after={
            mode === "Sign in" ? (
              <>
                {reset && <p className="notice">{reset}</p>}
                <button
                  type="button"
                  className="text-button forgot-password"
                  onClick={() => {
                    setReset("");
                    setForgot("email");
                  }}
                >
                  Forgot password?
                </button>
              </>
            ) : mode === "Register" && joinRole === "Student" ? (
              <fieldset className="join-details">
                <legend>Your hostel details</legend>
                <p>
                  Sent with your registration. The Admin assigns your room and
                  approves you in one step.
                </p>
                <div className="form-grid">
                  {studentDetailFields(today()).map((f) => (
                    <FieldInput key={f.name} f={f} />
                  ))}
                </div>
              </fieldset>
            ) : null
          }
          submit={mode === "Register" ? "Send registration" : mode}
          onSubmit={async (v) => {
            if (mode === "Register") {
              const detailKeys = studentDetailFields(today()).map(
                (f) => f.name,
              );
              const application = Object.fromEntries(
                detailKeys.map((k) => [k, k === "year" ? Number(v[k]) : v[k]]),
              );
              const body = {
                name: v.name,
                email: v.email,
                password: v.password,
                role: v.role,
                code: HOSTEL.code,
                ...(v.role === "Student" ? { application } : {}),
              };
              // With verification on, every registration gets a code first.
              const check = await api<{ required: boolean }>("/email/code", {
                email: v.email,
              });
              if (check.required) {
                setVerifying({ email: String(v.email), body });
                return;
              }
              await api("/communities/join", body);
              setJoined(true);
              return;
            }
            await api("/login", { email: v.email, password: v.password });
            await onLogin();
          }}
        />
      </div>
    </>
  );
}

export function MembershipStatus({
  membership,
  refresh,
}: {
  membership: Membership;
  refresh: () => Promise<void>;
}) {
  const [checked, setChecked] = useState("");
  const [checking, setChecking] = useState(false);
  const signOut = useSignOutConfirm(async () => {
    try {
      await api("/logout", {});
    } finally {
      leaveCommunity();
    }
  });
  const pending = membership.status === "Pending";
  const check = async () => {
    setChecking(true);
    setChecked("");
    try {
      // Approval signs out earlier sessions; the request is then decided.
      await api<Membership>("/membership");
      await refresh();
      setChecked(
        `Still waiting for the Admin · checked at ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. We’ll open the hostel as soon as you’re approved.`,
      );
    } catch {
      setChecked(
        "Your request has been decided. Sign in again with the same email and password to continue.",
      );
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="setup-page community-page">
      <div className="eyebrow">{membership.community.name}</div>
      <h1>
        {pending
          ? "Waiting for Admin approval"
          : membership.status === "Rejected"
            ? "Your request was not approved"
            : `${membership.status} access`}
      </h1>
      <section className="panel operation-form status-card">
        <div className={`status-pill ${pending ? "waiting" : "done"}`}>
          {pending ? "⏳ Pending" : membership.status}
        </div>
        <p>
          {membership.name}, you asked to join{" "}
          <strong>{membership.community.name}</strong> as a{" "}
          <strong>{membership.role}</strong>.{" "}
          {pending
            ? membership.role === "Student"
              ? "Your details are with the Admin, who will assign your room and approve you. No further form is needed."
              : "The Admin will review your request."
            : "Contact the hostel Admin if you have questions."}
        </p>
        {membership.reason && (
          <p className="notice">Admin’s reason: {membership.reason}</p>
        )}
        {checked && (
          <p className="notice" role="status">
            {checked}
          </p>
        )}
        <div className="row-actions">
          <button className="button" disabled={checking} onClick={check}>
            {checking ? "Checking…" : "Check status"}
          </button>
          {checked.startsWith("Your request has been decided") && (
            <button
              className="button secondary"
              onClick={() => window.location.reload()}
            >
              Sign in again
            </button>
          )}
        </div>
      </section>
      {signOut.dialog}
      <button className="button secondary" onClick={signOut.ask}>
        Sign out
      </button>
    </div>
  );
}

export function Setup({ onDone }: { onDone: () => void }) {
  const [setupKey] = useState(
    () => new URLSearchParams(window.location.hash.slice(1)).get("setup") || "",
  );
  useEffect(() => {
    if (setupKey)
      window.history.replaceState(null, "", window.location.pathname);
  }, [setupKey]);
  return (
    <div className="setup-page">
      <div className="eyebrow">JSS PDA HOSTEL · SECURE ACTIVATION</div>
      <h1>Make this workspace yours.</h1>
      <p>
        Create the first administrator. Setup closes permanently after this
        account is created.
      </p>
      <Form
        title="Activate your hostel"
        fields={[
          field("token", "Private setup key", "password", setupKey),
          field("name", "Administrator name"),
          field("email", "Email address", "email"),
          field("password", "Your password (12+ characters)", "password"),
        ]}
        submit="Activate workspace"
        onSubmit={async (values) => {
          await api("/setup", values);
          onDone();
        }}
      />
    </div>
  );
}
export function Account({
  onSaved,
}: {
  onSaved: (message: string) => Promise<void>;
}) {
  return (
    <Form
      title="Change your password"
      description="Use at least 12 characters. All other sessions will be signed out."
      fields={[
        field("current", "Current password", "password"),
        field("password", "New password", "password"),
      ]}
      submit="Update password"
      onSubmit={async (v) => {
        await api("/account/password", v);
        await onSaved("Password updated. Other sessions have been signed out.");
      }}
    />
  );
}

export function Operations({
  data,
  onSaved,
}: {
  data: Workspace;
  onSaved: (message: string) => Promise<void>;
}) {
  const isAdmin = data.user.role === "Admin";
  const [tab, setTab] = useState(
    isAdmin && data.pending_members ? "Accounts" : "Admissions",
  );
  const tabs = [
    "Admissions",
    ...(isAdmin
      ? ["Promote students", "Imports", "Accounts", "Corrections", "Backups"]
      : []),
    "Registers",
  ];
  return (
    <div className="operations">
      <div className="tabs page-tabs">
        {tabs.map((t) => (
          <button
            key={t}
            className={t === tab ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
            {t === "Accounts" && !!data.pending_members && (
              <span className="nav-count alert">{data.pending_members}</span>
            )}
          </button>
        ))}
      </div>
      {tab === "Admissions" && <Admissions data={data} onSaved={onSaved} />}{" "}
      {tab === "Promote students" && (
        <Promotion data={data} onSaved={onSaved} />
      )}{" "}
      {tab === "Imports" && <Imports onSaved={onSaved} />}{" "}
      {tab === "Accounts" && <Accounts data={data} onSaved={onSaved} />}{" "}
      {tab === "Corrections" && <Corrections data={data} onSaved={onSaved} />}{" "}
      {tab === "Backups" && <Backups onSaved={onSaved} />}
      {tab === "Registers" && <Registers data={data} />}
    </div>
  );
}
function Backups({ onSaved }: { onSaved: (m: string) => Promise<void> }) {
  const { rows, reload, error } = useRows("/backups"),
    [downloadError, setDownloadError] = useState("");
  return (
    <>
      <Form
        title="Protect your hostel records"
        description="Daily application-data snapshots are scheduled for 02:00 IST (Vercel may start within the hour). You can also save one now."
        fields={[]}
        submit="Save a backup now"
        onSubmit={async () => {
          await api("/backups", {});
          await reload();
          await onSaved("Backup saved to private Supabase Storage.");
        }}
      >
        <p className="notice">
          Archives include financial history and document metadata, not document
          files or Supabase Auth passwords. Download an independent copy
          regularly. Snapshots are retained until you choose a retention policy;
          nothing is automatically deleted.
        </p>
        <a className="button secondary" href={apiUrl("/backup")}>
          Download current data archive
        </a>
      </Form>
      <section className="panel">
        <div className="panel-heading">
          <h2>Latest 100 snapshots</h2>
        </div>
        {(error || downloadError) && (
          <p className="notice danger">{error || downloadError}</p>
        )}
        <Table
          headers={["Snapshot", "Download"]}
          rows={rows.map((r) => [
            r.name,
            <button
              className="button secondary"
              onClick={async () => {
                try {
                  const result = await api<{ url: string }>(
                    `/backups/${encodeURIComponent(r.name)}`,
                  );
                  window.location.assign(result.url);
                } catch (e) {
                  setDownloadError(errorText(e));
                }
              }}
            >
              Download privately
            </button>,
          ])}
        />
      </section>
    </>
  );
}
export function Admissions({
  data,
  onSaved,
}: {
  data: Workspace;
  onSaved: (m: string) => Promise<void>;
}) {
  const { rows, reload, error } = useRows("/applications"),
    [selected, setSelected] = useState<Row | null>(null),
    [adding, setAdding] = useState(false),
    [filter, setFilter] = useState("All");
  const isStudent = data.user.role === "Student";
  const saved = async (m: string) => {
    setSelected(null);
    setAdding(false);
    await reload();
    await onSaved(m);
  };
  const fields = [
    field("name", "Student name"),
    ...(!isStudent ? [field("email", "Email", "email")] : []),
    field("phone", "Phone", "tel"),
    field("guardian", "Parent name"),
    field("guardian_phone", "Parent phone", "tel"),
    field("department", "Department"),
    field("course", "Course", "text", "B.E."),
    { ...field("year", "Year of study", "number", 1), min: 1, max: 6 },
    field(
      "academic_year",
      "Academic year (YYYY-YYYY)",
      "text",
      year(data.today),
    ),
    {
      name: "admission_type",
      label: "Admission type",
      options: choices(["Fresher", "Existing"]),
    },
    field("address", "Address", "textarea"),
  ];
  return (
    <>
      {error && <p className="notice danger">{error}</p>}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>{isStudent ? "My application" : "Admission desk"}</h2>
            <p>
              {isStudent
                ? "Submit your details and follow your admission decision here."
                : "Submit, review and admit. One record all the way through."}
            </p>
          </div>
          {(!isStudent || (!rows.length && !data.user.student_id)) && (
            <button
              className="button"
              onClick={() => {
                setAdding(!adding);
                setSelected(null);
              }}
            >
              {adding ? "Close form" : "New application"}
            </button>
          )}
        </div>
        <div className="table-toolbar">
          <label>
            Status{" "}
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              {["All", "Submitted", "Approved", "Rejected"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <span>{rows.length} applications</span>
        </div>
        <Table
          headers={["Applicant", "Course", "Academic year", "Status", "Action"]}
          rows={rows
            .filter((r) => filter === "All" || r.status === filter)
            .map((r) => [
              <>
                <strong>{r.name}</strong>
                <small>{r.email}</small>
              </>,
              `${r.course} · Year ${r.year}`,
              r.academic_year,
              <span className="badge">
                {r.status === "Under Review" ? "Submitted" : r.status}
              </span>,
              <button
                className="button secondary small"
                onClick={() => {
                  setSelected(r);
                  setAdding(false);
                }}
              >
                View application
              </button>,
            ])}
        />
      </section>
      {adding && (
        <Form
          title="New hostel application"
          fields={fields}
          submit="Submit application"
          onSubmit={async (v) => {
            await api("/applications", { ...v, year: Number(v.year) });
            await saved("Application submitted for review.");
          }}
        />
      )}
      {selected && (
        <section className="panel">
          <div className="panel-heading">
            <h2>{selected.name}</h2>
            <button
              className="button secondary"
              onClick={() => setSelected(null)}
            >
              Close
            </button>
          </div>
          <div className="settings-form">
            <p>
              {selected.phone} · {selected.department}
            </p>
            <p>{selected.address}</p>
            <p>
              Parent: {selected.guardian}
              {selected.guardian_phone
                ? ` · ${selected.guardian_phone}`
                : ""} · {selected.admission_type}
            </p>
            {selected.reason && <p className="notice">{selected.reason}</p>}
          </div>
          {["Submitted", "Under Review"].includes(selected.status) &&
          data.user.role === "Admin" ? (
            <>
              <Form
                title="Assign room & approve"
                description={`One step: this adds the student to the register with this room and puts the ${selected.admission_type.toLowerCase()} admission fees (${money(admissionTotal(data.settings, selected.admission_type))}) for ${selected.academic_year} in their dues.`}
                before={<RoomPicker data={data} />}
                fields={[
                  {
                    ...field("joined", "Joining date", "date", data.today),
                    max: data.today,
                  },
                ]}
                submit="Assign room & approve"
                onSubmit={async (v) => {
                  await api(`/applications/${selected.id}/review`, {
                    ...v,
                    status: "Approved",
                  });
                  await saved(
                    "Admission approved. The student is in the register.",
                  );
                }}
              />
              <Form
                title="Reject application"
                fields={[field("reason", "Reason for rejection", "textarea")]}
                submit="Reject application"
                onSubmit={async (v) => {
                  await api(`/applications/${selected.id}/review`, {
                    ...v,
                    status: "Rejected",
                  });
                  await saved("Application rejected with reason.");
                }}
              />
            </>
          ) : null}
        </section>
      )}
    </>
  );
}
// Block, then room, from the hostel's layout, showing beds taken. Without a
// layout yet, the room is typed in as before.
export function RoomPicker({
  data,
  current = "",
  studentId = 0,
}: {
  data: Workspace;
  current?: string;
  studentId?: number;
}) {
  const blocks = parseBlocks(data.settings.blocks);
  const rooms = roomList(blocks);
  const known = rooms.find((r) => r.room === current);
  const [block, setBlock] = useState(known?.block || "");
  const [room, setRoom] = useState(known ? current : "");
  if (!rooms.length)
    return (
      <label className="field">
        <span>Room</span>
        <input name="room" required defaultValue={current} maxLength={40} />
      </label>
    );
  const taken = new Map<string, number>();
  for (const s of data.students)
    if (s.status === "Active" && s.id !== studentId)
      taken.set(s.room, (taken.get(s.room) || 0) + 1);
  return (
    <>
      <label className="field">
        <span>Block</span>
        <select
          required
          aria-label="Block"
          value={block}
          onChange={(e) => {
            setBlock(e.target.value);
            setRoom("");
          }}
        >
          <option value="">Choose a block</option>
          {blocks.map((b, i) => (
            <option key={i} value={blockLetter(i)}>
              Block {blockLetter(i)} · {b.gender}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Room</span>
        <select
          name="room"
          required
          aria-label="Room"
          value={room}
          disabled={!block}
          onChange={(e) => setRoom(e.target.value)}
        >
          <option value="">
            {block ? "Choose a room" : "Choose a block first"}
          </option>
          {rooms
            .filter((r) => r.block === block && !r.common)
            .map((r) => {
              const used = taken.get(r.room) || 0,
                full = used >= r.capacity;
              return (
                <option key={r.room} value={r.room} disabled={full}>
                  {r.room} · {used}/{r.capacity} beds taken
                  {full ? " · full" : ""}
                </option>
              );
            })}
        </select>
      </label>
    </>
  );
}
// Admin layout: how many Female and Male blocks (lettered A, B, C…),
// with rooms per block and students per room. Single rooms can differ.
export function BlocksSettings({
  data,
  onSaved,
}: {
  data: Workspace;
  onSaved: (m: string) => Promise<void>;
}) {
  const fresh = (gender: Block["gender"]): Block => ({
    gender,
    rooms: 13,
    capacity: 8,
  });
  const saved = parseBlocks(data.settings.blocks);
  const [blocks, setBlocks] = useState<Block[]>(
    saved.length ? saved : [fresh("Female"), fresh("Female"), fresh("Male")],
  );
  const count = (gender: Block["gender"]) =>
    blocks.filter((b) => b.gender === gender).length;
  // New blocks take the next letters; removing drops that type's last block,
  // so existing blocks keep their letters.
  const setCount = (gender: Block["gender"], n: number) => {
    let next = [...blocks];
    while (next.filter((b) => b.gender === gender).length < n)
      next.push(fresh(gender));
    while (next.filter((b) => b.gender === gender).length > n)
      next.splice(
        next.findLastIndex((b) => b.gender === gender),
        1,
      );
    if (next.length > 26) next = next.slice(0, 26);
    setBlocks(next);
  };
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const update = (i: number, change: Partial<Block>) =>
    setBlocks(blocks.map((b, j) => (j === i ? { ...b, ...change } : b)));
  const beds = (b: Block, i: number) =>
    Array.from(
      { length: Math.max(0, b.rooms - 1) },
      (_, n) => b.capacities?.[`${blockLetter(i)}${n + 1}`] ?? b.capacity,
    ).reduce((sum, c) => sum + c, 0);
  const number = (value: string) => Math.max(0, Math.round(Number(value)));
  return (
    <section className="panel fee-structure blocks-settings">
      <div className="panel-heading">
        <div>
          <h2>Blocks & rooms</h2>
          <p>
            Blocks are lettered A, B, C… A block with 13 rooms has rooms 1–12
            for students and a common room (such as AC), which is not allocated.
            Room allocation offers only these rooms.
          </p>
        </div>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api("/blocks", { blocks });
            await onSaved("Blocks and rooms saved.");
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="blocks-count">
          {(["Female", "Male"] as const).map((gender) => (
            <label key={gender} className="field">
              <span>{gender} blocks</span>
              <input
                type="number"
                min="0"
                max="26"
                required
                value={count(gender)}
                onChange={(e) =>
                  setCount(gender, Math.min(26, number(e.target.value)))
                }
              />
            </label>
          ))}
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Block</th>
                <th>For</th>
                <th>Rooms</th>
                <th>Students per room</th>
                <th>Rooms created</th>
                <th>Beds</th>
              </tr>
            </thead>
            <tbody>
              {blocks.map((b, i) => {
                const L = blockLetter(i);
                return (
                  <tr key={i}>
                    <td>
                      <strong>Block {L}</strong>
                    </td>
                    <td>
                      <span className={`badge block-${b.gender.toLowerCase()}`}>
                        {b.gender}
                      </span>
                    </td>
                    <td>
                      <input
                        type="number"
                        min="2"
                        max="100"
                        required
                        aria-label={`Rooms in block ${L}`}
                        value={b.rooms}
                        onChange={(e) =>
                          update(i, { rooms: number(e.target.value) })
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="1"
                        max="50"
                        required
                        aria-label={`Students per room in block ${L}`}
                        value={b.capacity}
                        onChange={(e) =>
                          update(i, { capacity: number(e.target.value) })
                        }
                      />
                    </td>
                    <td>
                      {b.rooms >= 2
                        ? `${L}1–${L}${b.rooms - 1} + ${L}C common`
                        : "—"}
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setOpen(open === i ? null : i)}
                      >
                        {open === i
                          ? "Hide room sizes"
                          : "Change single room sizes"}
                      </button>
                    </td>
                    <td>{beds(b, i)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {open !== null && blocks[open] && blocks[open].rooms >= 2 && (
          <div className="room-sizes">
            <h3>Block {blockLetter(open)} · students per room</h3>
            <div>
              {Array.from({ length: blocks[open].rooms - 1 }, (_, n) => {
                const room = `${blockLetter(open)}${n + 1}`,
                  b = blocks[open];
                return (
                  <label key={room} className="field">
                    <span>{room}</span>
                    <input
                      type="number"
                      min="1"
                      max="50"
                      required
                      value={b.capacities?.[room] ?? b.capacity}
                      onChange={(e) => {
                        const value = number(e.target.value);
                        const capacities = { ...b.capacities };
                        if (value === b.capacity) delete capacities[room];
                        else capacities[room] = value;
                        update(open, { capacities });
                      }}
                    />
                  </label>
                );
              })}
            </div>
          </div>
        )}
        <p className="notice">
          {count("Female")} Female blocks · {count("Male")} Male blocks ·{" "}
          {blocks.reduce((sum, b, i) => sum + beds(b, i), 0)} beds in total.
        </p>
        {error && <p className="notice danger">{error}</p>}
        <button className="button" disabled={busy}>
          {busy ? "Saving…" : "Save blocks & rooms"}
        </button>
      </form>
    </section>
  );
}
// Admission fees by student type. Fresher Fund includes the refundable mess
// caution deposit, shown as its own line so the difference is clear.
const feeLines = (type: "fresher" | "existing") => [
  { key: `fee_${type}_management`, label: "Management" },
  {
    key: `fee_${type}_fund`,
    label: type === "fresher" ? "Hostel fund" : "Fund",
  },
  ...(type === "fresher"
    ? [{ key: "fee_fresher_caution", label: "Mess caution deposit" }]
    : []),
  { key: `fee_${type}_establishment`, label: "Establishment" },
];
export const admissionTotal = (
  settings: Record<string, string>,
  type: string,
) =>
  feeLines(type === "Fresher" ? "fresher" : "existing").reduce(
    (sum, l) => sum + Number(settings[l.key] || 0),
    0,
  );
export function FeeStructure({
  data,
  onSaved,
}: {
  data: Workspace;
  onSaved: (m: string) => Promise<void>;
}) {
  const keys = [...feeLines("fresher"), ...feeLines("existing")].map(
    (l) => l.key,
  );
  const [fees, setFees] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      keys.map((k) => [k, String(Number(data.settings[k] || 0) / 100)]),
    ),
  );
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const paise = (k: string) => Math.round(Number(fees[k] || 0) * 100);
  const total = (type: "fresher" | "existing") =>
    feeLines(type).reduce((sum, l) => sum + paise(l.key), 0);
  const input = (key: string, label: string) => (
    <label className="fee-line" key={key}>
      <span>{label}</span>
      <span className="fee-input">
        ₹
        <input
          type="number"
          min="0"
          step="1"
          max="1000000"
          required
          aria-label={label}
          value={fees[key]}
          onChange={(e) => setFees({ ...fees, [key]: e.target.value })}
        />
      </span>
    </label>
  );
  return (
    <section className="panel fee-structure">
      <div className="panel-heading">
        <div>
          <h2>Admission fee structure</h2>
          <p>
            Charged once per academic year. Freshers are charged when the Admin
            approves their registration; existing students when they are
            promoted to the next year. Dues already issued never change.
          </p>
        </div>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api(
              "/fee-structure",
              Object.fromEntries(keys.map((k) => [k, paise(k)])),
            );
            await onSaved("Fee structure saved. It applies to new dues only.");
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="fee-columns">
          <div className="fee-card">
            <h3>Fresher</h3>
            <small>New students, on approval</small>
            {input("fee_fresher_management", "Management")}
            <div className="fee-group">
              <strong className="fee-line">
                <span>Fund</span>
                <span>
                  {money(
                    paise("fee_fresher_fund") + paise("fee_fresher_caution"),
                  )}
                </span>
              </strong>
              {input("fee_fresher_fund", "Hostel fund")}
              {input("fee_fresher_caution", "Mess caution deposit")}
            </div>
            {input("fee_fresher_establishment", "Establishment")}
            <div className="fee-line fee-total">
              <span>Total</span>
              <strong>{money(total("fresher"))}</strong>
            </div>
          </div>
          <div className="fee-card">
            <h3>Existing student</h3>
            <small>Every promotion to the next year</small>
            {input("fee_existing_management", "Management")}
            {input("fee_existing_fund", "Fund")}
            {input("fee_existing_establishment", "Establishment")}
            <div className="fee-line fee-total">
              <span>Total</span>
              <strong>{money(total("existing"))}</strong>
            </div>
          </div>
        </div>
        <p className="notice">
          Fresher Fund = Hostel fund {money(paise("fee_fresher_fund"))} + Mess
          caution deposit {money(paise("fee_fresher_caution"))}. The caution
          deposit is why a fresher’s Fund is{" "}
          {money(
            Math.abs(
              paise("fee_fresher_fund") +
                paise("fee_fresher_caution") -
                paise("fee_existing_fund"),
            ),
          )}{" "}
          {paise("fee_fresher_fund") + paise("fee_fresher_caution") >=
          paise("fee_existing_fund")
            ? "more"
            : "less"}{" "}
          than an existing student’s. Mess is billed monthly, separately.
        </p>
        {error && <p className="notice danger">{error}</p>}
        <button className="button" disabled={busy}>
          {busy ? "Saving…" : "Save fee structure"}
        </button>
      </form>
    </section>
  );
}
// Year-end promotion in one step: everyone selected moves up a year, except
// those ticked as failed, who repeat their year. All move to the new academic
// year and get the existing-student admission fees.
function Promotion({
  data,
  onSaved,
}: {
  data: Workspace;
  onSaved: (m: string) => Promise<void>;
}) {
  // Promotion starts the academic year after the current one.
  const y = Number(year(data.today).slice(5));
  const [academicYear, setAcademicYear] = useState(`${y}-${y + 1}`);
  const active = data.students.filter((s) => s.status === "Active");
  // Students already in this academic year or a later one are done.
  const done = (s: Student) =>
    !!s.academic_year && s.academic_year >= academicYear;
  const ready = active.filter((s) => !done(s));
  // Everyone in Year 1 and 2 is selected by default, whatever the year typed.
  const [picked, setPicked] = useState<Set<number>>(
    () => new Set(active.filter((s) => s.year < 3).map((s) => s.id)),
  );
  const [failed, setFailed] = useState<Set<number>>(() => new Set());
  // Year 3 is final: those students take part only when they failed.
  const included = (s: Student) =>
    picked.has(s.id) && (s.year < 3 || failed.has(s.id));
  const chosen = ready.filter(included);
  const repeating = chosen.filter((s) => failed.has(s.id));
  const fee = admissionTotal(data.settings, "Existing");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const { ask, dialog } = useConfirm();
  const toggle = (set: Set<number>, id: number, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };
  return (
    <section className="panel">
      {dialog}
      <div className="panel-heading">
        <div>
          <h2>Promote students to the next year</h2>
          <p>
            At the end of the year, promote everyone in one step: Year 1 → 2 and
            Year 2 → 3. Tick <strong>Failed</strong> for students who repeat
            their year; their academic year changes but their Year stays the
            same. Everyone selected gets the existing-student admission fees (
            {money(fee)}) for the new academic year.
          </p>
        </div>
      </div>
      <div className="table-toolbar">
        <label>
          New academic year{" "}
          <input
            value={academicYear}
            onChange={(e) => setAcademicYear(e.target.value.trim())}
            placeholder="2027-2028"
            maxLength={9}
            aria-label="New academic year"
          />
        </label>
        <span>
          {chosen.length - repeating.length} promoted · {repeating.length}{" "}
          repeating
        </span>
      </div>
      <Table
        headers={[
          <input
            type="checkbox"
            aria-label="Select all"
            checked={
              !!chosen.length &&
              chosen.length ===
                ready.filter((s) => s.year < 3 || failed.has(s.id)).length
            }
            onChange={(e) =>
              setPicked(new Set(e.target.checked ? ready.map((s) => s.id) : []))
            }
          />,
          "Student",
          "Now",
          "Failed",
          "After",
        ]}
        rows={active.map((s) => {
          const finished = done(s),
            isFailed = failed.has(s.id),
            final = s.year >= 3 && !isFailed;
          return [
            <input
              type="checkbox"
              aria-label={`Include ${s.name}`}
              disabled={finished || final}
              checked={!finished && included(s)}
              onChange={(e) =>
                setPicked(toggle(picked, s.id, e.target.checked))
              }
            />,
            <>
              <strong>{s.name}</strong>
              <small>{s.code}</small>
            </>,
            `Year ${s.year} · ${s.academic_year || "—"}`,
            <label className="inline-check">
              <input
                type="checkbox"
                aria-label={`${s.name} failed`}
                disabled={finished}
                checked={isFailed}
                onChange={(e) => {
                  setFailed(toggle(failed, s.id, e.target.checked));
                  if (e.target.checked) setPicked(toggle(picked, s.id, true));
                }}
              />{" "}
              Failed
            </label>,
            finished ? (
              <span className="badge">Already in {s.academic_year}</span>
            ) : final ? (
              <span className="badge">Final year</span>
            ) : !included(s) ? (
              "Not included"
            ) : (
              `Year ${isFailed ? s.year : s.year + 1}${isFailed ? " (repeat)" : ""} · ${academicYear} · ${money(fee)} due`
            ),
          ];
        })}
      />
      {error && <p className="notice danger">{error}</p>}
      <button
        className="button"
        disabled={busy || !chosen.length}
        onClick={async () => {
          setError("");
          if (
            !(await ask({
              title: `Move ${chosen.length} student${chosen.length === 1 ? "" : "s"} to ${academicYear}?`,
              body: `${chosen.length - repeating.length} promoted to the next year and ${repeating.length} repeating their year. This adds ${money(fee * chosen.length)} in admission fees to their dues. It cannot be undone.`,
              confirm: "Promote",
            }))
          )
            return;
          setBusy(true);
          try {
            const r = await api<{
              promoted: number;
              repeating: number;
              total: number;
            }>("/students/promote", {
              academic_year: academicYear,
              student_ids: chosen.map((s) => s.id),
              failed_ids: repeating.map((s) => s.id),
            });
            await onSaved(
              `${r.promoted} promoted, ${r.repeating} repeating. ${money(r.total)} added to their dues.`,
            );
          } catch (err) {
            setError(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Promoting…" : `Promote ${chosen.length} students`}
      </button>
    </section>
  );
}
function Accounts({
  data,
  onSaved,
}: {
  data: Workspace;
  onSaved: (m: string) => Promise<void>;
}) {
  const { rows, reload, error } = useRows("/accounts"),
    [selected, setSelected] = useState<Row | null>(null),
    [add, setAdd] = useState(false),
    [problem, setProblem] = useState(""),
    confirm = useConfirm();
  const saved = async () => {
    setSelected(null);
    setAdd(false);
    await reload();
    await onSaved("Account updated.");
  };
  return (
    <>
      {confirm.dialog}
      {(error || problem) && (
        <p className="notice danger">{error || problem}</p>
      )}
      <div className="notice">
        <p>
          New Students and Managers choose “Register” on the {HOSTEL.short}{" "}
          sign-in page. Review each registration below. Passwords belong to the
          person and cannot be reset by the Admin.
        </p>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>People & access</h2>
            <p>
              Students send their details when they ask to join. Assign a room
              and approve in one step.
            </p>
          </div>
          {!data.community && (
            <button className="button" onClick={() => setAdd(!add)}>
              {add ? "Close form" : "Create account"}
            </button>
          )}
        </div>
        <Table
          headers={["Name", "Email", "Role", "Access", ""]}
          rows={rows.map((r) => [
            r.name,
            r.email,
            r.role,
            r.active ? (
              r.membership_status === "Pending" ? (
                <span className="badge amber">Waiting for you</span>
              ) : (
                r.membership_status || "Active"
              )
            ) : (
              "Disabled"
            ),
            r.id !== data.user.id && r.membership_status === "Pending" ? (
              <span className="row-actions">
                <button
                  className="button small"
                  onClick={async () => {
                    if (r.application_id) return setSelected(r);
                    if (
                      r.role === "Admin" &&
                      !(await confirm.ask({
                        title: `Make ${r.name} an Admin?`,
                        body: (
                          <>
                            <strong>{r.email}</strong> will have full access,
                            including approving people, fees and payments.
                          </>
                        ),
                        confirm: "Approve as Admin",
                      }))
                    )
                      return;
                    setProblem("");
                    try {
                      await api(`/accounts/${r.id}`, { status: "Approved" });
                      await saved();
                    } catch (e) {
                      setProblem(errorText(e));
                    }
                  }}
                >
                  {r.application_id
                    ? "Assign room & approve"
                    : r.role === "Admin"
                      ? "Approve as Admin"
                      : "Approve"}
                </button>
                {!r.application_id && (
                  <button
                    className="button secondary small"
                    onClick={() => setSelected(r)}
                  >
                    Review
                  </button>
                )}
              </span>
            ) : r.id !== data.user.id && r.role === "Admin" ? (
              "Admin"
            ) : r.id !== data.user.id ? (
              <button
                className="button secondary small"
                onClick={() => setSelected(r)}
              >
                Manage
              </button>
            ) : (
              "You"
            ),
          ])}
        />
      </section>
      {add && (
        <Form
          title="Create an account"
          fields={[
            field("name", "Full name"),
            field("email", "Email", "email"),
            {
              name: "role",
              label: "Role",
              options: choices(["Manager", "Warden", "Student", "Admin"]),
            },
            {
              name: "student_id",
              label: "Linked student (Student role only)",
              options: [
                { value: "", label: "Not linked / new applicant" },
                ...data.students.map((s) => ({
                  value: String(s.id),
                  label: `${s.name} · ${s.code}`,
                })),
              ],
              optional: true,
            },
            field(
              "password",
              "Temporary password (12+ characters)",
              "password",
            ),
          ]}
          submit="Create account"
          onSubmit={async (v) => {
            await api("/accounts", {
              ...v,
              student_id: Number(v.student_id) || null,
            });
            await saved();
          }}
        >
          <p className="notice">
            Share the temporary password privately. The user must replace it on
            first sign-in.
          </p>
        </Form>
      )}
      {selected?.application_id && selected.membership_status === "Pending" && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>{selected.name}</h2>
              <p>
                {selected.course} · Year {selected.year} · {selected.department}{" "}
                · {selected.admission_type}
              </p>
            </div>
            <button
              className="button secondary"
              onClick={() => setSelected(null)}
            >
              Close
            </button>
          </div>
          <div className="settings-form join-request-details">
            <p>
              {selected.email} · {selected.phone}
              <br />
              Parent: {selected.guardian}
              {selected.guardian_phone ? ` · ${selected.guardian_phone}` : ""}
            </p>
            <p>{selected.address}</p>
          </div>
          <Form
            key={`approve-${selected.id}`}
            title="Assign room & approve"
            description="One step: this adds the student to the register with this room and gives them access."
            before={<RoomPicker data={data} />}
            fields={[
              {
                ...field("joined", "Joining date", "date", data.today),
                max: data.today,
              },
            ]}
            submit="Assign room & approve"
            onSubmit={async (v) => {
              await api(`/applications/${selected.application_id}/review`, {
                ...v,
                status: "Approved",
              });
              await saved();
            }}
          />
          <Form
            key={`reject-${selected.id}`}
            title="Reject request"
            fields={[field("reason", "Reason", "textarea")]}
            submit="Reject request"
            onSubmit={async (v) => {
              await api(`/applications/${selected.application_id}/review`, {
                ...v,
                status: "Rejected",
              });
              await saved();
            }}
          />
        </section>
      )}
      {selected &&
        data.community &&
        !(
          selected.application_id && selected.membership_status === "Pending"
        ) && (
          <>
            <Form
              key={selected.id}
              title={`Review ${selected.name} · ${selected.role}`}
              description="Check the person’s identity before granting access."
              fields={[
                {
                  name: "status",
                  label: "Decision",
                  options: choices(["Approved", "Rejected"]),
                },
                {
                  ...field("reason", "Reason (required for rejection)"),
                  optional: true,
                },
                ...(selected.role === "Student"
                  ? [
                      {
                        name: "student_id",
                        label: "Linked student record",
                        optional: true,
                        value: selected.student_id || "",
                        options: [
                          {
                            value: "",
                            label: "Not linked / new admission applicant",
                          },
                          ...data.students.map((s) => ({
                            value: String(s.id),
                            label: `${s.name} · ${s.code}`,
                          })),
                        ],
                      },
                    ]
                  : []),
              ]}
              submit="Save membership decision"
              onSubmit={async (v) => {
                await api(`/accounts/${selected.id}`, {
                  ...v,
                  ...(selected.role === "Student"
                    ? { student_id: Number(v.student_id) || null }
                    : {}),
                });
                await saved();
              }}
            >
              {selected.role === "Student" && (
                <p className="notice">
                  Link only this person’s student record. An approved, unlinked
                  Student can submit an admission application, which you review
                  separately.
                </p>
              )}
            </Form>
            {selected.membership_status === "Approved" && (
              <Form
                title={`${selected.active ? "Disable" : "Enable"} access`}
                fields={[]}
                submit={
                  selected.active
                    ? "Disable access & sign out"
                    : "Enable access"
                }
                onSubmit={async () => {
                  await api(`/accounts/${selected.id}`, {
                    active: selected.active ? 0 : 1,
                  });
                  await saved();
                }}
              />
            )}
          </>
        )}
      {selected && !data.community && (
        <>
          <Form
            title={`${selected.active ? "Disable" : "Enable"} ${selected.name}`}
            fields={[]}
            submit={
              selected.active ? "Disable access & sign out" : "Enable access"
            }
            onSubmit={async () => {
              await api(`/accounts/${selected.id}`, {
                active: selected.active ? 0 : 1,
              });
              await saved();
            }}
          />
          <Form
            title={`Reset password · ${selected.name}`}
            fields={[field("password", "New temporary password", "password")]}
            submit="Reset & revoke sessions"
            onSubmit={async (v) => {
              await api(`/accounts/${selected.id}`, v);
              await saved();
            }}
          />
        </>
      )}
    </>
  );
}
function Corrections({
  data,
  onSaved,
}: {
  data: Workspace;
  onSaved: (m: string) => Promise<void>;
}) {
  const confirm = useConfirm();
  return (
    <>
      {confirm.dialog}
      <div className="notice">
        Corrections are administrator-only and require a reason. Original
        receipts and billed rates remain in the audit history. A reversal
        cancels a bookkeeping entry; it does not send money to a bank account.
      </div>
      <Form
        title="Reverse a payment"
        description="Use for an incorrect collection. The receipt remains marked Reversed and the allocated balance reopens."
        fields={[
          {
            name: "id",
            label: "Receipt to reverse",
            options: data.payments
              .filter((p) => !p.reversed_at)
              .map((p) => ({
                value: String(p.id),
                label: `${p.receipt} · ${p.name} · ${money(p.amount)}`,
              })),
          },
          field("reason", "Correction reason", "textarea"),
        ]}
        submit="Reverse selected payment"
        onSubmit={async (v) => {
          if (
            !(await confirm.ask({
              title: "Reverse this payment?",
              body: "Its balance reopens. This cannot be undone.",
              confirm: "Reverse payment",
              danger: true,
            }))
          )
            return;
          await api(`/payments/${v.id}/reverse`, { reason: v.reason });
          await onSaved("Payment reversed. Its receipt remains in history.");
        }}
      />
      <Form
        title="Adjust a finalized demand"
        description="The revised total cannot be lower than the amount already collected."
        fields={[
          {
            name: "id",
            label: "Demand",
            options: data.demands.map((d) => ({
              value: String(d.id),
              label: `${d.name} · ${d.period} · ${d.description} · ${money(d.amount + d.adjustment)}`,
            })),
          },
          {
            ...field("amount", "Revised total (₹)", "number"),
            min: 0,
            step: "0.01",
          },
          field("reason", "Adjustment reason", "textarea"),
        ]}
        submit="Record adjustment"
        onSubmit={async (v) => {
          await api(`/demands/${v.id}/adjust`, {
            amount: Math.round(Number(v.amount) * 100),
            reason: v.reason,
          });
          await onSaved("Demand adjusted with an audit record.");
        }}
      />
    </>
  );
}

function Imports({ onSaved }: { onSaved: (m: string) => Promise<void> }) {
  const [kind, setKind] = useState("students"),
    [preview, setPreview] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const studentHeaders = [
      "name",
      "roll",
      "department",
      "year",
      "room",
      "phone",
      "guardian",
      "admission_type",
      "joined",
      "course",
      "academic_year",
      "address",
      "guardian_phone",
    ],
    balanceHeaders = ["roll", "category", "period", "amount", "description"];
  const template = async () => {
    const Excel = (await import("exceljs")).default;
    const book = new Excel.Workbook();
    const s = book.addWorksheet("Import");
    s.addRow(kind === "students" ? studentHeaders : balanceHeaders);
    s.getRow(1).font = { bold: true };
    const buffer = await book.xlsx.writeBuffer();
    const url = URL.createObjectURL(
      new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `jss-pda-${kind}-template.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const load = async (file: File) => {
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      if (file.size > 2_000_000)
        throw Error("Choose a workbook smaller than 2 MB.");
      const Excel = (await import("exceljs")).default;
      const book = new Excel.Workbook();
      await book.xlsx.load(await file.arrayBuffer());
      const sheet = book.worksheets[0];
      if (!sheet || sheet.rowCount > 5001)
        throw Error("Use the first sheet with at most 5,000 data rows.");
      const headers = (sheet.getRow(1).values as unknown[])
        .slice(1)
        .map((v) => String(v).trim());
      const required =
        kind === "students" ? studentHeaders.slice(0, 9) : balanceHeaders;
      for (const key of required)
        if (!headers.includes(key))
          throw Error(`Missing column: ${key}. Download the template.`);
      const rows: Row[] = [];
      sheet.eachRow((row, n) => {
        if (n === 1) return;
        const value: Row = {};
        for (let i = 0; i < headers.length; i++) {
          const cell = row.getCell(i + 1);
          if (cell.type === Excel.ValueType.Formula)
            throw Error(`Row ${n}: formulas are not accepted.`);
          const raw = cell.value;
          value[headers[i]] =
            raw instanceof Date
              ? raw.toISOString().slice(0, 10)
              : ["year", "amount"].includes(headers[i])
                ? Number(raw)
                : raw === null
                  ? ""
                  : typeof raw === "object"
                    ? cell.text
                    : String(raw);
        }
        rows.push(value);
      });
      setPreview(await api("/imports/preview", { kind, rows }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Bring your records with you</h2>
            <p>
              Excel → validation → review → one atomic import. Nothing is
              silently skipped.
            </p>
          </div>
        </div>
        <div className="settings-form">
          <label className="field">
            <span>Import type</span>
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setPreview(null);
              }}
            >
              <option value="students">Student register</option>
              <option value="balances">Historical opening balances</option>
            </select>
          </label>
          <p className="notice">
            Use YYYY-MM-DD dates and YYYY-MM billing periods. Opening-balance
            amounts are in paise (₹1 = 100). Preserve phone and roll numbers as
            text. Imports create unpaid demands, not historical receipts.
          </p>
          <div className="heading-actions">
            <button
              className="button secondary"
              onClick={() => void template()}
            >
              Download Excel template
            </button>
            <label className="button">
              {busy ? "Reading workbook…" : "Choose .xlsx workbook"}
              <input
                type="file"
                accept=".xlsx"
                disabled={busy}
                className="visually-hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void load(f);
                  e.currentTarget.value = "";
                }}
              />
            </label>
          </div>
          {error && (
            <div className="notice danger" role="alert">
              {error}
            </div>
          )}
        </div>
      </section>
      {preview && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>
                {preview.count} rows · {preview.errors.length} errors
              </h2>
              <p>
                {preview.errors.length
                  ? "Fix the source workbook and preview again. No rows have been saved."
                  : "Validation passed. Review before importing."}
              </p>
            </div>
          </div>
          {preview.errors.length > 0 ? (
            <Table
              headers={["Excel row", "Issue"]}
              rows={preview.errors.map((r: Row) => [r.row, r.error])}
            />
          ) : (
            <Table
              headers={
                kind === "students"
                  ? ["Name", "Roll", "Room"]
                  : ["Roll", "Category", "Period", "Amount"]
              }
              rows={preview.rows
                .slice(0, 100)
                .map((r: Row) =>
                  kind === "students"
                    ? [r.name, r.roll, r.room]
                    : [r.roll, r.category, r.period, money(r.amount)],
                )}
            />
          )}
          <div className="settings-form">
            <p>
              Preview shows up to 100 rows. The entire batch is validated again
              at commit.
            </p>
            <button
              className="button"
              disabled={busy || preview.errors.length > 0}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api<{ count: number }>(
                    `/imports/${preview.id}/commit`,
                    {},
                  );
                  setPreview(null);
                  await onSaved(`${r.count} rows imported successfully.`);
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Confirm import
            </button>
          </div>
        </section>
      )}
    </>
  );
}
function Registers({ data }: { data: Workspace }) {
  const [report, setReport] = useState<Row | null>(null);
  return (
    <>
      <Form
        title="Collection & reconciliation register"
        description="Date range applies to payments. Outstanding and category balances are current, all-time totals."
        fields={[
          field("from", "From", "date", `${data.today.slice(0, 7)}-01`),
          field("to", "To", "date", data.today),
        ]}
        submit="Generate register"
        onSubmit={async (v) =>
          setReport(await api(`/reports?from=${v.from}&to=${v.to}`))
        }
      />
      <section className="panel">
        <div className="panel-heading">
          <h2>Download complete registers</h2>
        </div>
        <div className="settings-form export-actions">
          {exportButton("students", "Students · Excel")}
          {exportButton("payments", "Payments · Excel")}
          {exportButton("outstanding", "Outstanding · Excel")}
          {exportButton("audit", "Audit trail · Excel")}
          {data.user.role === "Admin" && (
            <a className="button secondary" href={apiUrl("/backup")}>
              Data archive · JSON
            </a>
          )}
        </div>
      </section>
      {report && (
        <section className="panel printable-register">
          <div className="panel-heading">
            <div>
              <h2>{data.settings.hostel_name} · Collection register</h2>
              <p>
                {dateName(report.from)} – {dateName(report.to)} · Net valid
                collections: {money(report.total)}
              </p>
            </div>
            <button
              className="button secondary no-print"
              onClick={() => window.print()}
            >
              Print / Save PDF
            </button>
          </div>
          <div className="settings-form">
            <div className="detail-grid">
              {report.modes.map((m: Row) => (
                <div key={m.mode}>
                  <small>{m.mode}</small>
                  <strong>{money(m.amount)}</strong>
                </div>
              ))}
            </div>
          </div>
          <Table
            headers={["Receipt", "Student", "Date", "Mode", "Amount", "Status"]}
            rows={report.payments.map((p: Row) => [
              p.receipt,
              p.name,
              dateName(p.date),
              p.mode,
              money(p.amount),
              p.reversed_at ? "Reversed" : "Received",
            ])}
          />
          <div className="panel-heading">
            <h2>Current category reconciliation</h2>
          </div>
          <Table
            headers={["Category", "Demand", "Collected", "Balance"]}
            rows={report.categories.map((c: Row) => [
              c.category,
              money(c.demand),
              money(c.collected),
              money(c.balance),
            ])}
          />
          <div className="panel-heading">
            <h2>Outstanding fee register</h2>
          </div>
          <Table
            headers={["Student", "Category", "Period", "Balance"]}
            rows={report.outstanding.map((d: Row) => [
              `${d.name} · ${d.code}`,
              d.category,
              d.period,
              money(d.balance),
            ])}
          />
        </section>
      )}
    </>
  );
}

export function StudentTools({
  student: s,
  data,
  onSaved,
}: {
  student: Student;
  data: Workspace;
  onSaved: (m: string) => Promise<void>;
}) {
  const [history, setHistory] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [edit, setEdit] = useState(false),
    [busy, setBusy] = useState(false);
  const reload = async () => {
    try {
      setHistory(await api(`/students/${s.id}/history`));
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    void reload();
  }, [s.id]);
  return (
    <div className="student-tools">
      {error && (
        <p className="notice danger" role="alert">
          {error}
        </p>
      )}
      <details>
        <summary>Academic, room & attendance history</summary>
        <p>
          {s.course} · {s.academic_year || "Academic year not set"}
        </p>
        <p>{s.address || "Address not recorded"}</p>
        <p>Parent phone: {s.guardian_phone || "Not recorded"}</p>
        {s.exited && (
          <p className="notice">
            {s.status} on {dateName(s.exited)} · {s.exit_reason}
          </p>
        )}
        <Table
          headers={["Room", "From", "To", "Reason"]}
          rows={(history?.rooms || []).map((r: Row) => [
            r.room,
            r.started,
            r.ended || "Current",
            r.reason,
          ])}
        />
        <h3>Attendance · latest 366 days</h3>
        <div className="history-scroll">
          <Table
            headers={["Date", "Status"]}
            rows={(history?.attendance || []).map((r: Row) => [
              r.date,
              r.status,
            ])}
          />
        </div>
      </details>
      <details>
        <summary>Private documents</summary>
        <div className="document-list">
          {(history?.documents || []).map((d: Row) => (
            <button
              key={d.id}
              className="button secondary"
              onClick={async () => {
                try {
                  const r = await api<{ url: string }>(`/documents/${d.id}`);
                  window.location.assign(r.url);
                } catch (e) {
                  setError(errorText(e));
                }
              }}
            >
              {d.name} · {Math.ceil(d.bytes / 1024)} KB
            </button>
          ))}
          {!history?.documents?.length && <p>No documents uploaded.</p>}
        </div>
        {data.user.role !== "Student" && (
          <label className="button secondary">
            {busy ? "Uploading…" : "Upload PDF or image (2 MB max)"}
            <input
              type="file"
              className="visually-hidden"
              accept="application/pdf,image/png,image/jpeg"
              disabled={busy}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.currentTarget.value = "";
                if (!f) return;
                setBusy(true);
                setError("");
                try {
                  if (f.size > 2_000_000)
                    throw Error("Maximum file size is 2 MB.");
                  const content = await new Promise<string>(
                    (resolve, reject) => {
                      const reader = new FileReader();
                      reader.onload = () =>
                        resolve(String(reader.result).split(",")[1]);
                      reader.onerror = () =>
                        reject(Error("Could not read file."));
                      reader.readAsDataURL(f);
                    },
                  );
                  await api(`/students/${s.id}/documents`, {
                    name: f.name,
                    content,
                  });
                  await reload();
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label>
        )}
      </details>
      {data.user.role !== "Student" && (
        <button className="button secondary" onClick={() => setEdit(!edit)}>
          {edit ? "Cancel" : "Move room / close admission"}
        </button>
      )}
      {edit && (
        <Form
          title="Move room or close admission"
          description="Student details are fixed once approved. Only the room can change; Year and academic year change through Promote students."
          before={<RoomPicker data={data} current={s.room} studentId={s.id} />}
          fields={[
            {
              name: "status",
              label: "Status",
              options: choices(
                data.user.role === "Admin"
                  ? ["Active", "Left", "Graduated"]
                  : [s.status],
              ),
              value: s.status,
            },
            {
              ...field(
                "exited",
                "Exit date (only when leaving)",
                "date",
                s.exited || "",
              ),
              optional: true,
              max: data.today,
            },
            field("reason", "Reason for this change", "textarea"),
          ]}
          submit="Save changes"
          onSubmit={async (v) => {
            await api(`/students/${s.id}/update`, v);
            setEdit(false);
            await onSaved("Student record updated; history preserved.");
          }}
        />
      )}
    </div>
  );
}
