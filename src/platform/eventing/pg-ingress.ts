import type { Clock } from "../clock.js";
import { iso, isoRequired, runner, type Queryable } from "../persistence/postgres.js";
import { NO_SCOPE, type TransactionScope } from "../persistence/transaction.js";
import type { EventEnvelope } from "./envelope.js";
import type { InboundEventStore, InboundRecord, InboundStatus } from "./ingress.js";

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

  /** `for update skip locked` is what lets two dispatchers run side by side. */
  async claimDue(now: Date, limit: number): Promise<InboundRecord[]> {
    const result = await this.pool.query<InboundRow>(
      `select ${COLUMNS} from inbound_event
       where status = 'pending' and next_attempt_at <= $1
       order by next_attempt_at, received_at
       limit $2
       for update skip locked`,
      [iso(now), limit],
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
