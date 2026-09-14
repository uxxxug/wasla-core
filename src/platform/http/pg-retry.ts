import type { Clock } from "../clock.js";
import type { Queryable } from "../persistence/postgres.js";
import {
  CLAIM_HORIZON_MS,
  RETENTION_MS,
  type RetryClaimHold,
  type RetryClaimOutcome,
  type RetryClaimRequest,
  type RetryCompletedRow,
  type RetryEntry,
  type RetryLookup,
  type RetryRecordRow,
  type RetryRecordStore,
  type RetryState,
} from "./retry.js";

/**
 * Claims and recorded answers in Postgres.
 *
 * Shared state, so a retry collapses no matter which instance the first call
 * reached — the reason this exists beside the in-memory store rather than
 * instead of it. An in-process record behind two instances would mean a retry
 * is collapsed only when it lands on the same one, which is the failure mode a
 * caller would be least able to reproduce. Since milestone 33 it is also what
 * makes the claim an arbiter across instances and not just across requests: two
 * twins on two pods contend on one primary key.
 *
 * Like `PgRateLimitWindowStore`, it runs on the pool directly rather than
 * inside the request's transaction scope, for two reasons that survive the
 * change of shape: the handler's own transaction has not begun when the claim
 * is taken and has already committed when the answer is recorded, so there is
 * no scope to join at either end; and a claim written inside a transaction that
 * later rolled back would be invisible to the twin it exists to stop, which is
 * the defect rather than the fix. The cost is stated plainly: the claim and the
 * work are not one atomic unit, so a process that dies between them leaves a
 * claim with no work behind it — which is exactly what `CLAIM_HORIZON_MS` and
 * the takeover in `claim` are for.
 */

/**
 * Every column the table has, so nothing it stores is unreachable through this
 * adapter — the property `tests/read-path-parity.test.ts` exists to keep.
 */
const COLUMNS = `key, method, scope, request_fingerprint, state, claim_token, claimed_at,
                 completed_at, response_status, response_body, created_at, expires_at`;

interface Selected {
  key: string;
  method: string;
  scope: string;
  request_fingerprint: string;
  state: RetryState;
  claim_token: string;
  claimed_at: Date;
  completed_at: Date | null;
  response_status: number | null;
  response_body: unknown;
  created_at: Date;
  expires_at: Date;
}

/**
 * `integer` arrives as a number; `timestamptz` arrives as a `Date` from the
 * driver and is handed back as an ISO string, which is what the reference store
 * holds. Two backends that answer the same question with two types are the
 * divergence B-12 is about.
 */
function shape(row: Selected): RetryRecordRow {
  return {
    key: row.key,
    method: row.method,
    scope: row.scope,
    request_fingerprint: row.request_fingerprint,
    state: row.state,
    claim_token: row.claim_token,
    claimed_at: row.claimed_at.toISOString(),
    completed_at: row.completed_at === null ? null : row.completed_at.toISOString(),
    response_status: row.response_status === null ? null : Number(row.response_status),
    response_body: row.response_body,
    created_at: row.created_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
  };
}

/**
 * A body-less answer is stored as SQL `NULL`, not as the JSON document `null`:
 * the reference store holds `null` for "no body", and `JSON.stringify(null)`
 * would put a jsonb `null` in the column, which reads back as the same value in
 * JavaScript but is a different value to the database — `response_body is null`
 * would be false, and a column the parity gate declares nullable would never
 * actually hold a null. Migration 0020 says the same thing in its comment, and
 * 0021's `idempotency_key_state_record_ck` now depends on it: a completed row
 * with a jsonb `null` body is legal, a *claimed* row with one is not.
 */
