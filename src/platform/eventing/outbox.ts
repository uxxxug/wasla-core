import type { Clock } from "../clock.js";
import { journalMapWrite, NO_SCOPE, type TransactionScope } from "../persistence/transaction.js";
import type { EventEnvelope } from "./envelope.js";

export type OutboxStatus = "pending" | "published" | "dead";

export interface OutboxRecord {
  event: EventEnvelope;
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
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
  /** One record by id. Outbound delivery needs the envelope long after it was published. */
  get(eventId: string): Promise<OutboxRecord | undefined>;
  markPublished(eventId: string, scope?: TransactionScope): Promise<void>;
  markFailed(eventId: string, error: string, nextAttemptAt: Date): Promise<void>;
  markDead(eventId: string, error: string): Promise<void>;
  all(): Promise<OutboxRecord[]>;
  byStatus(status: OutboxStatus): Promise<OutboxRecord[]>;
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
      last_error: null,
      next_attempt_at: this.clock.now().toISOString(),
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
   * column, so an abandoned claim comes back by the same clock that schedules
   * retries — one timer, one truth. A worker that dies mid-attempt costs one
   * lease of delay, which is the same trade every retry in CORE already makes.
   */
  async claimDue(now: Date, limit: number, leaseMs = 30_000): Promise<OutboxRecord[]> {
    const due: OutboxRecord[] = [];
    for (const record of this.records.values()) {
      if (record.status !== "pending") continue;
      if (new Date(record.next_attempt_at).getTime() > now.getTime()) continue;
      // Written before the next iteration, with no await in between, so two
      // interleaved drains cannot both take it.
      this.records.set(record.event.event_id, {
        ...record,
        next_attempt_at: new Date(now.getTime() + leaseMs).toISOString(),
      });
      due.push(record);
      if (due.length >= limit) break;
    }
    return due;
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
    this.records.set(eventId, { ...record, status: "published", last_error: null });
  }

  async markFailed(eventId: string, error: string, nextAttemptAt: Date): Promise<void> {
    const record = this.records.get(eventId);
    if (!record) return;
    this.records.set(eventId, {
      ...record,
      attempts: record.attempts + 1,
      last_error: error,
      next_attempt_at: nextAttemptAt.toISOString(),
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
    });
  }

  async all(): Promise<OutboxRecord[]> {
    return [...this.records.values()];
  }

  async byStatus(status: OutboxStatus): Promise<OutboxRecord[]> {
    return (await this.all()).filter((r: OutboxRecord) => r.status === status);
  }
}
