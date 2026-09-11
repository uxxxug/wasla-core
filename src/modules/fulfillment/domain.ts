export type FulfillmentStatus = "coordinating" | "completed" | "failed";

export interface Fulfillment {
  fulfillment_id: string;
  organization_id: string;
  market_order_reference: string;
  move_job_reference: string | null;
  status: FulfillmentStatus;
  created_at: string;
  completed_at: string | null;
}

export interface MarketOrderCreatedPayload {
  order_id: string;
  organization_id: string;
  requested_service: string;
}

export interface MoveJobCompletedPayload {
  fulfillment_id: string;
  job_id: string;
  outcome: "completed" | "failed";
  completed_at: string;
}