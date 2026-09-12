import type { Clock } from "../clock.js";
import type { MetricsRegistry } from "./metrics.js";

/**
 * The reads a depth sample needs. Structural rather than imported, so the
 * sampler depends on nothing: the notification store lives in a module and the
 * queues live in the platform, and the platform must not import a module
 * (ADR 0017).
 */
export interface DepthSources {
  outbox: { counts(): Promise<Record<string, number>> };
  inbound: { counts(): Promise<Record<string, number>> };
  delivery: { counts(): Promise<Record<string, number>> };
  notification: { counts(organizationId?: string | null): Promise<Record<string, number>> };
  /**
   * Reconciliation reads, called without an organization so the result is the
   * platform-wide count. Optional because the eventing tests sample queues with
   * no fulfillment service wired.
   */
  reconciliation?: {
    listFinanciallyInconsistent(organizationId?: string): Promise<readonly unknown[]>;
    listPendingFinancialDecision(organizationId?: string): Promise<readonly unknown[]>;
    listStaleHolds(organizationId?: string): Promise<readonly unknown[]>;
  };
}

/**
 * Depth sampler.
 *
 * Gauges are the one part of the exposition that cannot be accumulated as work
 * happens: "how many rows are pending" is a question about the table, not about
 * anything this process did. So they are sampled — and sampled *here*, on a
 * schedule the operator controls, rather than inside the scrape.
 *
 * Sampling in the scrape would mean every scraper, every dashboard refresh and
 * every curious engineer with `curl` costs a set of aggregate queries against
 * the busiest tables in the system, and a monitoring system that gets slower the
 * more you look at it is a monitoring system people stop looking at. It would
 * also make the exposition non-deterministic and give the readiness of the
 * metrics endpoint a dependency on the database being up.
 *
 * The trade is that a gauge is as old as the last sample. That is why
 * `core_sample_timestamp_seconds` is exported next to it: a stale sample must be
 * visible as staleness, never mistaken for an empty queue.
 *
 * Nothing here writes. A sample is only ever `select count(*)`-shaped work and
 * the reconciliation reads, which are already read-only by construction.
 */
export class DepthSampler {
  constructor(
    private readonly registry: MetricsRegistry,
    private readonly sources: DepthSources,
    private readonly clock: Clock,
  ) {}

  async sample(): Promise<void> {
    try {
      const [outbox, inbound, delivery, notification] = await Promise.all([
        this.sources.outbox.counts(),
        this.sources.inbound.counts(),
        this.sources.delivery.counts(),
        this.sources.notification.counts(),
      ]);
      this.publish("outbox", outbox);
      this.publish("inbound", inbound);
      this.publish("event_delivery", delivery);
      this.publish("notification", notification);

      if (this.sources.reconciliation) {
        const reconciliation = this.sources.reconciliation;
        const [inconsistent, pendingDecision, staleHolds] = await Promise.all([
          reconciliation.listFinanciallyInconsistent(),
          reconciliation.listPendingFinancialDecision(),
          reconciliation.listStaleHolds(),
        ]);
        // Counts only, and platform-wide. The rows themselves name an
        // organization, a fulfillment and an order reference; the count names
        // nobody. This is the line milestone 8 draws: the reconciliation API
        // answers "which ones" under a tenant-scoped permission, and the metric
        // answers "how many" for the system as a whole.
        this.registry.setGauge("core_reconciliation_depth", { queue: "inconsistent" }, inconsistent.length);
        this.registry.setGauge(
          "core_reconciliation_depth",
          { queue: "pending_financial_decision" },
          pendingDecision.length,
        );
        this.registry.setGauge("core_reconciliation_depth", { queue: "stale_holds" }, staleHolds.length);
      }

      this.registry.setGauge("core_sample_timestamp_seconds", {}, Math.floor(this.clock.now().getTime() / 1000));
    } catch {
      // A failed sample must not take down the caller's loop, and must not
      // leave the previous gauges looking fresh: the timestamp is only advanced
      // on success, so a rising failure count beside a frozen timestamp is the
      // signal. The error itself is not put in a metric — it would be a label
      // carrying a database message.
      this.registry.increment("core_sample_failures_total", {});
    }
  }

  private publish(queue: string, counts: Record<string, number>): void {
    for (const [state, value] of Object.entries(counts)) {
      this.registry.setGauge("core_queue_depth", { queue, state }, value);
    }
  }
}
