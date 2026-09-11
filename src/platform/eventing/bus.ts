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

  async publish(event: EventEnvelope): Promise<void> {
    if (!isValidEnvelope(event)) {
      throw new Error(`invalid event envelope: ${JSON.stringify(event)}`);
    }
    for (const sub of this.subs) {
      if (sub.event_type !== event.event_type) continue;
      await this.deliver(sub, event);
    }
  }

  private async deliver(sub: Subscription, event: EventEnvelope): Promise<void> {
    if (!(await this.inbox.claim(sub.consumer, event.event_id))) return; // duplicate delivery
    let attempts = 0;
    let lastError = "";
    while (attempts < this.maxAttempts) {
      attempts += 1;
      try {
        await sub.handler(event);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        await this.inbox.release(sub.consumer, event.event_id);
        if (attempts < this.maxAttempts) {
          this.inbox.claim(sub.consumer, event.event_id);
        }
      }
    }
    this.deadLetters.push({ event, consumer: sub.consumer, error: lastError, attempts });
  }
}
