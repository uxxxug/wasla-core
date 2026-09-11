/**
 * Consumer inbox (ADR 0009). A consumer records an event id before handling it;
 * a second delivery of the same event id for the same consumer is a no-op.
 * This is what makes every handler idempotent under at-least-once delivery.
 */
export interface InboxStore {
  /** Returns true when this consumer has not seen the event before. */
  claim(consumer: string, eventId: string): boolean;
  seen(consumer: string, eventId: string): boolean;
  release(consumer: string, eventId: string): void;
  size(): number;
}

export class InMemoryInbox implements InboxStore {
  private entries = new Set<string>();
  private key(consumer: string, eventId: string) {
    return `${consumer}::${eventId}`;
  }
  claim(consumer: string, eventId: string): boolean {
    const key = this.key(consumer, eventId);
    if (this.entries.has(key)) return false;
    this.entries.add(key);
    return true;
  }
  seen(consumer: string, eventId: string): boolean {
    return this.entries.has(this.key(consumer, eventId));
  }
  /** Used when a handler fails so the event can be retried. */
  release(consumer: string, eventId: string): void {
    this.entries.delete(this.key(consumer, eventId));
  }
  size(): number {
    return this.entries.size;
  }
}
