import type { MetricsRegistry } from "./metrics.js";

/**
 * The four background workers, named once so the label values are a closed set.
 * These names appear in the exposition and in the operations document; renaming
 * one breaks somebody's dashboard, so they are declared here rather than passed
 * as strings from the composition root.
 */
export type WorkerName = "outbox_relay" | "inbound_dispatcher" | "event_delivery" | "notification";

/**
 * How a claimed item ended. A closed set, and each value is a distinct
 * operational fact rather than a synonym:
 *
 * - `completed` — the work was done and acknowledged. Whether that meant
 *   published, processed, delivered or accepted by a provider is the worker's
 *   own vocabulary; at this level the question is only whether it is finished.
 * - `retried` — it failed and is scheduled to be tried again. Not a state in any
 *   table: the row is pending with attempts spent, which is exactly why this is
 *   a counter of transitions and not a gauge derived from a second store.
 * - `failed_permanent` — it will not be tried again. Somebody has to look.
 * - `fenced` — the acknowledgement was refused because the lease had moved on:
 *   this worker was doing work another worker had already taken over. A rising
 *   fenced count means leases are expiring under real load.
 * - `reclaimed` — an expired lease was returned to the queue by this worker,
 *   i.e. an item some process claimed and never acknowledged.
 */
export type WorkerOutcome = "completed" | "retried" | "failed_permanent" | "fenced" | "reclaimed";

export interface WorkerMetrics {
  claimed(count: number): void;
  outcome(outcome: WorkerOutcome, count?: number): void;
  /**
   * Starts timing one item; call the returned function once the outcome has been
   * recorded. Timed with a monotonic process clock rather than the injected
   * domain `Clock`, because the domain clock is deliberately controllable in
   * tests — a fixed clock would report every item as taking zero time, and a
   * latency histogram that is always zero is worse than no histogram.
   */
  startItem(): () => void;
}

const NOOP_STOP = (): void => {};

/**
 * Workers accept this when no registry is wired — the eventing tests construct
 * workers directly and must not have to know that observability exists.
 */
export const NO_WORKER_METRICS: WorkerMetrics = {
  claimed: () => {},
  outcome: () => {},
  startItem: () => NOOP_STOP,
};

export function workerMetrics(registry: MetricsRegistry, worker: WorkerName): WorkerMetrics {
  return {
    claimed(count: number): void {
      if (count > 0) registry.increment("core_worker_claims_total", { worker }, count);
    },
    outcome(outcome: WorkerOutcome, count = 1): void {
      if (count > 0) {
        registry.increment("core_worker_outcomes_total", { worker, outcome }, count);
      }
    },
    startItem(): () => void {
      const started = process.hrtime.bigint();
      return () => {
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        registry.observe("core_worker_item_duration_seconds", { worker }, seconds);
      };
    },
  };
}
