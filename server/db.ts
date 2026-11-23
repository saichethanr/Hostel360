import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { extensions, addedColumns } from "./schema.js";

// Student IDs: JSSPDA, the joining year, then the student's permanent number,
// which never repeats, so every student keeps a unique ID across years.
export const studentCode = (id: number, joined: string) =>
  `JSSPDA-${joined.slice(0, 4)}-${String(id).padStart(4, "0")}`;

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export function checkPassword(password: string, hash: string) {
  const [salt, key] = hash.split(":");
  return timingSafeEqual(
    Buffer.from(key, "hex"),
    scryptSync(password, salt, 64),
  );
}

export function openDatabase(path: string, demo = false) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, roll TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, department TEXT NOT NULL, year INTEGER NOT NULL,
      room TEXT NOT NULL, phone TEXT NOT NULL, guardian TEXT NOT NULL DEFAULT '',
      admission_type TEXT NOT NULL DEFAULT 'Fresher', status TEXT NOT NULL DEFAULT 'Active',
      joined TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('Admin','Manager','Student')),
      student_id INTEGER REFERENCES students(id), active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attendance (
      student_id INTEGER NOT NULL REFERENCES students(id), date TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('Present','Absent','Leave')),
      recorded_by INTEGER NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL,
      PRIMARY KEY(student_id,date)
    );
    CREATE TABLE IF NOT EXISTS demands (
      id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES students(id),
      category TEXT NOT NULL CHECK(category IN ('Mess','Fund','Management','Establishment')),
      period TEXT NOT NULL, description TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0),
      days INTEGER, rate INTEGER, finalized_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL, UNIQUE(student_id,category,period,description)
    );
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES students(id),
      amount INTEGER NOT NULL CHECK(amount > 0), date TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('Cash','UPI','Bank')), reference TEXT NOT NULL,
      category TEXT NOT NULL, receipt TEXT NOT NULL UNIQUE,
      received_by INTEGER NOT NULL REFERENCES users(id), idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS allocations (
      payment_id INTEGER NOT NULL REFERENCES payments(id), demand_id INTEGER NOT NULL REFERENCES demands(id),
      amount INTEGER NOT NULL CHECK(amount > 0), PRIMARY KEY(payment_id,demand_id)
    );
    CREATE TABLE IF NOT EXISTS receipt_sequences (category TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT OR IGNORE INTO settings VALUES (?, ?)").run(
    "hostel_name",
    "Greenfield Student Hostel",
  );
  db.prepare("INSERT OR IGNORE INTO settings VALUES (?, ?)").run(
    "daily_rate",
    "11000",
  );
  db.prepare("INSERT OR IGNORE INTO settings VALUES (?, ?)").run(
    "demo",
    demo ? "true" : "false",
  );
  if (demo && !db.prepare("SELECT id FROM users LIMIT 1").get()) seedDemo(db);
  // Older local previews are migrated without losing their records.
  for (const [table, columns] of Object.entries(addedColumns)) {
    const existing = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name);
    for (const [name, definition] of Object.entries(columns)) {
      if (!existing.includes(name))
        db.exec(
          `ALTER TABLE ${table} ADD COLUMN ${name} ${definition.replace(" UNIQUE", "")}`,
        );
    }
  }
  db.exec(extensions);
  return db;
}

