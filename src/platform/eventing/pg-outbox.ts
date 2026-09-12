import type { Clock } from "../clock.js";
import { iso, isoRequired, runner, type Queryable } from "../persistence/postgres.js";
import { NO_SCOPE, type TransactionScope } from "../persistence/transaction.js";
import type { EventEnvelope } from "./envelope.js";
import type { OutboxRecord, OutboxStatus, OutboxStore } from "./outbox.js";
import { tallyRows, type CountRow } from "./queue-counts.js";

interface OutboxRow {
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
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: Date;
  claimed_at: Date | null;
}

function toRecord(row: OutboxRow): OutboxRecord {
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
    claimed_at: iso(row.claimed_at),
  };
}

/** The insert list. Positional, so `claimed_at` stays out of it: a new row is by
 * definition unclaimed and the column defaults to null. */
const COLUMNS = `event_id, event_type, version, producer, occurred_at, correlation_id,
  causation_id, entity_type, entity_id, payload, status, attempts, last_error, next_attempt_at`;

/** Everything a read returns, including the claim (B-24). */
const SELECT_COLUMNS = `${COLUMNS}, claimed_at`;

/**
 * Durable outbox (ADR 0009).
 *
 * `append` runs on the caller's transaction scope, so the event row and the
 * state change it describes commit together or not at all. That is the whole
 * reason the outbox exists; running it on the pool instead of the scope would
 * silently reintroduce the dual-write problem the pattern is meant to remove.
 *
 * The relay's own calls (`claimDue`, `markPublished`, `markFailed`, `markDead`)
 * are deliberately outside the producing transaction: publication is a separate
 * concern from the state change and must not be able to roll it back.
 */
export class PgOutbox implements OutboxStore {
  constructor(
    private readonly pool: Queryable,
    private readonly clock: Clock,
  ) {}

  async append(event: EventEnvelope, scope: TransactionScope = NO_SCOPE): Promise<void> {
    await runner(this.pool, scope).query(
      `insert into outbox (${COLUMNS}, created_at)
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
  }

  async get(eventId: string): Promise<OutboxRecord | undefined> {
    const result = await this.pool.query<OutboxRow>(
      `select ${SELECT_COLUMNS} from outbox where event_id = $1`,
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
   * column, so the lease and the retry schedule are read off one timer.
   *
   * B-24 added the missing half of that: `claimed_at` says which of the two
   * meanings `next_attempt_at` currently carries, and this query takes only rows
   * where it is null. A row held by a process that died is therefore no longer
   * silently re-served when its lease runs out — `reclaimExpired` frees it, and
   * counts it, which is what makes a dying worker visible instead of merely slow.
   *
   * `for update skip locked` still does the work of keeping two simultaneous
   * claims apart; `claimed_at` is about the interval *after* the statement
   * commits, which no row lock covers.
   */
  async claimDue(now: Date, limit: number, leaseMs = 30_000): Promise<OutboxRecord[]> {
    const result = await this.pool.query<OutboxRow>(
      `update outbox set next_attempt_at = $1::timestamptz + ($3::bigint * interval '1 millisecond'),
                         claimed_at = $1
       where event_id in (
         select event_id from outbox
         where status = 'pending' and claimed_at is null and next_attempt_at <= $1
         order by next_attempt_at, created_at
         limit $2
         for update skip locked
       )
       returning ${SELECT_COLUMNS}`,
      [iso(now), limit, String(leaseMs)],
    );
    return result.rows.map(toRecord);
  }

  /** See `OutboxStore.reclaimExpired`. */
  async reclaimExpired(now: Date, limit = 100): Promise<number> {
    const result = await this.pool.query(
      `update outbox
          set claimed_at = null,
              next_attempt_at = $1,
              last_error = 'abandoned claim reclaimed after attempt ' || attempts
       where event_id in (
         select event_id from outbox
         where status = 'pending' and claimed_at is not null and next_attempt_at <= $1
         order by next_attempt_at
         limit $2
         for update skip locked
       )`,
      [iso(now), limit],
    );
    return result.rowCount ?? 0;
  }

  /** Takes a scope: it commits with the outbound delivery rows it fans out to. */
  async markPublished(eventId: string, scope: TransactionScope = NO_SCOPE): Promise<void> {
    await runner(this.pool, scope).query(
      `update outbox set status = 'published', last_error = null, claimed_at = null
       where event_id = $1`,
      [eventId],
    );
  }

  async markFailed(eventId: string, error: string, nextAttemptAt: Date): Promise<void> {
    await this.pool.query(
      // Clearing the claim is what puts `next_attempt_at` back to meaning a
      // retry schedule; leaving it set would make the retry look like a lease.
      `update outbox set attempts = attempts + 1, last_error = $2, next_attempt_at = $3,
                         claimed_at = null
       where event_id = $1`,
      [eventId, error, iso(nextAttemptAt)],
    );
  }

  async markDead(eventId: string, error: string): Promise<void> {
    await this.pool.query(
      `update outbox set attempts = attempts + 1, status = 'dead', last_error = $2,
                         claimed_at = null
       where event_id = $1`,
      [eventId, error],
    );
  }

  async all(): Promise<OutboxRecord[]> {
    const result = await this.pool.query<OutboxRow>(
      `select ${SELECT_COLUMNS} from outbox order by created_at, event_id`,
    );
    return result.rows.map(toRecord);
  }

  async counts(): Promise<Record<string, number>> {
    const result = await this.pool.query<CountRow>(
      `select status,
              count(*) as total,
              count(*) filter (where status = 'pending' and attempts > 0) as retrying,
              count(*) filter (where status = 'pending' and claimed_at is not null
                                 and next_attempt_at > $1) as in_flight,
              count(*) filter (where status = 'pending' and claimed_at is not null
                                 and next_attempt_at <= $1) as abandoned
       from outbox group by status`,
      [iso(this.clock.now())],
    );
    return tallyRows(result.rows, ["pending", "published", "dead"]);
  }

  async byStatus(status: OutboxStatus): Promise<OutboxRecord[]> {
    const result = await this.pool.query<OutboxRow>(
      `select ${SELECT_COLUMNS} from outbox where status = $1 order by created_at, event_id`,
      [status],
    );
    return result.rows.map(toRecord);
  }
}