function bodyParameter(body: unknown): string | null {
  return body === undefined || body === null ? null : JSON.stringify(body);
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
    return row === undefined ? null : shape(row);
  }

  async claim(request: RetryClaimRequest): Promise<RetryClaimOutcome> {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - CLAIM_HORIZON_MS);
    // One statement decides the winner, and that is the whole of B-43. A
    // `select` followed by an `insert` cannot: between the two, any number of
    // twins read the same absence. Here the primary key arbitrates inside the
    // database, so exactly one caller gets a row back however many arrive
    // together — the property `tests/retry-claim.test.ts` measures by firing
    // them concurrently and counting rows.
    //
    // `do update … where` rather than `do nothing`, so the same statement also
    // performs the two takeovers that must not need a second round trip:
    //
    //  * an *expired* record — past `expires_at`, which `find` already treats
    //    as absent, so the key is free and the row is stale weight;
    //  * an *abandoned claim* — claimed before the cutoff and never completed,
    //    i.e. a process that died holding it.
    //
    // In both cases the row becomes this request's, with a fresh token, so the
    // previous owner's `complete` and `release` stop matching. When neither
    // applies the `where` is false, nothing is written and nothing is returned,
    // and the state is read below to say why.
    const claimed = await this.db.query<{ claim_token: string }>(
      `insert into idempotency_key
         (key, method, scope, request_fingerprint, state, claim_token, claimed_at,
          completed_at, response_status, response_body, created_at, expires_at)
       values ($1, $2, $3, $4, 'claimed', gen_random_uuid(), $5, null, null, null, $5, $6)
       on conflict (method, scope, key) do update
          set request_fingerprint = excluded.request_fingerprint,
              state = 'claimed',
              claim_token = excluded.claim_token,
              claimed_at = excluded.claimed_at,
              completed_at = null,
              response_status = null,
              response_body = null,
              created_at = excluded.created_at,
              expires_at = excluded.expires_at
        where idempotency_key.expires_at <= $5
           or (idempotency_key.state = 'claimed' and idempotency_key.claimed_at <= $7)
       returning claim_token`,
      [
        request.key,
        request.method,
        request.scope,
        request.request_fingerprint,
        now,
        new Date(now.getTime() + RETENTION_MS),
        cutoff,
      ],
    );
    const token = claimed.rows[0];
    if (token !== undefined) return { outcome: "claimed", claim_token: token.claim_token };
    const existing = await this.find(request);
    if (existing === null) {
      // The row was live when the insert conflicted and gone by the time this
      // read ran: a twin released or expired it in between. Reporting it as
      // in-flight sends the caller back in a second, which is correct and is
      // the one outcome here that cannot be wrong — claiming instead would need
      // a loop, and a loop is an unbounded number of round trips to save one.
      return { outcome: "in_flight", claimed_at: now.toISOString() };
    }
    // Fingerprint before state, as the reference store does it: a key reused
    // for a different request is refused whether the twin has finished or is
    // still working.
    if (existing.request_fingerprint !== request.request_fingerprint) {
      return { outcome: "reused" };
    }
    if (existing.state === "completed") {
      return { outcome: "completed", record: existing as RetryCompletedRow };
    }
    return { outcome: "in_flight", claimed_at: existing.claimed_at };
  }

  async complete(entry: RetryEntry): Promise<boolean> {
    const now = this.clock.now();
    // Fenced on the token and on the state. `state = 'claimed'` is not
    // redundant beside the token: it is what makes a second `complete` under a
    // token that is still the row's own a no-op rather than an overwrite.
    const result = await this.db.query(
      `update idempotency_key
          set state = 'completed',
              completed_at = $1,
              response_status = $2,
              response_body = $3
        where method = $4 and scope = $5 and key = $6
          and claim_token = $7 and state = 'claimed' and expires_at > $1`,
      [
        now,
        entry.response_status,
        bodyParameter(entry.response_body),
        entry.method,
        entry.scope,
        entry.key,
        entry.claim_token,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async release(hold: RetryClaimHold): Promise<boolean> {
    // Deleted rather than marked: `RetryState` has two states and no third, and
    // `tests/delete-parity.test.ts` classifies this delete against the catalog.
    // Fenced the same way `complete` is, so a request whose claim was taken
    // over cannot delete the new owner's row out from under it.
    const result = await this.db.query(
      `delete from idempotency_key
        where method = $1 and scope = $2 and key = $3
          and claim_token = $4 and state = 'claimed'`,
      [hold.method, hold.scope, hold.key, hold.claim_token],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
