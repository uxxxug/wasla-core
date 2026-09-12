import type { Clock } from "../clock.js";
import { NO_WORKER_METRICS, type WorkerMetrics } from "../observability/worker-metrics.js";
import type { EventBus } from "./bus.js";
import type { InboundEventStore } from "./ingress.js";

export interface DispatcherResult {
  processed: number;
  failed: number;
  dead: number;
  /** Rows a previous process claimed and never acknowledged (B-24). */
  reclaimed: number;
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
    private readonly metrics: WorkerMetrics = NO_WORKER_METRICS,
  ) {}

  async drainOnce(limit = 100): Promise<DispatcherResult> {
    const now = this.clock.now();
    const result: DispatcherResult = { processed: 0, failed: 0, dead: 0, reclaimed: 0 };
    // Recovery first, so a restart picks up what the previous process abandoned
    // before it starts adding work of its own. This is the only place an expired
    // lease is directly observable for this worker: the row was claimed by some
    // process that never acknowledged it (B-24). Before `claimed_at` existed the
    // row simply became due again and the death of a worker was indistinguishable
    // from an event politely asking to be retried.
    result.reclaimed = await this.store.reclaimExpired(now, limit);
    this.metrics.outcome("reclaimed", result.reclaimed);
    const due = await this.store.claimDue(now, limit);
    this.metrics.claimed(due.length);

    for (const record of due) {
      const stop = this.metrics.startItem();
      try {
        await this.bus.publish(record.event);
        await this.store.markProcessed(record.event.event_id);
        result.processed += 1;
        this.metrics.outcome("completed");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (record.attempts + 1 >= this.maxAttempts) {
          // Dead, not discarded. An event CORE accepted and then could never
          // process is an operational fact someone has to see; the row keeps
          // the envelope and the last error so it can be replayed by hand once
          // the cause is fixed.
          await this.store.markDead(record.event.event_id, message);
          result.dead += 1;
          this.metrics.outcome("failed_permanent");
        } else {
          const delay = this.baseBackoffMs * 2 ** record.attempts;
          await this.store.markFailed(
            record.event.event_id,
            message,
            new Date(now.getTime() + delay),
          );
          result.failed += 1;
          this.metrics.outcome("retried");
        }
      } finally {
        stop();
      }
    }
    return result;
  }
}
