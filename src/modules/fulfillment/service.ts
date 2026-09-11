import type { AuditLog } from "../../platform/audit/audit.js";
import type { Clock } from "../../platform/clock.js";
import { conflict, invalid, notFound } from "../../platform/errors.js";
import { newId } from "../../platform/ids.js";
import type { EventEnvelope } from "../../platform/eventing/envelope.js";
import { makeEvent } from "../../platform/eventing/envelope.js";
import type { OutboxStore } from "../../platform/eventing/outbox.js";
import { withTransaction } from "../../platform/eventing/unit-of-work.js";
import type {
  Fulfillment,
  FulfillmentStatus,
  MarketOrderCreatedPayload,
  MoveJobAcceptedPayload,
  MoveJobCompletedPayload,
  MoveJobRejectedPayload,
} from "./domain.js";
import { isClosed } from "./domain.js";

const PRODUCER = "wasla-core";

export interface FulfillmentRepository {
  insert(fulfillment: Fulfillment): void;
  update(fulfillment: Fulfillment): void;
  get(fulfillmentId: string): Fulfillment | undefined;
  findByOrderReference(orderReference: string): Fulfillment | undefined;
}

export class InMemoryFulfillmentRepository implements FulfillmentRepository {
  private rows = new Map<string, Fulfillment>();
  insert(fulfillment: Fulfillment): void {
    this.rows.set(fulfillment.fulfillment_id, fulfillment);
  }
  update(fulfillment: Fulfillment): void {
    this.rows.set(fulfillment.fulfillment_id, fulfillment);
  }
  get(fulfillmentId: string): Fulfillment | undefined {
    return this.rows.get(fulfillmentId);
  }
  findByOrderReference(orderReference: string): Fulfillment | undefined {
    return [...this.rows.values()].find((item) => item.market_order_reference === orderReference);
  }
}

/**
 * Published interface of the money module as consumed by fulfillment.
 * Fulfillment never imports money internals — only this port (ADR 0017).
 */
export interface FulfillmentPaymentPort {
  capture(input: { authorization_id: string; correlation_id: string }): Promise<unknown>;
  voidAuthorization(input: {
    authorization_id: string;
    reason: string;
    correlation_id: string;
  }): Promise<unknown>;
}

export class FulfillmentService {
  constructor(
    private readonly repo: FulfillmentRepository,
    private readonly outbox: OutboxStore,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    private readonly payments?: FulfillmentPaymentPort,
  ) {}

  /** MARKET commercial order → CORE fulfillment request. Idempotent per order. */
  async consumeMarketOrder(event: EventEnvelope): Promise<Fulfillment> {
    if (event.event_type !== "market.order.created" || event.version !== 1) {
      throw invalid("unsupported market event");
    }
    const payload = event.payload as Partial<MarketOrderCreatedPayload>;
    if (!payload.order_id || !payload.organization_id || !payload.requested_service) {
      throw invalid("market.order.created payload is incomplete");
    }
    const existing = this.repo.findByOrderReference(payload.order_id);
    if (existing) return existing;
    const fulfillment: Fulfillment = {
      fulfillment_id: newId(),
      organization_id: payload.organization_id,
      market_order_reference: payload.order_id,
      move_job_reference: null,
      payment_authorization_id: payload.payment_authorization_id ?? null,
      status: "coordinating",
      created_at: this.clock.now().toISOString(),
      completed_at: null,
      closure_reason: null,
    };
    await withTransaction(this.outbox, (uow) => {
      uow.stage(() => this.repo.insert(fulfillment));
      uow.emit(
        makeEvent({
          event_type: "core.fulfillment.created",
          version: 1,
          producer: PRODUCER,
          occurred_at: this.clock.now(),
          correlation_id: event.correlation_id,
          causation_id: event.event_id,
          entity_type: "fulfillment",
          entity_id: fulfillment.fulfillment_id,
          payload: {
            fulfillment_id: fulfillment.fulfillment_id,
            organization_id: fulfillment.organization_id,
            order_reference: fulfillment.market_order_reference,
            requested_service: payload.requested_service,
          },
        }),
      );
    });
    this.recordAudit("fulfillment.created", fulfillment, event.correlation_id);
    return fulfillment;
  }

