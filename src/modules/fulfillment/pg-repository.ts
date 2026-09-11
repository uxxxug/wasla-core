import { iso, isoRequired, runner, type Queryable } from "../../platform/persistence/postgres.js";
import { NO_SCOPE, type TransactionScope } from "../../platform/persistence/transaction.js";
import type { Fulfillment, FulfillmentStatus, SettlementState } from "./domain.js";
import type { FulfillmentRepository } from "./service.js";

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
});

const COLUMNS = `fulfillment_id, organization_id, market_order_reference, move_job_reference,
  payment_authorization_id, status, settlement_state, created_at, completed_at, closure_reason`;

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
      `insert into fulfillment (${COLUMNS}) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
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
      ],
    );
  }

  async update(fulfillment: Fulfillment, scope: TransactionScope = NO_SCOPE): Promise<void> {
    await runner(this.pool, scope).query(
      `update fulfillment
       set move_job_reference = $2, payment_authorization_id = $3, status = $4,
           settlement_state = $5, completed_at = $6, closure_reason = $7
       where fulfillment_id = $1`,
      [
        fulfillment.fulfillment_id,
        fulfillment.move_job_reference,
        fulfillment.payment_authorization_id,
        fulfillment.status,
        fulfillment.settlement_state,
        fulfillment.completed_at,
        fulfillment.closure_reason,
      ],
    );
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
