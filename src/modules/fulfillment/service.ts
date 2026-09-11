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
  SettlementState,
} from "./domain.js";
import { isClosed, isFinanciallyConsistent } from "./domain.js";

const PRODUCER = "wasla-core";

export interface FulfillmentRepository {
  insert(fulfillment: Fulfillment): void;
  update(fulfillment: Fulfillment): void;
  get(fulfillmentId: string): Fulfillment | undefined;
  findByOrderReference(orderReference: string): Fulfillment | undefined;
  /** Used by reconciliation reads only; a Postgres adapter must filter in SQL. */
  all(): readonly Fulfillment[];
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
  all(): readonly Fulfillment[] {
    return [...this.rows.values()];
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
  /**
   * Reads a hold without changing it. Used at intake to refuse work that can
   * never be settled. Throws when the authorization does not exist.
   */
  getAuthorization?(authorizationId: string): {
    status: string;
    expires_at: string | null;
  };
}

interface HoldInspection {
  usable: boolean;
  settlement: SettlementState;
  reason: string | null;
}

export class FulfillmentService {
  constructor(
    private readonly repo: FulfillmentRepository,
    private readonly outbox: OutboxStore,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    private readonly payments?: FulfillmentPaymentPort,
  ) {}

  /**
   * MARKET commercial order → CORE fulfillment request. Idempotent per order.
   *
   * When the order declares a money hold, the hold is verified BEFORE anything
   * is published. An order guarded by a hold that cannot be captured (missing,
   * already captured, already voided or expired) is closed immediately as
   * failed and `core.fulfillment.created` is never published — CORE must not
   * ask MOVE to execute work it already knows it cannot settle.
   */
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
    const authorizationId = payload.payment_authorization_id ?? null;
    const hold = this.inspectHold(authorizationId);
    const fulfillment: Fulfillment = {
      fulfillment_id: newId(),
      organization_id: payload.organization_id,
      market_order_reference: payload.order_id,
      move_job_reference: null,
      payment_authorization_id: authorizationId,
      status: "coordinating",
      settlement_state: hold.settlement,
      created_at: this.clock.now().toISOString(),
      completed_at: null,
      closure_reason: null,
    };

    if (!hold.usable) {
      // A refused order must not leave money parked: a hold that is still
      // authorized (for example an expired one awaiting the sweep) is released
      // as part of the refusal.
      const settlement =
        hold.settlement === "held"
          ? await this.release(fulfillment, `refused:${hold.reason}`, event.correlation_id)
          : hold.settlement;
      const refused: Fulfillment = {
        ...fulfillment,
        status: "failed",
        settlement_state: settlement,
        completed_at: this.clock.now().toISOString(),
        closure_reason: hold.reason,
      };
      await withTransaction(this.outbox, (uow) => {
        uow.stage(() => this.repo.insert(refused));
        uow.emit(this.closureEvent(refused, event.correlation_id, event.event_id));
      });
      this.recordAudit("fulfillment.refused", refused, event.correlation_id);
      return refused;
    }

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

  /**
   * MOVE accepted the request and created an operational job. Idempotent.
   *
   * The transition `coordinating -> dispatched` is published as
   * `core.fulfillment.dispatched` so MARKET can observe the assignment: CORE is
   * the only source of intermediate lifecycle state, and an unpublished
   * transition would leave MARKET unable to distinguish coordinating from
   * assigned work.
   *
   * An acceptance that arrives after a cancellation is not an error: the
   * cancellation was already published to MOVE, so CORE records the job
   * reference for traceability and keeps the cancelled state instead of
   * poisoning the consumer with a permanent conflict.
   */
  async consumeJobAccepted(event: EventEnvelope): Promise<Fulfillment> {
    if (event.event_type !== "move.job.accepted" || event.version !== 1) {
      throw invalid("unsupported move event");
    }
    const payload = event.payload as Partial<MoveJobAcceptedPayload>;
    if (!payload.fulfillment_id || !payload.job_id || !payload.accepted_at) {
      throw invalid("move.job.accepted payload is incomplete");
    }
    const current = this.require(payload.fulfillment_id);
    if (current.status === "cancelled") {
      if (current.move_job_reference === payload.job_id) return current;
      const traced: Fulfillment = { ...current, move_job_reference: payload.job_id };
      await withTransaction(this.outbox, (uow) => {
        uow.stage(() => this.repo.update(traced));
      });
      this.recordAudit("fulfillment.acceptance_after_cancellation", traced, event.correlation_id);
      return traced;
    }
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
      uow.emit(
        makeEvent({
          event_type: "core.fulfillment.dispatched",
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
            job_reference: payload.job_id,
            dispatched_at: payload.accepted_at,
          },
        }),
      );
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
    const settlement = await this.release(current, `move_rejected:${payload.reason}`, event.correlation_id);
    return this.close(current, "failed", payload.reason, settlement, event.correlation_id, event.event_id);
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
    let settlement: SettlementState;

    if (outcome === "completed") {
      const result = await this.settle(current, event.correlation_id);
      settlement = result.settlement;
      if (!result.ok) {
        outcome = "failed";
        reason = result.reason;
      }
    } else {
      settlement = await this.release(current, "move_execution_failed", event.correlation_id);
    }

