import type { Express, Response } from "express";
import { admin, ensure, integer, me, now, text, validDate } from "./http.js";
import { storeDocument } from "./operations.js";
import type { Row, Store } from "./store.js";

type Audit = (
  actor: { name: string },
  action: string,
  detail: string,
) => Promise<void>;

// Every date from start to end, inclusive (YYYY-MM-DD).
export function leaveDays(start: string, end: string) {
  const days: string[] = [];
  for (
    let d = new Date(`${start}T00:00:00Z`);
    d.toISOString().slice(0, 10) <= end;
    d.setUTCDate(d.getUTCDate() + 1)
  )
    days.push(d.toISOString().slice(0, 10));
  return days;
}

// Students apply for casual or medical leave, optionally with a document. A
// Warden or Admin approves or rejects, and decides whether the days get a mess
// concession: approved days are marked Leave in attendance, and they are free
// of mess charges only with a concession. A Warden or Admin can also record
// leave for a student; it is approved at once.
export function registerLeaves(app: Express, db: Store, audit: Audit) {
  const warden = (res: Response) =>
    ensure(
      ["Warden", "Admin"].includes(me(res).role),
      "Only a Warden or Admin can decide leave.",
      403,
    );
  // Finalized mess months are closed; leave cannot change their attendance.
  const unlocked = async (start: string, end: string, what = "leave") => {
    const months = [
      ...new Set(leaveDays(start, end).map((d) => d.slice(0, 7))),
    ];
    for (const m of months)
      ensure(
        !(await db.get("SELECT period FROM billing_periods WHERE period=?", m)),
        `Mess charges for ${m} are already finalized, so ${what} cannot include that month.`,
        409,
      );
  };

  app.get("/api/leaves", async (_req, res) => {
    const user = me(res);
    const own = user.role === "Student";
    res.json(
      await db.all(
        `SELECT l.*,s.name,s.code,s.room,d.name AS document_name,u.name AS decided_name,r.name AS requested_name,r.role AS requested_role
        FROM leaves l JOIN students s ON s.id=l.student_id
        LEFT JOIN documents d ON d.id=l.document_id
        LEFT JOIN users u ON u.id=l.decided_by
        LEFT JOIN users r ON r.id=l.requested_by
        ${own ? "WHERE l.student_id=?" : ""} ORDER BY l.start_date DESC,l.id DESC LIMIT 2000`,
        ...(own ? [user.student_id ?? -1] : []),
      ),
    );
  });

  // Approved days become Leave in attendance (within the student's stay).
  const markLeave = async (l: Row, userId: number) => {
    await unlocked(l.start_date, l.end_date);
    const days = leaveDays(l.start_date, l.end_date).filter(
      (d) => d >= l.joined && (!l.exited || d <= l.exited),
    );
    if (days.length)
      await db.insertRows(
        "attendance",
        ["student_id", "date", "status", "recorded_by", "updated_at"],
        days.map((d) => [l.student_id, d, "Leave", userId, now()]),
        "ON CONFLICT(student_id,date) DO UPDATE SET status='Leave',recorded_by=excluded.recorded_by,updated_at=excluded.updated_at",
      );
  };

  app.post("/api/leaves", async (req, res) => {
    const user = me(res),
      b = req.body;
    const staff = ["Warden", "Admin"].includes(user.role);
    ensure(
      staff || (user.role === "Student" && user.student_id),
      "Only admitted students can apply for leave.",
      403,
    );
    ensure(
      !staff || integer(b.student_id),
      "Choose the student this leave is for.",
    );
    ensure(
      ["Casual", "Medical"].includes(b.type),
      "Choose casual or medical leave.",
    );
    ensure(
      validDate(b.start_date) &&
        validDate(b.end_date) &&
        b.end_date >= b.start_date &&
        leaveDays(b.start_date, b.end_date).length <= 90,
      "Choose a start and end date, up to 90 days.",
    );
    ensure(text(b.reason, 500), "Give a reason for the leave.");
    ensure(
      !staff || typeof b.concession === "boolean",
      "Choose whether to give a mess concession.",
    );
    const student = await db.get(
      "SELECT * FROM students WHERE id=?",
      staff ? b.student_id : user.student_id,
    );
    ensure(student, "Student not found.", 404);
    ensure(
      student.status === "Active" &&
        b.start_date >= student.joined &&
        (!student.exited || b.end_date <= student.exited),
      "Leave must fall within the student's stay in the hostel.",
    );
    await unlocked(b.start_date, b.end_date);
    const insert = async (documentId: number | null) => {
      ensure(
        !(await db.get(
          "SELECT id FROM leaves WHERE student_id=? AND status IN ('Pending','Approved') AND start_date<=? AND end_date>=?",
          student.id,
          b.end_date,
          b.start_date,
        )),
        staff
          ? `${student.name} already has leave on some of these days.`
          : "You already have leave on some of these days.",
        409,
      );
      await db.run(
        `INSERT INTO leaves (student_id,type,start_date,end_date,reason,document_id,created_at,requested_by${staff ? ",status,decided_by,decided_at,concession" : ""}) VALUES (?,?,?,?,?,?,?,?${staff ? ",'Approved',?,?,?" : ""})`,
        student.id,
        b.type,
        b.start_date,
        b.end_date,
        b.reason.trim(),
        documentId,
        now(),
        user.id,
        ...(staff ? [user.id, now(), b.concession ? 1 : 0] : []),
      );
      if (staff)
        await markLeave(
          {
            ...b,
            student_id: student.id,
            joined: student.joined,
            exited: student.exited,
          },
          user.id,
        );
      await audit(
        user,
        staff ? "Leave recorded" : "Leave requested",
        `${student.name} · ${b.type} · ${b.start_date} to ${b.end_date}${staff ? ` · ${b.concession ? "mess concession" : "no mess concession"}` : ""}`,
      );
    };
    // A document is optional for either type of leave.
    if (b.document && typeof b.document === "object")
      await storeDocument(
        db,
        student.id,
        { name: b.document.name, content: b.document.content },
        user,
        insert,
      );
    else await db.transaction(() => insert(null));
    res.status(201).json({ ok: true });
  });

  // Holidays: the Admin declares days the mess is closed.
  app.get("/api/holidays", async (_req, res) => {
    res.json(
      await db.all(
        "SELECT id,date,name FROM holidays ORDER BY date LIMIT 2000",
      ),
    );
  });
  app.post("/api/holidays", async (req, res) => {
    admin(res);
    const b = req.body;
    ensure(
      validDate(b.start_date) &&
        validDate(b.end_date) &&
        b.end_date >= b.start_date &&
        leaveDays(b.start_date, b.end_date).length <= 90,
      "Choose a start and end date, up to 90 days.",
    );
    ensure(text(b.name, 80), "Name the holiday, such as Diwali.");
    const days = leaveDays(b.start_date, b.end_date);
    await db.transaction(async () => {
      await unlocked(b.start_date, b.end_date, "holidays");
      await db.insertRows(
        "holidays",
        ["date", "name", "created_by", "created_at"],
        days.map((d) => [d, b.name.trim(), me(res).id, now()]),
        "ON CONFLICT(community_id,date) DO UPDATE SET name=excluded.name",
      );
      await audit(
        me(res),
        "Holiday declared",
        `${b.name.trim()} · ${b.start_date} to ${b.end_date}`,
      );
    });
    res.status(201).json({ ok: true });
  });
  app.post("/api/holidays/:id/delete", async (req, res) => {
    admin(res);
    await db.transaction(async () => {
      const h = await db.get(
        "SELECT * FROM holidays WHERE id=?",
        Number(req.params.id),
      );
      ensure(h, "Holiday not found.", 404);
      await unlocked(h.date, h.date, "holidays");
      await db.run("DELETE FROM holidays WHERE id=?", h.id);
      await audit(me(res), "Holiday removed", `${h.name} · ${h.date}`);
    });
    res.json({ ok: true });
  });

  app.post("/api/leaves/:id/cancel", async (req, res) => {
    const user = me(res);
    await db.transaction(async () => {
      const l = await db.get(
        "SELECT * FROM leaves WHERE id=? AND student_id=?",
        Number(req.params.id),
        user.student_id ?? -1,
      );
      ensure(l, "Leave request not found.", 404);
      ensure(
        l.status === "Pending",
        "Only a pending request can be cancelled.",
        409,
      );
      await db.run("UPDATE leaves SET status='Cancelled' WHERE id=?", l.id);
      await audit(user, "Leave cancelled", `#${l.id}`);
    });
    res.json({ ok: true });
  });

  app.post("/api/leaves/:id/review", async (req, res) => {
    warden(res);
    const user = me(res),
      b = req.body;
    ensure(
      ["Approved", "Rejected"].includes(b.status),
      "Approve or reject the request.",
    );
    ensure(
      b.status === "Approved" || text(b.reason, 500),
      "Give a reason for rejecting the request.",
    );
    ensure(
      b.status === "Rejected" || typeof b.concession === "boolean",
      "Choose whether to give a mess concession.",
    );
    await db.transaction(async () => {
      const l: Row = await db.get(
        "SELECT l.*,s.name,s.joined,s.exited FROM leaves l JOIN students s ON s.id=l.student_id WHERE l.id=?",
        Number(req.params.id),
      );
      ensure(l, "Leave request not found.", 404);
      ensure(
        l.status === "Pending",
        "This request has already been decided.",
        409,
      );
      if (b.status === "Approved") await markLeave(l, user.id);
      await db.run(
        "UPDATE leaves SET status=?,decided_by=?,decision_reason=?,decided_at=?,concession=? WHERE id=?",
        b.status,
        user.id,
        typeof b.reason === "string" ? b.reason.trim().slice(0, 500) : "",
        now(),
        b.status === "Approved" && b.concession === false ? 0 : 1,
        l.id,
      );
      await audit(
        user,
        `Leave ${b.status.toLowerCase()}`,
        `${l.name} · ${l.type} · ${l.start_date} to ${l.end_date}${b.status === "Approved" ? ` · ${b.concession ? "mess concession" : "no mess concession"}` : ""}`,
      );
    });
    res.json({ ok: true });
  });
}

