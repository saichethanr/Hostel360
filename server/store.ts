import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import pg, { type PoolClient } from "pg";

export type Row = Record<string, any>;
pg.types.setTypeParser(20, Number);
const tables =
  "students|users|sessions|attendance|demands|payments|allocations|receipt_sequences|settings|audit|applications|fee_components|room_history|documents|import_batches|billing_periods|login_attempts|communities|identities|onboarding_attempts|gateway_orders|gateway_refunds|leaves|sponsors|sponsor_contributions|sponsor_grants|sponsor_listings|sponsor_files|sponsor_orders";

// Both adapters execute the same statements. A transaction owns its connection;
// no request can accidentally execute inside another request's transaction.
export class Store {
  private context = new AsyncLocalStorage<PoolClient | DatabaseSync>();
  private community = new AsyncLocalStorage<number>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    public source: DatabaseSync | pg.Pool,
    public communities = false,
  ) {}
  get communityId() {
    return this.community.getStore();
  }
  inCommunity<T>(id: number, fn: () => T): T {
    return this.community.run(id, fn);
  }
  key(column: string) {
    return this.communities ? `community_id,${column}` : column;
  }
  get backupFolder() {
    return this.communityId === 1 || !this.communities
      ? "daily"
      : `communities/${this.communityId}/daily`;
  }
  async studentIds(count: number) {
    if (this.source instanceof pg.Pool) {
      const rows = await this.all(
        "SELECT nextval(pg_get_serial_sequence('hostel360.students','id')) AS id FROM generate_series(1,?)",
        count,
      );
      return rows.map((r) => Number(r.id));
    }
    const first = (
      await this.get("SELECT COALESCE(MAX(id),0)+1 AS id FROM students")
    ).id;
    return Array.from({ length: count }, (_, i) => first + i);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => undefined);
    return result;
  }
  async all(sql: string, ...args: any[]): Promise<Row[]> {
    const current = this.context.getStore();
    if (this.source instanceof pg.Pool) {
      let index = 0;
      sql = sql
        .replace(/\?/g, () => `$${++index}`)
        .replace(
          new RegExp(
            `\\b(FROM|JOIN|INTO|UPDATE|TABLE)\\s+(${tables})\\b`,
            "gi",
          ),
          "$1 hostel360.$2",
        );
      if (!this.communities)
        return (await ((current as PoolClient) || this.source).query(sql, args))
          .rows;
      const client = (current as PoolClient) || (await this.source.connect());
      try {
        if (!current) await client.query("BEGIN");
        await client.query("SELECT set_config('app.community_id',$1,true)", [
          String(this.communityId || ""),
        ]);
        const result = await client.query(sql, args);
        if (!current) await client.query("COMMIT");
        return result.rows;
      } catch (error) {
        if (!current) await client.query("ROLLBACK");
        throw error;
      } finally {
        if (!current) client.release();
      }
    }
    const run = async () =>
      (this.source as DatabaseSync).prepare(sql).all(...args) as Row[];
    return current ? run() : this.serial(run);
  }
  async get(sql: string, ...args: any[]) {
    return (await this.all(sql, ...args))[0];
  }
  async run(sql: string, ...args: any[]) {
    await this.all(sql, ...args);
  }
  async insertRows(
    table: string,
    columns: string[],
    rows: any[][],
    suffix = "",
  ) {
    // Bounded parameter counts also keep bulk operations fast over the network.
    for (let offset = 0; offset < rows.length; offset += 500) {
      const batch = rows.slice(offset, offset + 500);
      await this.run(
        `INSERT INTO ${table} (${columns.join(",")}) VALUES ${batch.map(() => `(${columns.map(() => "?").join(",")})`).join(",")} ${suffix}`,
        ...batch.flat(),
      );
    }
  }
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return fn();
    if (this.source instanceof pg.Pool) {
      const client = await this.source.connect();
      try {
        await client.query("BEGIN");
        // Accounting and settings writes share a transaction-scoped database
        // lock, including across serverless instances, for serializable checks.
        await client.query("SELECT pg_advisory_xact_lock(3602026,$1)", [
          this.communityId || 0,
        ]);
        const result = await this.context.run(client, fn);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    return this.serial(async () => {
      const db = this.source as DatabaseSync;
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = await this.context.run(db, fn);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }
}

export function postgresStore(url: string) {
  return new Store(
    new pg.Pool({
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
      ssl:
        url.includes("supabase.com") || url.includes("supabase.co")
          ? { rejectUnauthorized: true, ca: process.env.SUPABASE_DB_CA }
          : undefined,
    }),
    true,
  );
}