function seedDemo(db: DatabaseSync) {
  const names = [
    "Aarav Sharma",
    "Aditya Kumar",
    "Arjun Patel",
    "Rohan Mehta",
    "Vikram Singh",
    "Karthik Reddy",
    "Rahul Nair",
    "Siddharth Rao",
    "Pranav Joshi",
    "Akash Verma",
    "Ishaan Gupta",
    "Nikhil Menon",
    "Ananya Iyer",
    "Diya Kapoor",
    "Meera Krishnan",
    "Sneha Desai",
    "Priya Nambiar",
    "Kavya Rao",
    "Aditi Sharma",
    "Riya Shah",
    "Dev Malhotra",
    "Varun Pillai",
    "Surya Prakash",
    "Harsh Jain",
    "Neha Reddy",
    "Pooja Menon",
    "Sanjay Kumar",
    "Vivek Anand",
    "Aryan Das",
    "Manav Sethi",
    "Shreya Nair",
    "Tanvi Joshi",
    "Omkar Patil",
    "Abhinav Roy",
    "Sahil Khan",
    "Yash Bhat",
    "Nandini Rao",
    "Anjali Das",
    "Rohit Sinha",
    "Dhruv Shah",
    "Mihir Bose",
    "Parth Mishra",
    "Gauri Kulkarni",
    "Sana Ali",
    "Anirudh Sen",
    "Deepak Rao",
    "Nisha Patel",
    "Keerthi Raj",
  ];
  const departments = [
    "Computer Science",
    "Mechanical",
    "Civil",
    "Electronics",
  ];
  const now = new Date();
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
  }).format(now);
  const month = today.slice(0, 7);
  const previous = (offset: number) => {
    const date = new Date(
      Date.UTC(
        Number(month.slice(0, 4)),
        Number(month.slice(5)) - 1 - offset,
        1,
      ),
    );
    return date.toISOString().slice(0, 7);
  };
  db.exec("BEGIN");
  try {
    names.forEach((name, i) =>
      db
        .prepare(
          "INSERT INTO students (id,code,roll,name,department,year,room,phone,guardian,admission_type,joined) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          i + 1,
          studentCode(i + 1, String(now.getFullYear())),
          `GF${now.getFullYear()}${String(i + 1).padStart(3, "0")}`,
          name,
          departments[i % 4],
          (i % 4) + 1,
          `${i < 24 ? "A" : "B"}-${101 + Math.floor((i % 24) / 3)}`,
          `90000${String(i + 1).padStart(5, "0")}`,
          `${name.split(" ").at(-1)} family`,
          i % 4 === 0 ? "Fresher" : "Existing",
          `${now.getFullYear()}-07-01`,
        ),
    );
    for (const [id, name, email, role, student] of [
      [1, "Anita Rao", "admin@hostel360.demo", "Admin", null],
      [2, "Ravi Kumar", "manager@hostel360.demo", "Manager", null],
      [3, names[0], "student@hostel360.demo", "Student", 1],
    ] as const) {
      db.prepare("INSERT INTO users VALUES (?,?,?,?,?,?,1)").run(
        id,
        name,
        email,
        hashPassword("Hostel360Demo!"),
        role,
        student,
      );
    }
    let receiptNumber = 0;
    for (let offset = 5; offset >= 1; offset--) {
      names.forEach((_, i) => {
        const days = 24 + (i % 7);
        const demand = db
          .prepare(
            "INSERT INTO demands (student_id,category,period,description,amount,days,rate,finalized_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
          )
          .run(
            i + 1,
            "Mess",
            previous(offset),
            "Monthly mess charges",
            days * 11000,
            days,
            11000,
            1,
            `${previous(offset)}-28T10:00:00.000Z`,
          );
        const amount =
          offset > 1
            ? days * 11000
            : i % 5 === 0
              ? 0
              : i % 3 === 0
                ? 150000
                : days * 11000;
        if (amount) {
          const seq = ++receiptNumber;
          const date =
            offset > 1
              ? `${previous(offset)}-${String(12 + (i % 15)).padStart(2, "0")}`
              : `${month}-${String(1 + (i % Math.min(Number(today.slice(-2)), 8))).padStart(2, "0")}`;
          const p = db
            .prepare(
              "INSERT INTO payments (student_id,amount,date,mode,reference,category,receipt,received_by,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              i + 1,
              amount,
              date,
              ["UPI", "Bank", "Cash"][i % 3],
              i % 3 === 2 ? "" : `DEMO${seq}`,
              "Mess",
              `MESS-${String(seq).padStart(6, "0")}`,
              2,
              `seed-${seq}`,
              `${date}T09:${String(i % 60).padStart(2, "0")}:00.000Z`,
            );
          db.prepare("INSERT INTO allocations VALUES (?,?,?)").run(
            p.lastInsertRowid,
            demand.lastInsertRowid,
            amount,
          );
        }
      });
    }
    db.prepare("INSERT INTO receipt_sequences VALUES (?,?)").run(
      "Mess",
      receiptNumber,
    );
    names.forEach((_, i) => {
      for (let day = 1; day <= Number(today.slice(-2)); day++) {
        // Leave a few unmarked records to make the operational exceptions visible.
        if (day === Number(today.slice(-2)) && i >= 43) continue;
        db.prepare("INSERT INTO attendance VALUES (?,?,?,?,?)").run(
          i + 1,
          `${month}-${String(day).padStart(2, "0")}`,
          i % 13 === 0 ? "Leave" : (i + day) % 11 === 0 ? "Absent" : "Present",
          2,
          now.toISOString(),
        );
      }
    });
    db.prepare(
      "INSERT INTO audit (actor,action,detail,created_at) VALUES (?,?,?,?)",
    ).run(
      "System",
      "Demo workspace created",
      "48 fictional students, sample attendance and mess transactions. Not live financial data.",
      now.toISOString(),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
