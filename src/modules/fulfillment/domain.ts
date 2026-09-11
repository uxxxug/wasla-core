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

export interface Fulfillment {
  fulfillment_id: string;
  organization_id: string;
  market_order_reference: string;
  move_job_reference: string | null;
  /** CORE-owned money hold guarding this fulfillment; null when unfunded. */
  payment_authorization_id: string | null;
  status: FulfillmentStatus;
  created_at: string;
  completed_at: string | null;
  closure_reason: string | null;
}

export function isClosed(status: FulfillmentStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
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