// Students on approved leave on a date; their attendance stays Leave.
export async function onLeave(db: Store, date: string) {
  if (!db.communities) return new Set<number>();
  const rows = await db.all(
    "SELECT student_id FROM leaves WHERE status='Approved' AND start_date<=? AND end_date>=?",
    date,
    date,
  );
  return new Set(rows.map((r) => r.student_id as number));
}

// Holiday dates between two days; no attendance is taken or charged on them.
export async function holidayDates(db: Store, from: string, to: string) {
  if (!db.communities) return new Set<string>();
  const rows = await db.all(
    "SELECT date FROM holidays WHERE date BETWEEN ? AND ?",
    from,
    to,
  );
  return new Set(rows.map((r) => r.date as string));
}

// Approved leave days without a mess concession are charged like present
// days. Returns "studentId|date" keys between two days.
export async function chargedLeaveDays(db: Store, from: string, to: string) {
  const keys = new Set<string>();
  if (!db.communities) return keys;
  const rows = await db.all(
    "SELECT student_id,start_date,end_date FROM leaves WHERE status='Approved' AND concession=0 AND start_date<=? AND end_date>=?",
    to,
    from,
  );
  for (const r of rows)
    for (const d of leaveDays(r.start_date, r.end_date))
      if (d >= from && d <= to) keys.add(`${r.student_id}|${d}`);
  return keys;
}
