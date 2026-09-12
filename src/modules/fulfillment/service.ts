import type {
  TransactionBoundary,
  TransactionScope,
} from "../../platform/persistence/transaction.js";
import type { AuditLog } from "../../platform/audit/audit.js";
import type { Clock } from "../../platform/clock.js";
import { conflict, invalid, notFound } from "../../platform/errors.js";
import { newId, assertId } from "../../platform/ids.js";
import type { EventEnvelope } from "../../platform/eventing/envelope.js";
import { makeEvent } from "../../platform/eventing/envelope.js";
import type { OutboxStore } from "../../platform/eventing/outbox.js";
import {
  withTransaction,
  type PendingAuditEntry,
  type UnitOfWork,
} from "../../platform/eventing/unit-of-work.js";
import { journalMapWrite } from "../../platform/persistence/transaction.js";
import type {
  Fulfillment,
  FulfillmentStatus,
  MarketOrderCreatedPayload,
  MoveJobAcceptedPayload,
  MoveJobCompletedPayload,
  MoveJobRejectedPayload,
  FinancialDisposition,
  SettlementState,
} from "./domain.js";
import {
  financialDisposition,
  isClosed,
  isFinanciallyConsistent,
  requiresFinancialDecision,
} from "./domain.js";

const PRODUCER = "wasla-core";

export interface FulfillmentRepository {
  insert(fulfillment: Fulfillment, scope: TransactionScope): Promise<void>;
  update(fulfillment: Fulfillment, scope: TransactionScope): Promise<void>;
  get(fulfillmentId: string): Promise<Fulfillment | undefined>;
  findByOrderReference(orderReference: string): Promise<Fulfillment | undefined>;
  /** Used by reconciliation reads only; a Postgres adapter must filter in SQL. */
  all(): Promise<readonly Fulfillment[]>;
}

export class InMemoryFulfillmentRepository implements FulfillmentRepository {
  private rows = new Map<string, Fulfillment>();
  async insert(fulfillment: Fulfillment, scope?: TransactionScope): Promise<void> {
    journalMapWrite(scope, this.rows, fulfillment.fulfillment_id);
    this.rows.set(fulfillment.fulfillment_id, fulfillment);
  }
  async update(fulfillment: Fulfillment, scope?: TransactionScope): Promise<void> {
    journalMapWrite(scope, this.rows, fulfillment.fulfillment_id);
    this.rows.set(fulfillment.fulfillment_id, fulfillment);
  }
  async get(fulfillmentId: string): Promise<Fulfillment | undefined> {
    return this.rows.get(fulfillmentId);
  }
  async findByOrderReference(orderReference: string): Promise<Fulfillment | undefined> {
    return [...this.rows.values()].find((item) => item.market_order_reference === orderReference);
  }
  async all(): Promise<readonly Fulfillment[]> {
    return [...this.rows.values()];
  }
}

/**
 * Published interface of the money module as consumed by fulfillment.
 * Fulfillment never imports money internals — only this port (ADR 0017).
 */
/**
 * What fulfillment needs from money.
 *
 * Both mutating operations take the caller's unit of work. That is deliberate
 * and it is the whole point of B-11: a fulfillment closure changes the
 * fulfillment row *and* settles the hold, and those two must commit together
 * or not at all. A port that opened its own transaction made that impossible
 * to express, however carefully each side was written.
 */
export interface FulfillmentPaymentPort {
  captureWithin(
    uow: UnitOfWork,
    input: { authorization_id: string; correlation_id: string },
  ): Promise<unknown>;
  /**
   * Releases whatever is still held and reports the hold as it now stands.
   *
   * The return value is not decoration. Since migration 0009 a void can close a
   * hold that already moved money, and only money knows how much. A port that
   * answered `unknown` forced fulfillment to assume nothing moved, which is how
   * a partially captured hold came to be recorded as `released` — a settlement
   * state whose documented meaning is that no money moved at all.
   */
  voidWithin(
    uow: UnitOfWork,
    input: { authorization_id: string; reason: string; correlation_id: string },
  ): Promise<{ status: string; captured_minor: number }>;
  /**
   * Reads a hold without changing it. Used at intake to refuse work that can
   * never be settled. Throws when the authorization does not exist.
   */
  getAuthorization?(authorizationId: string): Promise<{
    status: string;
    captured_minor: number;
    expires_at: string | null;
  }>;
}

