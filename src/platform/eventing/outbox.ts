import type { Clock } from "../clock.js";
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
  append(event: EventEnvelope): void;
  claimDue(now: Date, limit: number): OutboxRecord[];
  markPublished(eventId: string): void;
  markFailed(eventId: string, error: string, nextAttemptAt: Date): void;
  markDead(eventId: string, error: string): void;
  all(): OutboxRecord[];
  byStatus(status: OutboxStatus): OutboxRecord[];
}

export class InMemoryOutbox implements OutboxStore {
  private records = new Map<string, OutboxRecord>();
  constructor(private readonly clock: Clock) {}

  append(event: EventEnvelope): void {
    if (this.records.has(event.event_id)) return;
    this.records.set(event.event_id, {
      event,
      status: "pending",
      attempts: 0,
      last_error: null,
      next_attempt_at: this.clock.now().toISOString(),
    });
  }

  claimDue(now: Date, limit: number): OutboxRecord[] {
    const due: OutboxRecord[] = [];
    for (const record of this.records.values()) {
      if (record.status !== "pending") continue;
      if (new Date(record.next_attempt_at).getTime() > now.getTime()) continue;
      due.push(record);
      if (due.length >= limit) break;
    }
    return due;
  }

  markPublished(eventId: string): void {
    const record = this.records.get(eventId);
    if (!record) return;
    record.status = "published";
    record.last_error = null;
  }

  markFailed(eventId: string, error: string, nextAttemptAt: Date): void {
    const record = this.records.get(eventId);
    if (!record) return;
    record.attempts += 1;
    record.last_error = error;
    record.next_attempt_at = nextAttemptAt.toISOString();
  }

  markDead(eventId: string, error: string): void {
    const record = this.records.get(eventId);
    if (!record) return;
    record.attempts += 1;
    record.status = "dead";
    record.last_error = error;
  }

  all(): OutboxRecord[] {
    return [...this.records.values()];
  }

  byStatus(status: OutboxStatus): OutboxRecord[] {
    return this.all().filter((r) => r.status === status);
  }
}
