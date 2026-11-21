// Portable schema used by disposable SQLite tests and the PostgreSQL migration.
// Money is integer paise; financial rows are never deleted by the application.
export const extensions = `
CREATE TABLE IF NOT EXISTS applications (
 id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), name TEXT NOT NULL,
 roll TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, department TEXT NOT NULL,
 course TEXT NOT NULL, year INTEGER NOT NULL, academic_year TEXT NOT NULL, guardian TEXT NOT NULL,
 address TEXT NOT NULL, admission_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Submitted',
 reason TEXT NOT NULL DEFAULT '', student_id INTEGER REFERENCES students(id), created_at TEXT NOT NULL,
 guardian_phone TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS application_roll ON applications(roll) WHERE roll <> '';
CREATE TABLE IF NOT EXISTS fee_components (
 id INTEGER PRIMARY KEY, category TEXT NOT NULL, name TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK(amount>0), academic_year TEXT NOT NULL,
 applicability TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
 UNIQUE(category,name,academic_year)
);
CREATE TABLE IF NOT EXISTS room_history (
 id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES students(id),
 room TEXT NOT NULL, started TEXT NOT NULL, ended TEXT, reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
 id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES students(id),
 name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
 uploaded_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_batches (
 id INTEGER PRIMARY KEY, actor_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
 rows_json TEXT NOT NULL, errors_json TEXT NOT NULL, created_at TEXT NOT NULL, committed_at TEXT
);
CREATE TABLE IF NOT EXISTS billing_periods (
 period TEXT PRIMARY KEY, snapshot TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
 key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS demand_student_period ON demands(student_id,period);
CREATE INDEX IF NOT EXISTS payment_student_date ON payments(student_id,date);
CREATE INDEX IF NOT EXISTS allocation_demand ON allocations(demand_id);
CREATE INDEX IF NOT EXISTS attendance_date ON attendance(date);
CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);
`;

export const addedColumns: Record<string, Record<string, string>> = {
  students: {
    course: "TEXT NOT NULL DEFAULT 'B.E.'",
    academic_year: "TEXT NOT NULL DEFAULT ''",
    address: "TEXT NOT NULL DEFAULT ''",
    guardian_phone: "TEXT NOT NULL DEFAULT ''",
    exited: "TEXT",
    exit_reason: "TEXT NOT NULL DEFAULT ''",
  },
  users: {
    auth_id: "TEXT UNIQUE",
    must_change_password: "INTEGER NOT NULL DEFAULT 0",
  },
  demands: {
    adjustment: "INTEGER NOT NULL DEFAULT 0",
    adjustment_reason: "TEXT NOT NULL DEFAULT ''",
  },
  payments: {
    snapshot: "TEXT",
    reversed_at: "TEXT",
    reversal_reason: "TEXT NOT NULL DEFAULT ''",
  },
};