interface HoldInspection {
  usable: boolean;
  settlement: SettlementState;
  reason: string | null;
  /**
   * How much of the hold CORE observed as already moved, or `null` when there
   * was nothing to observe (no hold, no readable port) — never 0 as a stand-in
   * for "unknown".
   */
  captured_minor: number | null;
}

/**
 * The outcome of bringing a hold to a terminal state.
 *
 * `captured_minor` is `null` for "CORE did not observe an amount here", which
 * is not the same as zero and must never be published as zero — asserting that
 * nothing moved is precisely the falsehood this seam produced before. It is a
 * number only on the release path, where money hands the hold back and the
 * amount is a fact CORE was told.
 */
interface SettlementOutcome {
  settlement: SettlementState;
  captured_minor: number | null;
}

export class FulfillmentService {
  constructor(
    private readonly repo: FulfillmentRepository,
    private readonly outbox: OutboxStore,
    private readonly boundary: TransactionBoundary,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    private readonly payments?: FulfillmentPaymentPort,
  ) {}

  /** Boundary, outbox and audit log — the three things a commit needs. */
  private get tx() {
    return { boundary: this.boundary, outbox: this.outbox, audit: this.audit };
  }

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
    // organization_id and payment_authorization_id are CORE identifiers that
    // MARKET is echoing back to us; order_id is MARKET's own and stays opaque.
    assertId("organization_id", payload.organization_id);
    if (payload.payment_authorization_id !== undefined && payload.payment_authorization_id !== null) {
      assertId("payment_authorization_id", payload.payment_authorization_id);
    }
    const existing = await this.repo.findByOrderReference(payload.order_id);
    if (existing) return existing;
    const authorizationId = payload.payment_authorization_id ?? null;
    const hold = await this.inspectHold(authorizationId);
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
      return withTransaction(this.tx, async (uow) => {
        const outcome: SettlementOutcome =
          hold.settlement === "held"
            ? await this.release(uow, fulfillment, `refused:${hold.reason}`, event.correlation_id)
            : { settlement: hold.settlement, captured_minor: hold.captured_minor };
        const refused: Fulfillment = {
          ...fulfillment,
          status: "failed",
          settlement_state: outcome.settlement,
          completed_at: this.clock.now().toISOString(),
          closure_reason: hold.reason,
        };
        uow.stage((scope) => this.repo.insert(refused, scope));
        uow.emit(
          this.closureEvent(refused, event.correlation_id, event.event_id, outcome.captured_minor),
        );
        uow.audit(this.auditEntry("fulfillment.refused", refused, event.correlation_id));
        return refused;
      });
    }

    await withTransaction(this.tx, async (uow) => {
      uow.stage((scope) => this.repo.insert(fulfillment, scope));
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
      uow.audit(this.auditEntry("fulfillment.created", fulfillment, event.correlation_id));
    });
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
    const current = await this.require(payload.fulfillment_id);
    if (current.status === "cancelled") {
      if (current.move_job_reference === payload.job_id) return current;
      const traced: Fulfillment = { ...current, move_job_reference: payload.job_id };
      await withTransaction(this.tx, async (uow) => {
        uow.stage((scope) => this.repo.update(traced, scope));
        uow.audit(this.auditEntry("fulfillment.acceptance_after_cancellation", traced, event.correlation_id));
      });
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
    await withTransaction(this.tx, async (uow) => {
      uow.stage((scope) => this.repo.update(updated, scope));
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
      uow.audit(this.auditEntry("fulfillment.dispatched", updated, event.correlation_id));
    });
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
    const current = await this.require(payload.fulfillment_id);
    if (current.status === "failed") return current;
    if (isClosed(current.status)) throw conflict("fulfillment is already closed");
    // One transaction: the release and the closure commit together or not at
    // all, so MOVE's rejection can never leave a refunded hold on an open
    // fulfillment, or an open hold on a failed one.
    return withTransaction(this.tx, async (uow) => {
      const outcome = await this.release(
        uow,
        current,
        `move_rejected:${payload.reason}`,
        event.correlation_id,
      );
      return this.closeWithin(
        uow,
        current,
        "failed",
        payload.reason!,
        outcome,
        event.correlation_id,
        event.event_id,
      );
    });
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
    const current = await this.require(payload.fulfillment_id);
    if (isClosed(current.status)) {
      if (current.status === "cancelled") throw conflict("fulfillment was cancelled");
      if (current.move_job_reference !== payload.job_id) {
        throw conflict("fulfillment already closed by another job");
      }
      return current;
    }

    // One transaction for the settlement and the closure. Before B-11 the
    // capture committed on its own and the fulfillment row was updated
    // afterwards, so a failure in between left money captured against a
    // fulfillment still recorded as dispatched and held.
    return withTransaction(this.tx, async (uow) => {
      let outcome: FulfillmentStatus = payload.outcome === "completed" ? "completed" : "failed";
      let reason: string | null = payload.outcome === "completed" ? null : "move_execution_failed";
      let settled: SettlementOutcome;

      if (outcome === "completed") {
        const result = await this.settle(uow, current, event.correlation_id);
        settled = { settlement: result.settlement, captured_minor: result.captured_minor };
        if (!result.ok) {
          outcome = "failed";
          reason = result.reason;
        }
      } else {
        settled = await this.release(uow, current, "move_execution_failed", event.correlation_id);
      }

      const closed: Fulfillment = {
        ...current,
        move_job_reference: payload.job_id!,
        status: outcome,
        settlement_state: settled.settlement,
        completed_at: payload.completed_at!,
        closure_reason: reason,
      };
      uow.stage((scope) => this.repo.update(closed, scope));
      uow.emit(
        this.closureEvent(closed, event.correlation_id, event.event_id, settled.captured_minor),
      );
      uow.audit(this.auditEntry("fulfillment.closed", closed, event.correlation_id));
      return closed;
    });
  }

  /** MARKET (or an operator) cancels before execution closes. Idempotent. */
  async cancel(input: {
    fulfillment_id: string;
    reason: string;
    correlation_id: string;
  }): Promise<Fulfillment> {
    const current = await this.require(input.fulfillment_id);
    if (!input.reason.trim()) throw invalid("reason is required");
    if (current.status === "cancelled") return current;
    if (isClosed(current.status)) throw conflict("fulfillment is already closed");
    const reason = input.reason.trim();
    return withTransaction(this.tx, async (uow) => {
      const outcome = await this.release(
        uow,
        current,
        `cancelled:${reason}`,
        input.correlation_id,
      );
      return this.closeWithin(
        uow,
        current,
        "cancelled",
        reason,
        outcome,
        input.correlation_id,
        null,
      );
    });
  }

  /**
   * Reconciliation read: fulfillments whose execution state and money state
   * disagree. An empty result is the invariant CORE is expected to hold.
   *
   * It reports both defects and pending decisions, because both mean the money
   * question is open. `listPendingFinancialDecision` separates the half that is
   * waiting on a business answer rather than on an engineer.
   */
  async listFinanciallyInconsistent(organizationId?: string): Promise<readonly Fulfillment[]> {
    return (await this.repo.all())
      .filter((item) => !organizationId || item.organization_id === organizationId)
      .filter((item) => !isFinanciallyConsistent(item));
  }

  /**
   * Reconciliation read: fulfillments where money moved for work that did not
   * complete, and CORE has not been told what should happen to it.
   *
   * Unlike the read above, a non-empty result here is not a CORE defect. It is
   * the queue of cases blocked on the policy B-20 records as undecided, and it
   * exists so those cases are counted and visible instead of being silently
   * mixed with bookkeeping failures — or worse, silently closed.
   */
  async listPendingFinancialDecision(organizationId?: string): Promise<readonly Fulfillment[]> {
    return (await this.repo.all())
      .filter((item) => !organizationId || item.organization_id === organizationId)
      .filter((item) => requiresFinancialDecision(item));
  }

  /** What CORE can say about the money behind one fulfillment. Derived, never stored. */
  disposition(fulfillment: Fulfillment): FinancialDisposition {
    return financialDisposition(fulfillment);
  }

  async require(fulfillmentId: string): Promise<Fulfillment> {
    const fulfillment = await this.repo.get(fulfillmentId);
    if (!fulfillment) throw notFound("fulfillment not found");
    return fulfillment;
  }

  async findByOrderReference(orderReference: string): Promise<Fulfillment | undefined> {
    return await this.repo.findByOrderReference(orderReference);
  }

  /**
   * Stages the closure on the caller's unit of work.
   *
   * It does not open a transaction of its own, because the settlement that
   * decided `settlement` has already been staged on the same `uow` and the two
   * must land together.
   */
  private closeWithin(
    uow: UnitOfWork,
    current: Fulfillment,
    status: FulfillmentStatus,
    reason: string | null,
    settled: SettlementOutcome,
    correlationId: string,
    causationId: string | null,
  ): Fulfillment {
    const closed: Fulfillment = {
      ...current,
      status,
      settlement_state: settled.settlement,
      completed_at: this.clock.now().toISOString(),
      closure_reason: reason,
    };
    uow.stage((scope) => this.repo.update(closed, scope));
    uow.emit(this.closureEvent(closed, correlationId, causationId, settled.captured_minor));
    uow.audit(this.auditEntry(status === "cancelled" ? "fulfillment.cancelled" : "fulfillment.closed", closed, correlationId));
    return closed;
  }

  /**
   * The closure event for a fulfillment.
   *
   * Both closure events carry the money outcome, and `cancelled` in particular
   * is read downstream as "the customer got their money back". That reading is
   * false when part of the hold had already moved, so the event states the
   * money facts CORE holds rather than leaving them to be inferred:
   *
   *  - `settlement_state` names where the money is, including
   *    `partially_captured`;
   *  - `captured_minor` is present only when CORE observed an amount, and is
   *    omitted rather than sent as 0 when it did not;
   *  - `financial_decision_required` is true when the execution closed without
   *    delivering while money had moved. It is a fact about CORE's knowledge —
   *    CORE has not been told whether that amount is refunded, retained
   *    against work done, or charged as a fee — and never a policy CORE picked.
   *    A consumer must not settle, refund or invoice on its own while it is
   *    true (blocker B-20).
   */
  private closureEvent(
    fulfillment: Fulfillment,
    correlationId: string,
    causationId: string | null,
    capturedMinor: number | null,
  ) {
    const cancelled = fulfillment.status === "cancelled";
    const money = {
      settlement_state: fulfillment.settlement_state,
      financial_decision_required: requiresFinancialDecision(fulfillment),
      ...(capturedMinor === null ? {} : { captured_minor: capturedMinor }),
    };
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
            ...money,
          }
        : {
            fulfillment_id: fulfillment.fulfillment_id,
            order_reference: fulfillment.market_order_reference,
            outcome: fulfillment.status,
            completed_at: fulfillment.completed_at,
            reason: fulfillment.closure_reason,
            ...money,
          },
    });
  }

  private async settle(
    uow: UnitOfWork,
    fulfillment: Fulfillment,
    correlationId: string,
  ): Promise<
    | { ok: true; settlement: SettlementState; captured_minor: number | null }
    | { ok: false; settlement: SettlementState; captured_minor: number | null; reason: string }
  > {
    if (!this.payments || !fulfillment.payment_authorization_id) {
      return { ok: true, settlement: "none", captured_minor: null };
    }
    try {
      await this.payments.captureWithin(uow, {
        authorization_id: fulfillment.payment_authorization_id,
        correlation_id: correlationId,
      });
      // No amount is reported: a full capture takes the whole consented
      // ceiling, which is the figure MARKET already holds from creating the
      // hold, and `captureWithin` publishes a ledger transaction rather than
      // the authorization total. Restating it from the transaction would be a
      // guess on a hold captured in legs, where the last leg is not the total.
      // Left as `null` — not observed — rather than filled in with a number
      // CORE was not given. Recorded as an internal follow-up, not a blocker:
      // no consumer has asked for the figure on the success path.
      return { ok: true, settlement: "captured", captured_minor: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The capture was refused during its read phase, so nothing was staged
      // on `uow` and releasing instead is safe — the unit of work is still
      // clean at this point.
      const released = await this.release(
        uow,
        fulfillment,
        `settlement_failed:${message}`,
        correlationId,
      );
      return {
        ok: false,
        settlement: released.settlement,
        captured_minor: released.captured_minor,
        reason: `payment_settlement_failed:${message}`,
      };
    }
  }

  /**
   * Releases the money hold and reports where the money ended up.
   *
   * The money state it reports is derived from the hold money hands back, never
   * assumed: a hold that had already captured part of its amount closes as
   * `partially_captured`, not `released`.
   *
   * A void that cannot be applied (for example because the hold was already
   * captured out of band) is NOT swallowed silently: the fulfillment is marked
   * `unsettled` and an audit record names the inconsistency, so closure still
   * proceeds but the mismatch is visible to reconciliation instead of being
   * lost.
   */
  private async release(
    uow: UnitOfWork,
    fulfillment: Fulfillment,
    reason: string,
    correlationId: string,
  ): Promise<SettlementOutcome> {
    if (!this.payments || !fulfillment.payment_authorization_id) {
      return { settlement: "none", captured_minor: null };
    }
    try {
      const hold = await this.payments.voidWithin(uow, {
        authorization_id: fulfillment.payment_authorization_id,
        reason,
        correlation_id: correlationId,
      });
      // `released` is a claim that no money moved. It is only true when the
      // hold never captured anything; a hold that moved part of its amount and
      // released the rest is a different fact and gets a different name.
      return {
        settlement: hold.captured_minor > 0 ? "partially_captured" : "released",
        captured_minor: hold.captured_minor,
      };
    } catch (err) {
      // Deliberately OUT of the unit of work (B-9). Nothing was mutated here,
      // so there is no change for this entry to be atomic with, and it is the
      // only record of why the money and the execution disagree. Writing it
      // inside the caller's transaction would mean a later rollback erases the
      // evidence of the inconsistency that caused the rollback.
      await this.audit.record({
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
      // The amount is unknown by construction: the void failed, so CORE never
      // got an answer about the hold. Reporting 0 would assert that nothing
      // moved, which is the mistake this cycle exists to remove, so the
      // `unsettled` state carries no amount and the audit entry carries the
      // hold reference an operator needs to go and look.
      return { settlement: "unsettled", captured_minor: null };
    }
  }

  /**
   * Verifies, without mutating anything, that a declared hold can still guard
   * this execution. A port without `getAuthorization` (or no port at all)
   * cannot verify, so the declared hold is trusted and capture-time failure
   * remains the backstop.
   */
  private async inspectHold(authorizationId: string | null): Promise<HoldInspection> {
    if (!authorizationId) {
      return { usable: true, settlement: "none", reason: null, captured_minor: null };
    }
    if (!this.payments?.getAuthorization) {
      return { usable: true, settlement: "held", reason: null, captured_minor: null };
    }
    let authorization: { status: string; captured_minor: number; expires_at: string | null };
    try {
      authorization = await this.payments.getAuthorization(authorizationId);
    } catch {
      return {
        usable: false,
        settlement: "none",
        reason: "payment_hold_not_found",
        captured_minor: null,
      };
    }
    if (authorization.status === "captured") {
      // Money already moved for work that has not been coordinated yet: the
      // order is refused and the mismatch is surfaced for reconciliation.
      return {
        usable: false,
        settlement: "unsettled",
        reason: "payment_hold_already_captured",
        captured_minor: authorization.captured_minor,
      };
    }
    if (authorization.status === "partially_captured") {
      // A closed hold that moved part of its amount. Refused for the same
      // reason as a fully captured one — there is nothing left to guard the
      // execution — but recorded as `partially_captured` rather than
      // `released`, because money did move and this fulfillment must not claim
      // otherwise.
      return {
        usable: false,
        settlement: "partially_captured",
        reason: "payment_hold_partially_captured",
        captured_minor: authorization.captured_minor,
      };
    }
    if (authorization.status !== "authorized") {
      return {
        usable: false,
        settlement: "released",
        reason: "payment_hold_not_authorized",
        captured_minor: authorization.captured_minor,
      };
    }
    if (
      authorization.expires_at &&
      Date.parse(authorization.expires_at) <= this.clock.now().getTime()
    ) {
      return {
        usable: false,
        settlement: "held",
        reason: "payment_hold_expired",
        captured_minor: authorization.captured_minor,
      };
    }
    return { usable: true, settlement: "held", reason: null, captured_minor: authorization.captured_minor };
  }

  /**
   * The audit entry for a fulfillment state change, as a value.
   *
   * It is handed to `uow.audit` so it commits with the row and the event. A
   * trail that says a fulfillment was dispatched when the update rolled back
   * would send an investigation to the wrong product.
   */
  private auditEntry(
    action: string,
    fulfillment: Fulfillment,
    correlationId: string,
  ): PendingAuditEntry {
    return {
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
    };
  }
}
