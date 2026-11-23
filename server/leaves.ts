import type { Express, Response } from "express";
import { ensure, me, now, text, validDate } from "./http.js";
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

// Students apply for casual or medical leave (medical needs a document as
// proof). A Warden approves or rejects; approved days are marked Leave in
// attendance, so they are never charged as mess days.
export function registerLeaves(app: Express, db: Store, audit: Audit) {
  const warden = (res: Response) =>
    ensure(me(res).role === "Warden", "Only a Warden can decide leave.", 403);
  // Finalized mess months are closed; leave cannot change their attendance.
  const unlocked = async (start: string, end: string) => {
    const months = [
      ...new Set(leaveDays(start, end).map((d) => d.slice(0, 7))),
    ];
    for (const m of months)
      ensure(
        !(await db.get("SELECT period FROM billing_periods WHERE period=?", m)),
        `Mess charges for ${m} are already finalized, so leave cannot include that month.`,
        409,
      );
  };

  app.get("/api/leaves", async (_req, res) => {
    const user = me(res);
    const own = user.role === "Student";
    res.json(
      await db.all(
        `SELECT l.*,s.name,s.code,s.room,d.name AS document_name,u.name AS decided_name
        FROM leaves l JOIN students s ON s.id=l.student_id
        LEFT JOIN documents d ON d.id=l.document_id
        LEFT JOIN users u ON u.id=l.decided_by
        ${own ? "WHERE l.student_id=?" : ""} ORDER BY l.start_date DESC,l.id DESC LIMIT 2000`,
        ...(own ? [user.student_id ?? -1] : []),
      ),
    );
  });

  app.post("/api/leaves", async (req, res) => {
    const user = me(res),
      b = req.body;
    ensure(
      user.role === "Student" && user.student_id,
      "Only admitted students can apply for leave.",
      403,
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
    ensure(text(b.reason, 500), "Give a reason for your leave.");
    ensure(
      b.type === "Casual" || (b.document && typeof b.document === "object"),
      "Medical leave needs a medical document as proof.",
    );
    const student = await db.get(
      "SELECT * FROM students WHERE id=?",
      user.student_id,
    );
    ensure(
      student.status === "Active" &&
        b.start_date >= student.joined &&
        (!student.exited || b.end_date <= student.exited),
      "Leave must fall within your stay in the hostel.",
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
        "You already have leave on some of these days.",
        409,
      );
      await db.run(
        "INSERT INTO leaves (student_id,type,start_date,end_date,reason,document_id,created_at) VALUES (?,?,?,?,?,?,?)",
        student.id,
        b.type,
        b.start_date,
        b.end_date,
        b.reason.trim(),
        documentId,
        now(),
      );
      await audit(
        user,
        "Leave requested",
        `${student.name} · ${b.type} · ${b.start_date} to ${b.end_date}`,
      );
    };
    if (b.type === "Medical")
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
      if (b.status === "Approved") {
        await unlocked(l.start_date, l.end_date);
        const days = leaveDays(l.start_date, l.end_date).filter(
          (d) => d >= l.joined && (!l.exited || d <= l.exited),
        );
        if (days.length)
          await db.insertRows(
            "attendance",
            ["student_id", "date", "status", "recorded_by", "updated_at"],
            days.map((d) => [l.student_id, d, "Leave", user.id, now()]),
            "ON CONFLICT(student_id,date) DO UPDATE SET status='Leave',recorded_by=excluded.recorded_by,updated_at=excluded.updated_at",
          );
      }
      await db.run(
        "UPDATE leaves SET status=?,decided_by=?,decision_reason=?,decided_at=? WHERE id=?",
        b.status,
        user.id,
        typeof b.reason === "string" ? b.reason.trim().slice(0, 500) : "",
        now(),
        l.id,
      );
      await audit(
        user,
        `Leave ${b.status.toLowerCase()}`,
        `${l.name} · ${l.type} · ${l.start_date} to ${l.end_date}`,
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
