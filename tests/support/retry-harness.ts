/**
 * The ground two retry gates stand on: a tenant, an administrator, a session
 * and a row census, against either persistence backend.
 *
 * Extracted from `tests/retry-idempotency.test.ts` in milestone 33, when
 * `tests/retry-claim.test.ts` needed the same thing. Extracted rather than
 * copied on purpose: the harness encodes decisions a second copy would quietly
 * stop sharing — that the tenant is built through CORE's own services instead
 * of by seeding rows, that Postgres truncates before every case because a
 * leftover `idempotency_key` row changes an answer rather than a count, that
 * the reference backend's retry rows are counted off the concrete class because
 * no foreign key registry holds them, and that the driver is imported lazily so
 * the default suite never needs it installed. A gate measuring the same
 * mechanism through a slightly different harness would be measuring a different
 * mechanism.
 */
import { createCoreApp, type CoreApp } from "../../src/app.js";
import { FixedClock } from "../../src/platform/clock.js";
import { InMemoryRetryRecordStore } from "../../src/platform/http/retry.js";
import {
  memoryPersistence,
  postgresPersistence,
  type Persistence,
} from "../../src/platform/persistence/backends.js";
import { anonymousCredential } from "./credential.js";
import { seedCountry } from "./rows.js";

/** The tenant every case creates, so a case can be read without scrolling. */
export const ORGANIZATION = { name: "Keyed Org", country_code: "SA" };

/** The reference registry's row counts, as a plain object for diffing. */
/** The reference registry's row counts, as a plain object for diffing. */
export function census(store: Persistence): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [table, rows] of store.referenceKeys!.census()) counts[table] = rows;
  return counts;
}

export interface Harness {
  readonly name: string;
  make(): Promise<Ground>;
  close(): Promise<void>;
}

export interface Ground {
  readonly core: CoreApp;
  readonly store: Persistence;
  readonly clock: FixedClock;
  /** A credential holding `platform_admin` in the tenant this ground created. */
  readonly token: string;
  /** A credential that is valid and entitled to nothing. */
  readonly powerless: string;
  count(table: string): Promise<number>;
  post(
    path: string,
    body: unknown,
    key?: string,
    credential?: string,
  ): Promise<{ status: number; body: unknown; headers?: Record<string, string> }>;
  /** A fresh token for the same administrator, for tests that move the clock. */
  reissue(): Promise<string>;
}

/**
 * The tenant, administrator and session every case below needs.
 *
 * Built through CORE's own services rather than by seeding rows, for the reason
 * `./http-scenario.ts` gives: state a route could have created and
 * a test wrote by hand is state production may never produce. The exception is
 * the country, which `POST /v1/geography/countries` *is* one of the routes under
 * test — seeding it keeps the organization's foreign key satisfied without the
 * setup calling a route this file is measuring.
 */
export async function ground(store: Persistence, clock: FixedClock, count: Ground["count"]): Promise<Ground> {
  const core = createCoreApp({ clock, persistence: store, rateLimit: false });
  await seedCountry(store);
  const registered = await core.identity.registerIdentity({
    channel_type: "web",
    external_id: `retry-gate-admin-${Math.random().toString(36).slice(2)}`,
    correlation_id: "retry-gate",
  });
  const principalId = registered.principal.principal_id;
  const organization = await core.organization.create({
    name: "Retry Gate Tenant",
    country_code: "SA",
    correlation_id: "retry-gate",
  });
  await core.identity.grantMembership({
    principal_id: principalId,
    organization_id: organization.organization_id,
    roles: ["platform_admin"],
    correlation_id: "retry-gate",
  });
  const issue = async () =>
    (
      await core.identity.issueSession({
        principal_id: principalId,
        channel_type: "web",
        correlation_id: "retry-gate",
      })
    ).token;
  const token = await issue();
  const powerless = await anonymousCredential(core);
  return {
    core,
    store,
    clock,
    token,
    powerless,
    count,
    async post(path, body, key, credential = token) {
      const response = await core.router.handle({
        method: "POST",
        url: path,
        headers: {
          ...(credential === "" ? {} : { authorization: `Bearer ${credential}` }),
          ...(key === undefined ? {} : { "idempotency-key": key }),
        },
        body,
      });
      return {
        status: response.status,
        body: response.body,
        headers: response.headers as Record<string, string> | undefined,
      };
    },
    reissue: issue,
  };
}

export function memoryHarness(): Harness {
  return {
    name: "memory",
    async make() {
      const clock = new FixedClock(new Date("2026-06-01T00:00:00.000Z"));
      const store = memoryPersistence(clock);
      return ground(store, clock, async (table) => {
        // `idempotency_key` is not in the reference foreign-key registry, and
        // deliberately: no other table references a retry record, so nothing
        // would read it back and registering it would claim a relationship
        // that does not exist (`reference-keys.ts` names the four tables it
        // omits, and why). The reference store's own map is therefore the only
        // place to count them, which is why this narrows to the concrete
        // class rather than reading the port.
        if (table === "idempotency_key") {
          return (store.retry as InMemoryRetryRecordStore).rows().size;
        }
        return census(store)[table] ?? 0;
      });
    },
    async close() {},
  };
}

export function postgresHarness(connectionString: string): Harness {
  // Imported lazily, and the pool shared across the file's cases, exactly as
  // the neighbouring dual-backend tests do it: the default suite must not need
  // the driver installed at all.
  let pool: { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>; end(): Promise<void> } | undefined;
  const getPool = async () => {
    if (!pool) {
      const { Pool } = await import("pg");
      pool = new Pool({ connectionString, max: 4 }) as unknown as typeof pool;
    }
    return pool!;
  };
  return {
    name: "postgres",
    async make() {
      const created = await getPool();
      // Every case builds its own tenant, so the tables are emptied first:
      // otherwise the row counts below would measure the rows a previous case
      // left, and `idempotency_key` would still hold its records, which is the
      // one table where a leftover row changes an answer rather than a count.
      await created.query(
        `truncate membership, session, principal, identity_link, identity,
         organization, outbox, inbox, fulfillment, ledger_entry,
         ledger_transaction, payment_authorization, wallet, usage_record,
         subscription_period, subscription, plan_grant, plan, event_delivery,
         event_subscription, inbound_event, idempotency_key, audit_entry,
         service_area, city, region, country restart identity cascade`,
      );
      const clock = new FixedClock(new Date("2026-06-01T00:00:00.000Z"));
      const store = postgresPersistence(created as never, clock);
      return ground(store, clock, async (table) => {
        const result = await created.query(`select count(*)::int as rows from ${table}`);
        return (result.rows[0] as { rows: number }).rows;
      });
    },
    async close() {
      if (pool) await pool.end();
    },
  };
}

/** The harnesses a dual-backend retry gate runs against. */
export function retryHarnesses(url: string | undefined): Harness[] {
  const list: Harness[] = [memoryHarness()];
  if (url) list.push(postgresHarness(url));
  return list;
}
