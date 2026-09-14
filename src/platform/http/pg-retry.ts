import type { Clock } from "../clock.js";
import type { Queryable } from "../persistence/postgres.js";
import { RETENTION_MS, type RetryEntry, type RetryLookup, type RetryRecordRow, type RetryRecordStore } from "./retry.js";

/**
 * Recorded answers in Postgres.
 *
 * Shared state, so a retry collapses no matter which instance the first call
 * reached — the reason this exists beside the in-memory store rather than
 * instead of it. An in-process record behind two instances would mean a retry
 * is collapsed only when it lands on the same one, which is the failure mode a
 * caller would be least able to reproduce.
 *
 * Like `PgRateLimitWindowStore`, it runs on the pool directly rather than
 * inside the request's transaction scope, for two reasons: the handler's own
 * transaction has already committed by the time the router records the answer,
 * so there is no scope left to join; and a record written inside a transaction
 * that later rolled back would be a record of an answer nobody was given.
 */

/**
 * Every column the table has, so nothing it stores is unreachable through this
 * adapter — the property `tests/read-path-parity.test.ts` exists to keep.
 */
const COLUMNS = `key, method, scope, request_fingerprint, response_status, response_body, created_at, expires_at`;

interface Selected {
  key: string;
  method: string;
  scope: string;
  request_fingerprint: string;
  response_status: number;
  response_body: unknown;
  created_at: Date;
  expires_at: Date;
}

export class PgRetryRecordStore implements RetryRecordStore {
  constructor(
    private readonly db: Queryable,
    private readonly clock: Clock,
  ) {}

  async find(lookup: RetryLookup): Promise<RetryRecordRow | null> {
    // Expiry is a predicate rather than a check the caller makes on the row:
    // an expired record must be indistinguishable from no record, and a router
    // that filtered it afterwards would need a clock of its own to do it.
    const result = await this.db.query<Selected>(
      `select ${COLUMNS}
         from idempotency_key
        where method = $1 and scope = $2 and key = $3 and expires_at > $4`,
      [lookup.method, lookup.scope, lookup.key, this.clock.now()],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      key: row.key,
      method: row.method,
      scope: row.scope,
      request_fingerprint: row.request_fingerprint,
      // `integer` arrives as a number; `timestamptz` arrives as a `Date` from
      // the driver and is handed back as an ISO string, which is what the
      // reference store holds. Two backends that answer the same question with
      // two types are the divergence B-12 is about.
      response_status: Number(row.response_status),
      response_body: row.response_body,
      created_at: row.created_at.toISOString(),
      expires_at: row.expires_at.toISOString(),
    };
  }

  async record(entry: RetryEntry): Promise<void> {
    const now = this.clock.now();
    // `do nothing` rather than `do update`: the row can only already exist if
    // an identical request was recorded between this one's lookup and its
    // write, which is the concurrent-retry case. The first answer recorded is
    // the one every later retry is entitled to, so the second write is a
    // no-op rather than a refusal the caller would see instead of its answer.
    await this.db.query(
      `insert into idempotency_key (${COLUMNS})
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (method, scope, key) do nothing`,
      [
        entry.key,
        entry.method,
        entry.scope,
        entry.request_fingerprint,
        entry.response_status,
        // A body-less answer is stored as SQL `NULL`, not as the JSON document
        // `null`: the reference store holds `null` for "no body", and
        // `JSON.stringify(null)` would put a jsonb `null` in the column, which
        // reads back as the same value in JavaScript but is a different value
        // to the database — `response_body is null` would be false, and a
        // column the parity gate declares nullable would never actually hold a
        // null. Migration 0020 says the same thing in its comment.
        entry.response_body === undefined || entry.response_body === null
          ? null
          : JSON.stringify(entry.response_body),
        now,
        new Date(now.getTime() + RETENTION_MS),
      ],
    );
  }
}
