import { iso, isoRequired, runner, type Queryable } from "../../platform/persistence/postgres.js";
import { NO_SCOPE, type TransactionScope } from "../../platform/persistence/transaction.js";
import type { Fulfillment, FulfillmentStatus, SettlementState } from "./domain.js";
import type { ConditionalWrite, FulfillmentRepository, InsertOutcome } from "./service.js";

interface FulfillmentRow {
  fulfillment_id: string;
  organization_id: string;
  market_order_reference: string;
  move_job_reference: string | null;
  payment_authorization_id: string | null;
  status: FulfillmentStatus;
  settlement_state: SettlementState;
  created_at: Date;
  completed_at: Date | null;
  closure_reason: string | null;
  executed_after_cancellation_at: Date | null;
  executed_after_cancellation_job_reference: string | null;
}

const toFulfillment = (row: FulfillmentRow): Fulfillment => ({
  fulfillment_id: row.fulfillment_id,
  organization_id: row.organization_id,
  market_order_reference: row.market_order_reference,
  move_job_reference: row.move_job_reference,
  payment_authorization_id: row.payment_authorization_id,
  status: row.status,
  settlement_state: row.settlement_state,
  created_at: isoRequired(row.created_at),
  completed_at: iso(row.completed_at),
  closure_reason: row.closure_reason,
  executed_after_cancellation_at: iso(row.executed_after_cancellation_at),
  executed_after_cancellation_job_reference: row.executed_after_cancellation_job_reference,
});

const COLUMNS = `fulfillment_id, organization_id, market_order_reference, move_job_reference,
  payment_authorization_id, status, settlement_state, created_at, completed_at, closure_reason,
  executed_after_cancellation_at, executed_after_cancellation_job_reference`;

/**
 * The insert list: every column, the two B-29 markers included.
 *
 * They were left out on the grounds that a fulfillment is never born marked, and
 * on every code path in CORE that is still true. What the omission actually did
 * was discard a caller's values without saying so: the reference store kept the
 * markers a caller passed to `insert` and Postgres wrote nulls, so the two
 * backends held different rows and the schema's two coupling constraints never
 * saw the row they exist to refuse. `tests/check-parity.test.ts` measured that.
 * Binding two usually-null parameters is cheaper than a silent divergence, and
 * with them bound the database refuses an inconsistent marker on the insert path
 * as well as on the update path.
 */
const INSERT_COLUMNS = COLUMNS;

/**
 * Postgres adapter for the fulfillment port.
 *
 * The references to MARKET and MOVE stay opaque strings here exactly as they
 * are in the domain: this adapter stores an order reference and a job
 * reference and knows nothing about orders or jobs. That boundary is the
 * reason CORE can be the source of coordination state without owning either
 * side's model.
 *
 * `fulfillment_settlement_alignment_check` in the schema refuses any row whose
 * settlement state contradicts its status, so an adapter bug that wrote an
 * inconsistent pair is rejected by the database rather than persisted.
 */
export class PgFulfillmentRepository implements FulfillmentRepository {
  constructor(private readonly pool: Queryable) {}

