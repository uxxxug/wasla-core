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
    // A job that cost less than the consented ceiling: part of the hold moved
    // and the remainder was released. Legitimate since migration 0009 made a
    // hold capturable in legs.
    ["completed", "partially_captured"],
    ["completed", "unsettled"],
    ["failed", "released"],
    ["failed", "unsettled"],
    ["cancelled", "released"],
    ["cancelled", "unsettled"],
    // Storable on purpose: money moved for work that did not complete. It is a
    // true statement about a real outcome, so the schema records it rather than
    // forcing the service to write `released` — which would claim nothing
    // moved. The reconciliation read is what flags it (blocker B-20).
    ["failed", "partially_captured"],
    ["cancelled", "partially_captured"],
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
    // Open work may never claim a terminal money state, including the new one.
    ["coordinating", "partially_captured"],
    ["dispatched", "partially_captured"],
  ])("refuses %s / %s as financially inconsistent", async (status, settlement) => {
    const result = await insertFulfillment(status, settlement);
    expect(result.accepted).toBe(false);
    expect(result).toMatchObject({ constraint: "fulfillment_settlement_alignment_check" });
  });

  it("refuses a settlement_state outside the known vocabulary", async () => {
    // Deliberately not a plausible near-miss: the point is that the value list
    // is closed, so a state the domain has never heard of cannot be persisted
    // by a future adapter that invents one.
    const result = await insertFulfillment("completed", "settled_somehow");
    if (result.accepted) throw new Error("an unknown settlement_state was persisted");
    // Two constraints reject it and Postgres names whichever it evaluated
    // first, so the assertion is that a settlement constraint refused it — not
    // which one, which would pin an evaluation order nothing guarantees.
    expect(result.constraint).toMatch(/^fulfillment_settlement_/);
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

  it("refuses a claim on a queue row that is no longer pending (B-24)", async () => {
    // `claimed_at` is a lease held by a running worker. On a published, processed,
    // delivered or dead row it cannot mean anything, and if it could be left
    // behind it would be counted as work in flight for ever. The application
    // clears it on every acknowledgement; this asserts the database would not
    // accept the mistake even if a future writer forgot.
    const eventId = randomUUID();
    await client.query(
      `insert into outbox (event_id, event_type, version, producer, occurred_at,
                           correlation_id, entity_type, entity_id, payload, status,
                           attempts, next_attempt_at, created_at)
       values ($1, 'core.fulfillment.dispatched', 1, 'wasla-core', now(), $2,
               'fulfillment', $3, '{}'::jsonb, 'pending', 0, now(), now())`,
      [eventId, `corr-${eventId}`, randomUUID()],
    );

    // Claimed while pending: allowed.
    await client.query("update outbox set claimed_at = now() where event_id = $1", [eventId]);

    // Published while still claimed: refused, by name, so the failure is
    // attributable rather than a generic constraint violation.
    let constraint: string | undefined;
    try {
      await client.query("update outbox set status = 'published' where event_id = $1", [eventId]);
    } catch (error) {
      constraint = (error as { constraint?: string }).constraint;
    }
    expect(constraint).toBe("outbox_claim_check");

    // Releasing the claim in the same statement is accepted, which is what every
    // acknowledgement in the store adapters now does.
    await client.query(
      "update outbox set status = 'published', claimed_at = null where event_id = $1",
      [eventId],
    );
    const row = await client.query("select status, claimed_at from outbox where event_id = $1", [
      eventId,
    ]);
    expect(row.rows[0]?.["status"]).toBe("published");
    expect(row.rows[0]?.["claimed_at"]).toBe(null);
  });

  it("indexes the leases so recovery does not scan the queues (B-24)", async () => {
    // Recovery runs on every worker tick and looks for pending rows that carry a
    // claim whose lease has expired. Without a partial index on exactly that
    // predicate, the cheapest thing a worker does on a healthy queue becomes a
    // scan of every row it has ever published.
    for (const table of ["outbox", "inbound_event", "event_delivery"]) {
      const indexes = await client.query("select indexdef from pg_indexes where tablename = $1", [
        table,
      ]);
      const definitions = indexes.rows.map((row) => String(row["indexdef"]));
      expect(
        definitions.some((d) => d.includes("claimed_at IS NOT NULL")),
        `${table} has no lease index`,
      ).toBe(true);
    }
  });

  it("gives every queue a reclaim counter that starts at zero and cannot go negative (B-25)", async () => {
    // The budget that bounds recovery. A row that arrives with a NULL or a
    // negative count could not be compared against a limit, so the payload that
    // kills every worker touching it would be recovered for ever again — which is
    // the defect this column exists to remove. The default matters as much as the
    // constraint: existing rows and rows written by the positional insert lists in
    // the store adapters never mention the column at all.
    for (const table of ["outbox", "inbound_event", "event_delivery"]) {
      const column = await client.query(
        `select column_default, is_nullable, data_type from information_schema.columns
         where table_name = $1 and column_name = 'reclaims'`,
        [table],
      );
      expect(column.rows[0]?.["is_nullable"], `${table}.reclaims is nullable`).toBe("NO");
      expect(String(column.rows[0]?.["column_default"])).toContain("0");

      const constraints = await client.query(
        `select conname from pg_constraint
         where conrelid = $1::regclass and conname = $2`,
        [table, `${table}_reclaims_check`],
      );
      expect(constraints.rowCount, `${table} has no reclaims check`).toBe(1);
    }
  });

  it("gives every queue a nullable claim token tied to the claim itself (B-26)", async () => {
    // The token that makes a claim exclusive over time rather than only at the
    // instant it is taken. Nullable on purpose, and with no default: a row at rest
    // is held by nobody, and a token on an unclaimed row would be matched by a
    // worker that has no claim.
    //
    // The constraint is the weak direction — a token implies a claim, not the
    // reverse — because rows that were already claimed when 0016 ran have a
    // `claimed_at` and no token, and backfilling one would have fenced out a worker
    // still doing real work.
    for (const table of ["outbox", "inbound_event", "event_delivery"]) {
      const column = await client.query(
        `select column_default, is_nullable, data_type from information_schema.columns
         where table_name = $1 and column_name = 'claim_token'`,
        [table],
      );
      expect(column.rowCount, `${table} has no claim_token column`).toBe(1);
      expect(column.rows[0]?.["is_nullable"], `${table}.claim_token is not nullable`).toBe("YES");
      expect(column.rows[0]?.["column_default"], `${table}.claim_token has a default`).toBeNull();

      const constraints = await client.query(
        `select pg_get_constraintdef(oid) as def from pg_constraint
         where conrelid = $1::regclass and conname = $2`,
        [table, `${table}_claim_token_check`],
      );
      expect(constraints.rowCount, `${table} has no claim_token check`).toBe(1);
      expect(String(constraints.rows[0]?.["def"])).toContain("claimed_at IS NOT NULL");
    }

    // And the constraint is enforced, not merely declared. Shown on `outbox`,
    // because the three declarations are identical and inserting a valid row into
    // each queue would prove the same fact three times.
    const eventId = randomUUID();
    await client.query(
      `insert into outbox (event_id, event_type, version, producer, occurred_at,
                           correlation_id, entity_type, entity_id, payload, status,
                           attempts, next_attempt_at, created_at)
       values ($1, 'core.fulfillment.dispatched', 1, 'wasla-core', now(), $2,
               'fulfillment', $3, '{}'::jsonb, 'pending', 0, now(), now())`,
      [eventId, `corr-${eventId}`, randomUUID()],
    );

    // A token on a row nobody holds is the one state a fence cannot reason about:
    // a worker presenting that token would be treated as the current holder.
    let constraint: string | undefined;
    try {
      await client.query("update outbox set claim_token = $2 where event_id = $1", [
        eventId,
        randomUUID(),
      ]);
    } catch (error) {
      constraint = (error as { constraint?: string }).constraint;
    }
    expect(constraint).toBe("outbox_claim_token_check");

    // Stamped together with the claim: accepted, and that is exactly what
    // `claimDue` does in one statement.
    await client.query(
      "update outbox set claimed_at = now(), claim_token = $2 where event_id = $1",
      [eventId, randomUUID()],
    );
    const row = await client.query("select claim_token from outbox where event_id = $1", [eventId]);
    expect(row.rows[0]?.["claim_token"]).not.toBeNull();
  });
});
