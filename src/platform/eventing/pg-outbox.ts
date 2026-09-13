import type { Clock } from "../clock.js";
import { iso, isoRequired, runner, type Queryable } from "../persistence/postgres.js";
import { NO_SCOPE, type TransactionScope } from "../persistence/transaction.js";
import type { EventEnvelope } from "./envelope.js";
import { newClaimToken, type Fence } from "./fencing.js";
import type { OutboxRecord, OutboxStatus, OutboxStore } from "./outbox.js";
import { tallyRows, type CountRow } from "./queue-counts.js";
import type { OutboxRevivalSelection } from "./revival.js";
import type { ReclaimOutcome } from "./reclaim.js";

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
  created_at: Date;
  claimed_at: Date | null;
  reclaims: number;
  claim_token: string | null;
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
    created_at: isoRequired(row.created_at),
    claimed_at: iso(row.claimed_at),
    reclaims: row.reclaims,
    claim_token: row.claim_token,
  };
}

/** The insert list. Positional, so `claimed_at` stays out of it: a new row is by
 * definition unclaimed and the column defaults to null. */
const COLUMNS = `event_id, event_type, version, producer, occurred_at, correlation_id,
  causation_id, entity_type, entity_id, payload, status, attempts, last_error, next_attempt_at`;

/**
 * Everything a read returns, including the claim (B-24), its budget (B-25) and
 * the token that fences it (B-26).
 */
