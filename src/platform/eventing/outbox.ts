import type { Clock } from "../clock.js";
import { journalMapWrite, NO_SCOPE, type TransactionScope } from "../persistence/transaction.js";
import type { EventEnvelope } from "./envelope.js";
import { tallyByStatus } from "./queue-counts.js";
import {
  reclaimedError,
  reclaimExhausted,
  reclaimExhaustedError,
  type ReclaimOutcome,
} from "./reclaim.js";

export type OutboxStatus = "pending" | "published" | "dead";

export interface OutboxRecord {
  event: EventEnvelope;
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
  markPublished(eventId: string, scope?: TransactionScope): Promise<void>;
  markFailed(eventId: string, error: string, nextAttemptAt: Date): Promise<void>;
  markDead(eventId: string, error: string): Promise<void>;
  all(): Promise<OutboxRecord[]>;
  byStatus(status: OutboxStatus): Promise<OutboxRecord[]>;
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
  constructor(private readonly clock: Clock) {}

  async append(event: EventEnvelope, scope?: TransactionScope): Promise<void> {
    if (this.records.has(event.event_id)) return;
    journalMapWrite(scope, this.records, event.event_id);
    this.records.set(event.event_id, {
      event,
      status: "pending",
      attempts: 0,
      reclaims: 0,
      last_error: null,
      next_attempt_at: this.clock.now().toISOString(),
      claimed_at: null,
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
    for (const record of this.records.values()) {
      if (record.status !== "pending") continue;
      if (record.claimed_at !== null) continue;
      if (new Date(record.next_attempt_at).getTime() > now.getTime()) continue;
      // Written before the next iteration, with no await in between, so two
      // interleaved drains cannot both take it.
      const claimed: OutboxRecord = {
        ...record,
        next_attempt_at: new Date(now.getTime() + leaseMs).toISOString(),
        claimed_at: now.toISOString(),
      };
      this.records.set(record.event.event_id, claimed);
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
    for (const record of this.records.values()) {
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
      this.records.set(record.event.event_id, {
        ...record,
        reclaims,
        status: exhausted ? "dead" : record.status,
        claimed_at: null,
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
  async markPublished(eventId: string, scope: TransactionScope = NO_SCOPE): Promise<void> {
    const record = this.records.get(eventId);
    if (!record) return;
    journalMapWrite(scope, this.records, eventId);
    this.records.set(eventId, { ...record, status: "published", last_error: null, claimed_at: null });
  }

  async markFailed(eventId: string, error: string, nextAttemptAt: Date): Promise<void> {
    const record = this.records.get(eventId);
    if (!record) return;
    this.records.set(eventId, {
      ...record,
      attempts: record.attempts + 1,
      last_error: error,
      next_attempt_at: nextAttemptAt.toISOString(),
      // The claim is over. `next_attempt_at` goes back to meaning a retry
      // schedule, which it can only do once nobody holds the row.
      claimed_at: null,
    });
  }

  async markDead(eventId: string, error: string): Promise<void> {
    const record = this.records.get(eventId);
    if (!record) return;
    this.records.set(eventId, {
      ...record,
      attempts: record.attempts + 1,
      status: "dead",
      last_error: error,
      claimed_at: null,
    });
  }

  async all(): Promise<OutboxRecord[]> {
    return [...this.records.values()];
  }

  async byStatus(status: OutboxStatus): Promise<OutboxRecord[]> {
    return (await this.all()).filter((r: OutboxRecord) => r.status === status);
  }

  async counts(): Promise<Record<string, number>> {
    return tallyByStatus([...this.records.values()], undefined, this.clock.now());
  }
}
