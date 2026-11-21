import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import {
  api,
  apiUrl,
  communityCode,
  selectCommunity,
  leaveCommunity,
  money,
  dateName,
  type Student,
  type Workspace,
  type Community,
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
function Table({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
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

const communitySlug = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");

// Find a community by its name or readable ID; nobody types a random code.
function CommunityPicker({
  value,
  onChange,
}: {
  value: Community | null;
  onChange: (c: Community | null) => void;
}) {
  const [query, setQuery] = useState(""),
    [results, setResults] = useState<Community[]>([]),
    [searched, setSearched] = useState(false);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearched(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api<Community[]>(`/communities/search?q=${encodeURIComponent(q)}`)
        .then((rows) => {
          if (!cancelled) {
            setResults(rows);
            setSearched(true);
          }
        })
        .catch(() => !cancelled && setResults([]));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);
  if (value)
    return (
      <div className="field community-picked">
        <span>Community</span>
        <div className="community-choice selected">
          <div>
            <strong>{value.name}</strong>
            <small>ID: {value.code}</small>
          </div>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              onChange(null);
              setQuery("");
            }}
          >
            Change
          </button>
        </div>
      </div>
    );
  return (
    <div className="field community-picker">
      <label htmlFor="community-search">
        <span>Find your community</span>
      </label>
      <input
        id="community-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Type the hostel name or community ID, e.g. sais-hostel"
        autoComplete="off"
      />
      {results.length > 0 && (
        <div className="community-results" role="listbox">
          {results.map((c) => (
            <button
              type="button"
              role="option"
              aria-selected={false}
              key={c.code}
              className="community-choice"
              onClick={() => onChange(c)}
            >
              <strong>{c.name}</strong>
              <small>ID: {c.code}</small>
            </button>
          ))}
        </div>
      )}
      {searched && !results.length && (
        <small className="community-empty">
          No community matches “{query.trim()}”. Check the spelling or ask your
          Admin for the community ID.
        </small>
      )}
    </div>
  );
}

export function CommunityGate({ onLogin }: { onLogin: () => Promise<void> }) {
  const [mode, setMode] = useState("Sign in");
  const [community, setCommunity] = useState<Community | null>(null);
  const [created, setCreated] = useState<Community | null>(null);
  const [joined, setJoined] = useState<Community | null>(null);
  const [hostelName, setHostelName] = useState("");
  const [joinRole, setJoinRole] = useState("Student");
  // Pending join waiting for the email code: the details stay in the form.
  const [verifying, setVerifying] = useState<{
    email: string;
    body: Row;
    create: boolean;
  } | null>(null);
  const [customId, setCustomId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  useEffect(() => {
    const code = communityCode();
    if (code)
      api<{ community?: Community }>("/config")
        .then((c) => c.community && setCommunity(c.community))
        .catch(() => leaveCommunity());
  }, []);
  const typedId = idEdited
    ? communitySlug(customId)
    : communitySlug(hostelName);
  const [idCheck, setIdCheck] = useState<{
    code: string;
    valid: boolean;
    available: boolean;
    suggestion: string;
  } | null>(null);
  useEffect(() => {
    if (!typedId) return setIdCheck(null);
    let cancelled = false;
    const timer = setTimeout(() => {
      api<NonNullable<typeof idCheck>>(
        `/communities/available?code=${encodeURIComponent(typedId)}`,
      )
        .then((r) => !cancelled && setIdCheck(r))
        .catch(() => !cancelled && setIdCheck(null));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [typedId]);
  // Untouched suggestions take the next free ID; a typed ID must be free.
  const suggestedId =
    !idEdited && idCheck?.code === typedId && idCheck.suggestion
      ? idCheck.suggestion
      : typedId;
  const switchMode = (next: string) => {
    setMode(next);
    setCreated(null);
    setJoined(null);
  };
  if (created)
    return (
      <div className="setup-page community-page">
        <div className="eyebrow">COMMUNITY CREATED</div>
        <h1>{created.name} is ready.</h1>
        <p>
          You are its Admin. Share the community ID with your students and
          managers.
        </p>
        <section className="panel operation-form community-share">
          <span>Community ID</span>
          <strong className="community-id">{created.code}</strong>
          <p>
            People open Hostel360, choose <strong>Join a community</strong>, and
            search “{created.name}” or “{created.code}”. Their requests appear
            under Operations → Accounts for you to approve.
          </p>
          <div className="community-share-actions">
            <button
              className="button secondary"
              onClick={() =>
                void navigator.clipboard?.writeText(
                  `${window.location.origin}/?community=${created.code}`,
                )
              }
            >
              Copy join link
            </button>
            <button className="button" onClick={() => void onLogin()}>
              Open my community
            </button>
          </div>
        </section>
      </div>
    );
  if (verifying && (verifying.create || community))
    return (
      <div className="setup-page community-page">
        <div className="eyebrow">VERIFY YOUR EMAIL</div>
        <h1>Check your inbox.</h1>
        <p>
          We sent a code to <strong>{verifying.email}</strong>. Enter it to{" "}
          {verifying.create
            ? `create ${verifying.body.community_name}`
            : `send your request to ${community!.name}`}
          .
        </p>
        <Form
          title="Enter the code"
          fields={[
            {
              ...field("email_code", "Verification code"),
            },
          ]}
          submit={
            verifying.create
              ? "Verify & create community"
              : "Verify & send request"
          }
          onSubmit={async (v) => {
            const email_code = String(v.email_code).trim();
            const login = {
              email: verifying.body.email,
              password: verifying.body.password,
            };
            if (verifying.create) {
              const result = await api<{ community: Community }>(
                "/communities",
                { ...verifying.body, email_code },
              );
              selectCommunity(result.community.code);
              await api("/login", login);
              setVerifying(null);
              setCreated(result.community);
              return;
            }
            await api("/communities/join", { ...verifying.body, email_code });
            selectCommunity(community!.code);
            await api("/login", login);
            setVerifying(null);
            setJoined(community!);
          }}
        >
          <p className="notice">
            The code expires in an hour. Didn’t get it? Check spam, or{" "}
            <button
              type="button"
              className="text-button"
              onClick={async () => {
                try {
                  await api("/email/code", { email: verifying.email });
                  window.alert("A new code has been sent.");
                } catch (e) {
                  window.alert(errorText(e));
                }
              }}
            >
              send a new code
            </button>{" "}
            or{" "}
            <button
              type="button"
              className="text-button"
              onClick={() => setVerifying(null)}
            >
              change your email
            </button>
            .
          </p>
        </Form>
      </div>
    );
  if (joined)
    return (
      <div className="setup-page community-page">
        <div className="eyebrow">REQUEST SENT</div>
        <h1>Your request is with the Admin.</h1>
        <p>
          {joined.name}’s Admin has been notified. You can sign in now to check
          your status; records open once you are approved.
        </p>
        <button
          className="button"
          onClick={async () => {
            // Approval signs out earlier sessions; sign in again if needed.
            try {
              await api("/membership");
              await onLogin();
            } catch {
              setJoined(null);
              setMode("Sign in");
            }
          }}
        >
          Check my request status
        </button>
      </div>
    );
  return (
    <div className="setup-page community-page">
      <div className="eyebrow">HOSTEL360 · YOUR COMMUNITY, CONNECTED</div>
      <h1>A place for every hostel.</h1>
      <p>
        Create a community as its Admin, or join yours as a Manager or Student.
        Each community has its own people and private records.
      </p>
      <div className="tabs" aria-label="Community access">
        {["Sign in", "Create a community", "Join a community"].map((label) => (
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
          mode === "Create a community"
            ? "You’ll be the Admin. Pick a short, memorable community ID to share, then approve the people who request to join."
            : mode === "Join a community"
              ? "Search for your hostel by name. The Admin assigns your room and approves your request in one step."
              : "Choose your community, then use your own email and password."
        }
        fields={[
          ...(mode !== "Sign in" ? [field("name", "Your full name")] : []),
          field("email", "Email", "email"),
          field(
            "password",
            mode === "Sign in"
              ? "Password"
              : "Password (12+ characters, or your existing Hostel360 password)",
            "password",
          ),
        ]}
        before={
          mode === "Create a community" ? (
            <>
              <label className="field">
                <span>Community / hostel name</span>
                <input
                  name="community_name"
                  required
                  maxLength={120}
                  value={hostelName}
                  onChange={(e) => setHostelName(e.target.value)}
                  placeholder="e.g. Sai's Hostel"
                />
              </label>
              <label className="field">
                <span>Community ID (people search or type this)</span>
                <input
                  name="code"
                  maxLength={40}
                  value={idEdited ? customId : suggestedId}
                  onChange={(e) => {
                    setIdEdited(true);
                    setCustomId(e.target.value);
                  }}
                  onBlur={() =>
                    idEdited && setCustomId(communitySlug(customId))
                  }
                  placeholder="e.g. sais-hostel"
                />
                {idCheck?.code === typedId && !idCheck.valid ? (
                  <small className="id-status bad">
                    Use 3–40 letters, numbers or hyphens.
                  </small>
                ) : idCheck?.code === typedId &&
                  !idCheck.available &&
                  idEdited ? (
                  <small className="id-status bad">
                    “{typedId}” is taken.{" "}
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setCustomId(idCheck.suggestion)}
                    >
                      Use {idCheck.suggestion}
                    </button>
                  </small>
                ) : idCheck?.code === typedId ? (
                  <small className="id-status good">
                    ✓ {suggestedId} is available
                    {!idEdited && suggestedId !== typedId
                      ? ` (${typedId} is already used)`
                      : ""}
                  </small>
                ) : (
                  <small>Letters, numbers and hyphens.</small>
                )}
              </label>
            </>
          ) : (
            <>
              <CommunityPicker value={community} onChange={setCommunity} />
              {mode === "Join a community" && (
                <label className="field">
                  <span>I am joining as</span>
                  <select
                    name="role"
                    value={joinRole}
                    onChange={(e) => setJoinRole(e.target.value)}
                  >
                    <option>Student</option>
                    <option>Manager</option>
                  </select>
                </label>
              )}
            </>
          )
        }
        after={
          mode === "Join a community" && joinRole === "Student" ? (
            <fieldset className="join-details">
              <legend>Your hostel details</legend>
              <p>
                Sent with your request. The Admin assigns your room and approves
                you in one step.
              </p>
              <div className="form-grid">
                {studentDetailFields(today()).map((f) => (
                  <FieldInput key={f.name} f={f} />
                ))}
              </div>
            </fieldset>
          ) : null
        }
        submit={mode === "Join a community" ? "Send join request" : mode}
        onSubmit={async (v) => {
          if (mode === "Create a community") {
            const body = { ...v, code: suggestedId, custom_code: idEdited };
            const check = await api<{ required: boolean }>("/email/code", {
              email: v.email,
            });
            if (check.required) {
              setVerifying({ email: String(v.email), body, create: true });
              return;
            }
            const result = await api<{ community: Community }>(
              "/communities",
              body,
            );
            selectCommunity(result.community.code);
            await api("/login", { email: v.email, password: v.password });
            setCreated(result.community);
            return;
          }
          if (!community) throw new Error("Choose your community first.");
          if (mode === "Join a community") {
            const detailKeys = studentDetailFields(today()).map((f) => f.name);
            const application = Object.fromEntries(
              detailKeys.map((k) => [k, k === "year" ? Number(v[k]) : v[k]]),
            );
            const body = {
              name: v.name,
              email: v.email,
              password: v.password,
              role: v.role,
              code: community.code,
              ...(v.role === "Student" ? { application } : {}),
            };
            // New emails get a code first; existing accounts go straight on.
            const check = await api<{ required: boolean }>("/email/code", {
              email: v.email,
            });
            if (check.required) {
              setVerifying({ email: String(v.email), body, create: false });
              return;
            }
            await api("/communities/join", body);
            selectCommunity(community.code);
            await api("/login", { email: v.email, password: v.password });
            setJoined(community);
            return;
          }
          selectCommunity(community.code);
          await api("/login", { email: v.email, password: v.password });
          await onLogin();
        }}
      >
        {mode !== "Sign in" && (
          <p className="notice">
            Already use Hostel360 in another community? Use the same email and
            password. Joining a community never grants access until its Admin
            approves you.
          </p>
        )}
      </Form>
    </div>
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
        `Still waiting for the Admin · checked at ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. We’ll open your community as soon as you’re approved.`,
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
            : "Contact your community Admin if you have questions."}
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
        Sign out / choose another community
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
      <div className="eyebrow">HOSTEL360 · SECURE ACTIVATION</div>
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
      ? ["Admission fees", "Imports", "Accounts", "Corrections", "Backups"]
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
      {tab === "Admission fees" && (
        <AdmissionFees data={data} onSaved={onSaved} />
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
                description="One step: this adds the student to the register with this room."
                fields={[
                  field("room", "Assigned room"),
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
function AdmissionFees({
  data,
  onSaved,
}: {
  data: Workspace;
  onSaved: (m: string) => Promise<void>;
}) {
  const { rows, reload, error } = useRows("/components"),
    [edit, setEdit] = useState<Row | null>(null),
    [preview, setPreview] = useState<Row | null>(null),
    [input, setInput] = useState<Row | null>(null);
  const fees = [
    "Admission fee",
    "Depreciation",
    "Application fee",
    "Room rent",
    "Utilities",
    "Reading room",
    "Caution deposit",
    "Development fee",
    "Establishment fee",
    "Others",
  ];
  return (
    <>
      {error && <p className="notice danger">{error}</p>}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Admission fee components</h2>
            <p>
              Amounts are set by your hostel; finalized charges never change
              with these settings.
            </p>
          </div>
          <button className="button" onClick={() => setEdit({})}>
            Add component
          </button>
        </div>
        <Table
          headers={[
            "Component",
            "Category",
            "Academic year",
            "Applies to",
            "Amount",
            "Status",
            "",
          ]}
          rows={rows.map((r) => [
            r.name,
            r.category,
            r.academic_year,
            r.applicability,
            money(r.amount),
            r.active ? "Active" : "Inactive",
            <button
              className="button secondary small"
              onClick={() => setEdit(r)}
            >
              Edit
            </button>,
          ])}
        />
      </section>
      {edit && (
        <Form
          key={edit.id || "new"}
          title={edit.id ? "Edit fee component" : "New fee component"}
          fields={[
            {
              name: "category",
              label: "Category",
              options: choices(["Fund", "Management", "Establishment"]),
              value: edit.category,
            },
            {
              name: "name",
              label: "Component",
              options: choices(fees),
              value: edit.name,
            },
            {
              ...field(
                "amount",
                "Amount (₹)",
                "number",
                edit.amount ? edit.amount / 100 : undefined,
              ),
              min: 0.01,
              step: "0.01",
            },
            field(
              "academic_year",
              "Academic year",
              "text",
              edit.academic_year || year(data.today),
            ),
            {
              name: "applicability",
              label: "Applies to",
              options: choices(["All", "Fresher", "Existing", "B.E."]),
              value: edit.applicability,
            },
            {
              name: "active",
              label: "Status",
              options: [
                { value: "1", label: "Active" },
                { value: "0", label: "Inactive" },
              ],
              value: edit.active ?? 1,
            },
          ]}
          onSubmit={async (v) => {
            await api("/components", {
              ...v,
              id: edit.id,
              amount: Math.round(Number(v.amount) * 100),
              active: Number(v.active),
            });
            setEdit(null);
            setPreview(null);
            await reload();
            await onSaved("Fee component saved.");
          }}
        >
          <div className="notice">
            Caution deposit always applies only to freshers. Management
            application fees apply only to B.E. students.
          </div>
          <button
            className="button secondary"
            type="button"
            onClick={() => setEdit(null)}
          >
            Cancel
          </button>
        </Form>
      )}
      <Form
        title="Generate admission charges"
        description="Preview charges for one student or all active students. Already-issued components are skipped."
        fields={[
          field("academic_year", "Academic year", "text", year(data.today)),
          field("period", "Billing month", "month", data.today.slice(0, 7)),
          {
            name: "student",
            label: "Student",
            options: [
              { value: "all", label: "All active students" },
              ...data.students
                .filter((s) => s.status === "Active")
                .map((s) => ({
                  value: String(s.id),
                  label: `${s.name} · ${s.code}`,
                })),
            ],
          },
        ]}
        submit="Preview admission fees"
        onSubmit={async (v) => {
          const b = {
            academic_year: v.academic_year,
            period: v.period,
            student_ids:
              v.student === "all"
                ? data.students
                    .filter((s) => s.status === "Active")
                    .map((s) => s.id)
                : [Number(v.student)],
          };
          setInput(b);
          setPreview(await api("/admission/preview", b));
        }}
      />
      {preview && (
        <Form
          title={`Review ${preview.rows.length} charges · ${money(preview.total)}`}
          fields={[]}
          submit="Finalize admission fees"
          onSubmit={async () => {
            await api("/admission/finalize", {
              ...input,
              expected_rows: preview.rows,
            });
            setPreview(null);
            await onSaved("Admission charges finalized.");
          }}
        >
          <Table
            headers={["Student", "Category", "Charge", "Amount"]}
            rows={preview.rows.map((r: Row) => [
              r.name,
              r.category,
              r.description,
              money(r.amount),
            ])}
          />
        </Form>
      )}
    </>
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
    [add, setAdd] = useState(false);
  const saved = async () => {
    setSelected(null);
    setAdd(false);
    await reload();
    await onSaved("Account updated.");
  };
  return (
    <>
      {error && <p className="notice danger">{error}</p>}
      {data.community && (
        <div className="notice">
          <strong>
            {data.settings.hostel_name} · Community ID: {data.community.code}
          </strong>
          <p>
            Share this ID or{" "}
            <a href={`/?community=${data.community.code}`}>this join link</a>.
            People choose “Join a community”, search “
            {data.settings.hostel_name}” and request Student or Manager access.
            Review each request below. Passwords belong to the person and cannot
            be reset by a community Admin.
          </p>
        </div>
      )}
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
                    try {
                      await api(`/accounts/${r.id}`, { status: "Approved" });
                      await saved();
                    } catch (e) {
                      window.alert(errorText(e));
                    }
                  }}
                >
                  {r.application_id ? "Assign room & approve" : "Approve"}
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
              options: choices(["Manager", "Student", "Admin"]),
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
            fields={[
              field("room", "Room"),
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
              description="Approval only applies to this community. Check the person’s identity before granting access."
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
  return (
    <>
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
            !window.confirm(
              "Reverse this payment and reopen its balance? This cannot be undone.",
            )
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
    a.download = `hostel360-${kind}-template.xlsx`;
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
            headers={["Student", "Category", "Month", "Balance"]}
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
          {edit ? "Cancel editing" : "Edit profile / move room"}
        </button>
      )}
      {edit && (
        <Form
          title="Update student record"
          fields={[
            field("name", "Full name", "text", s.name),
            field("department", "Department", "text", s.department),
            { ...field("year", "Year", "number", s.year), min: 1, max: 6 },
            field("room", "Room", "text", s.room),
            field("phone", "Phone", "tel", s.phone),
            field("guardian", "Parent name", "text", s.guardian),
            field("course", "Course", "text", s.course),
            field(
              "academic_year",
              "Academic year",
              "text",
              s.academic_year || year(data.today),
            ),
            {
              ...field("address", "Address", "textarea", s.address),
              optional: true,
            },
            {
              ...field(
                "guardian_phone",
                "Parent phone",
                "tel",
                s.guardian_phone,
              ),
              optional: true,
            },
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
          submit="Save student changes"
          onSubmit={async (v) => {
            await api(`/students/${s.id}/update`, {
              ...v,
              year: Number(v.year),
            });
            setEdit(false);
            await onSaved("Student record updated; history preserved.");
          }}
        />
      )}
    </div>
  );
}
