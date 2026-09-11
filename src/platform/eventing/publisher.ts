import type { Clock } from "../clock.js";
import type { EventBus } from "./bus.js";
import type { OutboxStore } from "./outbox.js";

export interface PublisherResult {
  published: number;
  failed: number;
  dead: number;
}

/**
 * Outbox relay. Runs out-of-band from the write transaction, so a crash between
 * commit and publish loses nothing: the record is still pending and gets retried.
 */
export class OutboxPublisher {
  constructor(
    private readonly outbox: OutboxStore,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly maxAttempts = 5,
    private readonly baseBackoffMs = 1000,
  ) {}

  async drainOnce(limit = 100): Promise<PublisherResult> {
    const now = this.clock.now();
    const due = await this.outbox.claimDue(now, limit);
    const result: PublisherResult = { published: 0, failed: 0, dead: 0 };

    for (const record of due) {
      try {
        await this.bus.publish(record.event);
        await this.outbox.markPublished(record.event.event_id);
        result.published += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (record.attempts + 1 >= this.maxAttempts) {
          await this.outbox.markDead(record.event.event_id, message);
          result.dead += 1;
        } else {
          const delay = this.baseBackoffMs * 2 ** record.attempts;
          await this.outbox.markFailed(
            record.event.event_id,
            message,
            new Date(now.getTime() + delay),
          );
          result.failed += 1;
        }
      }
    }
    return result;
  }
}
