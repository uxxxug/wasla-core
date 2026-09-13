import type { Clock } from "../clock.js";
import { iso, isoRequired, runner, type Queryable } from "../persistence/postgres.js";
import { NO_SCOPE, type TransactionScope } from "../persistence/transaction.js";
import type { EventEnvelope } from "./envelope.js";
import { newClaimToken, type Fence } from "./fencing.js";
import type {
  InboundEventStore,
  InboundRecord,
  InboundSelection,
  InboundStatus,
} from "./ingress.js";
import type { ReclaimOutcome } from "./reclaim.js";
import { tallyRows, type CountRow } from "./queue-counts.js";

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
  received_at: Date;
  processed_at: Date | null;
  claimed_at: Date | null;
  reclaims: number;
  claim_token: string | null;
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
    received_at: isoRequired(row.received_at),
    processed_at: iso(row.processed_at),
    claimed_at: iso(row.claimed_at),
    reclaims: row.reclaims,
    claim_token: row.claim_token,
  };
}

/** The insert list. Positional, so `claimed_at` stays out of it: a newly accepted
 * event is by definition unclaimed and the column defaults to null. */
const COLUMNS = `event_id, event_type, version, producer, occurred_at, correlation_id,
  causation_id, entity_type, entity_id, payload, status, attempts, last_error, next_attempt_at,
  received_at`;

/**
 * Everything a read returns, including the claim (B-24), its budget (B-25) and the
 * token that fences it (B-26).
 */
