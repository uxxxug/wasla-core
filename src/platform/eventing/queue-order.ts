import { compareValues } from "../persistence/list-order.js";
/**
 * The order in which a queue serves its rows.
 *
 * Every queue in CORE — the outbox, the inbound log, outbound deliveries — has
 * two operations that take a `limit`: `claimDue`, which hands work to a worker,
 * and `reclaimExpired`, which recovers work from a worker that never came back.
 * A `limit` turns an ordering into a *selection*: whichever rows sort first are
 * the rows that get served, and the rest wait for the next tick.
 *
 * Before milestone 21 that ordering was written twice and agreed once by
 * accident. `PgOutboxStore.claimDue` ordered by `(next_attempt_at, created_at)`
 * and `InMemoryOutbox.claimDue` did not sort at all — it walked the insertion
 * order of a `Map` — so with a retry pending the two backends claimed different
 * rows for the same call, and the reference backend served an event that was
 * appended first ahead of one that had been due for half an hour. All three
 * `reclaimExpired` implementations had the same gap, and the Postgres ones
 * ordered by `next_attempt_at` alone, which is not a total order over rows that
 * became due in the same millisecond: under a limit, Postgres was free to
 * recover a different subset on every call.
 *
 * One comparator, used by both backends, with an explicit tiebreak:
 *
 *   - **`next_attempt_at` first**, because it is the only column that says when
 *     a row was supposed to be served. Serving the longest-overdue row first is
 *     what stops a busy queue from starving a row for ever.
 *   - **then the row's own arrival**, `created_at` or `received_at`. Ties in
 *     `next_attempt_at` are not hypothetical: a batch appended in one
 *     transaction shares a timestamp to the millisecond.
 *   - **then the row's own id**, added in milestone 22, because the first two
 *     keys are not total either: a batch written in one transaction shares both
 *     timestamps, and a `limit` over a non-total order leaves the tail of the
 *     batch to the `Map` on one side and to the query plan on the other.
 *
 * The Postgres side spells the same two keys in its `order by`. Neither side is
 * allowed to rely on a natural order — a `Map`'s insertion sequence or a heap
 * scan — because "whatever order the storage happens to produce" is exactly the
 * kind of agreement that holds until the day it does not.
 */

/** A row a queue can serve. */
interface DueRow {
  readonly next_attempt_at: string;
}

/**
 * The rows, in the order both backends serve them.
 *
 * Returns a new array; the input is not touched, so a caller iterating the
 * store's own values is not reordering the store.
 */
export function inDueOrder<T extends DueRow>(
  rows: Iterable<T>,
  arrivalOf: (row: T) => string,
  idOf: (row: T) => string,
): T[] {
  return [...rows].sort(
    (left, right) =>
      compareValues(left.next_attempt_at, right.next_attempt_at) ||
      compareValues(arrivalOf(left), arrivalOf(right)) ||
      compareValues(idOf(left), idOf(right)),
  );
}
