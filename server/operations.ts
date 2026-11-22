import type { Express } from "express";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import { hashPassword } from "./db.js";
import { archive, saveBackup } from "./backup.js";
import { type Store, type Row } from "./store.js";
import {
  ensure,
  today,
  now,
  validDate,
  validMonth,
  integer,
  text,
  me,
  staff,
  admin,
  supabase,
  categories,
} from "./http.js";

type Services = {
  db: Store;
  audit: (
    actor: { name: string },
    action: string,
    detail: string,
  ) => Promise<void>;
  demands: (id?: number) => Promise<Row[]>;
  payments: (id?: number) => Promise<Row[]>;
  settings: () => Promise<Record<string, string>>;
};
// Hostel details a student gives once, either with their join request or
// later from My application. Staff decide on it with a room in one step.
const phonePattern = /^\+?[\d\s-]{10,15}$/;
export function applicationInput(b: Row) {
  for (const key of ["name", "department", "phone", "guardian"])
    ensure(
      text(b[key]),
      `A valid ${key === "guardian" ? "parent name" : key} is required.`,
    );
  ensure(phonePattern.test(b.phone), "Enter a valid phone number.");
  ensure(
    typeof b.guardian_phone === "string" && phonePattern.test(b.guardian_phone),
    "Enter a valid parent phone number.",
  );
  ensure(
    Number.isInteger(b.year) && b.year >= 1 && b.year <= 6,
    "Year must be between 1 and 6.",
  );
  ensure(
    ["Fresher", "Existing"].includes(b.admission_type),
    "Select a valid admission type.",
  );
  ensure(
    text(b.email) &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email) &&
      text(b.course) &&
      /^20\d{2}-20\d{2}$/.test(b.academic_year) &&
      text(b.address, 1000),
    "Enter a valid email, course, academic year (YYYY-YYYY) and address.",
  );
}
export async function submitApplication(
  db: Store,
  audit: Services["audit"],
  b: Row,
  userId: number | null,
  actor: { name: string },
) {
  applicationInput(b);
  ensure(
    !userId ||
      !(await db.get("SELECT id FROM applications WHERE user_id=?", userId)),
    "You have already submitted an application.",
    409,
  );
  const r = await db.get(
    "INSERT INTO applications (user_id,name,roll,email,phone,department,course,year,academic_year,guardian,guardian_phone,address,admission_type,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
    userId,
    b.name.trim(),
    // College IDs are no longer collected; the hostel code identifies people.
    "",
    b.email.toLowerCase().trim(),
    b.phone,
    b.department,
    b.course,
    b.year,
    b.academic_year,
    b.guardian,
    b.guardian_phone.trim(),
    b.address,
    b.admission_type,
    now(),
  );
  await audit(actor, "Application submitted", `#${r.id} · ${b.name}`);
  return r;
}
export function registerOperations(
  app: Express,
  { db, audit, demands, payments, settings }: Services,
) {
  function studentInput(b: Row) {
    for (const key of ["name", "department", "room", "phone", "guardian"])
      ensure(
        text(b[key]),
        `A valid ${key === "guardian" ? "parent name" : key} is required.`,
      );
    ensure(
      b.roll === undefined || b.roll === null || typeof b.roll === "string",
      "Invalid roll.",
    );
    ensure(/^\+?[\d\s-]{10,15}$/.test(b.phone), "Enter a valid phone number.");
    ensure(
      Number.isInteger(b.year) && b.year >= 1 && b.year <= 6,
      "Year must be between 1 and 6.",
    );
    ensure(
      ["Fresher", "Existing"].includes(b.admission_type),
      "Select a valid admission type.",
    );
    ensure(
      validDate(b.joined) && b.joined <= today(),
      "Enter a valid joining date, not in the future.",
    );
    ensure(
      !b.guardian_phone || phonePattern.test(b.guardian_phone),
      "Enter a valid parent phone number.",
    );
    for (const key of ["course", "academic_year", "guardian_phone", "address"])
      ensure(
        b[key] === undefined ||
          (typeof b[key] === "string" &&
            b[key].length <= (key === "address" ? 1000 : 120)),
        `Invalid ${key}.`,
      );
  }
  async function addStudent(b: Row, actor: { name: string }) {
    studentInput(b);
    const [next] = await db.studentIds(1);
    const code = `H360-${String(next).padStart(4, "0")}`;
    // The roll column stays unique; without a college ID it holds the code.
    const roll = (b.roll || "").trim() || code;
    ensure(
      !(await db.get(
        "SELECT id FROM students WHERE lower(roll)=lower(?)",
        roll,
      )),
      "This student is already registered.",
      409,
    );
    await db.run(
      "INSERT INTO students (id,code,roll,name,department,year,room,phone,guardian,admission_type,joined,course,academic_year,address,guardian_phone) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      next,
      code,
      roll,
      b.name.trim(),
      b.department.trim(),
      b.year,
      b.room.trim(),
      b.phone.trim(),
      b.guardian.trim(),
      b.admission_type,
      b.joined,
      b.course || "B.E.",
      b.academic_year || "",
      b.address || "",
      b.guardian_phone || "",
    );
    await db.run(
      "INSERT INTO room_history (student_id,room,started,reason) VALUES (?,?,?,'Initial admission')",
      next,
      b.room.trim(),
      b.joined,
    );
    await audit(actor, "Student registered", `${b.name} · ${code}`);
    return next;
  }
  app.post("/api/students", async (req, res) => {
    staff(res);
    const id = await db.transaction(() => addStudent(req.body, me(res)));
    res.status(201).json({ id });
  });
  app.post("/api/students/:id/update", async (req, res) => {
    staff(res);
    const b = req.body;
    ensure(text(b.reason, 500), "Explain why the student record is changing.");
    await db.transaction(async () => {
      const s = await db.get(
        "SELECT * FROM students WHERE id=?",
        Number(req.params.id),
      );
      ensure(s, "Student not found.", 404);
      const updated = {
        ...s,
        ...b,
        joined: s.joined,
        roll: s.roll,
        admission_type: s.admission_type,
      };
      studentInput(updated);
      ensure(
        ["Active", "Left", "Graduated"].includes(b.status),
        "Select a valid status.",
      );
      ensure(
        s.status === "Active" || b.status === s.status,
        "A closed admission cannot be reopened.",
      );
      let exited = s.exited;
      if (s.status === "Active" && b.status !== "Active") {
        admin(res);
        ensure(
          validDate(b.exited) && b.exited >= s.joined && b.exited <= today(),
          "Choose a valid exit date.",
        );
        exited = b.exited;
        ensure(
          !(await db.get(
            "SELECT student_id FROM attendance WHERE student_id=? AND date>? LIMIT 1",
            s.id,
            exited,
          )),
          "Attendance exists after the exit date. Resolve it before closing this admission.",
        );
      }
      if (s.room !== updated.room) {
        ensure(
          s.status === "Active" && b.status === "Active",
          "Only active residents can move rooms.",
        );
        await db.run(
          "UPDATE room_history SET ended=? WHERE student_id=? AND ended IS NULL",
          today(),
          s.id,
        );
        await db.run(
          "INSERT INTO room_history (student_id,room,started,reason) VALUES (?,?,?,?)",
          s.id,
          updated.room,
          today(),
          b.reason,
        );
      }
      await db.run(
        "UPDATE students SET name=?,department=?,year=?,room=?,phone=?,guardian=?,course=?,academic_year=?,address=?,guardian_phone=?,status=?,exited=?,exit_reason=? WHERE id=?",
        updated.name,
        updated.department,
        updated.year,
        updated.room,
        updated.phone,
        updated.guardian,
        updated.course,
        updated.academic_year,
        updated.address,
        updated.guardian_phone,
        b.status,
        exited,
        b.status === "Active" ? s.exit_reason : b.reason,
        s.id,
      );
      if (b.status !== "Active")
        await db.run(
          "UPDATE room_history SET ended=? WHERE student_id=? AND ended IS NULL",
          exited,
          s.id,
        );
      await audit(
        me(res),
        "Student record updated",
        `${s.code} · ${JSON.stringify({ before: s, after: updated, status: b.status, exited, reason: b.reason })}`,
      );
    });
    res.json({ ok: true });
  });
  app.get("/api/students/:id/history", async (req, res) => {
    const id = Number(req.params.id);
    ensure(
      me(res).role !== "Student" || id === me(res).student_id,
      "Student not found.",
      404,
    );
    res.json({
      rooms: await db.all(
        "SELECT * FROM room_history WHERE student_id=? ORDER BY id DESC",
        id,
      ),
      documents: await db.all(
        "SELECT id,name,mime,bytes,created_at FROM documents WHERE student_id=? ORDER BY id DESC",
        id,
      ),
      attendance: await db.all(
        "SELECT date,status FROM attendance WHERE student_id=? ORDER BY date DESC LIMIT 366",
        id,
      ),
    });
  });
  app.get("/api/applications", async (_req, res) => {
    const user = me(res);
    res.json(
      await db.all(
        `SELECT * FROM applications ${user.role === "Student" ? "WHERE user_id=?" : ""} ORDER BY id DESC`,
        ...(user.role === "Student" ? [user.id] : []),
      ),
    );
  });
  app.post("/api/applications", async (req, res) => {
    const user = me(res),
      applicant = user.role === "Student";
    ensure(!applicant || !user.student_id, "You are already admitted.", 409);
    const b = { ...req.body, ...(applicant ? { email: user.email } : {}) };
    const result = await db.transaction(() =>
      submitApplication(db, audit, b, applicant ? user.id : null, me(res)),
    );
    res.status(201).json(result);
  });
  app.post("/api/applications/:id/review", async (req, res) => {
    staff(res);
    const b = req.body;
    // One decision: the Admin assigns a room and approves, or rejects.
    ensure(
      ["Approved", "Rejected"].includes(b.status),
      "Choose approve or reject.",
    );
    admin(res);
    const result = await db.transaction(async () => {
      const a = await db.get(
        "SELECT * FROM applications WHERE id=?",
        Number(req.params.id),
      );
      ensure(a, "Application not found.", 404);
      ensure(
        a.status === "Submitted" || a.status === "Under Review",
        "This application has already been decided.",
        409,
      );
      let sid = null;
      if (b.status === "Approved")
        sid = await addStudent(
          { ...a, roll: a.roll || "", room: b.room, joined: b.joined },
          me(res),
        );
      if (b.status === "Rejected")
        ensure(text(b.reason, 500), "Give a reason for rejection.");
      if (sid && a.user_id)
        await db.run(
          "UPDATE users SET student_id=? WHERE id=?",
          sid,
          a.user_id,
        );
      // A join request carries this application: the same decision settles
      // community membership, so the student is approved exactly once.
      if (db.communities && a.user_id)
        await db.run(
          "UPDATE users SET membership_status=?,membership_reason=?,active=1 WHERE id=? AND membership_status='Pending'",
          b.status,
          b.status === "Rejected" ? b.reason.trim() : "",
          a.user_id,
        );
      await db.run(
        "UPDATE applications SET status=?,reason=?,student_id=? WHERE id=?",
        b.status,
        typeof b.reason === "string" ? b.reason.slice(0, 500) : "",
        sid,
        a.id,
      );
      await audit(
        me(res),
        `Application ${b.status.toLowerCase()}`,
        `#${a.id} · ${b.reason || b.room}`,
      );
      return { student_id: sid };
    });
    res.json(result);
  });
  app.get("/api/components", async (_req, res) => {
    staff(res);
    res.json(
      await db.all(
        "SELECT * FROM fee_components ORDER BY academic_year DESC,category,name",
      ),
    );
  });
  app.post("/api/components", async (req, res) => {
    admin(res);
    const b = req.body;
    ensure(
      categories.slice(1).includes(b.category) &&
        text(b.name) &&
        integer(b.amount) &&
        /^20\d{2}-20\d{2}$/.test(b.academic_year) &&
        ["All", "Fresher", "Existing", "B.E."].includes(b.applicability),
      "Enter category, name, amount, academic year and applicability.",
    );
    ensure([0, 1].includes(b.active), "Choose an active status.");
    const applicability = /caution/i.test(b.name)
      ? "Fresher"
      : b.category === "Management" && /application/i.test(b.name)
        ? "B.E."
        : b.applicability;
    await db.transaction(async () => {
      if (b.id) {
        ensure(
          await db.get("SELECT id FROM fee_components WHERE id=?", b.id),
          "Fee component not found.",
          404,
        );
        await db.run(
          "UPDATE fee_components SET category=?,name=?,amount=?,academic_year=?,applicability=?,active=? WHERE id=?",
          b.category,
          b.name.trim(),
          b.amount,
          b.academic_year,
          applicability,
          b.active,
          b.id,
        );
      } else
        await db.run(
          "INSERT INTO fee_components (category,name,amount,academic_year,applicability,active) VALUES (?,?,?,?,?,?)",
          b.category,
          b.name.trim(),
          b.amount,
          b.academic_year,
          applicability,
          b.active,
        );
      await audit(
        me(res),
        "Fee component configured",
        `${b.category} · ${b.name} · ${b.academic_year} · ${b.amount / 100} INR · ${applicability}`,
      );
    });
    res.json({ ok: true });
  });
  const admissionPreview = async (b: Row) => {
    ensure(
      /^20\d{2}-20\d{2}$/.test(b.academic_year) &&
        validMonth(b.period) &&
        Array.isArray(b.student_ids) &&
        b.student_ids.length > 0 &&
        b.student_ids.length <= 5000 &&
        b.student_ids.every(integer) &&
        new Set(b.student_ids).size === b.student_ids.length,
      "Select academic year, billing month and students.",
    );
    const components = await db.all(
      "SELECT * FROM fee_components WHERE active=1 AND academic_year=? ORDER BY id",
      b.academic_year,
    );
    const students = await db.all(
        "SELECT * FROM students WHERE status='Active' ORDER BY id",
      ),
      existing = await db.all(
        "SELECT student_id,category,description FROM demands WHERE category<>'Mess'",
      );
    const issued = new Set(
      existing.map((d) =>
        JSON.stringify([d.student_id, d.category, d.description]),
      ),
    );
    const studentMap = new Map(students.map((s) => [s.id, s]));
    const rows: Row[] = [];
    for (const id of b.student_ids) {
      const s = studentMap.get(id);
      ensure(s, "Choose active students only.");
      for (const c of components) {
        if (
          c.applicability !== "All" &&
          c.applicability !== s.admission_type &&
          c.applicability !== s.course
        )
          continue;
        const description = `${b.academic_year} · ${c.name}`;
        if (issued.has(JSON.stringify([id, c.category, description]))) continue;
        rows.push({
          student_id: id,
          name: s.name,
          category: c.category,
          description,
          amount: c.amount,
          period: b.period,
        });
      }
    }
    return { rows, total: rows.reduce((sum, r) => sum + r.amount, 0) };
  };
  app.post("/api/admission/preview", async (req, res) => {
    admin(res);
    res.json(await admissionPreview(req.body));
  });
  app.post("/api/admission/finalize", async (req, res) => {
    admin(res);
    await db.transaction(async () => {
      const p = await admissionPreview(req.body);
      ensure(
        p.rows.length,
        "No new applicable charges. Existing demands are never issued twice.",
      );
      ensure(
        JSON.stringify(p.rows) === JSON.stringify(req.body.expected_rows),
        "Fees or students changed. Preview again.",
        409,
      );
      await db.insertRows(
        "demands",
        [
          "student_id",
          "category",
          "period",
          "description",
          "amount",
          "finalized_by",
          "created_at",
        ],
        p.rows.map((r) => [
          r.student_id,
          r.category,
          r.period,
          r.description,
          r.amount,
          me(res).id,
          now(),
        ]),
      );
      await audit(
        me(res),
        "Admission fees finalized",
        `${req.body.academic_year} · ${p.rows.length} charges · ${p.total / 100} INR`,
      );
    });
    res.status(201).json({ ok: true });
  });
  app.get("/api/accounts", async (_req, res) => {
    admin(res);
    res.json(
      await db.all(
        "SELECT id,name,email,role,student_id,active,must_change_password FROM users ORDER BY id",
      ),
    );
  });
  app.post("/api/accounts", async (req, res) => {
    admin(res);
    const b = req.body;
    ensure(
      text(b.name) &&
        text(b.email) &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email) &&
        ["Admin", "Manager", "Student"].includes(b.role) &&
        text(b.password, 200) &&
        b.password.length >= 12,
      "Provide name, email, role and temporary password (12+ characters).",
    );
    if (b.role === "Student" && b.student_id != null)
      ensure(
        integer(b.student_id) &&
          (await db.get("SELECT id FROM students WHERE id=?", b.student_id)),
        "Select a student to link.",
      );
    const email = b.email.toLowerCase().trim();
    let authId: string | null = null;
    ensure(
      !(await db.get("SELECT id FROM users WHERE email=?", email)),
      "This email already has an account.",
      409,
    );
    if (process.env.SUPABASE_URL) {
      const result = await supabase().auth.admin.createUser({
        email,
        password: b.password,
        email_confirm: true,
      });
      ensure(
        !result.error && result.data.user,
        "Unable to create this account in Supabase Auth.",
      );
      authId = result.data.user.id;
    }
    try {
      await db.transaction(async () => {
        await db.run(
          "INSERT INTO users (name,email,password,role,student_id,auth_id,must_change_password) VALUES (?,?,?,?,?,?,1)",
          b.name.trim(),
          email,
          authId ? "supabase" : hashPassword(b.password),
          b.role,
          b.role === "Student" ? (b.student_id ?? null) : null,
          authId,
        );
        await audit(me(res), "Account created", `${email} · ${b.role}`);
      });
    } catch (e) {
      if (authId) await supabase().auth.admin.deleteUser(authId);
      throw e;
    }
    res.status(201).json({ ok: true });
  });
  app.post("/api/accounts/:id", async (req, res) => {
    admin(res);
    const id = Number(req.params.id),
      b = req.body;
    ensure(
      id !== me(res).id,
      "Use My account for your own password; another administrator must change your access.",
    );
    await db.transaction(async () => {
      const u = await db.get("SELECT * FROM users WHERE id=?", id);
      ensure(u, "Account not found.", 404);
      if (b.password) {
        ensure(
          text(b.password, 200) && b.password.length >= 12,
          "Use at least 12 characters.",
        );
        if (u.auth_id) {
          const r = await supabase().auth.admin.updateUserById(u.auth_id, {
            password: b.password,
          });
          ensure(!r.error, "Supabase password reset failed.");
        } else
          await db.run(
            "UPDATE users SET password=? WHERE id=?",
            hashPassword(b.password),
            id,
          );
        await db.run("UPDATE users SET must_change_password=1 WHERE id=?", id);
      } else {
        ensure([0, 1].includes(b.active), "Choose an account status.");
        await db.run("UPDATE users SET active=? WHERE id=?", b.active, id);
      }
      await db.run("DELETE FROM sessions WHERE user_id=?", id);
      await audit(
        me(res),
        b.password ? "Password reset" : "Account access changed",
        `${u.email} · ${b.password ? "Temporary password issued" : b.active ? "Enabled" : "Disabled"}`,
      );
    });
    res.json({ ok: true });
  });
  app.post("/api/students/:id/documents", async (req, res) => {
    staff(res);
    const id = Number(req.params.id),
      b = req.body;
    ensure(
      await db.get("SELECT id FROM students WHERE id=?", id),
      "Student not found.",
      404,
    );
    ensure(
      text(b.name, 200) &&
        typeof b.content === "string" &&
        b.content.length <= 2_800_000,
      "Select a PDF, JPEG or PNG smaller than 2 MB.",
    );
    const bytes = Buffer.from(b.content, "base64");
    const mime =
      bytes.subarray(0, 5).toString() === "%PDF-"
        ? "application/pdf"
        : bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          ? "image/png"
          : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            ? "image/jpeg"
            : "";
    ensure(
      mime && bytes.length <= 2_000_000,
      "Only PDF, PNG and JPEG files up to 2 MB are accepted.",
    );
    const path = `${db.communities ? `communities/${db.communityId}/` : ""}${id}/${randomUUID()}`;
    const storage = supabase().storage.from("student-documents");
    const upload = await storage.upload(path, bytes, {
      contentType: mime,
      upsert: false,
    });
    ensure(!upload.error, "Document upload failed. Please try again.");
    try {
      await db.transaction(async () => {
        await db.run(
          "INSERT INTO documents (student_id,name,path,mime,bytes,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?)",
          id,
          b.name,
          path,
          mime,
          bytes.length,
          me(res).id,
          now(),
        );
        await audit(me(res), "Document uploaded", `Student #${id} · ${b.name}`);
      });
    } catch (e) {
      await storage.remove([path]);
      throw e;
    }
    res.status(201).json({ ok: true });
  });
  app.get("/api/documents/:id", async (req, res) => {
    const d = await db.get(
      "SELECT * FROM documents WHERE id=?",
      Number(req.params.id),
    );
    ensure(
      d && (me(res).role !== "Student" || d.student_id === me(res).student_id),
      "Document not found.",
      404,
    );
    const r = await supabase()
      .storage.from("student-documents")
      .createSignedUrl(d.path, 60, { download: d.name });
    ensure(!r.error && r.data, "Could not open document.");
    res.json({ url: r.data.signedUrl });
  });

  async function validateImport(kind: string, rows: Row[]) {
    const errors: { row: number; error: string }[] = [],
      seen = new Set<string>();
    const students = await db.all("SELECT id,roll FROM students");
    const rolls = new Set(students.map((s) => s.roll.toLowerCase()));
    const existing =
      kind === "balances"
        ? new Set(
            (
              await db.all(
                "SELECT s.roll,d.category,d.period,d.description FROM demands d JOIN students s ON s.id=d.student_id WHERE d.description LIKE 'Opening balance · %'",
              )
            ).map((d) =>
              JSON.stringify([d.roll, d.category, d.period, d.description]),
            ),
          )
        : new Set();
    for (const [index, r] of rows.entries()) {
      try {
        if (kind === "students") {
          studentInput(r);
          const key = r.roll.trim().toLowerCase();
          ensure(
            !seen.has(key) && !rolls.has(key),
            "Duplicate college roll number.",
          );
          seen.add(key);
        } else {
          ensure(
            text(r.roll) && students.some((s) => s.roll === r.roll),
            "College roll does not match a registered student.",
          );
          ensure(
            categories.includes(r.category) &&
              validMonth(r.period) &&
              integer(r.amount) &&
              text(r.description),
            "Category, period (YYYY-MM), positive amount in paise and description are required.",
          );
          const key = JSON.stringify([
            r.roll,
            r.category,
            r.period,
            r.description,
          ]);
          ensure(!seen.has(key), "Duplicate opening balance row.");
          seen.add(key);
          ensure(
            !existing.has(
              JSON.stringify([
                r.roll,
                r.category,
                r.period,
                `Opening balance · ${r.description}`,
              ]),
            ),
            "This opening balance already exists.",
          );
        }
      } catch (e) {
        errors.push({
          row: index + 2,
          error: e instanceof Error ? e.message : "Invalid row",
        });
      }
    }
    return errors;
  }
  app.post("/api/imports/preview", async (req, res) => {
    admin(res);
    const { kind, rows } = req.body;
    ensure(
      ["students", "balances"].includes(kind) &&
        Array.isArray(rows) &&
        rows.length > 0 &&
        rows.length <= 5000 &&
        rows.every((r) => r && typeof r === "object" && !Array.isArray(r)),
      "Choose a non-empty workbook with at most 5,000 rows.",
    );
    const errors = await validateImport(kind, rows);
    const batch = await db.get(
      "INSERT INTO import_batches (actor_id,kind,rows_json,errors_json,created_at) VALUES (?,?,?,?,?) RETURNING id",
      me(res).id,
      kind,
      JSON.stringify(rows),
      JSON.stringify(errors),
      now(),
    );
    res.json({ id: batch.id, rows, errors, count: rows.length });
  });
  app.post("/api/imports/:id/commit", async (req, res) => {
    admin(res);
    const count = await db.transaction(async () => {
      const batch = await db.get(
        "SELECT * FROM import_batches WHERE id=? AND actor_id=?",
        Number(req.params.id),
        me(res).id,
      );
      ensure(batch, "Import preview not found.", 404);
      ensure(!batch.committed_at, "This batch was already imported.", 409);
      const rows: Row[] = JSON.parse(batch.rows_json),
        errors = await validateImport(batch.kind, rows);
      ensure(
        !errors.length,
        "Fix all errors and preview the workbook again. No rows were imported.",
        409,
      );
      if (batch.kind === "students") {
        const ids = await db.studentIds(rows.length);
        await db.insertRows(
          "students",
          [
            "id",
            "code",
            "roll",
            "name",
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
          rows.map((r, i) => [
            ids[i],
            `H360-${String(ids[i]).padStart(4, "0")}`,
            r.roll.trim(),
            r.name.trim(),
            r.department.trim(),
            r.year,
            r.room.trim(),
            r.phone.trim(),
            r.guardian.trim(),
            r.admission_type,
            r.joined,
            r.course || "B.E.",
            r.academic_year || "",
            r.address || "",
            r.guardian_phone || "",
          ]),
        );
        await db.insertRows(
          "room_history",
          ["student_id", "room", "started", "reason"],
          rows.map((r, i) => [
            ids[i],
            r.room.trim(),
            r.joined,
            `Imported · batch ${batch.id}`,
          ]),
        );
      } else {
        const students = new Map(
          (await db.all("SELECT id,roll FROM students")).map((s) => [
            s.roll,
            s.id,
          ]),
        );
        await db.insertRows(
          "demands",
          [
            "student_id",
            "category",
            "period",
            "description",
            "amount",
            "finalized_by",
            "created_at",
          ],
          rows.map((r) => [
            students.get(r.roll),
            r.category,
            r.period,
            `Opening balance · ${r.description}`,
            r.amount,
            me(res).id,
            now(),
          ]),
        );
      }
      await db.run(
        "UPDATE import_batches SET committed_at=? WHERE id=?",
        now(),
        batch.id,
      );
      await audit(
        me(res),
        "Import committed",
        `Batch #${batch.id} · ${batch.kind} · ${rows.length} rows`,
      );
      return rows.length;
    });
    res.json({ count });
  });
  app.get("/api/reports", async (req, res) => {
    staff(res);
    ensure(
      validDate(req.query.from) &&
        validDate(req.query.to) &&
        req.query.from <= req.query.to,
      "Select a valid report date range.",
    );
    const ds = await demands(),
      ps = (await payments()).filter(
        (p) =>
          p.date >= String(req.query.from) && p.date <= String(req.query.to),
      );
    const active = ps.filter((p) => !p.reversed_at),
      total = active.reduce((s, p) => s + p.amount - p.refunded_amount, 0);
    res.json({
      from: req.query.from,
      to: req.query.to,
      payments: ps,
      outstanding: ds.filter((d) => d.balance > 0),
      total,
      modes: ["Cash", "UPI", "Bank", "Card"].map((mode) => ({
        mode,
        amount: active
          .filter((p) => p.mode === mode)
          .reduce((s, p) => s + p.amount - p.refunded_amount, 0),
      })),
      categories: categories.map((category) => {
        const list = ds.filter((d) => d.category === category);
        return {
          category,
          demand: list.reduce((s, d) => s + d.amount + d.adjustment, 0),
          collected: list.reduce((s, d) => s + d.collected, 0),
          balance: list.reduce((s, d) => s + d.balance, 0),
        };
      }),
    });
  });
  app.get("/api/export/:kind", async (req, res) => {
    staff(res);
    const kind = req.params.kind;
    ensure(
      ["students", "payments", "outstanding", "audit"].includes(String(kind)),
      "Unknown export.",
    );
    const rows =
      kind === "students"
        ? await db.all("SELECT * FROM students ORDER BY name")
        : kind === "payments"
          ? await payments()
          : kind === "outstanding"
            ? (await demands()).filter((d) => d.balance > 0)
            : await db.all("SELECT * FROM audit ORDER BY id DESC");
    const book = new ExcelJS.Workbook();
    book.creator = "JSS PDA Hostel";
    const sheet = book.addWorksheet(String(kind));
    const keys = rows.length ? Object.keys(rows[0]) : ["No records"];
    sheet.columns = keys.map((key) => ({ header: key, key, width: 24 }));
    sheet.addRows(rows);
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    res.set({
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="jss-pda-${kind}.xlsx"`,
    });
    res.send(Buffer.from(await book.xlsx.writeBuffer()));
  });
  app.get("/api/backup", async (_req, res) => {
    admin(res);
    const data = await archive(db);
    await audit(
      me(res),
      "Data export downloaded",
      "JSON archive excludes passwords and sessions; document metadata only, files remain in private Storage.",
    );
    res
      .set(
        "Content-Disposition",
        `attachment; filename="jss-pda-export-${today()}.json"`,
      )
      .json(data);
  });
  app.get("/api/backups", async (_req, res) => {
    admin(res);
    const r = await supabase()
      .storage.from("finance-backups")
      .list(db.backupFolder, {
        limit: 100,
        sortBy: { column: "name", order: "desc" },
      });
    ensure(!r.error, "Could not list backups.", 503);
    res.json(r.data);
  });
  app.post("/api/backups", async (_req, res) => {
    admin(res);
    res.status(201).json(await saveBackup(db));
  });
  app.get("/api/backups/:name", async (req, res) => {
    admin(res);
    ensure(
      /^[\dTZ.\-]+\.json$/.test(String(req.params.name)),
      "Invalid backup name.",
    );
    const r = await supabase()
      .storage.from("finance-backups")
      .createSignedUrl(`${db.backupFolder}/${req.params.name}`, 60, {
        download: true,
      });
    ensure(!r.error && r.data, "Could not download backup.");
    res.json({ url: r.data.signedUrl });
  });
}
