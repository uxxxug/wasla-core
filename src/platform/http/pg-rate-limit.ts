import type { Queryable } from "../persistence/postgres.js";
import type { RateLimitKey, RateLimitWindowStore } from "./rate-limit.js";

/**
 * Postgres rate-limit windows.
 *
 * Shared state, so the limit is the limit no matter how many instances are
 * running — the reason this exists next to the in-memory store rather than
 * instead of it.
 *
 * The increment is one statement. `insert … on conflict … do update … returning`
 * takes a row lock for the duration of that statement and returns the value it
 * wrote, so two concurrent callers at the boundary of the budget get 100 and 101,
 * never 100 and 100. This is the same failure that was found and fixed as B-22 in
 * the worker claim: a read followed by a write is not a decision, it is two
 * decisions racing. Written as an upsert here so there is no version of the code
 * where a `select` precedes the `update`.
 *
 * It also runs on the pool directly and never inside the request's transaction
 * scope: budget spent must survive a rolled-back request, and a refused request
 * must not hold a transaction open at all.
 */
export class PgRateLimitWindowStore implements RateLimitWindowStore {
  constructor(private readonly db: Queryable) {}

  async hit(key: RateLimitKey, windowStart: Date): Promise<number> {
    const result = await this.db.query<{ hits: string }>(
      `insert into rate_limit_counter
         (subject_kind, subject_hash, rate_class, window_start, hits, updated_at)
       values ($1, $2, $3, $4, 1, now())
       on conflict (subject_kind, subject_hash, rate_class, window_start)
       do update set hits = rate_limit_counter.hits + 1, updated_at = now()
       returning hits`,
      [key.subject_kind, key.subject_hash, key.rate_class, windowStart],
    );
    // bigint arrives as a string from the driver; the count is far below the
    // safe-integer range for any window length CORE would use.
    return Number(result.rows[0]?.hits ?? 0);
  }

  async prune(before: Date): Promise<number> {
    const result = await this.db.query<{ window_start: Date }>(
      `delete from rate_limit_counter where window_start < $1 returning window_start`,
      [before],
    );
    return result.rows.length;
  }
}
