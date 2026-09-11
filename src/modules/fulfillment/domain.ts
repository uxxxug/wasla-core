/**
 * Fulfillment coordination domain (ADR 0006).
 *
 * CORE coordinates a fulfillment as an OPAQUE reference: it never learns what
 * was ordered (MARKET's business) and never learns who executes it or how
 * (MOVE's business). It only knows that a commercial order needs operational
 * execution, and it owns the money hold that guards that execution.
 */
export type FulfillmentStatus =
  | "coordinating"
  | "dispatched"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Where the money that guards this fulfillment currently stands, as known by
 * CORE. This is a projection of the money module's authorization state onto
 * the fulfillment, kept so that execution state and financial state can be
 * compared without a cross-module join.
 *
 * - `none`      no hold guards this fulfillment (unfunded coordination).
 * - `held`      the hold exists and is still authorized.
 * - `captured`  the hold was captured; the money moved.
 * - `released`  the hold was voided; no money moved.
 * - `unsettled` CORE closed the execution but could NOT bring the hold to a
 *               terminal state. This is the only inconsistent value and it is
 *               deliberately explicit: it must be reconciled by an operator.
 */
export type SettlementState = "none" | "held" | "captured" | "released" | "unsettled";

export interface Fulfillment {
  fulfillment_id: string;
  organization_id: string;
  market_order_reference: string;
  move_job_reference: string | null;
  /** CORE-owned money hold guarding this fulfillment; null when unfunded. */
  payment_authorization_id: string | null;
  status: FulfillmentStatus;
  /** Financial counterpart of `status`; see SettlementState. */
  settlement_state: SettlementState;
  created_at: string;
  completed_at: string | null;
  closure_reason: string | null;
}

export function isClosed(status: FulfillmentStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * A fulfillment is financially consistent when its execution state and its
 * money state agree:
 *  - open work may only hold money or hold none of it;
 *  - a completed execution must have captured the hold it declared;
 *  - a failed or cancelled execution must have released it;
 *  - `unsettled` is never consistent.
 */
export function isFinanciallyConsistent(fulfillment: Fulfillment): boolean {
  const { status, settlement_state: settlement } = fulfillment;
  if (settlement === "unsettled") return false;
  if (!isClosed(status)) return settlement === "none" || settlement === "held";
  if (settlement === "held") return false;
  if (status === "completed") return settlement === "captured" || settlement === "none";
  return settlement === "released" || settlement === "none";
}

export interface MarketOrderCreatedPayload {
  order_id: string;
  organization_id: string;
  requested_service: string;
  /** Optional CORE money hold created by MARKET before submitting the order. */
  payment_authorization_id?: string | null;
}

export interface MoveJobAcceptedPayload {
  fulfillment_id: string;
  job_id: string;
  accepted_at: string;
}

export interface MoveJobRejectedPayload {
  fulfillment_id: string;
  reason: string;
  rejected_at: string;
}

export interface MoveJobCompletedPayload {
  fulfillment_id: string;
  job_id: string;
  outcome: "completed" | "failed";
  completed_at: string;
}
