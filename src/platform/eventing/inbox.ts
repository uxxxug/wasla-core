import type { Clock } from "../clock.js";
import { putRow } from "../persistence/row-rules.js";

/**
 * One row of the `inbox` table, as the table declares it.
 *
 * The reference inbox used to be a `Set<string>` of `consumer::event_id`, which
 * modelled the primary key and nothing else: `received_at` (`NOT NULL DEFAULT
 * now()`) was never written, and `event_id` was never an id — a claim for
 * `"not-a-uuid"` was accepted in memory and refused by the database with
 * `invalid input syntax for type uuid`. Measured, not supposed (milestone 19).
 *
 * Rows now, so `inbox` passes the same gates as the 28 ruled tables rather than
 * being a table the parity work never reached.
 */
export interface InboxRow {
  consumer: string;
  event_id: string;
  received_at: string;
}

/**
 * Consumer inbox (ADR 0009). A consumer records an event id before handling it;
 * a second delivery of the same event id for the same consumer is a no-op.
 * This is what makes every handler idempotent under at-least-once delivery.
 */
export interface InboxStore {
  /** Returns true when this consumer has not seen the event before. */
  claim(consumer: string, eventId: string): Promise<boolean>;
  seen(consumer: string, eventId: string): Promise<boolean>;
  release(consumer: string, eventId: string): Promise<void>;
  size(): Promise<number>;
}

export class InMemoryInbox implements InboxStore {
  private entries = new Map<string, InboxRow>();
  /**
   * The clock the row's `received_at` comes from.
   *
   * Optional so the dozens of existing call sites that construct an inbox with
   * no arguments keep working, and defaulted to the system clock rather than to
   * a fixed one: a store that silently stamps every row with the epoch is worse
   * than one that reads the wall clock.
   */
  constructor(private readonly clock: Clock = { now: () => new Date() }) {}
  private key(consumer: string, eventId: string) {
    return `${consumer}::${eventId}`;
  }
  async claim(consumer: string, eventId: string): Promise<boolean> {
    const key = this.key(consumer, eventId);
    // Checked and written with no await in between: the same synchronous
    // check-then-write the outbox and the inbound store use, so two
    // simultaneous redeliveries race here the way they race on Postgres, where
    // the claim is one `insert … on conflict do nothing` (B-12).
    if (this.entries.has(key)) return false;
    putRow("inbox", this.entries, key, {
      consumer,
      event_id: eventId,
      // Written, never defaulted: the reference backend applies no database
      // default, so the store is where the value comes from.
      received_at: this.clock.now().toISOString(),
    });
    return true;
  }
  async seen(consumer: string, eventId: string): Promise<boolean> {
    return this.entries.has(this.key(consumer, eventId));
  }
  /** Used when a handler fails so the event can be retried. */
  async release(consumer: string, eventId: string): Promise<void> {
    this.entries.delete(this.key(consumer, eventId));
  }
  async size(): Promise<number> {
    return this.entries.size;
  }
}
