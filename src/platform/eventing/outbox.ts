import type { Clock } from "../clock.js";
import type { ReferenceKeys } from "../persistence/reference-keys.js";
import { journalMapWrite, NO_SCOPE, type TransactionScope } from "../persistence/transaction.js";
import type { EventEnvelope } from "./envelope.js";
import { isFenced, newClaimToken, type Fence } from "./fencing.js";
import { tallyByStatus } from "./queue-counts.js";
import {
  compareRevivalPosition,
  matchesOutboxRevival,
  type OutboxRevivalSelection,
} from "./revival.js";
import {
  reclaimedError,
  reclaimExhausted,
  reclaimExhaustedError,
  type ReclaimOutcome,
} from "./reclaim.js";
import { orderedBy } from "../persistence/list-order.js";
import { putRow } from "../persistence/row-rules.js";
import { inDueOrder } from "./queue-order.js";

export type OutboxStatus = "pending" | "published" | "dead";

export interface OutboxRecord {
  event: EventEnvelope;
  /**
   * When CORE recorded the envelope, by CORE's clock.
   *
   * The column has been `not null default now()` since the first migration and
   * was surfaced by neither backend: the Postgres adapter inserted it and never
   * selected it, and the reference store never wrote it at all — so a reference
   * row was missing a value every database row had, and the two backends
   * returned records of different shapes. Found by the column-parity gate
   * (milestone 18), which refuses a row that leaves a defaulted column out
   * rather than applying the default itself.
   *
   * Distinct from `event.occurred_at`, which is the producer's claim about when
   * the thing happened; this is when CORE took custody of it, and it is what
   * `claimDue` and every listing order by.
   */
  created_at: string;
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  /**
   * When a worker claimed this row, or null when nobody holds it (B-24).
   *
   * This is the column that tells the two meanings of `next_attempt_at` apart.
   * While it is null, `next_attempt_at` is a retry schedule: the row is waiting
   * for its time. While it is set, `next_attempt_at` is a lease expiry: a worker
   * has the row and is expected back before then. Without it a row held by a
   * process that died looked exactly like a row politely waiting to be retried,
   * so lease expiry could not be counted and nothing could answer "what is
   * stuck".
   */
  claimed_at: string | null;
  /**
   * How many times a worker claimed this row and never came back (B-25).
   *
   * Separate from `attempts` because they count different things and are read by
   * different code. `attempts` counts failures somebody observed and drives the
   * retry backoff; this counts attempts nobody saw end, and drives only the limit
   * that stops a payload which kills every worker that touches it from being
   * recovered for ever. Incremented by the reclaim path alone, and never reset:
   * the budget is for the lifetime of the row.
   */
  reclaims: number;
  /**
   * The token identifying the claim currently held on this row (B-26).
   *
   * Stamped by `claimDue`, cleared by every acknowledgement and by recovery, and
   * carried back by the worker on each acknowledgement so a call from a worker
   * whose claim was taken away can be refused rather than applied. Null means
   * nobody holds the row, in which case any token presented for it is stale.
   */
  claim_token: string | null;
}

/**
 * Outbox port. Implementations MUST append within the same transaction that
 * mutates domain state (ADR 0009); the in-memory implementation models this by
 * exposing append only through a unit of work.
 */
