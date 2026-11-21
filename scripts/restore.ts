import { readFile } from "node:fs/promises";
import pg from "pg";

// Restore only into an already-migrated, empty database. This never drops tables
// or overwrites a live ledger. Documents and Supabase Auth are restored separately.
const file = process.argv[2];
if (!file || !process.env.DATABASE_URL)
  throw Error(
    "Usage: DATABASE_URL=... npx tsx scripts/restore.ts archive.json",
  );
const archive = JSON.parse(await readFile(file, "utf8"));
if (
  ![1, 2].includes(archive.version) ||
  !Array.isArray(archive.students) ||
  !Array.isArray(archive.users)
)
  throw Error("Unsupported archive");
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.SUPABASE_DB_CA
    ? { ca: process.env.SUPABASE_DB_CA, rejectUnauthorized: true }
    : undefined,
});
await client.connect();
try {
  await client.query("BEGIN");
  // Refuse a partial RLS-filtered view when checking whether the database is empty.
  // Community restores require a database administrator with BYPASSRLS.
  await client.query("SET LOCAL row_security=off");
  await client.query("SELECT pg_advisory_xact_lock(3602026)");
  const communitySchema = !!(
    await client.query("SELECT to_regclass('hostel360.communities') AS name")
  ).rows[0].name;
  if (archive.version === 2 && !communitySchema)
    throw Error(
      "Apply the communities migration before restoring this archive.",
    );
  const tables = [
    "students",
    "users",
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
  ];
  const gatewaySchema = !!(
    await client.query("SELECT to_regclass('hostel360.gateway_orders') AS name")
  ).rows[0].name;
  if (archive.gateway_orders && !gatewaySchema)
    throw Error(
      "Apply the payment gateway migration before restoring this archive.",
    );
  if (gatewaySchema) tables.push("gateway_orders");
  const refundSchema = !!(
    await client.query(
      "SELECT to_regclass('hostel360.gateway_refunds') AS name",
    )
  ).rows[0].name;
  if (archive.gateway_refunds && !refundSchema)
    throw Error(
      "Apply the payment recovery migration before restoring this archive.",
    );
  if (refundSchema) tables.push("gateway_refunds");
  for (const table of tables) {
    if (
      Number(
        (await client.query(`SELECT count(*) AS count FROM hostel360.${table}`))
          .rows[0].count,
      )
    )
      throw Error(
        "Restore requires an empty database; existing records will not be overwritten.",
      );
  }
  if (communitySchema) {
    const c = archive.community || {
      id: 1,
      code: "restored-legacy",
      name: "Restored hostel",
    };
    if (
      !Number.isSafeInteger(c.id) ||
      c.id < 1 ||
      typeof c.code !== "string" ||
      typeof c.name !== "string"
    )
      throw Error("Invalid archive community");
    await client.query(
      "INSERT INTO hostel360.communities (id,code,name,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET code=excluded.code,name=excluded.name",
      [c.id, c.code, c.name, archive.created_at],
    );
    await client.query("SELECT set_config('app.community_id',$1,true)", [
      String(c.id),
    ]);
    for (const u of archive.users) {
      const identity = u.identity_id || u.auth_id || `legacy-${u.id}`;
      await client.query(
        "INSERT INTO hostel360.identities (id,email,password,auth_id) VALUES ($1,$2,'disabled',$3)",
        [identity, u.email.toLowerCase(), u.auth_id],
      );
      u.identity_id = identity;
    }
    for (const table of ["settings", ...tables]) {
      for (const row of archive[table] || []) {
        if (row.community_id !== undefined && row.community_id !== c.id)
          throw Error("Archive contains records from another community");
        row.community_id = c.id;
      }
    }
    await client.query(
      "SELECT setval(pg_get_serial_sequence('hostel360.communities','id'),(SELECT MAX(id) FROM hostel360.communities))",
    );
  }
  for (const table of ["settings", ...tables]) {
    const allowed = new Set(
      (
        await client.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='hostel360' AND table_name=$1",
          [table],
        )
      ).rows.map((r) => r.column_name),
    );
    for (const source of archive[table] || []) {
      const row =
        table === "users" ? { ...source, password: "supabase" } : source;
      const keys = Object.keys(row);
      if (keys.some((k) => !allowed.has(k)))
        throw Error(`Unexpected archive column in ${table}`);
      await client.query(
        `INSERT INTO hostel360.${table} (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) ${table === "settings" ? `ON CONFLICT(${communitySchema ? "community_id," : ""}key) DO UPDATE SET value=excluded.value` : ""}`,
        Object.values(row),
      );
    }
    if (
      allowed.has("id") &&
      !["gateway_orders", "gateway_refunds"].includes(table)
    )
      await client.query(
        `SELECT setval(pg_get_serial_sequence('hostel360.${table}','id'),COALESCE((SELECT MAX(id) FROM hostel360.${table}),1),(SELECT COUNT(*)>0 FROM hostel360.${table}))`,
      );
  }
  await client.query("COMMIT");
  console.log(
    `Restored ${archive.students.length} students and ${archive.payments.length} payments. No sessions or passwords were restored.`,
  );
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  await client.end();
}
