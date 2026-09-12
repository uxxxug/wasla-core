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
 * - `captured`  the hold was captured in full; the whole consented amount moved.
 * - `released`  the hold was voided and **no money moved at all**.
 * - `partially_captured`
 *               the hold closed with part of the consented amount having moved
 *               and the remainder released. Since migration 0009 a hold can be
 *               captured in legs, so this is a reachable terminal money state
 *               and it is NOT the same fact as `released`: calling it
 *               `released` would claim nothing moved when some did, and the
 *               settlement state is what a reconciliation trusts.
 * - `unsettled` CORE closed the execution but could NOT bring the hold to a
 *               terminal state. It must be reconciled by an operator.
 */
export type SettlementState =
  | "none"
  | "held"
  | "captured"
  | "partially_captured"
  | "released"
  | "unsettled";

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
 *  - a completed execution must have captured the hold it declared, in full or
 *    in part — a job that cost less than the consented ceiling is a legitimate
 *    outcome of migration 0009's split captures;
 *  - a failed or cancelled execution must have released it and moved nothing;
 *  - `unsettled` is never consistent.
 *
 * `partially_captured` on a **failed or cancelled** fulfillment is deliberately
 * reported as inconsistent. Nothing is broken in CORE's bookkeeping — the money
 * state is terminal and truthful — but the payer has paid for work that did not
 * complete, and whether that money is refunded, kept as a cancellation fee or
 * split is a policy decision CORE has not been given (blocker B-20). Surfacing
 * it in the reconciliation read is the reversible direction: an operator can
 * act on a case CORE reported, and cannot act on one it hid.
 */
export function isFinanciallyConsistent(fulfillment: Fulfillment): boolean {
  const { status, settlement_state: settlement } = fulfillment;
  if (settlement === "unsettled") return false;
  if (!isClosed(status)) return settlement === "none" || settlement === "held";
  if (settlement === "held") return false;
  if (status === "completed") {
    return settlement === "captured" || settlement === "partially_captured" || settlement === "none";
  }
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
