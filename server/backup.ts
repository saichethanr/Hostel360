import type { Store, Row } from "./store.js";
import { now, supabase, ensure } from "./http.js";

export async function archive(db: Store) {
  return db.transaction(async () => {
    const data: Row = { version: db.communities ? 2 : 1, created_at: now() };
    if (db.communities)
      data.community = await db.get(
        "SELECT id,code,name FROM communities WHERE id=?",
        db.communityId,
      );
    for (const table of [
      "settings",
      "students",
      "attendance",
      "demands",
      "payments",
      "allocations",
      "receipt_sequences",
      "audit",
      "applications",
      "fee_components",
      "room_history",
      "documents",
      "billing_periods",
      "import_batches",
    ]) {
      data[table] = await db.all(`SELECT * FROM ${table}`);
    }
    if (
      db.communities &&
      (await db.get("SELECT to_regclass('hostel360.gateway_orders') AS name"))
        .name
    )
      data.gateway_orders = await db.all("SELECT * FROM gateway_orders");
    if (
      db.communities &&
      (await db.get("SELECT to_regclass('hostel360.gateway_refunds') AS name"))
        .name
    )
      data.gateway_refunds = await db.all("SELECT * FROM gateway_refunds");
    data.users = await db.all(
      `SELECT id,name,email,role,student_id,active,auth_id,must_change_password${db.communities ? ",community_id,identity_id,membership_status,membership_reason" : ""} FROM users`,
    );
    return data;
  });
}

export async function saveBackup(db: Store) {
  const data = await archive(db);
  const path = `${db.backupFolder}/${now().replaceAll(":", "-")}.json`;
  const result = await supabase()
    .storage.from("finance-backups")
    .upload(path, JSON.stringify(data), {
      contentType: "application/json",
      upsert: false,
    });
  ensure(!result.error, "Backup upload failed.", 503);
  await db.run(
    "INSERT INTO audit (actor,action,detail,created_at) VALUES ('System','Backup saved',?,?)",
    path,
    now(),
  );
  return { path, created_at: data.created_at };
}
