/**
 * Schema-level guarantees verified against a real PostgreSQL instance.
 *
 * The in-memory tests prove the CORE services keep execution state and money
 * state in agreement. They cannot prove the database refuses a bad row, and a
 * migration file that has never been executed is an unverified claim. These
 * tests close that gap.
 *
 * Skipped entirely when DATABASE_URL is absent, so the default suite stays
 * dependency-free and CI is unaffected. Run with:
 *
 *   DATABASE_URL=postgres://... node scripts/db-migrate.mjs up
 *   DATABASE_URL=postgres://... npx vitest run tests/db-schema.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env["DATABASE_URL"];
const ORGANIZATION_ID = "11111111-1111-1111-1111-111111111111";

type Row = Record<string, unknown>;
interface Queryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
  end(): Promise<void>;
}

let client: Queryable;
let sequence = 0;

function fulfillmentId(): string {
  return `7777${String(++sequence).padStart(4, "0")}-1111-1111-1111-111111111111`;
}

/** Inserts a fulfillment row, reporting whether the database accepted it. */
async function insertFulfillment(
  status: string,
  settlementState: string | null,
): Promise<{ accepted: true } | { accepted: false; constraint?: string }> {
  const columns = ["fulfillment_id", "organization_id", "market_order_reference", "status", "created_at"];
  const placeholders = ["$1", "$2", "$3", "$4", "now()"];
  const values: unknown[] = [fulfillmentId(), ORGANIZATION_ID, `order-${sequence}`, status];
  if (settlementState !== null) {
    columns.push("settlement_state");
    placeholders.push("$5");
    values.push(settlementState);
  }
  try {
    await client.query(
      `insert into fulfillment (${columns.join(",")}) values (${placeholders.join(",")})`,
      values,
    );
    return { accepted: true };
  } catch (error) {
    return { accepted: false, constraint: (error as { constraint?: string }).constraint };
  }
}

describe.skipIf(!DATABASE_URL)("the CORE schema enforces execution/money consistency", () => {
  beforeAll(async () => {
    const pg = await import("pg");
    client = new pg.default.Client({ connectionString: DATABASE_URL }) as unknown as Queryable;
    await (client as unknown as { connect(): Promise<void> }).connect();
    await client.query(
      `insert into organization (organization_id,name,status,country_code,created_at,updated_at,source_system)
       values ($1,'schema test','active','SA',now(),now(),'core')
       on conflict (organization_id) do nothing`,
      [ORGANIZATION_ID],
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("delete from fulfillment where organization_id = $1", [ORGANIZATION_ID]);
    await client.query("delete from organization where organization_id = $1", [ORGANIZATION_ID]);
    await client.end();
  });

  it("has every migration recorded, including the settlement state migration", async () => {
    const applied = await client.query("select version from schema_migrations order by version");
    const versions = applied.rows.map((row) => row["version"]);
    expect(versions).toContain("0001_core_foundation");
    expect(versions).toContain("0005_fulfillment_settlement_state");
  });

  it("defaults settlement_state to none so pre-existing rows stay valid", async () => {
    const result = await insertFulfillment("coordinating", null);
    expect(result.accepted).toBe(true);
    const row = await client.query(
      "select settlement_state from fulfillment where market_order_reference = $1",
      [`order-${sequence}`],
    );
    expect(row.rows[0]?.["settlement_state"]).toBe("none");
  });

  it.each([
    ["coordinating", "none"],
    ["coordinating", "held"],
    ["dispatched", "held"],
    ["completed", "captured"],
    ["completed", "unsettled"],
    ["failed", "released"],
    ["failed", "unsettled"],
    ["cancelled", "released"],
    ["cancelled", "unsettled"],
  ])("accepts %s / %s, which CORE actually produces", async (status, settlement) => {
    expect(await insertFulfillment(status, settlement)).toEqual({ accepted: true });
  });

  it.each([
    ["completed", "held"],
    ["cancelled", "held"],
    ["cancelled", "captured"],
    ["failed", "captured"],
    ["dispatched", "captured"],
    ["dispatched", "released"],
    ["coordinating", "released"],
    ["completed", "released"],
  ])("refuses %s / %s as financially inconsistent", async (status, settlement) => {
    const result = await insertFulfillment(status, settlement);
    expect(result.accepted).toBe(false);
    expect(result).toMatchObject({ constraint: "fulfillment_settlement_alignment_check" });
  });

  it("refuses a settlement_state outside the known vocabulary", async () => {
    const result = await insertFulfillment("completed", "partially_captured");
    expect(result.accepted).toBe(false);
  });

  it("pins a search_path on every trigger function", async () => {
    const functions = await client.query(
      `select p.proname, p.proconfig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = current_schema()
          and p.proname in ('audit_entry_is_append_only','ledger_entry_is_append_only','ledger_transaction_is_balanced')`,
    );
    expect(functions.rowCount).toBe(3);
    for (const row of functions.rows) {
      const config = row["proconfig"] as string[] | null;
      expect(config, `${String(row["proname"])} has a mutable search_path`).not.toBeNull();
      expect(config?.some((entry) => entry.startsWith("search_path="))).toBe(true);
    }
  });

  it("keeps the ledger balanced even when a decoy table shadows it", async () => {
    // Without a pinned search_path the balance trigger resolves ledger_entry
    // through the caller's search_path, so a decoy table makes it check the
    // wrong rows and an unbalanced transaction commits. This asserts it does
    // not.
    const transactionId = randomUUID();
    await client.query("create schema if not exists core_schema_probe");
    await client.query("drop table if exists core_schema_probe.ledger_entry");
    await client.query(
      "create table core_schema_probe.ledger_entry (transaction_id uuid, currency char(3), amount_minor bigint)",
    );
    await client.query(
      `insert into ledger_transaction (transaction_id, kind, business_reference, occurred_at)
       values ($1,'credit','schema-probe-unbalanced',now()) on conflict (transaction_id) do nothing`,
      [transactionId],
    );

    let committed = false;
    try {
      await client.query("set search_path = core_schema_probe, public");
      await client.query("begin");
      await client.query(
        `insert into public.ledger_entry (entry_id, transaction_id, account_reference, amount_minor, currency)
         values (gen_random_uuid(), $1, 'wallet:probe', 5000, 'SAR')`,
        [transactionId],
      );
      await client.query("commit");
      committed = true;
    } catch {
      await client.query("rollback");
    } finally {
      await client.query("reset search_path");
      await client.query("drop schema if exists core_schema_probe cascade");
      // The ledger is append-only at the database level, so a probe row that
      // did commit cannot be removed. Never let cleanup mask the assertion.
      try {
        await client.query("delete from ledger_transaction where transaction_id = $1", [transactionId]);
      } catch {
        /* the append-only trigger refused it; the assertion below is what matters */
      }
    }

    expect(committed, "an unbalanced ledger transaction was committed").toBe(false);
  });

  it("denies row access by default on every CORE table", async () => {
    const tables = await client.query(
      `select count(*) filter (where c.relrowsecurity) as protected, count(*) as total
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = current_schema() and c.relkind = 'r'`,
    );
    const row = tables.rows[0] ?? {};
    expect(Number(row["protected"])).toBe(Number(row["total"]));
  });

  it("indexes the unsettled rows so reconciliation does not scan the table", async () => {
    const indexes = await client.query(
      "select indexdef from pg_indexes where tablename = 'fulfillment'",
    );
    const definitions = indexes.rows.map((row) => String(row["indexdef"]));
    expect(definitions.some((definition) => definition.includes("'unsettled'"))).toBe(true);
  });
});
