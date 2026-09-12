/**
 * Queue depth tallies, shared by the four durable queues and their two backends.
 *
 * Both helpers exist so that a gauge sampler can ask "how deep is this queue"
 * without fetching the queue. The alternative — `(await byStatus("pending")).length`
 * — reads every pending row into memory to count it, which is what the readiness
 * probe used to do and is the sort of thing that works until the day it matters.
 *
 * Every declared status is present in the result even when it is zero. A metric
 * that disappears when it reaches zero is indistinguishable from a metric that
 * was never recorded, and "no dead rows" must not look like "the sampler died".
 */

/** In-memory tally over records that carry a status and an attempt count. */
export function tallyByStatus(
  records: readonly { status: string; attempts: number }[],
  statuses: readonly string[] = ["pending", "published", "dead"],
): Record<string, number> {
  const counts: Record<string, number> = { retrying: 0 };
  for (const status of statuses) counts[status] = 0;
  for (const record of records) {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
    if (record.status === "pending" && record.attempts > 0) {
      counts["retrying"] = (counts["retrying"] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * The same shape from a grouped SQL result. `retrying` is summed across groups
 * because the filter clause only ever matches within the pending group, and
 * summing is correct whether or not that stays true.
 */
export function tallyRows(
  rows: readonly { status: string; total: string; retrying: string }[],
  statuses: readonly string[],
): Record<string, number> {
  const counts: Record<string, number> = { retrying: 0 };
  for (const status of statuses) counts[status] = 0;
  for (const row of rows) {
    counts[row.status] = Number(row.total);
    counts["retrying"] = (counts["retrying"] ?? 0) + Number(row.retrying);
  }
  return counts;
}