export interface OutboxStore {
  /** MUST run inside the caller's transaction; the scope is how it joins it. */
  append(event: EventEnvelope, scope: TransactionScope): Promise<void>;
  /** Leases due records so two relays cannot claim the same work (B-22). */
  claimDue(now: Date, limit: number, leaseMs?: number): Promise<OutboxRecord[]>;
  /**
   * Returns rows whose lease ran out to the pending pool and reports how many
   * (B-24). A worker that died mid-attempt left `claimed_at` set and a lease that
   * has since expired; this is the only thing that frees such a row, because
   * `claimDue` refuses claimed rows.
   *
   * Still does not touch `attempts`: an attempt that was abandoned was never
   * observed to fail, and charging it against the retry budget would let a rolling
   * deploy dead-letter healthy events at `maxAttempts = 5`. Instead a recovery
   * charges `reclaims`, its own budget, and the row is dead-lettered when that
   * budget runs out (B-25). Two failure modes, two counters: a restart cannot
   * consume a healthy event's retries, and a payload that kills every worker that
   * touches it can no longer be recovered for ever with nothing to stop it.
   *
   * `maxReclaims` recoveries are allowed; the abandonment after that sets
   * `status = 'dead'` rather than returning the row to the pending pool.
   */
  reclaimExpired(now: Date, maxReclaims: number, limit?: number): Promise<ReclaimOutcome>;
  /** One record by id. Outbound delivery needs the envelope long after it was published. */
  get(eventId: string): Promise<OutboxRecord | undefined>;
  /**
   * The three acknowledgements are token-fenced (B-26) and return false when the
   * call was refused: the row is held by a different claim, or by none. The
   * caller passes the `claim_token` it was given by `claimDue`, or `UNFENCED` if
   * it never claimed the row.
   *
   * A refusal and a missing row are both false. They are the same fact from the
   * caller's point of view — nothing was applied — and these tables are never
   * deleted from, so a row a worker claimed cannot vanish underneath it.
   */
  markPublished(eventId: string, fence: Fence, scope?: TransactionScope): Promise<boolean>;
  markFailed(eventId: string, fence: Fence, error: string, nextAttemptAt: Date): Promise<boolean>;
  markDead(eventId: string, fence: Fence, error: string): Promise<boolean>;
  all(): Promise<OutboxRecord[]>;
  byStatus(status: OutboxStatus): Promise<OutboxRecord[]>;
  /**
   * A scoped page of **dead** rows, in `(occurred_at, event_id)` order (B-27).
   *
   * Separate from `byStatus("dead")`, which takes no filter, no limit and no
   * cursor: this one backs an operator command that must be describable in a
   * sentence before it runs and bounded when it does. The status is fixed rather
   * than a parameter, because the only rows revival may ever look at are dead
   * ones and a queue whose live rows an operator can page through invites exactly
   * the request that should never be made.
   */
  selectDead(selection: OutboxRevivalSelection): Promise<OutboxRecord[]>;
  /**
   * Returns one dead row to the pending pool so the relay publishes it again
   * (B-27). False when the row is not dead — it was revived by a concurrent run,
   * or never died at all.
   *
   * The transition is matched on `status = 'dead'`, so this is a transition and
   * not an overwrite: it can never resurrect a `published` row, which would
   * republish an event every subscriber already received. `reclaims` goes back to
   * zero, `attempts` and `last_error` are left exactly as they are, and the row
   * becomes due immediately — see `revival.ts` for why each of those is the way it
   * is.
   */
  revive(eventId: string, now: Date): Promise<boolean>;
  /**
   * Row counts by status, plus `retrying` (pending with an attempt already
   * spent). One aggregate query rather than a list, because the caller is a
   * gauge sampler and fetching every pending row to take its `length` is how a
   * readiness probe becomes a table scan.
   *
   * Also reports `in_flight` and `abandoned`: pending rows a worker is holding,
   * split by whether the lease has run out. Those two are how an operator asks
   * what is being worked on and what is stuck (B-24).
   *
   * All three are derived here, at read time, from the same rows: none is a
   * status any row carries, and none must become a second store competing with
   * the queue for the truth. They are subsets of `pending`, not additions to it.
   */
  counts(): Promise<Record<string, number>>;
}

export class InMemoryOutbox implements OutboxStore {
  private records = new Map<string, OutboxRecord>();
  /**
   * `keys` is how `outbox` becomes a parent table the other reference stores can
   * see: `event_delivery.event_id` and `notification.event_id` both reference
   * it, and without the registry neither could be checked in memory. Optional
   * because a unit test may build this store alone, which is the fail-open case
   * named in `reference-keys.ts`.
   */
  constructor(
    private readonly clock: Clock,
    keys?: ReferenceKeys,
  ) {
    keys?.attach("outbox", this.records);
  }

  async append(event: EventEnvelope, scope?: TransactionScope): Promise<void> {
    if (this.records.has(event.event_id)) return;
    journalMapWrite(scope, this.records, event.event_id);
    const now = this.clock.now().toISOString();
    putRow("outbox", this.records, event.event_id, {
      event,
      // Written rather than defaulted: the reference backend applies no
      // database default, so the store is the one place the value comes from.
      created_at: now,
      status: "pending",
      attempts: 0,
      reclaims: 0,
      last_error: null,
      next_attempt_at: now,
      claimed_at: null,
      claim_token: null,
    });
  }

  async get(eventId: string): Promise<OutboxRecord | undefined> {
    return this.records.get(eventId);
  }

