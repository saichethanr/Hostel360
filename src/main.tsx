import React, {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { OnlinePayments } from "./gateway";
import { LeavePage } from "./leave";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Building2,
  CalendarDays,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Clock3,
  FileCheck2,
  FileText,
  LayoutDashboard,
  Leaf,
  LockKeyhole,
  LogOut,
  Menu,
  Plus,
  Printer,
  ReceiptText,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
  Wallet,
  X,
  AlertCircle,
  type LucideIcon,
  UserPlus,
} from "lucide-react";
import {
  api,
  dateName,
  downloadCsv,
  initials,
  money,
  monthName,
  RequestError,
  shortMoney,
  sum,
  type Attendance,
  type Demand,
  type Payment,
  type Preview,
  type Receipt,
  type Student,
  type Workspace,
  type Membership,
  HOSTEL,
} from "./lib";
import {
  Operations,
  Admissions,
  Account,
  Setup,
  StudentTools,
  CommunityGate,
  PasswordInput,
  useSignOutConfirm,
  useConfirm,
  ThemeToggle,
  MembershipStatus,
  FeeStructure,
  BlocksSettings,
  RoomPicker,
} from "./operations";
import "./styles.css";
import "./dark.css";

type Page =
  | "Dashboard"
  | "Students"
  | "Attendance"
  | "Fee demands"
  | "Payments"
  | "Receipts"
  | "Reports & audit"
  | "Operations"
  | "Leave"
  | "My application"
  | "My account"
  | "Settings";
const pageIcons: Record<Page, LucideIcon> = {
  Dashboard: LayoutDashboard,
  Students: Users,
  Attendance: ClipboardCheck,
  "Fee demands": FileText,
  Payments: Wallet,
  Receipts: ReceiptText,
  "Reports & audit": FileCheck2,
  Operations: Building2,
  Leave: CalendarDays,
  "My application": FileCheck2,
  "My account": ShieldCheck,
  Settings: Settings2,
};
const pageDescriptions: Record<Page, string> = {
  Dashboard: "A little clarity for everything that happens here.",
  Students: "Every student, every detail. All in one place.",
  Attendance: "Keep a clear record of who’s at the table.",
  "Fee demands": "Transparent billing. Every month accounted for.",
  Payments: "Collect with confidence. Keep every rupee accounted for.",
  Receipts: "A reliable record of every payment received.",
  "Reports & audit": "The numbers you need. The history you can trust.",
  Operations:
    "Admissions, accounts and the details that keep your hostel running.",
  Leave: "Casual and medical leave, approved by the Warden.",
  "My application": "Your application, details and admission decision.",
  "My account": "Keep your workspace access secure.",
  Settings: "Make the hostel workspace feel at home.",
};
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

function Button({
  children,
  icon: Icon,
  variant = "",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: LucideIcon;
  variant?: string;
}) {
  return (
    <button className={`button ${variant} ${className}`} {...props}>
      {Icon && <Icon size={16} />}
      {children}
    </button>
  );
}
function Badge({
  children,
  tone = "green",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <span className={`badge ${tone}`}>
      <span />
      {children}
    </span>
  );
}
function Avatar({ name, index = 0 }: { name: string; index?: number }) {
  return <span className={`avatar avatar-${index % 5}`}>{initials(name)}</span>;
}
function Empty({
  title = "Nothing here yet",
  children,
}: {
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <FileCheck2 size={30} />
      <h3>{title}</h3>
      <p>{children || "Your records will appear here when they’re added."}</p>
    </div>
  );
}
function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      aria-label={title}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-header">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Login({
  onLogin,
  demo,
  hostel,
}: {
  onLogin: () => Promise<void>;
  demo: boolean;
  hostel: string;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const login = async (emailValue = email, passwordValue = password) => {
    setBusy(true);
    setError("");
    try {
      await api("/login", { email: emailValue, password: passwordValue });
      await onLogin();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-page">
      <section className="login-story">
        <div className="brand">
          <div className="brand-mark">
            <Building2 size={24} />
          </div>
          <span>
            JSS <span className="brand-light">PDA</span>
            <span className="brand-dot">.</span>
          </span>
        </div>
        <div className="login-story-content">
          <div className="eyebrow light">
            <span /> A BETTER EVERYDAY, TOGETHER
          </div>
          <h1>
            A well-run hostel.
            <br />A little more
            <br />
            <em>peace of mind.</em>
          </h1>
          <p>
            From the first day of admission to the last receipt.
            <br />
            One thoughtful space to manage it all.
          </p>
          <div className="building-illustration" aria-hidden="true">
            <div className="illustration-sun" />
            <div className="illustration-tree tree-one" />
            <div className="illustration-building">
              <div className="building-roof">H360</div>
              <div className="windows">
                {Array.from({ length: 12 }, (_, i) => (
                  <i key={i} />
                ))}
              </div>
              <div className="building-door" />
            </div>
            <div className="illustration-tree tree-two" />
            <div className="illustration-ground" />
          </div>
        </div>
        <span className="login-footer">
          <ShieldCheck size={15} /> Clear records. Connected people. Better
          days.
        </span>
      </section>
      <section className="login-form-section">
        <div className="login-top">
          <Leaf size={16} /> HOSTEL OPERATIONS, SIMPLIFIED
        </div>
        <div className="login-card">
          <div className="small-icon">
            <Building2 size={24} />
          </div>
          <h2>Welcome to JSS PDA Hostel</h2>
          <p>Your hostel’s day starts here.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void login();
            }}
          >
            <Field label="Email address">
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@yourhostel.edu"
                required
              />
            </Field>
            <Field label="Password">
              <PasswordInput
                autoComplete="current-password"
                value={password}
                onChange={setPassword}
                placeholder="Enter your password"
                required
              />
            </Field>
            {error && (
              <div className="notice danger" role="alert">
                {error}
              </div>
            )}
            <Button type="submit" className="full-width" disabled={busy}>
              {busy ? "Signing in…" : "Sign in to your workspace"}
              <ArrowRight size={16} />
            </Button>
          </form>
          {demo && (
            <div className="demo-login">
              <div className="divider-label">EXPLORE THE DEMO</div>
              <div className="demo-roles">
                {["Admin", "Manager", "Student"].map((role) => (
                  <Button
                    key={role}
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void login(
                        `${role.toLowerCase()}@hostel360.demo`,
                        "Hostel360Demo!",
                      )
                    }
                  >
                    {role}
                    <ArrowUpRight size={14} />
                  </Button>
                ))}
              </div>
              <p>
                Fictional data. A real working preview.
                <br />
                Choose a role to explore its workspace.
              </p>
            </div>
          )}
        </div>
        <div className="login-bottom">
          {hostel}
          <span>{HOSTEL.name}</span>
        </div>
      </section>
    </div>
  );
}