  /** MOVE accepted the request and created an operational job. Idempotent. */
  async consumeJobAccepted(event: EventEnvelope): Promise<Fulfillment> {
    if (event.event_type !== "move.job.accepted" || event.version !== 1) {
      throw invalid("unsupported move event");
    }
    const payload = event.payload as Partial<MoveJobAcceptedPayload>;
    if (!payload.fulfillment_id || !payload.job_id || !payload.accepted_at) {
      throw invalid("move.job.accepted payload is incomplete");
    }
    const current = this.require(payload.fulfillment_id);
    if (isClosed(current.status)) {
      throw conflict("fulfillment is already closed");
    }
    if (current.status === "dispatched") {
      if (current.move_job_reference !== payload.job_id) {
        throw conflict("fulfillment already dispatched to another job");
      }
      return current;
    }
    const updated: Fulfillment = {
      ...current,
      move_job_reference: payload.job_id,
      status: "dispatched",
    };
    await withTransaction(this.outbox, (uow) => {
      uow.stage(() => this.repo.update(updated));
    });
    this.recordAudit("fulfillment.dispatched", updated, event.correlation_id);
    return updated;
  }

  /** MOVE could not create an operational job — the request fails and money is released. */
  async consumeJobRejected(event: EventEnvelope): Promise<Fulfillment> {
    if (event.event_type !== "move.job.rejected" || event.version !== 1) {
      throw invalid("unsupported move event");
    }
    const payload = event.payload as Partial<MoveJobRejectedPayload>;
    if (!payload.fulfillment_id || !payload.reason) {
      throw invalid("move.job.rejected payload is incomplete");
    }
    const current = this.require(payload.fulfillment_id);
    if (current.status === "failed") return current;
    if (isClosed(current.status)) throw conflict("fulfillment is already closed");
    await this.release(current, `move_rejected:${payload.reason}`, event.correlation_id);
    return this.close(current, "failed", payload.reason, event.correlation_id, event.event_id);
  }

  /**
   * MOVE reported the final outcome. A successful execution captures the money
   * hold; anything else releases it. If the hold can no longer be captured
   * (expired or already released) the fulfillment closes as failed instead —
   * CORE never reports success for work it could not settle.
   */
  async consumeMoveCompletion(event: EventEnvelope): Promise<Fulfillment> {
    if (event.event_type !== "move.job.completed" || event.version !== 1) {
      throw invalid("unsupported move event");
    }
    const payload = event.payload as Partial<MoveJobCompletedPayload>;
    if (!payload.fulfillment_id || !payload.job_id || !payload.outcome || !payload.completed_at) {
      throw invalid("move.job.completed payload is incomplete");
    }
    const current = this.require(payload.fulfillment_id);
    if (isClosed(current.status)) {
      if (current.status === "cancelled") throw conflict("fulfillment was cancelled");
      if (current.move_job_reference !== payload.job_id) {
        throw conflict("fulfillment already closed by another job");
      }
      return current;
    }

    let outcome: FulfillmentStatus = payload.outcome === "completed" ? "completed" : "failed";
    let reason: string | null = payload.outcome === "completed" ? null : "move_execution_failed";

    if (outcome === "completed") {
      const settlement = await this.settle(current, event.correlation_id);
      if (!settlement.ok) {
        outcome = "failed";
        reason = settlement.reason;
      }
    } else {
      await this.release(current, "move_execution_failed", event.correlation_id);
    }

    const closed: Fulfillment = {
      ...current,
      move_job_reference: payload.job_id,
      status: outcome,
      completed_at: payload.completed_at,
      closure_reason: reason,
    };
    await withTransaction(this.outbox, (uow) => {
      uow.stage(() => this.repo.update(closed));
      uow.emit(this.closureEvent(closed, event.correlation_id, event.event_id));
    });
    this.recordAudit("fulfillment.closed", closed, event.correlation_id);
    return closed;
  }