  async insert(fulfillment: Fulfillment, scope: TransactionScope = NO_SCOPE): Promise<void> {
    await runner(this.pool, scope).query(
      `insert into fulfillment (${INSERT_COLUMNS}) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        fulfillment.fulfillment_id,
        fulfillment.organization_id,
        fulfillment.market_order_reference,
        fulfillment.move_job_reference,
        fulfillment.payment_authorization_id,
        fulfillment.status,
        fulfillment.settlement_state,
        fulfillment.created_at,
        fulfillment.completed_at,
        fulfillment.closure_reason,
        fulfillment.executed_after_cancellation_at,
        fulfillment.executed_after_cancellation_job_reference,
      ],
    );
  }

  /**
   * Insert unless the order reference is already taken, decided by the unique
   * index rather than by a prior read.
   *
   * `on conflict do nothing` is what makes this safe under concurrency: a second
   * transaction inserting the same order reference blocks on the uncommitted
   * index entry and, once the first commits, affects zero rows instead of
   * raising. The caller learns it created nothing and publishes nothing.
   */
  async insertIfAbsent(
    fulfillment: Fulfillment,
    scope: TransactionScope = NO_SCOPE,
  ): Promise<InsertOutcome> {
    const result = await runner(this.pool, scope).query(
      `insert into fulfillment (${INSERT_COLUMNS}) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict do nothing`,
      [
        fulfillment.fulfillment_id,
        fulfillment.organization_id,
        fulfillment.market_order_reference,
        fulfillment.move_job_reference,
        fulfillment.payment_authorization_id,
        fulfillment.status,
        fulfillment.settlement_state,
        fulfillment.created_at,
        fulfillment.completed_at,
        fulfillment.closure_reason,
        fulfillment.executed_after_cancellation_at,
        fulfillment.executed_after_cancellation_job_reference,
      ],
    );
    return result.rowCount === 1 ? "inserted" : "duplicate_order_reference";
  }

  async update(fulfillment: Fulfillment, scope: TransactionScope = NO_SCOPE): Promise<void> {
    await runner(this.pool, scope).query(
      // Every mutable column, the two B-29 markers included: a whole-row update
      // that leaves two of the row's columns alone is an update that silently
      // ignores part of what it was given, and the reference store — which
      // replaces the row outright — would then hold something different.
      `update fulfillment
       set move_job_reference = $2, payment_authorization_id = $3, status = $4,
           settlement_state = $5, completed_at = $6, closure_reason = $7,
           executed_after_cancellation_at = $8,
           executed_after_cancellation_job_reference = $9
       where fulfillment_id = $1`,
      [
        fulfillment.fulfillment_id,
        fulfillment.move_job_reference,
        fulfillment.payment_authorization_id,
        fulfillment.status,
        fulfillment.settlement_state,
        fulfillment.completed_at,
        fulfillment.closure_reason,
        fulfillment.executed_after_cancellation_at,
        fulfillment.executed_after_cancellation_job_reference,
      ],
    );
  }

  /**
   * The transition write. Identical to `update` plus `and status = any($10)`,
   * and that predicate is the entire fix for B-21.
   *
   * Under READ COMMITTED two transitions of the same row serialise on the row
   * lock: the second `update` waits for the first to commit and then re-evaluates
   * its `where` clause against the committed row. A row that has left `expected`
   * no longer matches, so the statement affects zero rows and this returns
   * `stale` — the losing caller learns it changed nothing while it can still
   * abort, instead of overwriting a closure that already published its event.
   *
   * `rowCount` is the report, not an inferred success: `update ... where` with no
   * match is not an error in SQL, which is exactly why the previous unconditional
   * version could not tell a first closure from a second one.
   */
  async updateIfStatusIn(
    fulfillment: Fulfillment,
    expected: readonly FulfillmentStatus[],
    scope: TransactionScope = NO_SCOPE,
  ): Promise<ConditionalWrite> {
    const result = await runner(this.pool, scope).query(
      `update fulfillment
       set move_job_reference = $2, payment_authorization_id = $3, status = $4,
           settlement_state = $5, completed_at = $6, closure_reason = $7,
           executed_after_cancellation_at = $8,
           executed_after_cancellation_job_reference = $9
       where fulfillment_id = $1 and status = any($10::text[])`,
      [
        fulfillment.fulfillment_id,
        fulfillment.move_job_reference,
        fulfillment.payment_authorization_id,
        fulfillment.status,
        fulfillment.settlement_state,
        fulfillment.completed_at,
        fulfillment.closure_reason,
        fulfillment.executed_after_cancellation_at,
        fulfillment.executed_after_cancellation_job_reference,
        [...expected],
      ],
    );
    return result.rowCount === 1 ? "applied" : "stale";
  }

  /** See `FulfillmentRepository.markExecutedAfterCancellation`. */
  async markExecutedAfterCancellation(
    input: { fulfillment_id: string; executed_at: string; job_reference: string },
    scope: TransactionScope = NO_SCOPE,
  ): Promise<ConditionalWrite> {
    const result = await runner(this.pool, scope).query(
      // Both predicates matter and neither is redundant with the check
      // constraints: `status = 'cancelled'` is what the constraint asserts, and
      // repeating it here turns a violation into a `stale` answer the caller can
      // act on instead of a raised error; `is null` is what makes the marker
      // single-valued, so two deliveries of the same report cannot both publish.
      `update fulfillment
       set executed_after_cancellation_at = $2, executed_after_cancellation_job_reference = $3
       where fulfillment_id = $1 and status = 'cancelled'
         and executed_after_cancellation_at is null`,
      [input.fulfillment_id, input.executed_at, input.job_reference],
    );
    return result.rowCount === 1 ? "applied" : "stale";
  }

  async get(fulfillmentId: string): Promise<Fulfillment | undefined> {
    const result = await this.pool.query<FulfillmentRow>(
      `select ${COLUMNS} from fulfillment where fulfillment_id = $1`,
      [fulfillmentId],
    );
    const row = result.rows[0];
    return row ? toFulfillment(row) : undefined;
  }

  async findByOrderReference(orderReference: string): Promise<Fulfillment | undefined> {
    const result = await this.pool.query<FulfillmentRow>(
      `select ${COLUMNS} from fulfillment where market_order_reference = $1`,
      [orderReference],
    );
    const row = result.rows[0];
    return row ? toFulfillment(row) : undefined;
  }

  async all(): Promise<readonly Fulfillment[]> {
    const result = await this.pool.query<FulfillmentRow>(
      `select ${COLUMNS} from fulfillment order by created_at, fulfillment_id`,
    );
    return result.rows.map(toFulfillment);
  }
}
