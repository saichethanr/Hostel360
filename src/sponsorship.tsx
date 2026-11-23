import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  Copy,
  FileText,
  HandCoins,
  HeartHandshake,
  Share2,
  Trash2,
} from "lucide-react";
import { api, money, HOSTEL, type Workspace } from "./lib";
import { useConfirm, ThemeToggle } from "./operations";
import { loadCheckout } from "./gateway";
import { coverMost } from "../server/cover";

type File = {
  id: number;
  label: string;
  detail: string;
  document_id: number | null;
  document_name?: string | null;
};
type Profile = {
  student_id: number;
  name: string;
  code?: string;
  course: string;
  department: string;
  year: number;
  academic_year: string;
  reason: string;
  active?: number;
  share_token?: string;
  photo_url: string | null;
  results: File[];
  documents: File[];
  outstanding: number | null;
  oldest?: string | null;
};
type Due = {
  student_id: number;
  name: string;
  code: string;
  department: string;
  outstanding: number;
  oldest: string;
  dues: number;
};
type Sponsor = {
  id: number;
  name: string;
  email: string;
  phone: string;
  contributed: number;
  given: number;
  balance: number;
};
type Contribution = {
  id: number;
  sponsor_id: number;
  sponsor_name: string;
  amount: number;
  received_on: string;
  method: string;
  note: string;
};
type Grant = {
  id: number;
  sponsor_id: number;
  sponsor_name: string;
  student_id: number;
  student_name: string;
  code: string;
  amount: number;
  created_at: string;
  chosen_by: "Sponsor" | "Admin";
};
type AdminData = {
  dues: Due[];
  listings: Profile[];
  sponsors: Sponsor[];
  contributions: Contribution[];
  grants: Grant[];
  online: boolean;
};