  /**
   * Leases up to `limit` due records.
   *
   * The lease is the fix for blocker B-22. Before it, this method only *read*
   * due rows — on Postgres with `for update skip locked` in its own implicit
   * transaction, so the locks were gone the moment the statement returned, and
   * two workers polling together both received the same rows and both did the
   * work. Measured on a real database: two pools claiming five due rows each
   * got five rows each, all five shared.
   *
   * Claiming now writes: `next_attempt_at` moves out by the lease, so the row
   * is not due again until then and a second worker's identical query does not
   * see it. `next_attempt_at` doubles as the lease expiry rather than a new
   * column, so the lease and the retry schedule are read off one timer.
   *
   * B-24 added the missing half of that: `claimed_at` says which of the two
   * meanings `next_attempt_at` currently carries. A claim sets it, every
   * acknowledgement clears it, and this query skips rows that still have it —
   * so a row held by a dead process is no longer silently re-served when its
   * lease runs out. `reclaimExpired` frees it and counts it, which is what makes
   * a dying worker visible instead of merely slow.
   */
  async claimDue(now: Date, limit: number, leaseMs = 30_000): Promise<OutboxRecord[]> {
    const due: OutboxRecord[] = [];
    // One token per call, not per row, matching Postgres — where claiming a batch
    // is one statement and stamping a different token on each row would mean one
    // statement per row. The fence only ever compares a row against whoever holds
    // that row, so a token shared across one claim refuses exactly the same
    // acknowledgements a per-row token would. The two backends must agree on this,
    // or a test that passes in memory certifies nothing (B-12).
    const token = newClaimToken();
    // Due order, not insertion order (milestone 21). This loop used to walk the
    // Map, so with a retry pending the reference backend claimed the row that
    // was appended first and Postgres claimed the row that was due first; under
    // a limit the two backends handed a worker different work for the same
    // call, and nothing in the suite could see it.
    for (const record of inDueOrder(this.records.values(), (row) => row.created_at, (row) => row.event.event_id)) {
      if (record.status !== "pending") continue;
      if (record.claimed_at !== null) continue;
      if (new Date(record.next_attempt_at).getTime() > now.getTime()) continue;
      // Written before the next iteration, with no await in between, so two
      // interleaved drains cannot both take it.
      const claimed: OutboxRecord = {
        ...record,
        next_attempt_at: new Date(now.getTime() + leaseMs).toISOString(),
        claimed_at: now.toISOString(),
        // A fresh token per claim, never reused, so an acknowledgement from a
        // previous holder of this row can be told apart from this one's (B-26).
        claim_token: token,
      };
      putRow("outbox", this.records, record.event.event_id, claimed);
      // The claimed record, not the pre-claim one: Postgres returns the updated
      // row and the two backends must not disagree about what a claim returns
      // (B-12). Callers read `event` and `attempts`, which the claim leaves
      // alone.
      due.push(claimed);
      if (due.length >= limit) break;
    }
    return due;
  }

  /** See `OutboxStore.reclaimExpired`. */
  async reclaimExpired(now: Date, maxReclaims: number, limit = 100): Promise<ReclaimOutcome> {
    const outcome: ReclaimOutcome = { reclaimed: 0, dead: 0 };
    // Due order, for the same reason as `claimDue`: `limit` makes the order a
    // selection, so an unordered scan recovers a different subset than Postgres.
    for (const record of inDueOrder(this.records.values(), (row) => row.created_at, (row) => row.event.event_id)) {
      if (outcome.reclaimed + outcome.dead >= limit) break;
      if (record.status !== "pending" || record.claimed_at === null) continue;
      if (new Date(record.next_attempt_at).getTime() > now.getTime()) continue;
      const reclaims = record.reclaims + 1;
      // The budget is spent either way, so the count on the row is the same on
      // both branches: what changes is whether the row is allowed to be tried
      // again. Recording it on the dead row too is what makes the dead-letter
      // explain itself — without it, `status = 'dead'` on a row with
      // `attempts = 0` looks like a bug rather than a payload nobody survived.
      const exhausted = reclaimExhausted(record.reclaims, maxReclaims);
      putRow("outbox", this.records, record.event.event_id, {
        ...record,
        reclaims,
        status: exhausted ? "dead" : record.status,
        claimed_at: null,
        // Taking the claim away invalidates its token. This is the write that
        // makes the stalled worker's later acknowledgement refusable (B-26):
        // without it, the row would still recognise a holder that no longer
        // holds it.
        claim_token: null,
        // Due immediately. The row already waited out a whole lease for a worker
        // that never came back; making it wait again would turn one crash into
        // two delays. Left as-is on the dead branch too: nothing reads
        // `next_attempt_at` on a terminal row, and rewriting it would suggest
        // something is still going to happen.
        next_attempt_at: exhausted ? record.next_attempt_at : now.toISOString(),
        last_error: exhausted
          ? reclaimExhaustedError(reclaims, record.attempts)
          : reclaimedError(reclaims, record.attempts),
      });
      if (exhausted) outcome.dead += 1;
      else outcome.reclaimed += 1;
    }
    return outcome;
  }