function App() {
  const [data, setData] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState({
    demo: false,
    hostel_name: HOSTEL.name,
    setup: false,
    communities: false,
  });
  const [membership, setMembership] = useState<Membership | null>(null);
  const [fatal, setFatal] = useState("");
  const [page, setPage] = useState<Page>("Dashboard");
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState("");
  const [addStudent, setAddStudent] = useState(false);
  const [collect, setCollect] = useState<number | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [profile, setProfile] = useState<Student | null>(null);
  const [help, setHelp] = useState(false);
  const refresh = async () => {
    const configuration = await api<typeof config>("/config");
    setConfig(configuration);
    try {
      if (configuration.communities) {
        const status = await api<Membership>("/membership");
        setMembership(status);
        if (status.status !== "Approved") {
          setData(null);
          return;
        }
      }
      const workspace = await api<Workspace>("/workspace");
      setData(workspace);
      if (workspace.user.role === "Student" && !workspace.user.student_id)
        setPage("My application");
      if (workspace.user.role === "Warden") setPage("Leave");
    } catch (e) {
      if (e instanceof RequestError && e.status === 401) {
        setData(null);
        setMembership(null);
      } else throw e;
    }
  };
  useEffect(() => {
    refresh()
      .catch((e) => setFatal(errorMessage(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  const navigate = (next: Page) => {
    setPage(next);
    setSearch("");
    setMenu(false);
    window.scrollTo(0, 0);
  };
  const openReceipt = async (id: number) => {
    try {
      setReceipt(await api<Receipt>(`/receipts/${id}`));
    } catch (e) {
      setToast(errorMessage(e));
    }
  };
  const saved = async (message: string) => {
    await refresh();
    setToast(message);
  };
  const signOut = useSignOutConfirm(async () => {
    try {
      await api("/logout", {});
      setData(null);
      setMembership(null);
      navigate("Dashboard");
    } catch (e) {
      setToast(errorMessage(e));
    }
  });
  if (loading)
    return (
      <div className="loading-screen">
        <Building2 size={36} />
        <h2>Making room for a better day.</h2>
        <div className="loader" />
      </div>
    );
  if (fatal)
    return (
      <div className="loading-screen">
        <AlertCircle />
        <h2>Unable to connect</h2>
        <p>{fatal}</p>
        <Button onClick={() => window.location.reload()}>Try again</Button>
      </div>
    );
  if (!data && config.setup)
    return <Setup onDone={() => window.location.reload()} />;
  if (!data && membership)
    return <MembershipStatus membership={membership} refresh={refresh} />;
  if (!data && config.communities) return <CommunityGate onLogin={refresh} />;
  if (!data)
    return (
      <Login onLogin={refresh} demo={config.demo} hostel={config.hostel_name} />
    );
  if (data.user["must_change_password"])
    return (
      <div className="setup-page">
        <h1>Choose your own password</h1>
        <p>Replace your temporary password before opening the workspace.</p>
        <Account onSaved={saved} />
      </div>
    );
  const isStudent = data.user.role === "Student";
  const isAdmin = data.user.role === "Admin";
  // Wardens handle leave only.
  const pages: Page[] = isStudent
    ? data.user.student_id
      ? [
          "Dashboard",
          "My application",
          "Students",
          "Fee demands",
          "Receipts",
          "Leave",
          "My account",
        ]
      : ["My application", "My account"]
    : data.user.role === "Warden"
      ? ["Leave", "My account"]
      : [
          "Dashboard",
          "Students",
          "Attendance",
          "Leave",
          "Fee demands",
          "Payments",
          "Receipts",
          "Reports & audit",
          "Operations",
          ...(isAdmin ? ["Settings" as Page] : []),
          "My account",
        ];
  const title =
    isStudent && page === "Students"
      ? "My profile"
      : isStudent && page === "Fee demands"
        ? "My fee statement"
        : page;
  return (
    <div className="app-shell">
      {signOut.dialog}
      {menu && <div className="sidebar-scrim" onClick={() => setMenu(false)} />}
      <aside
        id="workspace-navigation"
        className={`sidebar ${menu ? "open" : ""}`}
      >
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("Dashboard");
          }}
        >
          <div className="brand-mark">
            <Building2 size={23} />
          </div>
          <span>
            JSS <span className="brand-light">PDA</span>
            <span className="brand-dot">.</span>
          </span>
        </a>
        <div className="workspace-switch">
          <div className="workspace-icon">
            <Building2 size={17} />
          </div>
          <div>
            <strong>{HOSTEL.short}</strong>
            <small>{HOSTEL.name}</small>
          </div>
          <span className="workspace-status" title="Connected" />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {pages.map((item) => {
            const Icon = pageIcons[item];
            return (
              <React.Fragment key={item}>
                {item === "Reports & audit" && (
                  <div className="nav-label second">MANAGEMENT</div>
                )}
                <button
                  className={`nav-item ${page === item ? "active" : ""}`}
                  onClick={() => navigate(item)}
                  aria-current={page === item ? "page" : undefined}
                >
                  <Icon size={18} />
                  <span>
                    {isStudent && item === "Students"
                      ? "My profile"
                      : isStudent && item === "Fee demands"
                        ? "My fee statement"
                        : item}
                  </span>
                  {item === "Students" && !isStudent && (
                    <span className="nav-count">{data.students.length}</span>
                  )}
                  {item === "Leave" && !!data.pending_leaves && (
                    <span
                      className="nav-count alert"
                      title="Leave requests waiting for your decision"
                    >
                      {data.pending_leaves}
                    </span>
                  )}
                  {item === "Operations" && !!data.pending_members && (
                    <span
                      className="nav-count alert"
                      title="Join requests waiting for approval"
                    >
                      {data.pending_members}
                    </span>
                  )}
                  {page === item && <span className="nav-active-dot" />}
                </button>
              </React.Fragment>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="help-card">
            <div className="help-card-title">
              <Sparkles size={17} /> A little help goes a long way.
            </div>
            <p>Get to know your new workspace.</p>
            <button onClick={() => setHelp(true)}>
              Explore the quick guide <ArrowUpRight size={14} />
            </button>
          </div>
          <button className="user-card" onClick={signOut.ask} title="Log out">
            <Avatar name={data.user.name} />
            <div>
              <strong>{data.user.name}</strong>
              <small>
                {data.user.role === "Admin" ? "Administrator" : data.user.role}
              </small>
            </div>
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              onClick={() => setMenu(!menu)}
              aria-label="Open navigation"
              aria-expanded={menu}
              aria-controls="workspace-navigation"
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>{title}</strong>
          </div>
          <div className="topbar-right">
            {data.settings.demo === "true" && (
              <span className="demo-label">
                <span />
                Demo workspace
              </span>
            )}
            <div className="topbar-divider" />
            <ThemeToggle />
            <button
              className="icon-button"
              aria-label="Open quick guide"
              onClick={() => setHelp(true)}
            >
              <CircleHelp size={19} />
            </button>
            <Avatar name={data.user.name} />
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {page === "Dashboard"
                  ? "YOUR HOSTEL, AT A GLANCE"
                  : "JSS PDA HOSTEL"}
              </div>
              <h1>
                {page === "Dashboard"
                  ? `Welcome back, ${data.user.name.split(" ")[0]}`
                  : title}
                {page === "Dashboard" && <span className="welcome-dot">.</span>}
              </h1>
              <p>{pageDescriptions[page]}</p>
            </div>
            <div className="heading-actions">
              {page === "Dashboard" && (
                <div className="date-chip">
                  <CalendarDays size={16} />
                  {dateName(data.today)}
                </div>
              )}
              {!isStudent && ["Dashboard", "Payments"].includes(page) && (
                <Button icon={Plus} onClick={() => setCollect(0)}>
                  Collect payment
                </Button>
              )}
              {!isStudent && page === "Students" && (
                <Button icon={Plus} onClick={() => setAddStudent(true)}>
                  Add student
                </Button>
              )}
            </div>
          </div>
          {page === "Leave" && <LeavePage data={data} onSaved={saved} />}
          {page === "Dashboard" && (
            <Dashboard
              data={data}
              navigate={navigate}
              onCollect={() => setCollect(0)}
              onReceipt={openReceipt}
              onAdd={() => setAddStudent(true)}
            />
          )}
          {page === "Students" && (
            <Students
              data={data}
              search={search}
              setSearch={setSearch}
              onProfile={setProfile}
            />
          )}
          {page === "Attendance" && (
            <AttendancePage data={data} onSaved={saved} />
          )}
          {page === "Fee demands" && (
            <>
              <OnlinePayments
                data={data}
                onSaved={saved}
                onReceipt={openReceipt}
              />
              <DemandsPage data={data} onSaved={saved} onCollect={setCollect} />
            </>
          )}
          {["Payments", "Receipts"].includes(page) && (
            <PaymentsPage
              data={data}
              receipts={page === "Receipts"}
              onReceipt={openReceipt}
              search={search}
              setSearch={setSearch}
            />
          )}
          {page === "Reports & audit" && <Reports data={data} />}
          {page === "Operations" && <Operations data={data} onSaved={saved} />}
          {page === "My application" && (
            <Admissions data={data} onSaved={saved} />
          )}
          {page === "My account" && <Account onSaved={saved} />}
          {page === "Settings" && <SettingsPage data={data} onSaved={saved} />}
          <footer className="page-footer">
            <span>
              <span className="live-dot" /> All in one place. All accounted for.
            </span>
            <span>{HOSTEL.name}</span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          {toast}
          <button
            onClick={() => setToast("")}
            aria-label="Dismiss notification"
          >
            <X size={16} />
          </button>
        </div>
      )}
      {addStudent && (
        <StudentForm
          data={data}
          today={data.today}
          onClose={() => setAddStudent(false)}
          onSaved={async () => {
            setAddStudent(false);
            await saved("Student registered successfully.");
          }}
        />
      )}
      {collect !== null && (
        <PaymentForm
          data={data}
          initialStudent={collect}
          onClose={() => setCollect(null)}
          onSaved={async (id) => {
            setCollect(null);
            await saved("Payment recorded. Your receipt is ready.");
            await openReceipt(id);
          }}
        />
      )}
      {receipt && (
        <ReceiptModal
          receipt={receipt}
          demo={data.settings.demo === "true"}
          onClose={() => setReceipt(null)}
        />
      )}
      {profile && (
        <Modal
          title={profile.name}
          subtitle={`${profile.code} · Student profile`}
          onClose={() => setProfile(null)}
          wide
        >
          <div className="modal-body">
            <div className="profile-top">
              <Avatar name={profile.name} />
              <div>
                <h3>{profile.department}</h3>
                <p>
                  Year {profile.year} · Room {profile.room}
                </p>
              </div>
              <Badge>{profile.status}</Badge>
            </div>
            <div className="detail-grid">
              {[
                ["Admission type", profile.admission_type],
                ["Contact", profile.phone],
                ["Parent", profile.guardian],
                ["Parent phone", profile.guardian_phone || "Not recorded"],
                ["Joined", dateName(profile.joined)],
              ].map(([key, value]) => (
                <div key={key}>
                  <small>{key}</small>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            <h3 className="section-subtitle">Fee statement</h3>
            <DemandTable
              rows={data.demands.filter((d) => d.student_id === profile.id)}
              compact
            />
            <StudentTools
              student={profile}
              data={data}
              onSaved={async (message) => {
                setProfile(null);
                await saved(message);
              }}
            />
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setProfile(null)}>
                Close profile
              </Button>
              {!isStudent && (
                <Button
                  icon={Wallet}
                  onClick={() => {
                    setCollect(profile.id);
                    setProfile(null);
                  }}
                >
                  Collect payment
                </Button>
              )}
            </div>
          </div>
        </Modal>
      )}
      {help && (
        <Modal
          title="A good place to start"
          subtitle="Your JSS PDA Hostel quick guide"
          onClose={() => setHelp(false)}
        >
          <div className="modal-body">
            <div className="guide-step">
              <span>01</span>
              <div>
                <h3>Know your students</h3>
                <p>
                  Search the register, add a student, and open their profile to
                  see outstanding fees.
                </p>
              </div>
            </div>
            <div className="guide-step">
              <span>02</span>
              <div>
                <h3>Keep the daily record</h3>
                <p>
                  Mark Present, Absent or Leave in Attendance. Save your entries
                  before changing the date.
                </p>
              </div>
            </div>
            <div className="guide-step">
              <span>03</span>
              <div>
                <h3>Close the month with confidence</h3>
                <p>
                  Admins can preview completed months and finalize only when
                  attendance is complete. Present days × daily rate is the
                  provisional rule.
                </p>
              </div>
            </div>
            <div className="guide-step">
              <span>04</span>
              <div>
                <h3>Collect once. Account for everything.</h3>
                <p>
                  Select outstanding months, enter full or partial allocations,
                  review, and confirm. One category per payment, one
                  consolidated receipt.
                </p>
              </div>
            </div>
            <div className="notice">
              This foundation is not production-ready. Application approvals,
              admission fee configuration, Excel import, reversals and account
              administration are planned next.
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  icon: Icon,
  children,
  color = "",
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  children: ReactNode;
  color?: string;
}) {
  return (
    <div className={`metric ${color}`}>
      <div className="metric-top">
        <span>{label}</span>
        <div className="metric-icon">
          <Icon size={19} />
        </div>
      </div>
      <strong>{value}</strong>
      <div className="metric-note">{children}</div>
    </div>
  );
}
function Dashboard({
  data,
  navigate,
  onCollect,
  onReceipt,
  onAdd,
}: {
  data: Workspace;
  navigate: (page: Page) => void;
  onCollect: () => void;
  onReceipt: (id: number) => void;
  onAdd: () => void;
}) {
  const isStudent = data.user.role === "Student";
  const messDemands = data.demands.filter((d) => d.category === "Mess");
  const periods = [...new Set(messDemands.map((d) => d.period))].sort();
  const latest = periods.at(-1) || data.today.slice(0, 7);
  const current = messDemands.filter((d) => d.period === latest);
  const demand = sum(current, (d) => d.amount + d.adjustment);
  const collected = sum(current, (d) => d.collected);
  const balance = sum(data.demands, (d) => d.balance);
  const missing = data.students.filter(
    (s) =>
      s.status === "Active" &&
      s.joined <= data.today &&
      !data.attendance.some((a) => a.student_id === s.id),
  ).length;
  const debtors = new Set(
    data.demands.filter((d) => d.balance > 0).map((d) => d.student_id),
  ).size;
  const present = data.attendance.filter((a) => a.status === "Present").length;
  const absent = data.attendance.filter((a) => a.status === "Absent").length;
  const leave = data.attendance.filter((a) => a.status === "Leave").length;
  // Open on Mess, or on the first category that has dues.
  const [chartType, setChartType] = useState(
    () =>
      ["Mess", "Management", "Fund", "Establishment"].find((c) =>
        data.demands.some((d) => d.category === c),
      ) || "Mess",
  );
  return (
    <>
      <div className="overview-banner">
        <div className="banner-icon">
          <Leaf size={22} />
        </div>
        <div>
          <strong>A clearer picture. A smoother day.</strong>
          <span>
            {isStudent
              ? "Your fees, payments and receipts — always within reach."
              : `Here’s what’s happening at ${data.settings.hostel_name} today.`}
          </span>
        </div>
        <div className="banner-tag">
          <span />{" "}
          {isStudent ? "YOUR PERSONAL WORKSPACE" : "LET’S MAKE IT A GOOD ONE"}
        </div>
        <div className="banner-decoration">
          <i />
          <i />
          <i />
        </div>
      </div>
      <div className="metrics">
        <Metric
          label={isStudent ? "My room" : "Active students"}
          value={
            isStudent
              ? data.students[0]?.room || "—"
              : String(
                  data.students.filter((s) => s.status === "Active").length,
                )
          }
          icon={Users}
        >
          <span className="positive">
            <span className="live-dot" />
            {isStudent
              ? data.students[0]?.department
              : `${new Set(data.students.map((s) => s.room)).size} rooms occupied`}
          </span>
          <span>{isStudent ? "" : "In the student register"}</span>
        </Metric>
        <Metric
          label="Monthly mess demand"
          value={money(demand)}
          icon={FileText}
        >
          <span className="subtle-pill">{monthName(latest, true)}</span>
          <span>Latest finalized month</span>
        </Metric>
        <Metric
          label="Collected against demand"
          value={money(collected)}
          icon={Wallet}
          color="mint"
        >
          <span className="positive">
            <ArrowUpRight size={13} />
            {demand ? Math.round((collected / demand) * 100) : 0}% collected
          </span>
          <span>of {monthName(latest, true)} demand</span>
        </Metric>
        <Metric
          label="Total outstanding"
          value={money(balance)}
          icon={Clock3}
          color="peach"
        >
          <span className="amber-text">
            {debtors} {isStudent ? "student account" : "students with dues"}
          </span>
          <span>All billing periods</span>
        </Metric>
      </div>
      <div className="dashboard-middle">
        <section className="panel chart-panel">
          <div className="panel-heading">
            <div>
              <h2>Demand & collections</h2>
              <p>
                {chartType === "Mess"
                  ? "A month-by-month view of your mess accounts"
                  : `Admission dues by academic year · ${chartType}`}
              </p>
            </div>
            <select
              aria-label="Chart category"
              value={chartType}
              onChange={(e) => setChartType(e.target.value)}
            >
              {["Mess", "Fund", "Management", "Establishment"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="chart-legend">
            <span>
              <i className="demand-key" />
              Demand
            </span>
            <span>
              <i className="collection-key" />
              Allocated collection
            </span>
            <small>
              {chartType === "Mess"
                ? "Last 6 billing months"
                : "Last 6 academic years"}
            </small>
          </div>
          <CollectionChart data={data} category={chartType} />
          <div className="chart-foot">
            <ShieldCheck size={14} />
            <span>
              Collections are matched to their original billing month.
            </span>
          </div>
        </section>
        <section className="panel attention-panel">
          <div className="panel-heading">
            <h2>Needs your attention</h2>
            <span className="number-badge">
              {(missing > 0 ? 1 : 0) +
                (debtors > 0 ? 1 : 0) +
                (data.pending_members ? 1 : 0)}
            </span>
          </div>
          {!!data.pending_members && (
            <button
              className="attention-item"
              onClick={() => navigate("Operations")}
            >
              <div className="attention-icon orange">
                <UserPlus size={19} />
              </div>
              <div>
                <strong>
                  {data.pending_members} join{" "}
                  {data.pending_members === 1 ? "request" : "requests"} waiting
                </strong>
                <p>Approve students and managers for this hostel</p>
                <span>
                  Review requests <ArrowRight size={12} />
                </span>
              </div>
            </button>
          )}
          {missing > 0 && (
            <button
              className="attention-item"
              onClick={() => navigate(isStudent ? "Students" : "Attendance")}
            >
              <div className="attention-icon orange">
                <ClipboardCheck size={19} />
              </div>
              <div>
                <strong>
                  {missing} attendance {missing === 1 ? "entry" : "entries"}{" "}
                  pending
                </strong>
                <p>Complete today’s mess register</p>
                <span>
                  View attendance <ArrowRight size={12} />
                </span>
              </div>
            </button>
          )}
          {debtors > 0 && (
            <button
              className="attention-item"
              onClick={() => navigate("Fee demands")}
            >
              <div className="attention-icon purple">
                <Wallet size={19} />
              </div>
              <div>
                <strong>Outstanding fee balances</strong>
                <p>
                  {money(balance)} across {debtors}{" "}
                  {debtors === 1 ? "student" : "students"}
                </p>
                <span>
                  Review outstanding <ArrowRight size={12} />
                </span>
              </div>
            </button>
          )}
          {missing === 0 && debtors === 0 && !data.pending_members && (
            <Empty title="You’re all caught up">
              No pending attendance or outstanding fees.
            </Empty>
          )}
          <div className="attention-bottom">
            <CheckCircle2 size={15} /> Small tasks today. Smoother days ahead.
          </div>
        </section>
      </div>
      <div className="dashboard-bottom">
        <section className="panel recent-panel">
          <div className="panel-heading">
            <div>
              <h2>Recent collections</h2>
              <p>The latest payments, neatly accounted for</p>
            </div>
            <button
              className="text-button"
              onClick={() => navigate(isStudent ? "Receipts" : "Payments")}
            >
              View all <ArrowRight size={15} />
            </button>
          </div>
          <PaymentTable
            rows={data.payments.slice(0, 5)}
            onReceipt={onReceipt}
            compact
          />
          <div className="table-foot">
            <span>
              <LockKeyhole size={12} /> Every payment has a traceable receipt
            </span>
            <span>{data.payments.length} total collections</span>
          </div>
        </section>
        <section className="panel attendance-card">
          <div className="panel-heading">
            <div>
              <h2>Today’s attendance</h2>
              <p>{dateName(data.today)}</p>
            </div>
            <span className="small-icon">
              <ClipboardCheck size={18} />
            </span>
          </div>
          <div className="attendance-visual">
            <div
              className="donut"
              style={
                {
                  "--present": `${(present / Math.max(data.students.length, 1)) * 100}%`,
                  "--marked": `${((present + absent) / Math.max(data.students.length, 1)) * 100}%`,
                  "--leave": `${((present + absent + leave) / Math.max(data.students.length, 1)) * 100}%`,
                } as React.CSSProperties
              }
            >
              <div>
                <strong>{present}</strong>
                <span>Present today</span>
              </div>
            </div>
          </div>
          <div className="attendance-legend">
            {[
              ["Present", present, "green"],
              ["Absent", absent, "orange"],
              ["On leave", leave, "purple"],
              ["Unmarked", missing, "grey"],
            ].map(([label, count, color]) => (
              <div key={label}>
                <span>
                  <i className={String(color)} />
                  {label}
                </span>
                <strong>{count}</strong>
              </div>
            ))}
          </div>
          {!isStudent && (
            <button
              className="card-bottom-button"
              onClick={() => navigate("Attendance")}
            >
              Open attendance register <ArrowRight size={15} />
            </button>
          )}
        </section>
      </div>
      {!isStudent && (
        <div className="quick-actions">
          <span>TAKE A SHORTCUT</span>
          <button onClick={onAdd}>
            <Users size={16} /> Add a student <ArrowUpRight size={13} />
          </button>
          <button onClick={() => navigate("Attendance")}>
            <ClipboardCheck size={16} /> Mark attendance{" "}
            <ArrowUpRight size={13} />
          </button>
          <button onClick={onCollect}>
            <Wallet size={16} /> Collect a payment <ArrowUpRight size={13} />
          </button>
          <button onClick={() => navigate("Reports & audit")}>
            <FileCheck2 size={16} /> View reports <ArrowUpRight size={13} />
          </button>
        </div>
      )}
    </>
  );
}
function CollectionChart({
  data,
  category,
}: {
  data: Workspace;
  category: string;
}) {
  // Mess is billed monthly; the other categories once per academic year.
  const monthly = category === "Mess";
  const periods = data.demands
    .filter((d) => d.category === category)
    .map((d) => d.period)
    .sort();
  let months: string[];
  if (monthly) {
    const end = periods.at(-1) || data.today.slice(0, 7);
    months = Array.from({ length: 6 }, (_, i) =>
      new Date(
        Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5)) - 6 + i, 1),
      )
        .toISOString()
        .slice(0, 7),
    );
  } else {
    const y = data.today.slice(5, 7) < "07" ? -1 : 0;
    const end = Number(
      (periods.at(-1) || `${Number(data.today.slice(0, 4)) + y}`).slice(0, 4),
    );
    months = Array.from(
      { length: 6 },
      (_, i) => `${end - 5 + i}-${end - 4 + i}`,
    );
  }
  const label = (m: string) =>
    monthly ? monthName(m, true) : `${m.slice(2, 5)}${m.slice(7)}`;
  const amounts = months.map((month) => {
    const ds = data.demands.filter(
      (d) => d.period === month && d.category === category,
    );
    return {
      demand: sum(ds, (d) => d.amount + d.adjustment),
      collection: sum(ds, (d) => d.collected),
    };
  });
  const max = Math.max(100_000, ...amounts.map((a) => a.demand)) * 1.15;
  return (
    <div className="collection-chart">
      <svg
        viewBox="0 0 660 205"
        role="img"
        aria-label={`${category} demand and allocated collections by billing month. ${months.map((m, i) => `${monthName(m)}: demand ${money(amounts[i].demand)}, collected ${money(amounts[i].collection)}`).join(". ")}`}
      >
        <title>
          {monthly ? "Monthly" : "Academic year"} demand and collection
          comparison
        </title>
        {[0, 1, 2, 3].map((n) => (
          <g key={n}>
            <text x="0" y={17 + n * 49} className="axis-label">
              {shortMoney((max * (3 - n)) / 3)}
            </text>
            <line
              x1="63"
              x2="656"
              y1={13 + n * 49}
              y2={13 + n * 49}
              style={{ stroke: "var(--chart-grid)" }}
              strokeDasharray="4 4"
            />
          </g>
        ))}
        {months.map((m, i) => (
          <g key={m}>
            <rect
              x={88 + i * 96}
              y={160 - (amounts[i].demand / max) * 147}
              width="24"
              height={Math.max(0, (amounts[i].demand / max) * 147)}
              rx="4"
              style={{ fill: "var(--chart-demand)" }}
            >
              <title>
                {monthName(m)} demand: {money(amounts[i].demand)}
              </title>
            </rect>
            <rect
              x={117 + i * 96}
              y={160 - (amounts[i].collection / max) * 147}
              width="24"
              height={Math.max(0, (amounts[i].collection / max) * 147)}
              rx="4"
              style={{ fill: "var(--chart-collected)" }}
            >
              <title>
                {monthName(m)} collected: {money(amounts[i].collection)}
              </title>
            </rect>
            <text
              x={115 + i * 96}
              y="190"
              textAnchor="middle"
              className="axis-label"
            >
              {label(m)}
            </text>
          </g>
        ))}
      </svg>
      {amounts.every((a) => a.demand === 0) && (
        <div className="chart-empty">
          No {category.toLowerCase()} demands yet
        </div>
      )}
    </div>
  );
}

function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div className="search-box">
      <Search size={17} />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button aria-label="Clear search" onClick={() => onChange("")}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}
function Students({
  data,
  search,
  setSearch,
  onProfile,
}: {
  data: Workspace;
  search: string;
  setSearch: (value: string) => void;
  onProfile: (student: Student) => void;
}) {
  const [department, setDepartment] = useState("All departments");
  const students = data.students.filter(
    (s) =>
      (department === "All departments" || s.department === department) &&
      [s.name, s.code, s.roll, s.phone, s.room].some((v) =>
        v.toLowerCase().includes(search.toLowerCase()),
      ),
  );
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>
            {data.user.role === "Student"
              ? "My student record"
              : "Student register"}{" "}
            <span className="inline-count">{data.students.length}</span>
          </h2>
          <p>People are at the heart of every hostel.</p>
        </div>
        {data.user.role !== "Student" && (
          <Button
            variant="secondary"
            icon={ArrowDownToLine}
            onClick={() =>
              downloadCsv(
                "jss-pda-students.csv",
                [
                  "Code",
                  "Name",
                  "Department",
                  "Year",
                  "Room",
                  "Phone",
                  "Status",
                ],
                students.map((s) => [
                  s.code,
                  s.name,
                  s.department,
                  s.year,
                  s.room,
                  s.phone,
                  s.status,
                ]),
              )
            }
          >
            Export CSV
          </Button>
        )}
      </div>
      <div className="table-toolbar">
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Search name, student code, room or phone…"
        />
        <select
          aria-label="Filter department"
          value={department}
          onChange={(e) => setDepartment(e.target.value)}
        >
          <option>All departments</option>
          {[...new Set(data.students.map((s) => s.department))]
            .sort()
            .map((d) => (
              <option key={d}>{d}</option>
            ))}
        </select>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Student</th>
              <th>Department / year</th>
              <th>Room</th>
              <th>Fee balance</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {students.map((s, i) => (
              <tr key={s.id}>
                <td>
                  <button className="student-cell" onClick={() => onProfile(s)}>
                    <Avatar name={s.name} index={i} />
                    <span>
                      <strong>{s.name}</strong>
                      <small>{s.code}</small>
                    </span>
                  </button>
                </td>
                <td>
                  {s.department}
                  <small>Year {s.year}</small>
                </td>
                <td>
                  <span className="room-tag">{s.room}</span>
                </td>
                <td className="amount">
                  {money(
                    sum(
                      data.demands.filter((d) => d.student_id === s.id),
                      (d) => d.balance,
                    ),
                  )}
                </td>
                <td>
                  <Badge>{s.status}</Badge>
                </td>
                <td>
                  <button
                    className="icon-button"
                    aria-label={`View ${s.name}`}
                    onClick={() => onProfile(s)}
                  >
                    <ArrowUpRight size={17} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {students.length === 0 && (
        <Empty title="No students found">
          Try a different name or department.
        </Empty>
      )}
      <div className="table-foot">
        <span>
          Showing {students.length} of {data.students.length} students
        </span>
        <span>
          Academic year{" "}
          {Number(data.today.slice(0, 4)) -
            (Number(data.today.slice(5, 7)) < 7 ? 1 : 0)}
          –
          {Number(data.today.slice(0, 4)) +
            (Number(data.today.slice(5, 7)) >= 7 ? 1 : 0)}
        </span>
      </div>
    </section>
  );
}
function StudentForm({
  data,
  today,
  onClose,
  onSaved,
}: {
  data: Workspace;
  today: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api("/students", { ...form, year: Number(form.year) });
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Make room for someone new"
      subtitle="Add an official student record. A unique student code is created automatically."
      onClose={onClose}
      wide
    >
      <form className="modal-body" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Full name">
            <input
              name="name"
              required
              maxLength={120}
              placeholder="e.g. Aarav Sharma"
            />
          </Field>
          <Field label="Department">
            <select name="department">
              {[
                "Computer Science",
                "Mechanical",
                "Civil",
                "Electronics",
                "Other",
              ].map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </Field>
          <Field label="Year of study">
            <select name="year">
              {[1, 2, 3, 4, 5, 6].map((y) => (
                <option key={y} value={y}>
                  Year {y}
                </option>
              ))}
            </select>
          </Field>
          <RoomPicker data={data} />
          <Field label="Phone number">
            <input
              name="phone"
              type="tel"
              required
              placeholder="10-digit mobile number"
              maxLength={15}
            />
          </Field>
          <Field label="Parent name">
            <input name="guardian" required maxLength={120} />
          </Field>
          <Field label="Parent phone">
            <input
              name="guardian_phone"
              type="tel"
              required
              placeholder="10-digit mobile number"
              maxLength={15}
            />
          </Field>
          <Field label="Admission type">
            <select name="admission_type">
              <option>Fresher</option>
              <option>Existing</option>
            </select>
          </Field>
          <Field label="Joining date">
            <input
              name="joined"
              type="date"
              required
              max={today}
              defaultValue={today}
            />
          </Field>
        </div>
        <div className="notice">
          <ShieldCheck size={16} /> This creates a student record only. Use
          Operations → Admission fees to preview and finalize applicable
          charges.
        </div>
        {error && (
          <div className="notice danger" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" icon={Plus} disabled={busy}>
            {busy ? "Adding…" : "Add student"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function AttendancePage({
  data,
  onSaved,
}: {
  data: Workspace;
  onSaved: (message: string) => Promise<void>;
}) {
  const [date, setDate] = useState(data.today);
  const [entries, setEntries] = useState<Record<number, string>>({});
  // Approved by the Warden: these students stay on Leave for the day.
  const [onLeave, setOnLeave] = useState<Set<number>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const confirm = useConfirm();
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    api<Attendance[]>(`/attendance?date=${date}`)
      .then((rows) => {
        if (active) {
          setEntries(
            Object.fromEntries(rows.map((r) => [r.student_id, r.status])),
          );
          setOnLeave(
            new Set(
              rows.filter((r) => r.approved_leave).map((r) => r.student_id),
            ),
          );
          setDirty(false);
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [date]);
  const locked = data.demands.some(
    (d) => d.category === "Mess" && d.period === date.slice(0, 7),
  );
  const students = data.students.filter(
    (s) =>
      s.joined <= date &&
      (!s.exited || s.exited >= date) &&
      [s.name, s.room, s.department].some((v) =>
        v.toLowerCase().includes(search.toLowerCase()),
      ),
  );
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/attendance", {
        date,
        entries: Object.entries(entries).map(([student_id, status]) => ({
          student_id: Number(student_id),
          status,
        })),
      });
      setDirty(false);
      await onSaved("Attendance saved successfully.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {confirm.dialog}
      <div className="notice">
        <ClipboardCheck size={17} />
        <span>
          Daily mess attendance · Present days are chargeable. Absent and Leave
          days are excluded under the provisional billing rule.
        </span>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Daily attendance register</h2>
            <p>
              {Object.keys(entries).length} marked ·{" "}
              {dirty
                ? "You have unsaved changes"
                : "Changes are saved when you click Save attendance"}
            </p>
          </div>
          <div className="heading-actions">
            <input
              aria-label="Attendance date"
              type="date"
              value={date}
              max={data.today}
              disabled={busy}
              onChange={async (e) => {
                const next = e.target.value || data.today;
                if (
                  !dirty ||
                  (await confirm.ask({
                    title: "Discard unsaved attendance changes?",
                    body: "The marks you changed for this date are not saved yet.",
                    confirm: "Discard changes",
                    danger: true,
                  }))
                )
                  setDate(next);
              }}
            />
            <Button
              icon={Check}
              disabled={locked || busy || loading || !dirty}
              onClick={save}
            >
              {busy ? "Saving…" : "Save attendance"}
            </Button>
          </div>
        </div>
        {error && (
          <div className="notice danger" role="alert">
            {error}
          </div>
        )}
        {locked && (
          <div className="notice">
            <LockKeyhole size={16} /> This month is finalized. Attendance cannot
            be edited.
          </div>
        )}
        <div className="table-toolbar">
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="Search student, room or department…"
          />
          <Button
            variant="secondary"
            icon={CheckCheck}
            disabled={locked || loading || busy || !!error}
            onClick={() => {
              setEntries((current) => ({
                ...current,
                ...Object.fromEntries(
                  students
                    .filter((s) => !onLeave.has(s.id))
                    .map((s) => [s.id, "Present"]),
                ),
              }));
              setDirty(true);
            }}
          >
            Mark visible present
          </Button>
        </div>
        {loading ? (
          <div className="empty">Loading attendance…</div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Room</th>
                  <th>Department</th>
                  <th>Attendance</th>
                </tr>
              </thead>
              <tbody>
                {students.map((s, i) => (
                  <tr key={s.id}>
                    <td>
                      <div className="student-cell">
                        <Avatar name={s.name} index={i} />
                        <span>
                          <strong>{s.name}</strong>
                          <small>{s.code}</small>
                        </span>
                      </div>
                    </td>
                    <td>{s.room}</td>
                    <td>{s.department}</td>
                    <td>
                      {onLeave.has(s.id) && (
                        <span className="badge leave-badge">
                          Approved leave
                        </span>
                      )}
                      <div
                        className="attendance-toggle"
                        role="group"
                        aria-label={`${s.name} attendance`}
                      >
                        {["Present", "Absent", "Leave"].map((status) => (
                          <button
                            key={status}
                            disabled={
                              locked || busy || !!error || onLeave.has(s.id)
                            }
                            className={
                              entries[s.id] === status
                                ? `selected ${status.toLowerCase()}`
                                : ""
                            }
                            aria-pressed={entries[s.id] === status}
                            onClick={() => {
                              setEntries((current) => ({
                                ...current,
                                [s.id]: status,
                              }));
                              setDirty(true);
                            }}
                          >
                            {entries[s.id] === status && <Check size={12} />}
                            {status}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {students.length === 0 && <Empty title="No matching students" />}
          </div>
        )}
      </section>
    </>
  );
}

function DemandTable({
  rows,
  compact = false,
  onCollect,
}: {
  rows: Demand[];
  compact?: boolean;
  onCollect?: (id: number) => void;
}) {
  return (
    <>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {!compact && <th>Student</th>}
              <th>Billing period</th>
              <th>Demand</th>
              <th>Collected</th>
              <th>Balance</th>
              <th>Status</th>
              {onCollect && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                {!compact && (
                  <td>
                    <strong>{d.name}</strong>
                    <small>{d.code}</small>
                  </td>
                )}
                <td>
                  {monthName(d.period)}
                  <small>
                    {d.category}
                    {d.days != null
                      ? ` · ${d.days} days × ${money(d.rate)}`
                      : d.category === "Mess"
                        ? ""
                        : ` · ${
                            // "Management fee" says nothing new; Fund lines do.
                            d.description
                              .replace(/^Admission · /, "")
                              .startsWith(d.category)
                              ? "Admission"
                              : d.description.replace(/^Admission · /, "")
                          }`}
                  </small>
                </td>
                <td className="amount">
                  {money(d.amount + d.adjustment)}
                  {d.adjustment !== 0 && (
                    <small>Adjusted · {d.adjustment_reason}</small>
                  )}
                </td>
                <td className="amount">{money(d.collected)}</td>
                <td className={`amount ${d.balance > 0 ? "amber-text" : ""}`}>
                  {money(d.balance)}
                </td>
                <td>
                  <Badge
                    tone={
                      d.balance === 0
                        ? "green"
                        : d.collected > 0
                          ? "amber"
                          : "grey"
                    }
                  >
                    {d.balance === 0
                      ? "Paid"
                      : d.collected > 0
                        ? "Part-paid"
                        : "Unpaid"}
                  </Badge>
                </td>
                {onCollect && (
                  <td>
                    {d.balance > 0 && (
                      <button
                        className="text-button"
                        onClick={() => onCollect(d.student_id)}
                      >
                        Collect <ArrowRight size={13} />
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <Empty title="No demands to show">
          Finalized fee demands will appear here.
        </Empty>
      )}
    </>
  );
}
function DemandsPage({
  data,
  onSaved,
  onCollect,
}: {
  data: Workspace;
  onSaved: (message: string) => Promise<void>;
  onCollect: (id: number) => void;
}) {
  const [filter, setFilter] = useState("All");
  const [period, setPeriod] = useState("All months");
  const [search, setSearch] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const rows = data.demands.filter(
    (d) =>
      (period === "All months" || d.period === period) &&
      (filter !== "Outstanding" || d.balance > 0) &&
      `${d.name} ${d.code}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="three-metrics">
        <Metric
          label="Total demand"
          value={money(sum(rows, (d) => d.amount + d.adjustment))}
          icon={FileText}
        >
          <span>For the selected filters</span>
        </Metric>
        <Metric
          label="Allocated collections"
          value={money(sum(rows, (d) => d.collected))}
          icon={Wallet}
          color="mint"
        >
          <span>Matched to these demands</span>
        </Metric>
        <Metric
          label="Outstanding balance"
          value={money(sum(rows, (d) => d.balance))}
          icon={Clock3}
          color="peach"
        >
          <span>Demand less collected payments</span>
        </Metric>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Finalized fee demands</h2>
            <p>Historical rates and chargeable days stay locked.</p>
          </div>
          {data.user.role === "Admin" && (
            <Button icon={Plus} onClick={() => setPreviewing(true)}>
              Generate mess demand
            </Button>
          )}
        </div>
        <div className="table-toolbar">
          <div className="tabs">
            {["All", "Outstanding"].map((t) => (
              <button
                key={t}
                className={filter === t ? "active" : ""}
                onClick={() => setFilter(t)}
              >
                {t}
              </button>
            ))}
          </div>
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="Find a student…"
          />
          <select
            aria-label="Billing month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          >
            <option>All months</option>
            {[...new Set(data.demands.map((d) => d.period))]
              .sort()
              .reverse()
              .map((m) => (
                <option value={m} key={m}>
                  {monthName(m)}
                </option>
              ))}
          </select>
        </div>
        <DemandTable
          rows={rows}
          onCollect={data.user.role === "Student" ? undefined : onCollect}
        />
        <div className="table-foot">
          <span>{rows.length} demand rows</span>
          <span>
            <LockKeyhole size={12} /> Finalized records are read-only
          </span>
        </div>
      </section>
      {previewing && (
        <DemandPreview
          data={data}
          onClose={() => setPreviewing(false)}
          onSaved={async () => {
            setPreviewing(false);
            await onSaved(
              "Mess demands finalized. Calculation inputs are now locked.",
            );
          }}
        />
      )}
    </>
  );
}
function DemandPreview({
  data,
  onClose,
  onSaved,
}: {
  data: Workspace;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [period, setPeriod] = useState(data.today.slice(0, 7));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const load = async () => {
    setBusy(true);
    setError("");
    try {
      setPreview(await api<Preview>("/mess/preview", { period }));
      setConfirmed(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const finalize = async () => {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      await api("/mess/finalize", {
        period,
        expected_rate: preview.rate,
        expected_total: preview.total,
        expected_rows: preview.rows,
      });
      await onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const canFinalize =
    preview &&
    preview.closed &&
    !preview.finalized &&
    preview.total > 0 &&
    preview.rows.every((r) => r.missing === 0);
  return (
    <Modal
      title="Monthly mess demand"
      subtitle="Review attendance and the calculation before finalizing."
      onClose={onClose}
      wide
    >
      <div className="modal-body">
        <div className="table-toolbar">
          <Field label="Billing month">
            <input
              type="month"
              value={period}
              onChange={(e) => {
                setPeriod(e.target.value);
                setPreview(null);
              }}
              max={data.today.slice(0, 7)}
            />
          </Field>
          <Button onClick={load} disabled={busy || !period} icon={FileText}>
            {busy ? "Working…" : "Preview demand"}
          </Button>
        </div>
        <div className="notice">
          <ShieldCheck size={16} /> Provisional rule: Present days ×{" "}
          {money(Number(data.settings.daily_rate))}/day. Leave and Absent are
          not charged.
        </div>
        {error && (
          <div className="notice danger" role="alert">
            {error}
          </div>
        )}
        {preview && (
          <>
            <div className={`notice ${canFinalize ? "success" : "warning"}`}>
              {preview.finalized
                ? "This month already has finalized demands."
                : !preview.closed
                  ? "This month is still in progress. Finalization is available after month-end."
                  : preview.rows.some((r) => r.missing > 0)
                    ? "Missing attendance must be completed before this month can be finalized."
                    : "Attendance is complete. Review the rows below before finalizing."}
            </div>
            <div className="preview-total">
              <span>Total proposed demand</span>
              <strong>{money(preview.total)}</strong>
            </div>
            <div className="table-scroll preview-table">
              <table>
                <thead>
                  <tr>
                    <th>Student</th>
                    <th>Present days</th>
                    <th>Missing</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.student_id}>
                      <td>
                        {row.name}
                        <small>{row.code}</small>
                      </td>
                      <td>
                        {row.days} / {row.expected}
                      </td>
                      <td className={row.missing ? "amber-text" : ""}>
                        {row.missing || "—"}
                      </td>
                      <td className="amount">{money(row.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {canFinalize && (
              <label className="confirm-check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                I reviewed these amounts. I understand finalization locks this
                month.
              </label>
            )}
            <div className="modal-actions">
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                icon={LockKeyhole}
                disabled={!canFinalize || !confirmed || busy}
                onClick={finalize}
              >
                Finalize demands
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function PaymentTable({
  rows,
  onReceipt,
  compact = false,
}: {
  rows: Payment[];
  onReceipt: (id: number) => void;
  compact?: boolean;
}) {
  return (
    <>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Student</th>
              {!compact && <th>Receipt / date</th>}
              <th>Category</th>
              <th>Amount</th>
              <th>Mode</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => (
              <tr key={p.id}>
                <td>
                  <div className="student-cell">
                    <Avatar name={p.name} index={i} />
                    <span>
                      <strong>{p.name}</strong>
                      <small>{p.code}</small>
                    </span>
                  </div>
                </td>
                {!compact && (
                  <td>
                    <button
                      className="receipt-link"
                      onClick={() => onReceipt(p.id)}
                    >
                      {p.receipt}
                    </button>
                    <small>{dateName(p.date)}</small>
                  </td>
                )}
                <td>{p.category}</td>
                <td className="amount">
                  {money(p.amount)}
                  {p.refunded_amount > 0 && (
                    <small className="amber-text">
                      Refunded {money(p.refunded_amount)} · Net{" "}
                      {money(p.amount - p.refunded_amount)}
                    </small>
                  )}
                  {p.reversed_at && (
                    <small className="amber-text">Reversed</small>
                  )}
                </td>
                <td>
                  <span className={`mode-pill ${p.mode.toLowerCase()}`}>
                    {p.mode === "Cash" ? (
                      <Wallet size={11} />
                    ) : p.mode === "UPI" ? (
                      <ArrowUpRight size={11} />
                    ) : (
                      <Building2 size={11} />
                    )}
                    {p.mode}
                  </span>
                </td>
                <td>
                  <button
                    className="icon-button"
                    onClick={() => onReceipt(p.id)}
                    aria-label={`Open receipt ${p.receipt}`}
                  >
                    <ArrowUpRight size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <Empty title="No payments found">
          Recorded collections will appear here with their receipt.
        </Empty>
      )}
    </>
  );
}
function PaymentsPage({
  data,
  receipts,
  onReceipt,
  search,
  setSearch,
}: {
  data: Workspace;
  receipts: boolean;
  onReceipt: (id: number) => void;
  search: string;
  setSearch: (value: string) => void;
}) {
  const [mode, setMode] = useState("All modes");
  const [month, setMonth] = useState("All months");
  const rows = data.payments.filter(
    (p) =>
      (mode === "All modes" || p.mode === mode) &&
      (month === "All months" || p.date.startsWith(month)) &&
      `${p.name} ${p.code} ${p.receipt}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>
            {receipts ? "Receipt register" : "Payment collections"}{" "}
            <span className="inline-count">{rows.length}</span>
          </h2>
          <p>
            {receipts
              ? "View and print existing receipts. Reprints never create another payment."
              : `${money(sum(rows, (p) => (p.reversed_at ? 0 : p.amount - p.refunded_amount)))} retained across the selected records, after refunds and reversals.`}
          </p>
        </div>
        <Button
          variant="secondary"
          icon={ArrowDownToLine}
          onClick={() =>
            downloadCsv(
              "jss-pda-collections.csv",
              [
                "Receipt",
                "Date",
                "Student",
                "Code",
                "Category",
                "Amount INR",
                "Refunded INR",
                "Net INR",
                "Mode",
                "Reference",
                "Received by",
                "Status",
              ],
              rows.map((p) => [
                p.receipt,
                p.date,
                p.name,
                p.code,
                p.category,
                p.amount / 100,
                p.refunded_amount / 100,
                (p.reversed_at ? 0 : p.amount - p.refunded_amount) / 100,
                p.mode,
                p.reference,
                p.received_name,
                p.reversed_at
                  ? "Reversed"
                  : p.refunded_amount > 0
                    ? "Partly refunded"
                    : "Received",
              ]),
            )
          }
        >
          Export CSV
        </Button>
      </div>
      <div className="table-toolbar">
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Search student or receipt number…"
        />
        <select
          aria-label="Payment month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
        >
          <option>All months</option>
          {[...new Set(data.payments.map((p) => p.date.slice(0, 7)))]
            .sort()
            .reverse()
            .map((m) => (
              <option key={m} value={m}>
                {monthName(m)}
              </option>
            ))}
        </select>
        <select
          aria-label="Payment mode filter"
          value={mode}
          onChange={(e) => setMode(e.target.value)}
        >
          {["All modes", "Cash", "UPI", "Bank", "Card"].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </div>
      <PaymentTable rows={rows} onReceipt={onReceipt} />
      <div className="table-foot">
        <span>{rows.length} records</span>
        <span>
          <ShieldCheck size={12} /> All collections are audit-logged
        </span>
      </div>
    </section>
  );
}

function PaymentForm({
  data,
  initialStudent,
  onClose,
  onSaved,
}: {
  data: Workspace;
  initialStudent: number;
  onClose: () => void;
  onSaved: (id: number) => Promise<void>;
}) {
  const [student, setStudent] = useState(initialStudent);
  const [category, setCategory] = useState("Mess");
  const [allocations, setAllocations] = useState<Record<number, string>>({});
  const [mode, setMode] = useState("UPI");
  const [reference, setReference] = useState("");
  const [date, setDate] = useState(data.today);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [key] = useState(() => crypto.randomUUID());
  const rows = data.demands
    .filter(
      (d) =>
        d.student_id === student && d.category === category && d.balance > 0,
    )
    .sort((a, b) => a.period.localeCompare(b.period));
  const allocated = rows
    .filter((d) => Number(allocations[d.id]) > 0)
    .map((d) => ({
      demand_id: d.id,
      amount: Math.round(Number(allocations[d.id]) * 100),
    }));
  const total = sum(allocated, (a) => a.amount);
  const selectedStudent = data.students.find((s) => s.id === student);
  const valid =
    total > 0 &&
    rows.every(
      (d) =>
        !allocations[d.id] ||
        (Number.isFinite(Number(allocations[d.id])) &&
          Number(allocations[d.id]) >= 0 &&
          Math.round(Number(allocations[d.id]) * 100) <= d.balance),
    );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!review) {
      setReview(true);
      setError("");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api<{ id: number }>("/payments", {
        student_id: student,
        amount: total,
        date,
        mode,
        reference,
        category,
        allocations: allocated,
        idempotency_key: key,
      });
      await onSaved(result.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={review ? "Everything look right?" : "Collect a payment"}
      subtitle={
        review
          ? "Confirm the details below. The payment and receipt are saved together."
          : "One payment. Multiple months. A single, clear receipt."
      }
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <form className="modal-body" onSubmit={submit}>
        {!review ? (
          <>
            <div className="form-grid">
              <Field label="Student">
                <select
                  required
                  aria-label="Payment student"
                  value={student || ""}
                  onChange={(e) => {
                    setStudent(Number(e.target.value));
                    setAllocations({});
                  }}
                >
                  <option value="" disabled>
                    Select a student
                  </option>
                  {data.students.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {s.code}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Fee category">
                <select
                  value={category}
                  onChange={(e) => {
                    setCategory(e.target.value);
                    setAllocations({});
                  }}
                >
                  {["Mess", "Fund", "Management", "Establishment"].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
            </div>
            {student > 0 && (
              <>
                <div className="allocation-heading">
                  <h3>Allocate to outstanding demands</h3>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      setAllocations(
                        Object.fromEntries(
                          rows.map((d) => [d.id, String(d.balance / 100)]),
                        ),
                      )
                    }
                  >
                    Pay all outstanding <CheckCheck size={15} />
                  </button>
                </div>
                {rows.length === 0 ? (
                  <Empty title="All clear in this category">
                    This student has no outstanding {category.toLowerCase()}{" "}
                    demands.
                  </Empty>
                ) : (
                  <div className="table-scroll">
                    <table className="allocation-table">
                      <thead>
                        <tr>
                          <th>Billing month</th>
                          <th>Outstanding</th>
                          <th>Pay amount (₹)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((d) => (
                          <tr key={d.id}>
                            <td>
                              {monthName(d.period)}
                              <small>{d.description}</small>
                            </td>
                            <td className="amount">{money(d.balance)}</td>
                            <td>
                              <input
                                aria-label={`Allocation for ${monthName(d.period)}`}
                                type="number"
                                min="0"
                                step="0.01"
                                max={d.balance / 100}
                                value={allocations[d.id] || ""}
                                placeholder="0.00"
                                onChange={(e) =>
                                  setAllocations({
                                    ...allocations,
                                    [d.id]: e.target.value,
                                  })
                                }
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
            <div className="form-grid payment-details">
              <Field label="Payment date">
                <input
                  type="date"
                  required
                  value={date}
                  max={data.today}
                  onChange={(e) => setDate(e.target.value)}
                />
              </Field>
              <Field label="Payment mode">
                <select value={mode} onChange={(e) => setMode(e.target.value)}>
                  {["UPI", "Cash", "Bank"].map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </Field>
              <Field
                label={
                  mode === "Cash"
                    ? "Reference / note (optional)"
                    : "Transaction reference"
                }
              >
                <input
                  value={reference}
                  required={mode !== "Cash"}
                  maxLength={120}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder={
                    mode === "Cash"
                      ? "Optional note"
                      : "UPI / bank transaction ID"
                  }
                />
              </Field>
            </div>
          </>
        ) : (
          <>
            <div className="payment-review-person">
              <Avatar name={selectedStudent?.name || ""} />
              <div>
                <h3>{selectedStudent?.name}</h3>
                <p>
                  {selectedStudent?.code} · {category}
                </p>
              </div>
              <Badge tone="amber">Awaiting confirmation</Badge>
            </div>
            <div className="detail-grid">
              <div>
                <small>Payment date</small>
                <strong>{dateName(date)}</strong>
              </div>
              <div>
                <small>Payment mode</small>
                <strong>{mode}</strong>
              </div>
              <div>
                <small>Reference</small>
                <strong>{reference || "—"}</strong>
              </div>
            </div>
            <div className="review-allocations">
              {allocated.map((a) => (
                <div key={a.demand_id}>
                  <span>
                    {monthName(rows.find((d) => d.id === a.demand_id)!.period)}
                  </span>
                  <strong>{money(a.amount)}</strong>
                </div>
              ))}
            </div>
            <div className="notice">
              <LockKeyhole size={16} /> This records money actually received.
              Posted payments cannot be silently edited or deleted.
            </div>
          </>
        )}
        <div className="payment-total">
          <div>
            <span>Total to collect</span>
            <small>
              {allocated.length} {allocated.length === 1 ? "demand" : "demands"}{" "}
              · one {category.toLowerCase()} receipt
            </small>
          </div>
          <strong>{money(total)}</strong>
        </div>
        {error && (
          <div className="notice danger" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              if (review) {
                setReview(false);
              } else onClose();
            }}
          >
            {review ? "Back to details" : "Cancel"}
          </Button>
          <Button
            type="submit"
            icon={review ? Check : ArrowRight}
            disabled={!valid || busy}
          >
            {busy
              ? "Recording payment…"
              : review
                ? "Confirm & create receipt"
                : "Review payment"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ReceiptModal({
  receipt: r,
  demo,
  onClose,
}: {
  receipt: Receipt;
  demo: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      title="Payment receipt"
      subtitle="Saved once. Ready whenever you need it."
      onClose={onClose}
      wide
    >
      <div className="receipt-paper">
        <div className="receipt-brand">
          <div className="small-icon">
            <Building2 size={25} />
          </div>
          <div>
            <h2>{r.hostel}</h2>
            <p>
              {HOSTEL.short} · {r.category} payment receipt
            </p>
          </div>
          <Badge
            tone={r.reversed_at || r.refunded_amount > 0 ? "amber" : "green"}
          >
            {r.reversed_at
              ? "Reversed"
              : r.refunded_amount > 0
                ? "Partly refunded"
                : "Received"}
          </Badge>
        </div>
        {r.reversed_at && (
          <div className="notice danger">
            REVERSED · {dateName(r.reversed_at)} · {r.reversal_reason}. This
            receipt is retained for audit and is no longer a valid collection.
          </div>
        )}
        {demo && (
          <div className="receipt-demo">
            DEMO RECEIPT · FICTIONAL DATA · NOT VALID FOR ACCOUNTING
          </div>
        )}
        <div className="receipt-meta">
          <div>
            <small>RECEIVED FROM</small>
            <h3>{r.name}</h3>
            <span>{r.code}</span>
          </div>
          <div>
            <small>RECEIPT NUMBER</small>
            <strong>{r.receipt}</strong>
            <span>{dateName(r.date)}</span>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Billing period</th>
              <th>Description</th>
              <th className="right">Amount received</th>
            </tr>
          </thead>
          <tbody>
            {r.allocations.map((a, i) => (
              <tr key={i}>
                <td>{monthName(a.period)}</td>
                <td>{a.description}</td>
                <td className="amount right">{money(a.amount)}</td>
              </tr>
            ))}
            {!!r.advance && (
              <tr>
                <td>Advance</td>
                <td>Credit kept for the next {r.category} dues</td>
                <td className="amount right">{money(r.advance)}</td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="receipt-total">
          <span>Total received</span>
          <strong>{money(r.amount)}</strong>
        </div>
        {!!r.gateway?.refunded_before_receipt && (
          <p className="notice">
            Originally charged {money(r.gateway.charged)};{" "}
            {money(r.gateway.refunded_before_receipt)} was refunded before this
            receipt. This receipt records only the retained credit.
          </p>
        )}
        {r.refunded_amount > 0 && (
          <div className="notice">
            Refunded after receipt: {money(r.refunded_amount)}. Net retained:{" "}
            {money(r.amount - r.refunded_amount)}. The original receipt and
            allocations are preserved; refunded fees are outstanding again.
          </div>
        )}
        <div className="detail-grid">
          <div>
            <small>Payment mode</small>
            <strong>{r.mode}</strong>
          </div>
          <div>
            <small>Reference</small>
            <strong>{r.reference || "—"}</strong>
          </div>
          <div>
            <small>Received by</small>
            <strong>{r.received_name}</strong>
          </div>
        </div>
        <div className="receipt-signature">
          <p>Thank you. Every payment makes a difference.</p>
          <div>Authorized signature</div>
        </div>
      </div>
      <div className="modal-actions receipt-actions">
        <span>
          <ShieldCheck size={14} /> Reprinting does not create a new payment.
        </span>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
        <Button icon={Printer} onClick={() => window.print()}>
          Print / Save PDF
        </Button>
      </div>
    </Modal>
  );
}

function Reports({ data }: { data: Workspace }) {
  const [tab, setTab] = useState("Financial overview");
  const exportOutstanding = () =>
    downloadCsv(
      "jss-pda-outstanding.csv",
      [
        "Student",
        "Code",
        "Category",
        "Period",
        "Demand INR",
        "Collected INR",
        "Balance INR",
      ],
      data.demands
        .filter((d) => d.balance > 0)
        .map((d) => [
          d.name,
          d.code,
          d.category,
          d.period,
          (d.amount + d.adjustment) / 100,
          d.collected / 100,
          d.balance / 100,
        ]),
    );
  return (
    <>
      <div className="tabs page-tabs">
        {["Financial overview", "Audit trail"].map((t) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "Financial overview" ? (
        <>
          <div className="three-metrics">
            <Metric
              label="All-time demand"
              value={money(sum(data.demands, (d) => d.amount + d.adjustment))}
              icon={FileText}
            >
              <span>All finalized billing periods</span>
            </Metric>
            <Metric
              label="All-time collections"
              value={money(
                sum(data.payments, (p) =>
                  p.reversed_at ? 0 : p.amount - p.refunded_amount,
                ),
              )}
              icon={Wallet}
              color="mint"
            >
              <span>Actual recorded payments</span>
            </Metric>
            <Metric
              label="Outstanding balance"
              value={money(sum(data.demands, (d) => d.balance))}
              icon={Clock3}
              color="peach"
            >
              <span>Fully reconciled to allocations</span>
            </Metric>
          </div>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Category-wise account summary</h2>
                <p>Demand, collection and balance — kept distinct.</p>
              </div>
              <Button
                variant="secondary"
                icon={ArrowDownToLine}
                onClick={exportOutstanding}
              >
                Export outstanding
              </Button>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Fee category</th>
                    <th>Demand</th>
                    <th>Collection</th>
                    <th>Balance</th>
                    <th>Collection rate</th>
                  </tr>
                </thead>
                <tbody>
                  {["Mess", "Fund", "Management", "Establishment"].map(
                    (category) => {
                      const ds = data.demands.filter(
                        (d) => d.category === category,
                      );
                      const demand = sum(ds, (d) => d.amount + d.adjustment);
                      const collection = sum(ds, (d) => d.collected);
                      return (
                        <tr key={category}>
                          <td>
                            <strong>{category}</strong>
                          </td>
                          <td className="amount">{money(demand)}</td>
                          <td className="amount">{money(collection)}</td>
                          <td className="amount amber-text">
                            {money(demand - collection)}
                          </td>
                          <td>
                            <div className="progress-cell">
                              <div>
                                <span
                                  style={{
                                    width: `${demand ? (collection / demand) * 100 : 0}%`,
                                  }}
                                />
                              </div>
                              {demand
                                ? Math.round((collection / demand) * 100)
                                : 0}
                              %
                            </div>
                          </td>
                        </tr>
                      );
                    },
                  )}
                </tbody>
              </table>
            </div>
          </section>
          <div className="notice report-notice">
            <FileCheck2 size={18} /> Use Operations → Registers for date-range
            reconciliation, Excel exports and printable collection and
            outstanding registers.
          </div>
        </>
      ) : (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Activity & audit trail</h2>
              <p>The latest 100 important actions, with who and when.</p>
            </div>
            <ShieldCheck size={20} />
          </div>
          <div className="audit-list">
            {data.audit.map((event) => (
              <div className="audit-item" key={event.id}>
                <div className="audit-icon">
                  <Check size={16} />
                </div>
                <div>
                  <h3>{event.action}</h3>
                  <p>{event.detail}</p>
                  <small>
                    {event.actor} ·{" "}
                    {new Date(event.created_at).toLocaleString("en-IN", {
                      timeZone: "Asia/Kolkata",
                    })}{" "}
                    IST
                  </small>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
function SettingsPage({
  data,
  onSaved,
}: {
  data: Workspace;
  onSaved: (message: string) => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api("/settings", {
        hostel_name: f.get("hostel_name"),
        daily_rate: Math.round(Number(f.get("daily_rate")) * 100),
      });
      await onSaved("Settings saved. Historical demands remain unchanged.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-layout">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Hostel & billing settings</h2>
            <p>These settings apply to future calculations.</p>
          </div>
          <Settings2 size={19} />
        </div>
        <form onSubmit={submit} className="settings-form">
          <Field label="Hostel name">
            <input
              name="hostel_name"
              defaultValue={data.settings.hostel_name}
              required
              maxLength={120}
            />
          </Field>
          <Field label="Mess daily rate (₹)">
            <input
              name="daily_rate"
              type="number"
              min="0.01"
              step="0.01"
              max="9999999"
              defaultValue={Number(data.settings.daily_rate) / 100}
              required
            />
          </Field>
          <div className="notice">
            <LockKeyhole size={17} /> Updating this rate never changes finalized
            demands or issued receipts.
          </div>
          {error && (
            <div className="notice danger" role="alert">
              {error}
            </div>
          )}
          <Button icon={Check} disabled={busy} type="submit">
            {busy ? "Saving…" : "Save settings"}
          </Button>
        </form>
      </section>
      <section className="panel policy-panel">
        <div className="panel-heading">
          <h2>Initial operating rules</h2>
          <span className="subtle-pill">Provisional</span>
        </div>
        {[
          ["Mess billing", "Present days × daily rate"],
          ["Leave & absent days", "Not chargeable"],
          ["Payment allocation", "Staff-selected demand amounts"],
          ["Receipts", "One category per payment; separate sequences"],
          ["Finalization", "Admin only, after month-end"],
          ["Currency & timezone", "Indian rupee (INR) · Asia/Kolkata"],
        ].map(([key, value]) => (
          <div className="policy-row" key={key}>
            <small>{key}</small>
            <strong>{value}</strong>
          </div>
        ))}
        <div className="notice">
          Confirm these policies with hostel staff before using real financial
          data.
        </div>
      </section>
      <BlocksSettings data={data} onSaved={onSaved} />
      <FeeStructure data={data} onSaved={onSaved} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
