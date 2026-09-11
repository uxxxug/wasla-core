import type { Clock } from "../clock.js";
import type { TransactionScope } from "../persistence/transaction.js";
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
  claimDue(now: Date, limit: number): Promise<OutboxRecord[]>;
  markPublished(eventId: string): Promise<void>;
  markFailed(eventId: string, error: string, nextAttemptAt: Date): Promise<void>;
  markDead(eventId: string, error: string): Promise<void>;
  all(): Promise<OutboxRecord[]>;
  byStatus(status: OutboxStatus): Promise<OutboxRecord[]>;
}

export class InMemoryOutbox implements OutboxStore {
  private records = new Map<string, OutboxRecord>();
  constructor(private readonly clock: Clock) {}

  async append(event: EventEnvelope, _scope?: TransactionScope): Promise<void> {
    if (this.records.has(event.event_id)) return;
    this.records.set(event.event_id, {
      event,
      status: "pending",
      attempts: 0,
      last_error: null,
      next_attempt_at: this.clock.now().toISOString(),
    });
  }

  async claimDue(now: Date, limit: number): Promise<OutboxRecord[]> {
    const due: OutboxRecord[] = [];
    for (const record of this.records.values()) {
      if (record.status !== "pending") continue;
      if (new Date(record.next_attempt_at).getTime() > now.getTime()) continue;
      due.push(record);
      if (due.length >= limit) break;
    }
    return due;
  }

  async markPublished(eventId: string): Promise<void> {
    const record = this.records.get(eventId);
    if (!record) return;
    record.status = "published";
    record.last_error = null;
  }

  async markFailed(eventId: string, error: string, nextAttemptAt: Date): Promise<void> {
    const record = this.records.get(eventId);
    if (!record) return;
    record.attempts += 1;
    record.last_error = error;
    record.next_attempt_at = nextAttemptAt.toISOString();
  }

  async markDead(eventId: string, error: string): Promise<void> {
    const record = this.records.get(eventId);
    if (!record) return;
    record.attempts += 1;
    record.status = "dead";
    record.last_error = error;
  }

  async all(): Promise<OutboxRecord[]> {
    return [...this.records.values()];
  }

  async byStatus(status: OutboxStatus): Promise<OutboxRecord[]> {
    return (await this.all()).filter((r: OutboxRecord) => r.status === status);
  }
}
