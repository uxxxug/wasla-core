/**
 * What one reclaim pass did, for all three eventing queues (B-25).
 *
 * `reclaimExpired` used to return a single number, which was enough while a
 * reclaim had exactly one outcome. It now has two — the row goes back to the
 * pending pool, or its abandonment budget ran out and it is dead-lettered — and
 * they are not interchangeable: one says a worker died and the work continues, the
 * other says the work has stopped and somebody has to look at it. A single total
 * would report a crash loop that is recovering and a crash loop that has given up
 * as the same number.
 */
export interface ReclaimOutcome {
  /** Returned to the pending pool and due immediately. Will be tried again. */
  reclaimed: number;
  /**
   * Dead-lettered instead of returned: this row has now been abandoned more times
   * than `maxReclaims` allows. Terminal — no worker will pick it up again.
   */
  dead: number;
}

/**
 * How many abandonments a row is allowed before it is dead-lettered instead of
 * recovered.
 *
 * Three. The budget exists to tell two things apart: an unlucky row, and a row
 * that kills whatever picks it up. A row is normally in flight for milliseconds,
 * so being abandoned even once is already unusual — it takes a process dying in
 * that window. Being abandoned three times is not luck; it is a property of the
 * row. One deploy, one restart and one genuine node failure fit inside the budget;
 * an out-of-memory on an oversized payload does not.
 *
 * Set low deliberately. The cost of stopping too early is a dead row an operator
 * can see and decide about; the cost of stopping too late is a worker that never
 * finishes a pass, and the queue behind it never drains.
 */
export const DEFAULT_MAX_RECLAIMS = 3;

/**
 * Whether this abandonment exceeds the budget, given the count *before* it.
 *
 * `maxReclaims` recoveries are allowed; the abandonment after that is terminal.
 * Shared by six store implementations so the boundary cannot drift between the two
 * backends the way `delivered_at` did (B-12).
 */
export function reclaimExhausted(reclaimsBefore: number, maxReclaims: number): boolean {
  return reclaimsBefore + 1 > maxReclaims;
}

/** `last_error` for a row that was recovered. `reclaims` is the count after this pass. */
export function reclaimedError(reclaims: number, attempts: number): string {
  return `abandoned claim ${reclaims} reclaimed after attempt ${attempts}`;
}

/** `last_error` for a row whose abandonment budget ran out. */
export function reclaimExhaustedError(reclaims: number, attempts: number): string {
  return `reclaim limit exceeded: abandoned ${reclaims} times after attempt ${attempts}`;
}
