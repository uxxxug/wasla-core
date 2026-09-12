import type { Clock } from "../clock.js";
import { iso, isoRequired, runner, type Queryable } from "../persistence/postgres.js";
import { NO_SCOPE, type TransactionScope } from "../persistence/transaction.js";
import type { EventEnvelope } from "./envelope.js";
import type { InboundEventStore, InboundRecord, InboundStatus } from "./ingress.js";
import { tallyRows } from "./queue-counts.js";

interface InboundRow {
  event_id: string;
  event_type: string;
  version: number;
  producer: string;
  occurred_at: Date;
  correlation_id: string;
  causation_id: string | null;
  entity_type: string;
  entity_id: string;
  payload: unknown;
  status: InboundStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: Date;
}

function toRecord(row: InboundRow): InboundRecord {
  const event: EventEnvelope = {
    event_id: row.event_id,
    event_type: row.event_type,
    version: row.version,
    producer: row.producer,
    occurred_at: isoRequired(row.occurred_at),
    correlation_id: row.correlation_id,
    causation_id: row.causation_id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    payload: row.payload,
  };
  return {
    event,
    status: row.status,
    attempts: row.attempts,
    last_error: row.last_error,
    next_attempt_at: isoRequired(row.next_attempt_at),
  };
}

const COLUMNS = `event_id, event_type, version, producer, occurred_at, correlation_id,
  causation_id, entity_type, entity_id, payload, status, attempts, last_error, next_attempt_at`;

/**
 * Durable ingress store on Postgres.
 *
 * `accept` runs on the caller's scope so the receipt commits before the
 * producer is answered, and its first-delivery answer comes from the database
 * rather than from a prior read: `on conflict do nothing` plus `rowCount` makes
 * the decision atomic, so two simultaneous redeliveries cannot both be told
 * they are the first. A check-then-insert would be exactly the race the money
 * store had.
 */
export class PgInboundEventStore implements InboundEventStore {
  constructor(
    private readonly pool: Queryable,
    private readonly clock: Clock,
  ) {}

  async accept(event: EventEnvelope, scope: TransactionScope = NO_SCOPE): Promise<boolean> {
    const result = await runner(this.pool, scope).query(
      `insert into inbound_event (${COLUMNS}, received_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',0,null,$11,$11)
       on conflict (event_id) do nothing`,
      [
        event.event_id,
        event.event_type,
        event.version,
        event.producer,
        event.occurred_at,
        event.correlation_id,
        event.causation_id,
        event.entity_type,
        event.entity_id,
        JSON.stringify(event.payload ?? null),
        this.clock.now().toISOString(),
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async get(eventId: string): Promise<InboundRecord | undefined> {
    const result = await this.pool.query<InboundRow>(
      `select ${COLUMNS} from inbound_event where event_id = $1`,
      [eventId],
    );
    const row = result.rows[0];
    return row ? toRecord(row) : undefined;
  }

  /**
   * Leases up to `limit` due records.
   *
   * The lease is the fix for blocker B-22. Before it, this method only *read*
   * due rows — on Postgres with `for update skip locked` in its own implicit
   * transaction, so the locks were gone the moment the statement returned, and
   * two workers polling together both received the same rows and both did the
   * work. Measured on a real database: two pools claiming five due rows each
   * got five rows each, all five shared.
   *
   * Claiming now writes: `next_attempt_at` moves out by the lease, so the row
   * is not due again until then and a second worker's identical query does not
   * see it. `next_attempt_at` doubles as the lease expiry rather than a new
   * column, so an abandoned claim comes back by the same clock that schedules
   * retries — one timer, one truth. A worker that dies mid-attempt costs one
   * lease of delay, which is the same trade every retry in CORE already makes.
   */
  async claimDue(now: Date, limit: number, leaseMs = 30_000): Promise<InboundRecord[]> {
    const result = await this.pool.query<InboundRow>(
      `update inbound_event set next_attempt_at = $1::timestamptz + ($3::bigint * interval '1 millisecond')
       where event_id in (
         select event_id from inbound_event
         where status = 'pending' and next_attempt_at <= $1
         order by next_attempt_at, received_at
         limit $2
         for update skip locked
       )
       returning ${COLUMNS}`,
      [iso(now), limit, String(leaseMs)],
    );
    return result.rows.map(toRecord);
  }

  async markProcessed(eventId: string): Promise<void> {
    await this.pool.query(
      `update inbound_event
       set status = 'processed', last_error = null, processed_at = $2
       where event_id = $1`,
      [eventId, this.clock.now().toISOString()],
    );
  }

  async markFailed(eventId: string, error: string, nextAttemptAt: Date): Promise<void> {
    await this.pool.query(
      `update inbound_event
       set attempts = attempts + 1, last_error = $2, next_attempt_at = $3
       where event_id = $1`,
      [eventId, error, iso(nextAttemptAt)],
    );
  }

  async markDead(eventId: string, error: string): Promise<void> {
    await this.pool.query(
      `update inbound_event
       set status = 'dead', attempts = attempts + 1, last_error = $2
       where event_id = $1`,
      [eventId, error],
    );
  }

  async counts(): Promise<Record<string, number>> {
    const result = await this.pool.query<{ status: InboundStatus; total: string; retrying: string }>(
      `select status,
              count(*) as total,
              count(*) filter (where status = 'pending' and attempts > 0) as retrying
       from inbound_event group by status`,
    );
    return tallyRows(result.rows, ["pending", "processed", "dead"]);
  }

  async byStatus(status: InboundStatus): Promise<InboundRecord[]> {
    const result = await this.pool.query<InboundRow>(
      `select ${COLUMNS} from inbound_event where status = $1 order by received_at`,
      [status],
    );
    return result.rows.map(toRecord);
  }

  async all(): Promise<InboundRecord[]> {
    const result = await this.pool.query<InboundRow>(
      `select ${COLUMNS} from inbound_event order by received_at`,
    );
    return result.rows.map(toRecord);
  }
}
