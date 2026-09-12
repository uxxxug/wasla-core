import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  assertNotNested,
  insideTransaction,
  NO_SCOPE,
  type TransactionBoundary,
  type TransactionScope,
} from "./transaction.js";

/**
 * The narrow slice of `pg` the adapters actually use. Declaring it here keeps
 * every repository testable against a fake and stops `pg` types leaking into
 * module code.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

/** A scope produced by `PgTransactionBoundary`: the client inside `BEGIN`. */
interface PgScope extends TransactionScope {
  readonly handle: PoolClient;
}

function isPgScope(scope: TransactionScope): scope is PgScope {
  const handle = scope.handle as { query?: unknown } | null;
  return handle !== null && typeof handle === "object" && typeof handle.query === "function";
}

/**
 * Picks what a statement runs on.
 *
 * A write inside a unit of work gets the scope, so it runs on the client that
 * holds the open transaction and commits with everything else. A read, or a
 * write deliberately outside a transaction, gets `NO_SCOPE` and runs on the
 * pool as its own autocommit statement.
 *
 * This is the single place where "did this write join the transaction?" is
 * decided, so it is the single place to audit.
 */
export function runner(pool: Queryable, scope: TransactionScope = NO_SCOPE): Queryable {
  return isPgScope(scope) ? scope.handle : pool;
}

/**
 * Real transaction boundary: `BEGIN` on a dedicated client, `COMMIT` when the
 * work returns, `ROLLBACK` when it throws. The client is always released.
 *
 * Nesting is deliberately not supported. A nested `run` would need savepoints,
 * and no service needs them; making it explicit is better than pretending.
 */
export class PgTransactionBoundary implements TransactionBoundary {
  constructor(private readonly pool: Pool) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    // A nested run would take a *second* pooled connection and commit
    // independently while the outer transaction was still open.
    assertNotNested();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await insideTransaction(() => work({ handle: client }));
      await client.query("commit");
      return result;
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // The connection is already broken; the original error is the useful one.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

/**
 * A `Queryable` on which writing is impossible.
 *
 * Every statement runs inside `begin transaction read only`, so a write is
 * refused **by the database** with SQLSTATE 25006, not by a flag in application
 * code that a later edit could forget to check. That distinction is the whole
 * point: a dry-run that merely avoids calling the handlers is a promise, and a
 * dry-run whose connection cannot write is a proof. It is also why this is not
 * `PgTransactionBoundary` with an extra option — the guarantee has to hold for
 * statements issued outside any unit of work too, which is most reads.
 *
 * Read-only is per transaction rather than per session so the same pool is
 * shared with everything else: no second connection string, no second set of
 * credentials, and nothing to configure in the database for the guarantee to
 * hold.
 */
export class ReadOnlyQueryable implements Queryable {
  constructor(private readonly pool: Pool) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    const client = await this.pool.connect();
    try {
      await client.query("begin transaction read only");
      const result = await client.query<R>(text, values as unknown[] | undefined);
      await client.query("commit");
      return result;
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // The original error is the useful one.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Timestamps cross the boundary as ISO strings, never as `Date`. */
export function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Same, for a column the domain declares non-nullable. */
export function isoRequired(value: Date | string): string {
  const out = iso(value);
  if (out === null) throw new Error("expected a timestamp, received null");
  return out;
}
