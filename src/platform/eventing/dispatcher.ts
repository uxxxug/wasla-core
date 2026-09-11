import type { Clock } from "../clock.js";
import type { EventBus } from "./bus.js";
import type { InboundEventStore } from "./ingress.js";

export interface DispatcherResult {
  processed: number;
  failed: number;
  dead: number;
}

/**
 * Inbound dispatcher: the mirror of `OutboxPublisher`.
 *
 * The publisher moves events CORE produced from a durable row onto the bus.
 * This moves events CORE *received* from a durable row onto the bus. Both run
 * out-of-band from the transaction that created the row, and for the same
 * reason: a crash between the commit and the handing-off loses nothing,
 * because the row is still pending and will be picked up again.
 *
 * Exactly-once effects do not come from here. This is at-least-once by
 * construction — a crash after the handler succeeded but before
 * `markProcessed` will dispatch the event again. What makes that safe is the
 * consumer inbox, which claims `(consumer, event_id)` before the handler runs,
 * so the second dispatch is a no-op. Retrying a dispatch is cheap precisely
 * because the layer below refuses to do the work twice.
 */
export class InboundDispatcher {
  constructor(
    private readonly store: InboundEventStore,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly maxAttempts = 5,
    private readonly baseBackoffMs = 1000,
  ) {}

  async drainOnce(limit = 100): Promise<DispatcherResult> {
    const now = this.clock.now();
    const due = await this.store.claimDue(now, limit);
    const result: DispatcherResult = { processed: 0, failed: 0, dead: 0 };

    for (const record of due) {
      try {
        await this.bus.publish(record.event);
        await this.store.markProcessed(record.event.event_id);
        result.processed += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (record.attempts + 1 >= this.maxAttempts) {
          // Dead, not discarded. An event CORE accepted and then could never
          // process is an operational fact someone has to see; the row keeps
          // the envelope and the last error so it can be replayed by hand once
          // the cause is fixed.
          await this.store.markDead(record.event.event_id, message);
          result.dead += 1;
        } else {
          const delay = this.baseBackoffMs * 2 ** record.attempts;
          await this.store.markFailed(
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
