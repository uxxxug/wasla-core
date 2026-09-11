import type { Clock } from "../clock.js";
import type { Queryable } from "../persistence/postgres.js";
import type { InboxStore } from "./inbox.js";

/**
 * Durable consumer inbox (ADR 0009).
 *
 * `claim` is a single `insert ... on conflict do nothing` and reports whether
 * the row was new. Doing it in one statement is what makes the claim safe when
 * two workers receive the same delivery at once: exactly one insert wins, so
 * exactly one worker handles the event. A `select` followed by an `insert`
 * would leave a window where both see nothing and both proceed.
 */
export class PgInbox implements InboxStore {
  constructor(
    private readonly pool: Queryable,
    private readonly clock: Clock,
  ) {}

  async claim(consumer: string, eventId: string): Promise<boolean> {
    const result = await this.pool.query(
      `insert into inbox (consumer, event_id, received_at)
       values ($1, $2, $3)
       on conflict (consumer, event_id) do nothing
       returning event_id`,
      [consumer, eventId, this.clock.now().toISOString()],
    );
    return result.rowCount === 1;
  }

  async seen(consumer: string, eventId: string): Promise<boolean> {
    const result = await this.pool.query(
      `select 1 from inbox where consumer = $1 and event_id = $2`,
      [consumer, eventId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Called when a handler failed, so the delivery can legitimately be retried. */
  async release(consumer: string, eventId: string): Promise<void> {
    await this.pool.query(`delete from inbox where consumer = $1 and event_id = $2`, [
      consumer,
      eventId,
    ]);
  }

  async size(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(`select count(*)::text from inbox`);
    return Number(result.rows[0]?.count ?? 0);
  }
}
