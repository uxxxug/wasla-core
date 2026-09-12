import type { Clock } from "../clock.js";
import { NO_WORKER_METRICS, type WorkerMetrics } from "../observability/worker-metrics.js";
import type { TransactionBoundary } from "../persistence/transaction.js";
import type { EventBus } from "./bus.js";
import type { EventEnvelope } from "./envelope.js";
import type { OutboxStore } from "./outbox.js";
import type { TransactionScope } from "../persistence/transaction.js";

/**
 * Anything that turns one published event into durable follow-on work.
 *
 * Structural on purpose, and declared here rather than imported: `DeliveryFanOut`
 * (webhooks to systems) and the notification module's fan-out (messages to
 * people) both satisfy it, and the relay must not know which is which. Declaring
 * it in the platform keeps the dependency pointing inwards — a module implements
 * a platform interface, the platform never imports a module (ADR 0017).
 *
 * Every implementation runs on the relay's scope, so its writes commit with
 * `markPublished` or not at all.
 */
export interface EventFanOut {
  queueFor(event: EventEnvelope, scope: TransactionScope): Promise<unknown>;
}

export interface PublisherResult {
  published: number;
  failed: number;
  dead: number;
  /** Rows a previous process claimed and never acknowledged (B-24). */
  reclaimed: number;
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
    /**
     * Outbound fan-outs, optional so the eventing tests can run the relay with
     * no notion of external subscribers at all. A list because there is more
     * than one kind of follow-on work — deliveries to systems and notifications
     * to people — and they must all commit with `markPublished` rather than one
     * of them being run afterwards on its own.
     */
    fanOut?: EventFanOut | readonly EventFanOut[],
    private readonly boundary?: TransactionBoundary,
    /**
     * Optional so the eventing tests can run the relay with no notion of
     * observability. Records transitions only; it never queries or writes.
     */
    private readonly metrics: WorkerMetrics = NO_WORKER_METRICS,
  ) {
    this.fanOuts = fanOut === undefined ? [] : Array.isArray(fanOut) ? [...fanOut] : [fanOut as EventFanOut];
  }

  private readonly fanOuts: readonly EventFanOut[];

  async drainOnce(limit = 100): Promise<PublisherResult> {
    const now = this.clock.now();
    const result: PublisherResult = { published: 0, failed: 0, dead: 0, reclaimed: 0 };
    // Recovery first, so a restart picks up what the previous process abandoned
    // before it starts adding work of its own. This is the only place an expired
    // lease is directly observable for this worker: the row was claimed by some
    // process that never acknowledged it (B-24). Before `claimed_at` existed the
    // row simply became due again and the death of a worker was indistinguishable
    // from an event politely asking to be retried.
    result.reclaimed = await this.outbox.reclaimExpired(now, limit);
    this.metrics.outcome("reclaimed", result.reclaimed);
    const due = await this.outbox.claimDue(now, limit);
    this.metrics.claimed(due.length);

    for (const record of due) {
      const stop = this.metrics.startItem();
      try {
        await this.bus.publish(record.event);
        // Marking the row published and queueing its external deliveries are
        // one transaction. As two, a crash between them would leave an event
        // marked published that no subscriber will ever be sent — the
        // dual-write problem the outbox exists to prevent, moved one step
        // downstream. Re-running the fan-out is free: the delivery rows are
        // unique per (event, subscription).
        if (this.fanOuts.length > 0 && this.boundary) {
          const fanOuts = this.fanOuts;
          await this.boundary.run(async (scope) => {
            for (const fanOut of fanOuts) await fanOut.queueFor(record.event, scope);
            await this.outbox.markPublished(record.event.event_id, scope);
          });
        } else {
          await this.outbox.markPublished(record.event.event_id);
        }
        result.published += 1;
        this.metrics.outcome("completed");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (record.attempts + 1 >= this.maxAttempts) {
          await this.outbox.markDead(record.event.event_id, message);
          result.dead += 1;
          this.metrics.outcome("failed_permanent");
        } else {
          const delay = this.baseBackoffMs * 2 ** record.attempts;
          await this.outbox.markFailed(
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
