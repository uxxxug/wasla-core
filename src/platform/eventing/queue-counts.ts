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
 *
 * Three of the states are derived rather than stored, and all three are subsets
 * of `pending` — they are cuts through the pending rows, not extra rows, so they
 * must never be added to `pending` to get a total:
 *
 *   retrying   pending, and an attempt has already been spent
 *   in_flight  pending, claimed, lease not yet expired — being worked on now
 *   abandoned  pending, claimed, lease expired — the worker never came back
 *
 * `in_flight` and `abandoned` are what blocker B-24 was about. Before
 * `claimed_at` existed, a pending row with a future `next_attempt_at` was either
 * being worked on or sleeping off a backoff and nothing distinguished the two, so
 * "what is stuck" had no answer. `abandoned` is that answer, and it is the gauge
 * to alarm on: a healthy system holds a few rows in flight for milliseconds at a
 * time and abandons none.
 */

/** A record as the in-memory queues hold it: status, attempts, and its lease. */
interface CountableRecord {
  status: string;
  attempts: number;
  next_attempt_at: string;
  claimed_at: string | null;
}

/**
 * In-memory tally. `now` is passed rather than read from a clock because the
 * lease cut depends on the caller's notion of time, and a store that consults a
 * different clock than the worker polling it would report rows as abandoned that
 * the worker still holds.
 */
export function tallyByStatus(
  records: readonly CountableRecord[],
  statuses: readonly string[] = ["pending", "published", "dead"],
  now: Date = new Date(),
): Record<string, number> {
  const counts: Record<string, number> = { retrying: 0, in_flight: 0, abandoned: 0 };
  for (const status of statuses) counts[status] = 0;
  const bump = (key: string): void => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  for (const record of records) {
    bump(record.status);
    if (record.status !== "pending") continue;
    if (record.attempts > 0) bump("retrying");
    if (record.claimed_at !== null) {
      const expired = new Date(record.next_attempt_at).getTime() <= now.getTime();
      bump(expired ? "abandoned" : "in_flight");
    }
  }
  return counts;
}

/**
 * The same shape from a grouped SQL result. The derived states are summed across
 * groups because their filter clauses only ever match within the pending group,
 * and summing is correct whether or not that stays true.
 */
export interface CountRow {
  status: string;
  total: string;
  retrying: string;
  in_flight?: string;
  abandoned?: string;
}

export function tallyRows(
  rows: readonly CountRow[],
  statuses: readonly string[],
): Record<string, number> {
  const counts: Record<string, number> = { retrying: 0, in_flight: 0, abandoned: 0 };
  for (const status of statuses) counts[status] = 0;
  const add = (key: string, value: number): void => {
    counts[key] = (counts[key] ?? 0) + value;
  };
  for (const row of rows) {
    counts[row.status] = Number(row.total);
    add("retrying", Number(row.retrying));
    add("in_flight", Number(row.in_flight ?? 0));
    add("abandoned", Number(row.abandoned ?? 0));
  }
  return counts;
}
