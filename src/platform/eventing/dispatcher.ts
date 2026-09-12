import type { Clock } from "../clock.js";
import { NO_WORKER_METRICS, type WorkerMetrics } from "../observability/worker-metrics.js";
import type { EventBus } from "./bus.js";
import type { InboundEventStore } from "./ingress.js";
import { DEFAULT_MAX_RECLAIMS } from "./reclaim.js";

export interface DispatcherResult {
  processed: number;
  failed: number;
  dead: number;
  /** Rows a previous process claimed and never acknowledged (B-24). */
  reclaimed: number;
  /**
   * Rows dead-lettered because they have now been abandoned more times than
   * `maxReclaims` allows (B-25). Separate from `dead`, which counts events a
   * handler actually rejected `maxAttempts` times: one says the event is bad, this
   * says nothing lived long enough to judge it.
   */
  reclaim_exhausted: number;
  /**
   * Acknowledgements the store refused because this dispatcher no longer held the
   * claim (B-26). It stalled past its lease and recovery gave the row away; the
   * event was still put on the bus, but the row's outcome now belongs to whoever
   * holds the claim. Refusing here is what stops a stale success from marking an
   * event processed whose newer attempt actually failed.
   */
  fenced: number;
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
    /**
     * How many abandonments one row is allowed before it is dead-lettered instead
     * of recovered (B-25). Last, so no existing positional caller moves.
     */
    private readonly maxReclaims = DEFAULT_MAX_RECLAIMS,
  ) {}

  async drainOnce(limit = 100): Promise<DispatcherResult> {
    const now = this.clock.now();
    const result: DispatcherResult = {
      processed: 0,
      failed: 0,
      dead: 0,
      reclaimed: 0,
      reclaim_exhausted: 0,
      fenced: 0,
    };
    // Recovery first, so a restart picks up what the previous process abandoned
    // before it starts adding work of its own. This is the only place an expired
    // lease is directly observable for this worker: the row was claimed by some
    // process that never acknowledged it (B-24). Before `claimed_at` existed the
    // row simply became due again and the death of a worker was indistinguishable
    // from an event politely asking to be retried.
    //
    // A recovery charges its own budget rather than `attempts` (B-25); once that
    // budget runs out the row is dead-lettered, which is reported as
    // `failed_permanent` because it is terminal, and not as `reclaimed`, because
    // the recovery is precisely what did not happen. For this queue a dead row is
    // also the one an operator can act on: `dead` is a default status of the replay
    // selector, so the event is recoverable by hand rather than lost.
    const reclaim = await this.store.reclaimExpired(now, this.maxReclaims, limit);
    result.reclaimed = reclaim.reclaimed;
    result.reclaim_exhausted = reclaim.dead;
    this.metrics.outcome("reclaimed", reclaim.reclaimed);
    this.metrics.outcome("failed_permanent", reclaim.dead);
    const due = await this.store.claimDue(now, limit);
    this.metrics.claimed(due.length);

    for (const record of due) {
      const stop = this.metrics.startItem();
      try {
        await this.bus.publish(record.event);
        // Nothing here is transactional, so a refusal is reported and dropped
        // rather than thrown: unlike the relay there are no sibling writes to roll
        // back (B-26).
        const applied = await this.store.markProcessed(record.event.event_id, record.claim_token);
        if (applied) {
          result.processed += 1;
          this.metrics.outcome("completed");
        } else {
          result.fenced += 1;
          this.metrics.outcome("fenced");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (record.attempts + 1 >= this.maxAttempts) {
          // Dead, not discarded. An event CORE accepted and then could never
          // process is an operational fact someone has to see; the row keeps
          // the envelope and the last error so it can be replayed by hand once
          // the cause is fixed.
          const applied = await this.store.markDead(
            record.event.event_id,
            record.claim_token,
            message,
          );
          if (applied) {
            result.dead += 1;
            this.metrics.outcome("failed_permanent");
          } else {
            result.fenced += 1;
            this.metrics.outcome("fenced");
          }
        } else {
          const delay = this.baseBackoffMs * 2 ** record.attempts;
          const applied = await this.store.markFailed(
            record.event.event_id,
            record.claim_token,
            message,
            new Date(now.getTime() + delay),
          );
          if (applied) {
            result.failed += 1;
            this.metrics.outcome("retried");
          } else {
            result.fenced += 1;
            this.metrics.outcome("fenced");
          }
        }
      } finally {
        stop();
      }
    }
    return result;
  }
}