const SELECT_COLUMNS = `${COLUMNS}, created_at, claimed_at, reclaims, claim_token`;

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
                         claimed_at = $1,
                         claim_token = $4
       where event_id in (
         select event_id from outbox
         where status = 'pending' and claimed_at is null and next_attempt_at <= $1
         order by next_attempt_at, created_at
         limit $2
         for update skip locked
       )
       returning ${SELECT_COLUMNS}`,
      // One token for this whole statement rather than per row. Two workers
      // still cannot share a claim — `for update skip locked` and `claimed_at is
      // null` see to that — and the fence only ever compares a row against the
      // holder of that row, so a token shared across one worker's own batch
      // refuses exactly the same acknowledgements a per-row token would. A
      // per-row token would need one statement per row, which is the round trip
      // this claim exists to avoid.
      [iso(now), limit, String(leaseMs), newClaimToken()],
    );
    return result.rows.map(toRecord);
  }

  /**
   * See `OutboxStore.reclaimExpired`. One statement, two outcomes (B-25).
   *
   * Recovering a row and giving up on it are decided from `reclaims`, which this
   * same statement increments; every `reclaims`
   * on the right-hand side reads the pre-update value, so the whole CASE agrees
   * with itself. Splitting it into a select-then-update would reintroduce exactly
   * the race `for update skip locked` is here to prevent: two workers reading the
   * same budget and both deciding the row still has room.
   *
   * `returning status` is how the caller separates the two, rather than a second
   * query or a count of a subset: the row itself says which branch it took.
   */
  async reclaimExpired(now: Date, maxReclaims: number, limit = 100): Promise<ReclaimOutcome> {
    const result = await this.pool.query<{ status: OutboxStatus }>(
      `update outbox
          set reclaims = reclaims + 1,
              claimed_at = null,
              -- Taking the claim away invalidates its token, which is what makes
              -- the stalled worker's later acknowledgement refusable (B-26).
              claim_token = null,
              status = case when reclaims + 1 > $3 then 'dead' else status end,
              -- Due immediately on the recovered branch; untouched once dead, the
              -- same as markDead leaves it, because nothing is going to happen at
              -- that time any more.
              next_attempt_at = case when reclaims + 1 > $3 then next_attempt_at else $1 end,
              last_error = case when reclaims + 1 > $3
                then 'reclaim limit exceeded: abandoned ' || (reclaims + 1) || ' times after attempt ' || attempts
                else 'abandoned claim ' || (reclaims + 1) || ' reclaimed after attempt ' || attempts end
       where event_id in (
         select event_id from outbox
         where status = 'pending' and claimed_at is not null and next_attempt_at <= $1
         order by next_attempt_at
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
   * Takes a scope: it commits with the outbound delivery rows it fans out to.
   *
   * Fenced on `claim_token` (B-26). The predicate is written as `$2::text is null
   * or claim_token = $2` so that one statement serves both a worker presenting a
   * token and the one legitimate caller that holds no claim (`UNFENCED`); the
   * alternative was building the SQL string conditionally, which is harder to read
   * and impossible to grep for. `returning event_id` rather than `rowCount`,
   * because the row itself saying it was updated is the same evidence on both
   * backends.
   */
  async markPublished(
    eventId: string,
    fence: Fence,
    scope: TransactionScope = NO_SCOPE,
  ): Promise<boolean> {
    const result = await runner(this.pool, scope).query(
      `update outbox set status = 'published', last_error = null, claimed_at = null,
                         claim_token = null
       where event_id = $1 and ($2::text is null or claim_token = $2)
       returning event_id`,
      [eventId, fence],
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
      // Clearing the claim is what puts `next_attempt_at` back to meaning a
      // retry schedule; leaving it set would make the retry look like a lease.
      `update outbox set attempts = attempts + 1, last_error = $3, next_attempt_at = $4,
                         claimed_at = null, claim_token = null
       where event_id = $1 and ($2::text is null or claim_token = $2)
       returning event_id`,
      [eventId, fence, error, iso(nextAttemptAt)],
    );
    return result.rows.length === 1;
  }

  async markDead(eventId: string, fence: Fence, error: string): Promise<boolean> {
    const result = await this.pool.query(
      `update outbox set attempts = attempts + 1, status = 'dead', last_error = $3,
                         claimed_at = null, claim_token = null
       where event_id = $1 and ($2::text is null or claim_token = $2)
       returning event_id`,
      [eventId, fence, error],
    );
    return result.rows.length === 1;
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

  /**
   * See `OutboxStore.selectDead`.
   *
   * Every filter is a bound parameter, never interpolated text. This query is
   * built from an operator's command line, so concatenation here would be an
   * injection point in a tool that runs with the widest privileges CORE has —
   * the same rule, for the same reason, as the replay `select`.
   *
   * No index is added. Reviving a dead row is a rare hand-run action, and
   * `outbox_due_idx` is partial on `status = 'pending'` so it cannot serve this
   * anyway; adding an index for the dead set would slow every relay write to
   * speed up an operation performed by a person a few times a year.
   */
  async selectDead(selection: OutboxRevivalSelection): Promise<OutboxRecord[]> {
    const values: unknown[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };
    // Not a parameter and not part of the selection type: revival looks at dead
    // rows and at nothing else.
    const where: string[] = ["status = 'dead'"];
    if (selection.event_ids) where.push(`event_id = any(${bind(selection.event_ids)}::uuid[])`);
    if (selection.event_types) {
      where.push(`event_type = any(${bind(selection.event_types)}::text[])`);
    }
    if (selection.producer !== undefined) where.push(`producer = ${bind(selection.producer)}`);
    if (selection.entity_type !== undefined) {
      where.push(`entity_type = ${bind(selection.entity_type)}`);
    }
    if (selection.entity_id !== undefined) where.push(`entity_id = ${bind(selection.entity_id)}`);
    if (selection.occurred_from !== undefined) {
      where.push(`occurred_at >= ${bind(selection.occurred_from)}::timestamptz`);
    }
    if (selection.occurred_to !== undefined) {
      where.push(`occurred_at <= ${bind(selection.occurred_to)}::timestamptz`);
    }
    if (selection.after) {
      // Row-value comparison, so the cursor is strictly after the last position in
      // exactly the order the rows come back in. Comparing the columns separately
      // would skip or repeat every row sharing an `occurred_at`.
      where.push(
        `(occurred_at, event_id) > (${bind(selection.after.occurred_at)}::timestamptz, ${bind(
          selection.after.event_id,
        )}::uuid)`,
      );
    }
    const result = await this.pool.query<OutboxRow>(
      `select ${SELECT_COLUMNS} from outbox where ${where.join(" and ")}
       order by occurred_at, event_id
       limit ${bind(selection.limit)}`,
      values,
    );
    return result.rows.map(toRecord);
  }

  /**
   * See `OutboxStore.revive`.
   *
   * One statement, and `status = 'dead'` is in the `where` clause rather than
   * checked first: a read-then-write would let two concurrent revivals both
   * believe they resurrected the row and both report so. `returning event_id`
   * with a one-row check is the same shape the fenced acknowledgements use.
   */
  async revive(eventId: string, now: Date): Promise<boolean> {
    const result = await this.pool.query<{ event_id: string }>(
      `update outbox
          set status = 'pending',
              next_attempt_at = $2,
              claimed_at = null,
              claim_token = null,
              reclaims = 0
        where event_id = $1 and status = 'dead'
        returning event_id`,
      [eventId, now],
    );
    return result.rows.length === 1;
  }
}
