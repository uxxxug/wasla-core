import type { EventEnvelope } from "./envelope.js";
import { isValidEnvelope } from "./envelope.js";
import type { InboxStore } from "./inbox.js";

export type EventHandler = (event: EventEnvelope) => Promise<void> | void;

export interface Subscription {
  consumer: string;
  event_type: string;
  handler: EventHandler;
}

export interface EventBus {
  subscribe(consumer: string, eventType: string, handler: EventHandler): void;
  publish(event: EventEnvelope): Promise<void>;
}

export interface DeadLetter {
  event: EventEnvelope;
  consumer: string;
  error: string;
  attempts: number;
}

/**
 * Logical event bus. Transport is deliberately swappable (in-process now,
 * broker later) — producers and consumers only depend on this interface.
 * Delivery is at-least-once; per-consumer idempotency comes from the inbox.
 */
export class LocalEventBus implements EventBus {
  private subs: Subscription[] = [];
  readonly deadLetters: DeadLetter[] = [];

  constructor(
    private readonly inbox: InboxStore,
    private readonly maxAttempts = 3,
  ) {}

  subscribe(consumer: string, eventType: string, handler: EventHandler): void {
    this.subs.push({ consumer, event_type: eventType, handler });
  }

  /**
   * Throws when any subscriber exhausted its attempts (B-13).
   *
   * It used to resolve successfully in that case, recording the failure only in
   * the in-process `deadLetters` array. That made `publish` say "delivered"
   * when nothing had been delivered, and both durable relays above it —
   * `OutboxPublisher` and `InboundDispatcher` — decide whether to retry from
   * exactly that answer. So an event could be marked `published` or
   * `processed` in the database while no consumer had done anything, and the
   * only trace of it died with the process. A relay that cannot be told about
   * failure cannot recover from it.
   */
  async publish(event: EventEnvelope): Promise<void> {
    if (!isValidEnvelope(event)) {
      throw new Error(`invalid event envelope: ${JSON.stringify(event)}`);
    }
    const failures: string[] = [];
    for (const sub of this.subs) {
      if (sub.event_type !== event.event_type) continue;
      const failure = await this.deliver(sub, event);
      if (failure) failures.push(`${sub.consumer}: ${failure}`);
    }
    if (failures.length > 0) {
      // Every subscriber is attempted before throwing: one broken consumer
      // must not stop the others from seeing the event.
      throw new Error(`event ${event.event_id} was not consumed by ${failures.join("; ")}`);
    }
  }

  /** Returns the error that ended the attempts, or `undefined` on success. */
  private async deliver(sub: Subscription, event: EventEnvelope): Promise<string | undefined> {
    // Duplicate delivery: already handled, and reporting success is correct.
    if (!(await this.inbox.claim(sub.consumer, event.event_id))) return undefined;
    let attempts = 0;
    let lastError = "";
    while (attempts < this.maxAttempts) {
      attempts += 1;
      try {
        await sub.handler(event);
        return undefined;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        await this.inbox.release(sub.consumer, event.event_id);
        // Awaited: an unawaited claim is a claim that may land after the
        // next attempt has already read the inbox.
        if (attempts < this.maxAttempts) {
          await this.inbox.claim(sub.consumer, event.event_id);
        }
      }
    }
    this.deadLetters.push({ event, consumer: sub.consumer, error: lastError, attempts });
    return lastError;
  }
}