const SELECT_COLUMNS = `${COLUMNS}, processed_at, claimed_at, reclaims, claim_token`;

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
      `insert into inbound_event (${COLUMNS})
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
      `select ${SELECT_COLUMNS} from inbound_event where event_id = $1`,
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
   * B-24 added the missing half: `claimed_at` says which of the two meanings
   * `next_attempt_at` currently carries, and this query takes only rows where it
   * is null. A row held by a dispatcher that died is therefore no longer
   * silently re-served when its lease runs out — `reclaimExpired` frees it, and
   * counts it, which is what makes a dying dispatcher visible instead of slow.
   */
  async claimDue(now: Date, limit: number, leaseMs = 30_000): Promise<InboundRecord[]> {
    const result = await this.pool.query<InboundRow>(
      // The batch is returned in the order it was claimed.
      //
      // Milestone 22: the selection below has always been ordered, but
      // `update ... returning` hands rows back in whatever order it updated
      // them — a heap scan — so the worker processed the batch in storage
      // order while the reference backend processed it in due order. The two
      // agreed only while rows were inserted in the order they came due. The
      // rank is carried out of the selection because the update overwrites
      // `next_attempt_at` with the lease expiry, so the due order cannot be
      // recovered afterwards.
      `with due as (
         select event_id from inbound_event
         where status = 'pending' and claimed_at is null and next_attempt_at <= $1
         order by next_attempt_at, received_at, event_id
         limit $2
         for update skip locked
       ),
       ranked as (
         select d.event_id as due_id,
                row_number() over (order by i.next_attempt_at, i.received_at, i.event_id) as due_rank
         from due d join inbound_event i on i.event_id = d.event_id
       ),
       claimed as (
         update inbound_event set next_attempt_at = $1::timestamptz + ($3::bigint * interval '1 millisecond'),
                                  claimed_at = $1,
                                  claim_token = $4
         from ranked r
         where inbound_event.event_id = r.due_id
         returning r.due_rank as due_rank, ${SELECT_COLUMNS}
       )
       select ${SELECT_COLUMNS} from claimed order by due_rank`,
      // One token for the batch; see `PgOutbox.claimDue` for why per-row would
      // cost one statement per row and refuse nothing extra.
      [iso(now), limit, String(leaseMs), newClaimToken()],
    );
    return result.rows.map(toRecord);
  }

  /**
   * See `InboundEventStore.reclaimExpired`. One statement, two outcomes (B-25):
   * every `reclaims` on the right-hand side reads the pre-update value, so the
   * increment and the three CASEs that branch on it agree with each other, and the
   * decision cannot be split across two statements where two dispatchers could
   * both read the same remaining budget.
   */
  async reclaimExpired(now: Date, maxReclaims: number, limit = 100): Promise<ReclaimOutcome> {
    const result = await this.pool.query<{ status: InboundStatus }>(
      `update inbound_event
          set reclaims = reclaims + 1,
              claimed_at = null,
              -- The token dies with the claim, which is what makes a late
              -- acknowledgement from the previous holder refusable (B-26).
              claim_token = null,
              status = case when reclaims + 1 > $3 then 'dead' else status end,
              next_attempt_at = case when reclaims + 1 > $3 then next_attempt_at else $1 end,
              last_error = case when reclaims + 1 > $3
                then 'reclaim limit exceeded: abandoned ' || (reclaims + 1) || ' times after attempt ' || attempts
                else 'abandoned claim ' || (reclaims + 1) || ' reclaimed after attempt ' || attempts end
       where event_id in (
         select event_id from inbound_event
         where status = 'pending' and claimed_at is not null and next_attempt_at <= $1
         -- Two keys, not one: with a limit, ordering by next_attempt_at alone is
         -- not a total order over rows that became due in the same millisecond,
         -- so which rows a recovery run picked was left to the plan (milestone
         -- 21). The reference backend spells the same two keys.
         order by next_attempt_at, received_at, event_id
         limit $2
         for update skip locked
       )
       returning status`,
      [iso(now), limit, maxReclaims],
    );
    const dead = result.rows.filter((row) => row.status === "dead").length;
    return { reclaimed: result.rows.length - dead, dead };
  }

  /**
   * Fenced on `claim_token` (B-26). `$2::text is null` is the `UNFENCED` case: the
   * replay service advances a row it never claimed, and is the only caller in CORE
   * that may. Everything else passes the token `claimDue` handed it, so a
   * dispatcher that lost its claim cannot mark an event processed that its own
   * attempt never finished.
   */
  async markProcessed(eventId: string, fence: Fence): Promise<boolean> {
    const result = await this.pool.query(
      `update inbound_event
       set status = 'processed', last_error = null, processed_at = $3, claimed_at = null,
           claim_token = null
       where event_id = $1 and ($2::text is null or claim_token = $2)
       returning event_id`,
      [eventId, fence, this.clock.now().toISOString()],
    );
    return result.rows.length === 1;
  }

  async markFailed(
    eventId: string,
    fence: Fence,
    error: string,
    nextAttemptAt: Date,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `update inbound_event
       -- Clearing the claim is what puts next_attempt_at back to meaning a retry
       -- schedule; leaving it set would make the retry look like a lease.
       set attempts = attempts + 1, last_error = $3, next_attempt_at = $4, claimed_at = null,
           claim_token = null
       where event_id = $1 and ($2::text is null or claim_token = $2)
       returning event_id`,
      [eventId, fence, error, iso(nextAttemptAt)],
    );
    return result.rows.length === 1;
  }

  async markDead(eventId: string, fence: Fence, error: string): Promise<boolean> {
    const result = await this.pool.query(
      `update inbound_event
       set status = 'dead', attempts = attempts + 1, last_error = $3, claimed_at = null,
           claim_token = null
       where event_id = $1 and ($2::text is null or claim_token = $2)
       returning event_id`,
      [eventId, fence, error],
    );
    return result.rows.length === 1;
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
       from inbound_event group by status`,
      [iso(this.clock.now())],
    );
    return tallyRows(result.rows, ["pending", "processed", "dead"]);
  }

  async byStatus(status: InboundStatus): Promise<InboundRecord[]> {
    const result = await this.pool.query<InboundRow>(
      `select ${SELECT_COLUMNS} from inbound_event where status = $1 order by received_at`,
      [status],
    );
    return result.rows.map(toRecord);
  }

  async all(): Promise<InboundRecord[]> {
    const result = await this.pool.query<InboundRow>(
      `select ${SELECT_COLUMNS} from inbound_event order by received_at`,
    );
    return result.rows.map(toRecord);
  }

  /**
   * A scoped slice of the history, in `(received_at, event_id)` order.
   *
   * Every filter is a parameter, never interpolated text: this query is built
   * from an operator's arguments, so string concatenation here would be an
   * injection point in the one tool that runs with the widest privileges CORE
   * has. The `where` clause grows by predicate, and each predicate is `$n`.
   *
   * No index is added for it. A scoped replay is a rare operator action, not a
   * request path, and `inbound_event_producer_idx (producer, received_at desc)`
   * already covers the common "what did this producer send" narrowing; adding
   * indexes for the rest would slow every ingress write to speed up an operation
   * that runs by hand.
   */
  async select(selection: InboundSelection): Promise<InboundRecord[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };
    if (selection.event_ids) where.push(`event_id = any(${bind(selection.event_ids)}::uuid[])`);
    if (selection.event_types) where.push(`event_type = any(${bind(selection.event_types)}::text[])`);
    if (selection.producer !== undefined) where.push(`producer = ${bind(selection.producer)}`);
    if (selection.statuses) where.push(`status = any(${bind(selection.statuses)}::text[])`);
    if (selection.received_from !== undefined) {
      where.push(`received_at >= ${bind(selection.received_from)}::timestamptz`);
    }
    if (selection.received_to !== undefined) {
      where.push(`received_at <= ${bind(selection.received_to)}::timestamptz`);
    }
    if (selection.occurred_from !== undefined) {
      where.push(`occurred_at >= ${bind(selection.occurred_from)}::timestamptz`);
    }
    if (selection.occurred_to !== undefined) {
      where.push(`occurred_at <= ${bind(selection.occurred_to)}::timestamptz`);
    }
    if (selection.after) {
      // Row-value comparison, so the cursor is strictly after the last position
      // in exactly the same order the rows are returned in. Comparing the two
      // columns separately would either skip rows sharing a timestamp or repeat
      // them, which is the difference between a resumable replay and a replay
      // that quietly loses an event on resume.
      where.push(
        `(received_at, event_id) > (${bind(selection.after.received_at)}::timestamptz, ${bind(
          selection.after.event_id,
        )}::uuid)`,
      );
    }
    const clause = where.length > 0 ? `where ${where.join(" and ")}` : "";
    const result = await this.pool.query<InboundRow>(
      `select ${SELECT_COLUMNS} from inbound_event ${clause}
       order by received_at, event_id
       limit ${bind(selection.limit)}`,
      values,
    );
    return result.rows.map(toRecord);
  }
}