const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong.";
const readFile = (file: globalThis.File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
const rupees = (value: FormDataEntryValue | null) =>
  Math.round(Number(value || 0) * 100);
const shareLink = (token: string) =>
  `${window.location.origin}/appeal/${token}`;
const openDocument = async (id: number) => {
  const tab = window.open("", "_blank");
  try {
    const { url } = await api<{ url: string }>(`/sponsorship/documents/${id}`);
    if (tab) tab.location.href = url;
    else window.location.href = url;
  } catch (e) {
    tab?.close();
    alertError(e);
  }
};
let alertError: (e: unknown) => void = () => undefined;

// Small form wrapper: shows the error, disables while saving.
function SponsorForm({
  submit,
  onSubmit,
  children,
  className = "",
}: {
  submit: string;
  onSubmit: (f: FormData, form: HTMLFormElement) => Promise<void>;
  children: ReactNode;
  className?: string;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className={`settings-form ${className}`}
      onSubmit={async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const form = e.currentTarget;
        setBusy(true);
        setError("");
        try {
          await onSubmit(new FormData(form), form);
        } catch (err) {
          setError(errorText(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
      {error && (
        <p className="notice danger" role="alert">
          {error}
        </p>
      )}
      <button className="button" disabled={busy}>
        {busy ? "Saving…" : submit}
      </button>
    </form>
  );
}

function Photo({ p, size = 72 }: { p: Profile; size?: number }) {
  return p.photo_url ? (
    <img
      className="sponsor-photo"
      src={p.photo_url}
      alt={`Photo of ${p.name}`}
      style={{ width: size, height: size }}
    />
  ) : (
    <div
      className="sponsor-photo initials"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {p.name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()}
    </div>
  );
}

// Share a profile's public page: the phone's share sheet, or a platform.
export function ShareButtons({
  token,
  name,
  outstanding,
}: {
  token: string;
  name: string;
  outstanding: number | null;
}) {
  const [copied, setCopied] = useState(false);
  const link = shareLink(token);
  const message = `Help ${name} continue their studies at ${HOSTEL.name}${outstanding ? ` — ${money(outstanding)} in hostel fees is still due` : ""}.`;
  const encoded = encodeURIComponent(`${message} ${link}`);
  const targets = [
    ["WhatsApp", `https://wa.me/?text=${encoded}`],
    [
      "Facebook",
      `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(link)}`,
    ],
    [
      "X",
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(message)}&url=${encodeURIComponent(link)}`,
    ],
    [
      "LinkedIn",
      `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(link)}`,
    ],
    [
      "Telegram",
      `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(message)}`,
    ],
    [
      "Email",
      `mailto:?subject=${encodeURIComponent(`Sponsor ${name} at ${HOSTEL.short}`)}&body=${encoded}`,
    ],
  ];
  return (
    <div className="share-buttons">
      {"share" in navigator && (
        <button
          type="button"
          className="button secondary"
          onClick={() =>
            navigator
              .share({ title: `Sponsor ${name}`, text: message, url: link })
              .catch(() => undefined)
          }
        >
          <Share2 size={15} /> Share
        </button>
      )}
      {targets.map(([label, href]) => (
        <a
          key={label}
          className="button secondary"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {label}
        </a>
      ))}
      <button
        type="button"
        className="button secondary"
        onClick={async () => {
          await navigator.clipboard.writeText(link);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        <Copy size={15} /> {copied ? "Link copied" : "Copy link"}
      </button>
    </div>
  );
}

// What a Sponsor (or anyone with the shared link) sees about a student.
function ProfileCard({
  p,
  documents = true,
  children,
}: {
  p: Profile;
  documents?: boolean;
  children?: ReactNode;
}) {
  return (
    <article className="sponsor-card">
      <div className="sponsor-card-head">
        <Photo p={p} />
        <div>
          <h3>{p.name}</h3>
          <small>
            {[p.course, p.department, `Year ${p.year}`, p.academic_year]
              .filter(Boolean)
              .join(" · ")}
          </small>
          {p.outstanding !== null && (
            <p className="sponsor-due">
              {p.outstanding > 0 ? (
                <>
                  <strong>{money(p.outstanding)}</strong> in fees still due
                </>
              ) : (
                <span className="badge">Fees fully covered</span>
              )}
            </p>
          )}
        </div>
      </div>
      {p.reason && (
        <div>
          <h4>Why help is needed</h4>
          <p className="sponsor-reason">{p.reason}</p>
        </div>
      )}
      {!!p.results.length && (
        <div>
          <h4>Semester results</h4>
          <ul className="sponsor-results">
            {p.results.map((r) => (
              <li key={r.id}>
                <span>{r.label}</span>
                <strong>{r.detail}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}
      {documents && !!p.documents.length && (
        <div>
          <h4>Documents</h4>
          <div className="sponsor-documents">
            {p.documents.map((d) => (
              <button
                key={d.id}
                type="button"
                className="button secondary"
                onClick={() => d.document_id && openDocument(d.document_id)}
              >
                <FileText size={15} /> {d.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {children}
    </article>
  );
}

// Online contribution through Razorpay (UPI or card), for one student or
// for the wallet.
async function payOnline(
  data: Workspace,
  body: { amount: number; phone: string; student_id?: number },
  done: (message: string) => Promise<void>,
  fail: (message: string) => void,
) {
  await loadCheckout();
  const order = await api<{
    id: string;
    key_id: string;
    order_id: string;
    amount: number;
  }>("/sponsorship/contribute", body);
  const checkout = new window.Razorpay!({
    key: order.key_id,
    order_id: order.order_id,
    amount: order.amount,
    currency: "INR",
    name: data.community?.name || HOSTEL.name,
    description: body.student_id
      ? "Sponsoring a student"
      : "Sponsor wallet contribution",
    prefill: {
      name: data.user.name,
      email: data.user.email,
      contact: body.phone,
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
    handler: async (result: Record<string, string>) => {
      try {
        const { status } = await api<{ status: string }>(
          `/sponsorship/contribute/${order.id}/confirm`,
          result,
        );
        await done(
          status === "paid"
            ? body.student_id
              ? "Thank you! The student's fees are settled with your contribution."
              : "Thank you! Your contribution is in the sponsor wallet."
            : "Payment received by Razorpay; it will show here once confirmed.",
        );
      } catch (e) {
        fail(
          `${errorText(e)} If money was deducted, do not pay again; it will appear here shortly.`,
        );
      }
    },
    modal: { ondismiss: () => fail("Checkout closed. No money was taken.") },
  });
  checkout.open();
}

// ── Sponsor ─────────────────────────────────────────────────────────────
export function SponsorPage({
  data,
  onSaved,
}: {
  data: Workspace;
  onSaved: (message: string) => Promise<void>;
}) {
  const [students, setStudents] = useState<Profile[] | null>(null);
  const [mine, setMine] = useState<{
    sponsor: Sponsor | null;
    contributions: Contribution[];
    grants: Grant[];
    students: Profile[];
    online: boolean;
  } | null>(null);
  const [error, setError] = useState("");
  const [paying, setPaying] = useState<Profile | null>(null);
  const [tab, setTab] = useState("Students to sponsor");
  alertError = (e) => setError(errorText(e));
  const reload = async () => {
    try {
      const [s, m] = await Promise.all([
        api<Profile[]>("/sponsorship/students"),
        api<typeof mine>("/sponsorship/mine"),
      ]);
      setStudents(s);
      setMine(m);
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    void reload();
  }, [data]);
  const done = async (message: string) => {
    setPaying(null);
    await reload();
    await onSaved(message);
  };
  if (!students || !mine)
    return (
      <section className="panel">
        <p className="empty">{error || "Loading…"}</p>
      </section>
    );
  const phone = mine.sponsor?.phone || "";
  const giveForm = (student?: Profile) => (
    <SponsorForm
      className="sponsor-give"
      submit="Pay with UPI or card"
      onSubmit={async (f) => {
        setError("");
        await payOnline(
          data,
          {
            amount: rupees(f.get("amount")),
            phone: String(f.get("phone") || "").trim(),
            ...(student ? { student_id: student.student_id } : {}),
          },
          done,
          setError,
        );
      }}
    >
      <div className="form-grid">
        <label className="field">
          <span>Amount (₹)</span>
          <input
            name="amount"
            type="number"
            min="1"
            step="1"
            max={student?.outstanding ? student.outstanding / 100 : 1000000}
            defaultValue={
              student?.outstanding ? student.outstanding / 100 : undefined
            }
            required
          />
        </label>
        <label className="field">
          <span>Your phone</span>
          <input name="phone" type="tel" defaultValue={phone} required />
        </label>
      </div>
    </SponsorForm>
  );
  return (
    <div className="sponsor-page">
      {error && <p className="notice danger">{error}</p>}
      <section className="panel sponsor-summary">
        <div>
          <span>You have given</span>
          <strong>{money(Number(mine.sponsor?.contributed ?? 0))}</strong>
        </div>
        <div>
          <span>Reached students</span>
          <strong>{money(Number(mine.sponsor?.given ?? 0))}</strong>
        </div>
        <div>
          <span>Waiting for the Admin to allocate</span>
          <strong>{money(Number(mine.sponsor?.balance ?? 0))}</strong>
        </div>
      </section>
      <div className="tabs" aria-label="Sponsorship">
        {[
          "Students to sponsor",
          "Give to the wallet",
          "Where your money went",
        ].map((label) => (
          <button
            key={label}
            className={tab === label ? "active" : ""}
            onClick={() => setTab(label)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "Students to sponsor" && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Students to sponsor</h2>
              <p>
                Listed by the {HOSTEL.short} Admin. Sponsoring a student pays
                their oldest fees first; you get a record of every receipt.
              </p>
            </div>
          </div>
          {!students.length && (
            <div className="empty">
              <h3>No students are listed right now</h3>
              <p>You can still give to the wallet; the Admin allocates it.</p>
            </div>
          )}
          <div className="sponsor-grid">
            {students.map((p) => (
              <ProfileCard key={p.student_id} p={p}>
                {paying?.student_id === p.student_id ? (
                  <div className="sponsor-pay">
                    <h4>Sponsor {p.name}</h4>
                    {mine.online ? (
                      giveForm(p)
                    ) : (
                      <p className="notice">
                        Online payments are not enabled yet. Contact the hostel
                        office to sponsor.
                      </p>
                    )}
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setPaying(null)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="sponsor-actions">
                    {!!p.outstanding && (
                      <button
                        type="button"
                        className="button"
                        onClick={() => setPaying(p)}
                      >
                        <HeartHandshake size={15} /> Sponsor this student
                      </button>
                    )}
                    {p.share_token && (
                      <details className="sponsor-share">
                        <summary className="text-button">
                          Share this profile
                        </summary>
                        <ShareButtons
                          token={p.share_token}
                          name={p.name}
                          outstanding={p.outstanding}
                        />
                      </details>
                    )}
                  </div>
                )}
              </ProfileCard>
            ))}
          </div>
        </section>
      )}
      {tab === "Give to the wallet" && (
        <section className="panel operation-form">
          <div className="panel-heading">
            <div>
              <h2>Give to the sponsor wallet</h2>
              <p>
                The Admin uses the wallet to cover students with the oldest and
                largest dues. You’ll see here which students it reached.
              </p>
            </div>
          </div>
          {mine.online ? (
            giveForm()
          ) : (
            <p className="notice">
              Online payments are not enabled yet. Contact the hostel office.
            </p>
          )}
        </section>
      )}
      {tab === "Where your money went" && (
        <>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Students your money reached</h2>
                <p>Every grant from your contributions, with its receipts.</p>
              </div>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Student</th>
                    <th>How</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {mine.grants.map((g) => (
                    <tr key={g.id}>
                      <td>{g.created_at.slice(0, 10)}</td>
                      <td>{g.student_name}</td>
                      <td>
                        {g.chosen_by === "Sponsor"
                          ? "You sponsored this student"
                          : "Allocated by the Admin from your wallet"}
                      </td>
                      <td>{money(Number(g.amount))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!mine.grants.length && (
                <div className="empty">
                  <h3>Nothing allocated yet</h3>
                  <p>
                    Students you sponsor, or the Admin allocates, show here.
                  </p>
                </div>
              )}
            </div>
          </section>
          {!!mine.students.length && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Profiles of students you helped</h2>
                </div>
              </div>
              <div className="sponsor-grid">
                {mine.students.map((p) => (
                  <ProfileCard key={p.student_id} p={p} />
                ))}
              </div>
            </section>
          )}
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Your contributions</h2>
              </div>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>How</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {mine.contributions.map((c) => (
                    <tr key={c.id}>
                      <td>{c.received_on}</td>
                      <td>
                        {c.method === "Online"
                          ? c.note
                          : "Recorded by the Admin"}
                      </td>
                      <td>{money(c.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!mine.contributions.length && (
                <div className="empty">
                  <h3>No contributions yet</h3>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

// ── Admin ───────────────────────────────────────────────────────────────
export function SponsorshipAdmin({
  data,
  onSaved,
}: {
  data: Workspace;
  onSaved: (message: string) => Promise<void>;
}) {
  const [state, setState] = useState<AdminData | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("Due list");
  const [editing, setEditing] = useState<number | null>(null);
  const [allocating, setAllocating] = useState<number | null>(null);
  const { ask, dialog } = useConfirm();
  alertError = (e) => setError(errorText(e));
  const reload = async () => {
    try {
      setState(await api<AdminData>("/sponsorship/admin"));
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
  if (!state)
    return (
      <section className="panel">
        <p className="empty">{error || "Loading…"}</p>
      </section>
    );
  const listingOf = (id: number) =>
    state.listings.find((l) => l.student_id === id);
  const editProfile = (id: number) => {
    setEditing(id);
    setTab("Profiles");
    window.scrollTo(0, 0);
  };
  return (
    <div className="sponsor-page">
      {dialog}
      {error && <p className="notice danger">{error}</p>}
      <div className="tabs" aria-label="Sponsorship">
        {["Due list", "Profiles", "Sponsors & wallet"].map((label) => (
          <button
            key={label}
            className={tab === label ? "active" : ""}
            onClick={() => setTab(label)}
          >
            {label}
            {label === "Profiles" && (
              <span className="tab-count">
                {state.listings.filter((l) => l.active).length}
              </span>
            )}
          </button>
        ))}
      </div>
      {tab === "Due list" && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Students with dues</h2>
              <p>
                Oldest dues first, then the largest. Prepare a profile to list a
                student for sponsors.
              </p>
            </div>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Dues since</th>
                  <th>Open dues</th>
                  <th>Outstanding</th>
                  <th>Sponsorship</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {state.dues.map((d) => {
                  const l = listingOf(d.student_id);
                  return (
                    <tr key={d.student_id}>
                      <td>
                        <strong>{d.name}</strong>
                        <small className="cell-sub">
                          {d.code} · {d.department}
                        </small>
                      </td>
                      <td>{d.oldest}</td>
                      <td>{d.dues}</td>
                      <td>
                        <strong>{money(d.outstanding)}</strong>
                      </td>
                      <td>
                        {l ? (
                          <span className={`badge ${l.active ? "" : "grey"}`}>
                            {l.active ? "Listed" : "Hidden"}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="button secondary"
                          onClick={async () => {
                            if (!l)
                              try {
                                await api(
                                  `/sponsorship/listings/${d.student_id}`,
                                  { reason: "", active: 0 },
                                );
                                await reload();
                              } catch (e) {
                                setError(errorText(e));
                                return;
                              }
                            editProfile(d.student_id);
                          }}
                        >
                          {l ? "Edit profile" : "Prepare profile"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!state.dues.length && (
              <div className="empty">
                <h3>No student has dues</h3>
              </div>
            )}
          </div>
        </section>
      )}
      {tab === "Profiles" && (
        <ProfilesTab
          state={state}
          editing={editing}
          setEditing={setEditing}
          saved={saved}
          ask={ask}
        />
      )}
      {tab === "Sponsors & wallet" && (
        <WalletTab
          data={data}
          state={state}
          allocating={allocating}
          setAllocating={setAllocating}
          saved={saved}
          ask={ask}
        />
      )}
    </div>
  );
}

type Ask = ReturnType<typeof useConfirm>["ask"];

function ProfilesTab({
  state,
  editing,
  setEditing,
  saved,
  ask,
}: {
  state: AdminData;
  editing: number | null;
  setEditing: (id: number | null) => void;
  saved: (message: string) => Promise<void>;
  ask: Ask;
}) {
  const p = state.listings.find((l) => l.student_id === editing);
  if (!p)
    return (
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Sponsorship profiles</h2>
            <p>
              Listed profiles are what Sponsors see and what you share. Start
              from the Due list to add a student.
            </p>
          </div>
        </div>
        {!state.listings.length && (
          <div className="empty">
            <h3>No profiles yet</h3>
            <p>Use “Prepare profile” on the Due list.</p>
          </div>
        )}
        <div className="sponsor-grid">
          {state.listings.map((l) => (
            <ProfileCard key={l.student_id} p={l}>
              <div className="sponsor-actions">
                <span className={`badge ${l.active ? "" : "grey"}`}>
                  {l.active ? "Listed for sponsors" : "Hidden"}
                </span>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setEditing(l.student_id)}
                >
                  Edit profile
                </button>
              </div>
            </ProfileCard>
          ))}
        </div>
      </section>
    );
  const post = (path: string, body: unknown, message: string) =>
    api(path, body).then(() => saved(message));
  return (
    <div className="sponsor-editor">
      <button
        type="button"
        className="text-button"
        onClick={() => setEditing(null)}
      >
        ← All profiles
      </button>
      <section className="panel operation-form">
        <div className="panel-heading">
          <div>
            <h2>
              {p.name} <small className="cell-sub">{p.code}</small>
            </h2>
            <p>
              {p.outstanding
                ? `${money(p.outstanding)} outstanding since ${p.oldest}.`
                : "No dues outstanding."}
            </p>
          </div>
        </div>
        <SponsorForm
          key={`reason-${p.student_id}-${p.active}`}
          submit="Save profile"
          onSubmit={async (f) =>
            post(
              `/sponsorship/listings/${p.student_id}`,
              {
                reason: String(f.get("reason") || ""),
                active: f.get("active") ? 1 : 0,
              },
              f.get("active")
                ? `${p.name} is listed for sponsors.`
                : "Profile saved, not listed.",
            )
          }
        >
          <label className="field wide">
            <span>Difficulty in paying fees</span>
            <textarea
              name="reason"
              rows={5}
              maxLength={2000}
              defaultValue={p.reason}
              placeholder="Family situation, income, what has changed…"
            />
          </label>
          <label className="check-row">
            <input type="checkbox" name="active" defaultChecked={!!p.active} />
            List this student for sponsors and allow sharing
          </label>
        </SponsorForm>
      </section>
      <section className="panel operation-form">
        <div className="panel-heading">
          <div>
            <h2>Photo</h2>
            <p>
              JPEG or PNG, up to 2 MB. Shown to Sponsors and on the shared page.
            </p>
          </div>
        </div>
        <div className="sponsor-photo-row">
          <Photo p={p} size={96} />
          <SponsorForm
            key={`photo-${p.photo_url}`}
            submit="Upload photo"
            onSubmit={async (f, form) => {
              const file = f.get("photo");
              if (!(file instanceof window.File) || !file.size)
                throw Error("Choose a photo.");
              await post(
                `/sponsorship/listings/${p.student_id}/photo`,
                { name: file.name, content: await readFile(file) },
                "Photo updated.",
              );
              form.reset();
            }}
          >
            <input
              name="photo"
              type="file"
              accept="image/png,image/jpeg"
              aria-label="Photo"
              required
            />
          </SponsorForm>
        </div>
      </section>
      <section className="panel operation-form">
        <div className="panel-heading">
          <div>
            <h2>Semester results</h2>
            <p>Sponsors look at how the student is doing in studies.</p>
          </div>
        </div>
        <ItemList
          items={p.results}
          render={(r) => (
            <>
              <span>{r.label}</span>
              <strong>{r.detail}</strong>
            </>
          )}
          onRemove={async (r) => {
            if (
              await ask({
                title: `Remove ${r.label}?`,
                body: "It disappears from the profile and the shared page.",
                confirm: "Remove",
                danger: true,
              })
            )
              await post(`/sponsorship/files/${r.id}/delete`, {}, "Removed.");
          }}
        />
        <SponsorForm
          submit="Add result"
          onSubmit={async (f, form) => {
            await post(
              `/sponsorship/listings/${p.student_id}/files`,
              {
                kind: "Result",
                label: String(f.get("label") || ""),
                detail: String(f.get("detail") || ""),
              },
              "Result added.",
            );
            form.reset();
          }}
        >
          <div className="form-grid">
            <label className="field">
              <span>Semester</span>
              <input name="label" placeholder="Semester 2" required />
            </label>
            <label className="field">
              <span>Result</span>
              <input name="detail" placeholder="SGPA 8.2 or 76%" required />
            </label>
          </div>
        </SponsorForm>
      </section>
      <section className="panel operation-form">
        <div className="panel-heading">
          <div>
            <h2>Supporting documents</h2>
            <p>
              Label each one, such as Income certificate or Marks card. Sponsors
              can open them; the shared page does not show them.
            </p>
          </div>
        </div>
        <ItemList
          items={p.documents}
          render={(d) => (
            <button
              type="button"
              className="text-button"
              onClick={() => d.document_id && openDocument(d.document_id)}
            >
              <FileText size={14} /> {d.label}
            </button>
          )}
          onRemove={async (d) => {
            if (
              await ask({
                title: `Remove ${d.label}?`,
                body: "Sponsors will no longer see this document.",
                confirm: "Remove",
                danger: true,
              })
            )
              await post(`/sponsorship/files/${d.id}/delete`, {}, "Removed.");
          }}
        />
        <SponsorForm
          submit="Upload document"
          onSubmit={async (f, form) => {
            const file = f.get("document");
            if (!(file instanceof window.File) || !file.size)
              throw Error("Choose a document.");
            await post(
              `/sponsorship/listings/${p.student_id}/files`,
              {
                kind: "Document",
                label: String(f.get("label") || ""),
                document: { name: file.name, content: await readFile(file) },
              },
              "Document added.",
            );
            form.reset();
          }}
        >
          <div className="form-grid">
            <label className="field">
              <span>Label</span>
              <input name="label" placeholder="Income certificate" required />
            </label>
            <label className="field">
              <span>File (PDF, JPG or PNG, up to 2 MB)</span>
              <input
                name="document"
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                required
              />
            </label>
          </div>
        </SponsorForm>
      </section>
      {p.active && p.share_token ? (
        <section className="panel operation-form">
          <div className="panel-heading">
            <div>
              <h2>Share to reach more sponsors</h2>
              <p>
                Anyone with this link sees the photo, course, reason, results
                and amount due — no contact details or documents.
              </p>
            </div>
          </div>
          <p className="share-link">{shareLink(p.share_token)}</p>
          <ShareButtons
            token={p.share_token}
            name={p.name}
            outstanding={p.outstanding}
          />
        </section>
      ) : (
        <p className="notice">
          List this student (tick the box above) to get a link to share.
        </p>
      )}
    </div>
  );
}

function ItemList({
  items,
  render,
  onRemove,
}: {
  items: File[];
  render: (item: File) => ReactNode;
  onRemove: (item: File) => Promise<void>;
}) {
  if (!items.length) return null;
  return (
    <ul className="sponsor-items">
      {items.map((item) => (
        <li key={item.id}>
          {render(item)}
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove ${item.label}`}
            onClick={() => onRemove(item)}
          >
            <Trash2 size={15} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function WalletTab({
  data,
  state,
  allocating,
  setAllocating,
  saved,
  ask,
}: {
  data: Workspace;
  state: AdminData;
  allocating: number | null;
  setAllocating: (id: number | null) => void;
  saved: (message: string) => Promise<void>;
  ask: Ask;
}) {
  const [adding, setAdding] = useState<number | null>(null);
  const sponsor = state.sponsors.find((s) => s.id === allocating);
  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>
              <HandCoins size={20} /> Sponsor wallet
            </h2>
            <p>
              {money(state.sponsors.reduce((sum, s) => sum + s.balance, 0))}{" "}
              ready to allocate ·{" "}
              {money(
                state.sponsors.reduce((sum, s) => sum + Number(s.given), 0),
              )}{" "}
              given to students so far.
              {!state.online &&
                " Online sponsor payments start once Razorpay is enabled."}
            </p>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Sponsor</th>
                <th>Contact</th>
                <th>Contributed</th>
                <th>Given</th>
                <th>Balance</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.sponsors.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.name}</strong>
                  </td>
                  <td>
                    {s.email}
                    <small className="cell-sub">{s.phone}</small>
                  </td>
                  <td>{money(Number(s.contributed))}</td>
                  <td>{money(Number(s.given))}</td>
                  <td>
                    <strong>{money(s.balance)}</strong>
                  </td>
                  <td className="sponsor-row-actions">
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => setAdding(adding === s.id ? null : s.id)}
                    >
                      Add money
                    </button>
                    <button
                      type="button"
                      className="button"
                      disabled={s.balance <= 0}
                      onClick={() => setAllocating(s.id)}
                    >
                      Allocate
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!state.sponsors.length && (
            <div className="empty">
              <h3>No sponsors yet</h3>
              <p>
                Add one below, or Sponsors who register and pay appear here.
              </p>
            </div>
          )}
        </div>
        {adding !== null && (
          <div className="sponsor-inline">
            <h3>
              Add money from {state.sponsors.find((s) => s.id === adding)?.name}
            </h3>
            <SponsorForm
              submit="Record contribution"
              onSubmit={async (f) => {
                await api(`/sponsorship/sponsors/${adding}/contributions`, {
                  amount: rupees(f.get("amount")),
                  received_on: f.get("received_on"),
                  note: f.get("note"),
                });
                setAdding(null);
                await saved("Contribution recorded.");
              }}
            >
              <ContributionFields today={data.today} required />
            </SponsorForm>
          </div>
        )}
      </section>
      {sponsor && (
        <Allocate
          sponsor={sponsor}
          state={state}
          ask={ask}
          close={() => setAllocating(null)}
          saved={saved}
        />
      )}
      <section className="panel operation-form">
        <div className="panel-heading">
          <div>
            <h2>Add a sponsor</h2>
            <p>
              Record who is sponsoring and what they gave. Saving an existing
              email updates that sponsor.
            </p>
          </div>
        </div>
        <SponsorForm
          submit="Save sponsor"
          onSubmit={async (f, form) => {
            const amount = rupees(f.get("amount"));
            await api("/sponsorship/sponsors", {
              name: f.get("name"),
              email: f.get("email"),
              phone: f.get("phone"),
              ...(amount
                ? {
                    amount,
                    received_on: f.get("received_on"),
                    note: f.get("note"),
                  }
                : {}),
            });
            form.reset();
            await saved("Sponsor saved.");
          }}
        >
          <div className="form-grid">
            <label className="field">
              <span>Sponsor name</span>
              <input name="name" required maxLength={120} />
            </label>
            <label className="field">
              <span>Email</span>
              <input name="email" type="email" required />
            </label>
            <label className="field">
              <span>Phone</span>
              <input name="phone" type="tel" required />
            </label>
          </div>
          <ContributionFields today={data.today} />
        </SponsorForm>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Allocations</h2>
            <p>Wallet money given to students. Each has fee receipts.</p>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Sponsor</th>
                <th>Student</th>
                <th>Chosen by</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {state.grants.map((g) => (
                <tr key={g.id}>
                  <td>{g.created_at.slice(0, 10)}</td>
                  <td>{g.sponsor_name}</td>
                  <td>
                    {g.student_name}{" "}
                    <small className="cell-sub">{g.code}</small>
                  </td>
                  <td>{g.chosen_by}</td>
                  <td>{money(Number(g.amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!state.grants.length && (
            <div className="empty">
              <h3>No allocations yet</h3>
            </div>
          )}
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Contributions</h2>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Sponsor</th>
                <th>How</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {state.contributions.map((c) => (
                <tr key={c.id}>
                  <td>{c.received_on}</td>
                  <td>{c.sponsor_name}</td>
                  <td>
                    {c.method === "Online" ? c.note : "Recorded"}
                    {c.method !== "Online" && c.note && (
                      <small className="cell-sub">{c.note}</small>
                    )}
                  </td>
                  <td>{money(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!state.contributions.length && (
            <div className="empty">
              <h3>No contributions yet</h3>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

function ContributionFields({
  today,
  required = false,
}: {
  today: string;
  required?: boolean;
}) {
  return (
    <div className="form-grid">
      <label className="field">
        <span>Amount received (₹){required ? "" : " — optional"}</span>
        <input
          name="amount"
          type="number"
          min="1"
          step="1"
          required={required}
        />
      </label>
      <label className="field">
        <span>Received on</span>
        <input
          name="received_on"
          type="date"
          max={today}
          defaultValue={today}
        />
      </label>
      <label className="field wide">
        <span>Note — optional</span>
        <input name="note" maxLength={300} placeholder="Cheque no., UPI ref…" />
      </label>
    </div>
  );
}

// Allocate one sponsor's balance. Suggested: the most students whose whole
// dues fit; the Admin can change who and how much.
function Allocate({
  sponsor,
  state,
  ask,
  close,
  saved,
}: {
  sponsor: Sponsor;
  state: AdminData;
  ask: Ask;
  close: () => void;
  saved: (message: string) => Promise<void>;
}) {
  const suggested = coverMost(state.dues, sponsor.balance);
  const [amounts, setAmounts] = useState<Record<number, number>>(() =>
    Object.fromEntries(suggested.map((d) => [d.student_id, d.outstanding])),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const total = Object.values(amounts).reduce((sum, a) => sum + a, 0);
  const chosen = Object.entries(amounts).filter(([, a]) => a > 0);
  const listed = new Set(
    state.listings.filter((l) => l.active).map((l) => l.student_id),
  );
  const rows = [...state.dues].sort(
    (a, b) =>
      Number(b.student_id in amounts) - Number(a.student_id in amounts) ||
      a.outstanding - b.outstanding,
  );
  return (
    <section className="panel sponsor-allocate">
      <div className="panel-heading">
        <div>
          <h2>
            Allocate {sponsor.name}’s {money(sponsor.balance)}
          </h2>
          <p>
            {suggested.length
              ? `Suggested: ${suggested.length} student${suggested.length === 1 ? "" : "s"} whose full dues fit — the most students this balance can clear.`
              : "No student's full dues fit this balance; tick students to cover part of their dues."}{" "}
            Change the selection or amounts as needed; dues are settled oldest
            first.
          </p>
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th />
              <th>Student</th>
              <th>Outstanding</th>
              <th>Give (₹)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const on = d.student_id in amounts;
              return (
                <tr key={d.student_id} className={on ? "selected" : ""}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Allocate to ${d.name}`}
                      checked={on}
                      onChange={(e) => {
                        const next = { ...amounts };
                        if (e.target.checked)
                          next[d.student_id] = Math.min(
                            d.outstanding,
                            Math.max(0, sponsor.balance - total),
                          );
                        else delete next[d.student_id];
                        setAmounts(next);
                      }}
                    />
                  </td>
                  <td>
                    <strong>{d.name}</strong>{" "}
                    {listed.has(d.student_id) && (
                      <span className="badge">Listed</span>
                    )}
                    {suggested.some((s) => s.student_id === d.student_id) && (
                      <span className="badge amber">Suggested</span>
                    )}
                    <small className="cell-sub">
                      {d.code} · dues since {d.oldest}
                    </small>
                  </td>
                  <td>{money(d.outstanding)}</td>
                  <td>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      max={d.outstanding / 100}
                      disabled={!on}
                      aria-label={`Amount for ${d.name}`}
                      value={on ? amounts[d.student_id] / 100 : ""}
                      onChange={(e) =>
                        setAmounts({
                          ...amounts,
                          [d.student_id]: Math.min(
                            d.outstanding,
                            Math.round(Number(e.target.value) * 100),
                          ),
                        })
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="sponsor-allocate-foot">
        <p className={total > sponsor.balance ? "notice danger" : "notice"}>
          {chosen.length} student{chosen.length === 1 ? "" : "s"} ·{" "}
          {money(total)} of {money(sponsor.balance)}
          {total > sponsor.balance
            ? " — more than the wallet holds."
            : ` · ${money(sponsor.balance - total)} stays in the wallet.`}
        </p>
        {error && (
          <p className="notice danger" role="alert">
            {error}
          </p>
        )}
        <div className="sponsor-actions">
          <button
            type="button"
            className="button"
            disabled={busy || !chosen.length || total > sponsor.balance}
            onClick={async () => {
              if (
                !(await ask({
                  title: `Give ${money(total)} to ${chosen.length} student${chosen.length === 1 ? "" : "s"}?`,
                  body: `From ${sponsor.name}’s wallet. Fee receipts are issued now and the sponsor can see which students it reached.`,
                  confirm: "Allocate",
                }))
              )
                return;
              setBusy(true);
              setError("");
              try {
                await api(`/sponsorship/sponsors/${sponsor.id}/grants`, {
                  grants: chosen.map(([id, amount]) => ({
                    student_id: Number(id),
                    amount,
                  })),
                });
                close();
                await saved("Sponsor money allocated. Receipts issued.");
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Allocate {money(total)}
          </button>
          <button type="button" className="button secondary" onClick={close}>
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}

// ── Public shared page ───────────────────────────────────────────────────
export function AppealPage({ token }: { token: string }) {
  const [p, setP] = useState<(Profile & { hostel: string }) | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Profile & { hostel: string }>(`/public/appeals/${token}`)
      .then((profile) => {
        setP(profile);
        document.title = `Sponsor ${profile.name} · ${HOSTEL.short}`;
      })
      .catch((e) => setError(errorText(e)));
  }, [token]);
  return (
    <div className="appeal-page">
      <header className="appeal-header">
        <a href="/" className="appeal-brand">
          {HOSTEL.short} <span>Hostel</span>
        </a>
        <ThemeToggle />
      </header>
      {error && (
        <section className="panel appeal-card">
          <h1>Sponsorship page unavailable</h1>
          <p>{error}</p>
        </section>
      )}
      {!p && !error && <div className="loader" />}
      {p && (
        <main className="appeal-card">
          <div className="eyebrow">SPONSOR A STUDENT</div>
          <ProfileCard
            p={{ ...p, student_id: 0, documents: [] }}
            documents={false}
          />
          <section className="panel appeal-cta">
            <h2>Help {p.name} continue their studies</h2>
            <p>
              {p.hostel || HOSTEL.name} supports differently abled students.
              Register as a Sponsor to pay {p.name}’s fees directly with UPI or
              card, or give to the hostel’s sponsor wallet.
            </p>
            <a className="button" href="/?register=sponsor">
              <HeartHandshake size={15} /> Become a sponsor
            </a>
            <h3>Share this page</h3>
            <ShareButtons
              token={token}
              name={p.name}
              outstanding={p.outstanding}
            />
          </section>
        </main>
      )}
    </div>
  );
}
