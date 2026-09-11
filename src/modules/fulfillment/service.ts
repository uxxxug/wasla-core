import type { AuditLog } from "../../platform/audit/audit.js";
import type { Clock } from "../../platform/clock.js";
import { conflict, invalid, notFound } from "../../platform/errors.js";
import { newId } from "../../platform/ids.js";
import type { EventEnvelope } from "../../platform/eventing/envelope.js";
import { makeEvent } from "../../platform/eventing/envelope.js";
import type { OutboxStore } from "../../platform/eventing/outbox.js";
import { withTransaction } from "../../platform/eventing/unit-of-work.js";
import type { Fulfillment, MarketOrderCreatedPayload, MoveJobCompletedPayload } from "./domain.js";

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

export class FulfillmentService {
  constructor(
    private readonly repo: FulfillmentRepository,
    private readonly outbox: OutboxStore,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
  ) {}

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
      status: "coordinating",
      created_at: this.clock.now().toISOString(),
      completed_at: null,
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

  async consumeMoveCompletion(event: EventEnvelope): Promise<Fulfillment> {
    if (event.event_type !== "move.job.completed" || event.version !== 1) {
      throw invalid("unsupported move event");
    }
    const payload = event.payload as Partial<MoveJobCompletedPayload>;
    if (!payload.fulfillment_id || !payload.job_id || !payload.outcome || !payload.completed_at) {
      throw invalid("move.job.completed payload is incomplete");
    }
    const current = this.repo.get(payload.fulfillment_id);
    if (!current) throw notFound("fulfillment not found");
    if (current.status === "completed" || current.status === "failed") {
      if (current.move_job_reference !== payload.job_id) throw conflict("fulfillment already closed by another job");
      return current;
    }
    const updated: Fulfillment = {
      ...current,
      move_job_reference: payload.job_id,
      status: payload.outcome,
      completed_at: payload.completed_at,
    };
    await withTransaction(this.outbox, (uow) => {
      uow.stage(() => this.repo.update(updated));
      uow.emit(
        makeEvent({
          event_type: "core.fulfillment.completed",
          version: 1,
          producer: PRODUCER,
          occurred_at: this.clock.now(),
          correlation_id: event.correlation_id,
          causation_id: event.event_id,
          entity_type: "fulfillment",
          entity_id: updated.fulfillment_id,
          payload: {
            fulfillment_id: updated.fulfillment_id,
            order_reference: updated.market_order_reference,
            outcome: updated.status,
            completed_at: updated.completed_at,
          },
        }),
      );
    });
    this.recordAudit("fulfillment.closed", updated, event.correlation_id);
    return updated;
  }

  require(fulfillmentId: string): Fulfillment {
    const fulfillment = this.repo.get(fulfillmentId);
    if (!fulfillment) throw notFound("fulfillment not found");
    return fulfillment;
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