  /** MARKET (or an operator) cancels before execution closes. Idempotent. */
  async cancel(input: {
    fulfillment_id: string;
    reason: string;
    correlation_id: string;
  }): Promise<Fulfillment> {
    const current = this.require(input.fulfillment_id);
    if (!input.reason.trim()) throw invalid("reason is required");
    if (current.status === "cancelled") return current;
    if (isClosed(current.status)) throw conflict("fulfillment is already closed");
    await this.release(current, `cancelled:${input.reason.trim()}`, input.correlation_id);
    return this.close(current, "cancelled", input.reason.trim(), input.correlation_id, null);
  }

  require(fulfillmentId: string): Fulfillment {
    const fulfillment = this.repo.get(fulfillmentId);
    if (!fulfillment) throw notFound("fulfillment not found");
    return fulfillment;
  }

  findByOrderReference(orderReference: string): Fulfillment | undefined {
    return this.repo.findByOrderReference(orderReference);
  }

  private async close(
    current: Fulfillment,
    status: FulfillmentStatus,
    reason: string | null,
    correlationId: string,
    causationId: string | null,
  ): Promise<Fulfillment> {
    const closed: Fulfillment = {
      ...current,
      status,
      completed_at: this.clock.now().toISOString(),
      closure_reason: reason,
    };
    await withTransaction(this.outbox, (uow) => {
      uow.stage(() => this.repo.update(closed));
      uow.emit(this.closureEvent(closed, correlationId, causationId));
    });
    this.recordAudit(status === "cancelled" ? "fulfillment.cancelled" : "fulfillment.closed", closed, correlationId);
    return closed;
  }

  private closureEvent(fulfillment: Fulfillment, correlationId: string, causationId: string | null) {
    const cancelled = fulfillment.status === "cancelled";
    return makeEvent({
      event_type: cancelled ? "core.fulfillment.cancelled" : "core.fulfillment.completed",
      version: 1,
      producer: PRODUCER,
      occurred_at: this.clock.now(),
      correlation_id: correlationId,
      causation_id: causationId,
      entity_type: "fulfillment",
      entity_id: fulfillment.fulfillment_id,
      payload: cancelled
        ? {
            fulfillment_id: fulfillment.fulfillment_id,
            order_reference: fulfillment.market_order_reference,
            reason: fulfillment.closure_reason ?? "cancelled",
            cancelled_at: fulfillment.completed_at,
          }
        : {
            fulfillment_id: fulfillment.fulfillment_id,
            order_reference: fulfillment.market_order_reference,
            outcome: fulfillment.status,
            completed_at: fulfillment.completed_at,
            reason: fulfillment.closure_reason,
          },
    });
  }

  private async settle(
    fulfillment: Fulfillment,
    correlationId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.payments || !fulfillment.payment_authorization_id) return { ok: true };
    try {
      await this.payments.capture({
        authorization_id: fulfillment.payment_authorization_id,
        correlation_id: correlationId,
      });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.release(fulfillment, `settlement_failed:${message}`, correlationId);
      return { ok: false, reason: `payment_settlement_failed:${message}` };
    }
  }

  /** Releases the money hold, tolerating a hold that is already released. */
  private async release(
    fulfillment: Fulfillment,
    reason: string,
    correlationId: string,
  ): Promise<void> {
    if (!this.payments || !fulfillment.payment_authorization_id) return;
    try {
      await this.payments.voidAuthorization({
        authorization_id: fulfillment.payment_authorization_id,
        reason,
        correlation_id: correlationId,
      });
    } catch {
      // A captured or missing hold cannot be released; closure still proceeds
      // and the audit trail records the outcome.
    }
  }

  private recordAudit(action: string, fulfillment: Fulfillment, correlationId: string): void {
    this.audit.record({
      actor_type: "service",
      actor_id: null,
      action,
      entity_type: "fulfillment",
      entity_id: fulfillment.fulfillment_id,
      correlation_id: correlationId,
      metadata: { status: fulfillment.status },
    });
  }
}