    const closed: Fulfillment = {
      ...current,
      move_job_reference: payload.job_id,
      status: outcome,
      settlement_state: settlement,
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
    const settlement = await this.release(
      current,
      `cancelled:${input.reason.trim()}`,
      input.correlation_id,
    );
    return this.close(
      current,
      "cancelled",
      input.reason.trim(),
      settlement,
      input.correlation_id,
      null,
    );
  }

  /**
   * Reconciliation read: fulfillments whose execution state and money state
   * disagree. An empty result is the invariant CORE is expected to hold.
   */
  listFinanciallyInconsistent(organizationId?: string): readonly Fulfillment[] {
    return this.repo
      .all()
      .filter((item) => !organizationId || item.organization_id === organizationId)
      .filter((item) => !isFinanciallyConsistent(item));
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
    settlement: SettlementState,
    correlationId: string,
    causationId: string | null,
  ): Promise<Fulfillment> {
    const closed: Fulfillment = {
      ...current,
      status,
      settlement_state: settlement,
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
            settlement_state: fulfillment.settlement_state,
          }
        : {
            fulfillment_id: fulfillment.fulfillment_id,
            order_reference: fulfillment.market_order_reference,
            outcome: fulfillment.status,
            completed_at: fulfillment.completed_at,
            reason: fulfillment.closure_reason,
            settlement_state: fulfillment.settlement_state,
          },
    });
  }

  private async settle(
    fulfillment: Fulfillment,
    correlationId: string,
  ): Promise<
    | { ok: true; settlement: SettlementState }
    | { ok: false; settlement: SettlementState; reason: string }
  > {
    if (!this.payments || !fulfillment.payment_authorization_id) {
      return { ok: true, settlement: "none" };
    }
    try {
      await this.payments.capture({
        authorization_id: fulfillment.payment_authorization_id,
        correlation_id: correlationId,
      });
      return { ok: true, settlement: "captured" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const settlement = await this.release(
        fulfillment,
        `settlement_failed:${message}`,
        correlationId,
      );
      return { ok: false, settlement, reason: `payment_settlement_failed:${message}` };
    }
  }

  /**
   * Releases the money hold and reports where the money ended up.
   *
   * A void that cannot be applied (for example because the hold was already
   * captured out of band) is NOT swallowed silently: the fulfillment is marked
   * `unsettled` and an audit record names the inconsistency, so closure still
   * proceeds but the mismatch is visible to reconciliation instead of being
   * lost.
   */
  private async release(
    fulfillment: Fulfillment,
    reason: string,
    correlationId: string,
  ): Promise<SettlementState> {
    if (!this.payments || !fulfillment.payment_authorization_id) return "none";
    try {
      await this.payments.voidAuthorization({
        authorization_id: fulfillment.payment_authorization_id,
        reason,
        correlation_id: correlationId,
      });
      return "released";
    } catch (err) {
      this.audit.record({
        actor_type: "service",
        actor_id: null,
        action: "fulfillment.settlement_inconsistent",
        entity_type: "fulfillment",
        entity_id: fulfillment.fulfillment_id,
        correlation_id: correlationId,
        metadata: {
          // Deliberately not named *authorization*: the audit scrubber redacts
          // such keys, and this reference must survive for reconciliation.
          hold_reference: fulfillment.payment_authorization_id,
          attempted: "void",
          release_reason: reason,
          error: err instanceof Error ? err.message : String(err),
        },
      });
      return "unsettled";
    }
  }

  /**
   * Verifies, without mutating anything, that a declared hold can still guard
   * this execution. A port without `getAuthorization` (or no port at all)
   * cannot verify, so the declared hold is trusted and capture-time failure
   * remains the backstop.
   */
  private inspectHold(authorizationId: string | null): HoldInspection {
    if (!authorizationId) return { usable: true, settlement: "none", reason: null };
    if (!this.payments?.getAuthorization) {
      return { usable: true, settlement: "held", reason: null };
    }
    let authorization: { status: string; expires_at: string | null };
    try {
      authorization = this.payments.getAuthorization(authorizationId);
    } catch {
      return { usable: false, settlement: "none", reason: "payment_hold_not_found" };
    }
    if (authorization.status === "captured") {
      // Money already moved for work that has not been coordinated yet: the
      // order is refused and the mismatch is surfaced for reconciliation.
      return { usable: false, settlement: "unsettled", reason: "payment_hold_already_captured" };
    }
    if (authorization.status !== "authorized") {
      return { usable: false, settlement: "released", reason: "payment_hold_not_authorized" };
    }
    if (
      authorization.expires_at &&
      Date.parse(authorization.expires_at) <= this.clock.now().getTime()
    ) {
      return { usable: false, settlement: "held", reason: "payment_hold_expired" };
    }
    return { usable: true, settlement: "held", reason: null };
  }

  private recordAudit(action: string, fulfillment: Fulfillment, correlationId: string): void {
    this.audit.record({
      actor_type: "service",
      actor_id: null,
      action,
      entity_type: "fulfillment",
      entity_id: fulfillment.fulfillment_id,
      correlation_id: correlationId,
      metadata: {
        status: fulfillment.status,
        settlement_state: fulfillment.settlement_state,
      },
    });
  }
}