  /**
   * These three replace the record instead of mutating it in place.
   *
   * In-place mutation used to be harmless because none of them ran inside a
   * transaction. `markPublished` now does — it commits with the outbound
   * delivery rows — and the journal records a pre-image by reference, so
   * mutating the stored object would make the pre-image and the current value
   * the same object and roll back to nothing. Same bug `revokeSession` had.
   */
  async markPublished(
    eventId: string,
    fence: Fence,
    scope: TransactionScope = NO_SCOPE,
  ): Promise<boolean> {
    const record = this.records.get(eventId);
    // Read and fence-check with no await before the write, for the reason on the
    // class: a yield point between the check and the write is a race Postgres
    // does not have, and a permissive memory backend certifies bugs (B-12).
    if (!record || isFenced(record.claim_token, fence)) return false;
    journalMapWrite(scope, this.records, eventId);
    putRow("outbox", this.records, eventId, {
      ...record,
      status: "published",
      last_error: null,
      claimed_at: null,
      claim_token: null,
    });
    return true;
  }

  async markFailed(
    eventId: string,
    fence: Fence,
    error: string,
    nextAttemptAt: Date,
  ): Promise<boolean> {
    const record = this.records.get(eventId);
    if (!record || isFenced(record.claim_token, fence)) return false;
    putRow("outbox", this.records, eventId, {
      ...record,
      attempts: record.attempts + 1,
      last_error: error,
      next_attempt_at: nextAttemptAt.toISOString(),
      // The claim is over. `next_attempt_at` goes back to meaning a retry
      // schedule, which it can only do once nobody holds the row.
      claimed_at: null,
      claim_token: null,
    });
    return true;
  }

  async markDead(eventId: string, fence: Fence, error: string): Promise<boolean> {
    const record = this.records.get(eventId);
    if (!record || isFenced(record.claim_token, fence)) return false;
    putRow("outbox", this.records, eventId, {
      ...record,
      attempts: record.attempts + 1,
      status: "dead",
      last_error: error,
      claimed_at: null,
      claim_token: null,
    });
    return true;
  }

  /**
   * `order by created_at, event_id`, the same keys as `PgOutbox.all`. Map
   * insertion order agreed with that only while every fixture appended in
   * timestamp order; a replay, a back-dated append or a redelivered event breaks
   * the coincidence.
   */
  async all(): Promise<OutboxRecord[]> {
    return orderedBy(
      this.records.values(),
      (r) => r.created_at,
      (r) => r.event.event_id,
    );
  }

  async byStatus(status: OutboxStatus): Promise<OutboxRecord[]> {
    return (await this.all()).filter((r: OutboxRecord) => r.status === status);
  }

  /** See `OutboxStore.selectDead`. */
  async selectDead(selection: OutboxRevivalSelection): Promise<OutboxRecord[]> {
    return [...this.records.values()]
      .filter((record) =>
        matchesOutboxRevival(
          {
            status: record.status,
            event_id: record.event.event_id,
            event_type: record.event.event_type,
            producer: record.event.producer,
            entity_type: record.event.entity_type,
            entity_id: record.event.entity_id,
            occurred_at: record.event.occurred_at,
          },
          selection,
        ),
      )
      .sort((a, b) =>
        compareRevivalPosition(
          { primary: a.event.occurred_at, secondary: a.event.event_id },
          { primary: b.event.occurred_at, secondary: b.event.event_id },
        ),
      )
      .slice(0, selection.limit);
  }

  /** See `OutboxStore.revive`. */
  async revive(eventId: string, now: Date): Promise<boolean> {
    const record = this.records.get(eventId);
    // Read and write with no await between them, like the acknowledgements above:
    // Postgres does this in one statement and the memory backend must not be the
    // permissive one (B-12).
    if (!record || record.status !== "dead") return false;
    putRow("outbox", this.records, eventId, {
      ...record,
      status: "pending",
      next_attempt_at: now.toISOString(),
      claimed_at: null,
      claim_token: null,
      reclaims: 0,
    });
    return true;
  }

  async counts(): Promise<Record<string, number>> {
    return tallyByStatus([...this.records.values()], undefined, this.clock.now());
  }
}
