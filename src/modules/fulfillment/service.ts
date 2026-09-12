import type {
  TransactionBoundary,
  TransactionScope,
} from "../../platform/persistence/transaction.js";
import type { AuditLog } from "../../platform/audit/audit.js";
import type { Clock } from "../../platform/clock.js";
import { conflict, invalid, notFound } from "../../platform/errors.js";
import { newId } from "../../platform/ids.js";
import type { EventEnvelope } from "../../platform/eventing/envelope.js";
import { makeEvent } from "../../platform/eventing/envelope.js";
import type {
  MarketOrderCreatedPayload,
  MoveJobAcceptedPayload,
  MoveJobCompletedPayload,
  MoveJobRejectedPayload,
} from "../../platform/eventing/normalize.js";
import { canonicalPayload } from "../../platform/eventing/normalize.js";
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
  FinancialDisposition,
  SettlementState,
} from "./domain.js";
import {
  financialDisposition,
  isClosed,
  isFinanciallyConsistent,
  OPEN_STATUSES,
  requiresFinancialDecision,
} from "./domain.js";

const PRODUCER = "wasla-core";

/**
 * Outcome of a write that is only allowed to apply while the row still holds an
 * expected status.
 *
 * `applied` means this caller performed the transition. `stale` means the row
 * had already left the expected set, so this caller performed nothing at all —
 * it is a fact about the write, not an error, and the caller decides what it
 * means. Two values, no third reading: an adapter that cannot distinguish them
 * cannot implement this port.
 */
export type ConditionalWrite = "applied" | "stale";

/**
 * Outcome of an insert guarded by the uniqueness of the order reference.
 *
 * `duplicate_order_reference` means another transaction already holds a
 * fulfillment for this MARKET order — the same shape of answer as `stale`, for
 * the one transition that creates a row instead of moving one.
 */
export type InsertOutcome = "inserted" | "duplicate_order_reference";

export interface FulfillmentRepository {
  /**
   * Unconditional insert. Fails when the order reference is already taken; both
   * backends must refuse, so the in-memory store cannot certify a duplicate the
   * database would reject.
   */
  insert(fulfillment: Fulfillment, scope: TransactionScope): Promise<void>;
  /**
   * Insert unless a fulfillment for this order reference already exists.
   *
   * Must be decided by the store itself in one statement (Postgres: `on
   * conflict do nothing`), never by a read followed by a write: two concurrent
   * intakes of the same order both pass a prior read and only the store can
   * serialise them.
   */
  insertIfAbsent(fulfillment: Fulfillment, scope: TransactionScope): Promise<InsertOutcome>;
  /**
   * Unconditional update. For writes that record information without moving the
   * lifecycle — a job reference kept for traceability, a reconciliation fix.
   * Never for a transition: see `updateIfStatusIn`.
   */
  update(fulfillment: Fulfillment, scope: TransactionScope): Promise<void>;
  /**
   * Update only while the stored status is still one of `expected`, and report
   * whether that was the case.
   *
   * This is the whole of B-21. A transition implemented as "read, decide,
   * update" is not a transition under concurrency: both callers read the open
   * row, both decide, and both updates apply, so both commit a closure and both
   * publish a closure event. The condition must be evaluated by the store as
   * part of the write — in Postgres the second update blocks on the row lock and
   * re-evaluates its predicate after the first commits, which is what makes the
   * loser observable as `stale` instead of overwriting the winner.
   *
   * The status is compared, not a version column: the status IS the thing being
   * guarded, and a separate version would let a row be closed twice with the
   * version agreeing.
   */
  updateIfStatusIn(
    fulfillment: Fulfillment,
    expected: readonly FulfillmentStatus[],
    scope: TransactionScope,
  ): Promise<ConditionalWrite>;
  get(fulfillmentId: string): Promise<Fulfillment | undefined>;
  findByOrderReference(orderReference: string): Promise<Fulfillment | undefined>;
  /** Used by reconciliation reads only; a Postgres adapter must filter in SQL. */
  all(): Promise<readonly Fulfillment[]>;
}

export class InMemoryFulfillmentRepository implements FulfillmentRepository {
  private rows = new Map<string, Fulfillment>();
  async insert(fulfillment: Fulfillment, scope?: TransactionScope): Promise<void> {
    // `market_order_reference` is UNIQUE in the schema since migration 0002.
    // Enforced here too: a memory store more permissive than the database
    // certifies a bug rather than catching it.
    if (this.byOrderReference(fulfillment.market_order_reference)) {
      throw new Error("duplicate key value violates unique constraint on market_order_reference");
    }
    journalMapWrite(scope, this.rows, fulfillment.fulfillment_id);
    this.rows.set(fulfillment.fulfillment_id, fulfillment);
  }
  async insertIfAbsent(
    fulfillment: Fulfillment,
    scope?: TransactionScope,
  ): Promise<InsertOutcome> {
    if (this.byOrderReference(fulfillment.market_order_reference)) {
      return "duplicate_order_reference";
    }
    journalMapWrite(scope, this.rows, fulfillment.fulfillment_id);
    this.rows.set(fulfillment.fulfillment_id, fulfillment);
    return "inserted";
  }
  async update(fulfillment: Fulfillment, scope?: TransactionScope): Promise<void> {
    journalMapWrite(scope, this.rows, fulfillment.fulfillment_id);
    this.rows.set(fulfillment.fulfillment_id, fulfillment);
  }
  /**
   * The in-memory counterpart of the conditional update.
   *
   * The read and the write are one indivisible step here because nothing can be
   * interleaved between them: a mutation staged on a unit of work runs to
   * completion before any other resumes, so this is the same guarantee the
   * database gives through its row lock, not a weaker imitation of it. The two
   * backends must agree; a store that lets a second closure through would make
   * the in-memory suite pass on a defect Postgres refuses.
   */
  async updateIfStatusIn(
    fulfillment: Fulfillment,
    expected: readonly FulfillmentStatus[],
    scope?: TransactionScope,
  ): Promise<ConditionalWrite> {
    const stored = this.rows.get(fulfillment.fulfillment_id);
    if (!stored || !expected.includes(stored.status)) return "stale";
    journalMapWrite(scope, this.rows, fulfillment.fulfillment_id);
    this.rows.set(fulfillment.fulfillment_id, fulfillment);
    return "applied";
  }
  private byOrderReference(orderReference: string): Fulfillment | undefined {
    return [...this.rows.values()].find(
      (item) => item.market_order_reference === orderReference,
    );
  }
  async get(fulfillmentId: string): Promise<Fulfillment | undefined> {
    return this.rows.get(fulfillmentId);
  }
  async findByOrderReference(orderReference: string): Promise<Fulfillment | undefined> {
    return this.byOrderReference(orderReference);
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
  /**
   * Captures the hold and reports it as it now stands.
   *
   * The return value is the same kind of fact `voidWithin` reports, and it is
   * required for the same reason. This method used to answer `unknown`, so the
   * success path had no amount to publish and `core.fulfillment.completed`
   * carried no `captured_minor` at all — while the *failure* path carried one.
   * A consumer reading the two events therefore learned how much a payer paid
   * for work that was never delivered, and nothing about what they paid for
   * work that was. `captured_minor` here is the hold's running total, never the
   * amount of the last leg: on a hold captured in legs those differ, and the
   * total is the figure that is true.
   */
  captureHoldWithin(
    uow: UnitOfWork,
    input: { authorization_id: string; correlation_id: string },
  ): Promise<{ status: string; captured_minor: number }>;
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
  /**
   * Whether CORE actually holds this authorization.
   *
   * False only when the declared reference resolves to nothing. It exists
   * because `fulfillment.payment_authorization_id` is a foreign key: a row
   * referencing a hold CORE does not have cannot be stored at all, so the
   * reference has to be dropped from the row and kept in the audit trail
   * instead of being written and rejected by the database.
   */
  known: boolean;
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

/**
 * An open fulfillment whose money hold can no longer settle it.
 *
 * A projection assembled at read time from two modules. It is deliberately not a
 * fulfillment status: the execution is genuinely still open, and inventing a
 * status for "open but unfunded" would put a second, staler copy of the money
 * state inside the fulfillment row — the same mistake `financial_disposition`
 * avoids by being derived.
 */
export interface StaleHold {
  fulfillment: Fulfillment;
  /** Why the hold cannot settle this work, in the vocabulary intake already uses. */
  reason: string;
  /** How much of it has already moved, or null when CORE could not read it. */
  hold_captured_minor: number | null;
  /** The settlement state this fulfillment would take if it closed right now. */
  settlement_state_if_closed: SettlementState;
}

/**
 * Thrown by a staged transition whose conditional write found the row already
 * moved, to abort the transaction it is part of.
 *
 * It is an internal control signal, never surfaced: the caller catches it,
 * re-reads the committed row and answers from the winner. Aborting is the point.
 * The losing transaction has by then already staged its money settlement and its
 * outbox append, and only a rollback removes all of them together — which is why
 * the check cannot live before the transaction, where there is nothing to abort.
 */
class TransitionLost extends Error {
  constructor(readonly fulfillmentId: string) {
    super(`fulfillment ${fulfillmentId} was transitioned concurrently`);
    this.name = "TransitionLost";
  }
}

/** Thrown by a staged intake whose insert found the order already coordinated. */
class IntakeLost extends Error {
  constructor(readonly orderReference: string) {
    super(`order ${orderReference} was taken up concurrently`);
    this.name = "IntakeLost";
  }
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
   * Stages a lifecycle transition so that the row write, the money settlement,
   * the audit entry and the outbox append share one fate.
   *
   * The conditional write is staged, not performed inline, because the commit
   * point is where the transaction still can be abandoned: a `stale` answer
   * throws, `withTransaction` unwinds, and the money mutation staged before it
   * plus the outbox row staged after it are both gone. Nothing partial survives
   * and no event was ever appended, on either backend.
   */
  private stageTransition(
    uow: UnitOfWork,
    next: Fulfillment,
    expected: readonly FulfillmentStatus[],
  ): void {
    uow.stage(async (scope) => {
      const write = await this.repo.updateIfStatusIn(next, expected, scope);
      if (write === "stale") throw new TransitionLost(next.fulfillment_id);
    });
  }

  /**
   * Runs a transition and, if another transaction got there first, answers from
   * the row that actually committed.
   *
   * `whenLost` receives the winner and applies the same rule the path applies to
   * a fulfillment that was already in that state when the command arrived: the
   * concurrent case and the sequential repeat are the same question, so they must
   * not be allowed to give different answers.
   */
  private async transition(
    body: (uow: UnitOfWork) => Promise<Fulfillment>,
    whenLost: (winner: Fulfillment) => Fulfillment | Promise<Fulfillment>,
  ): Promise<Fulfillment> {
    try {
      return await withTransaction(this.tx, body);
    } catch (err) {
      if (!(err instanceof TransitionLost)) throw err;
      return await whenLost(await this.require(err.fulfillmentId));
    }
  }

  /**
   * Stages the creation of a fulfillment so that two intakes of the same MARKET
   * order cannot both create one.
   *
   * The prior `findByOrderReference` is a fast path, not the guard: two intakes
   * of the same order both read "absent" before either writes. The unique index
   * decides, and the loser aborts before its event reaches the outbox — which
   * matters most on the refusal path, where the row is born closed and carries a
   * closure event with it.
   */
  private stageIntake(uow: UnitOfWork, fulfillment: Fulfillment): void {
    uow.stage(async (scope) => {
      const write = await this.repo.insertIfAbsent(fulfillment, scope);
      if (write === "duplicate_order_reference") {
        throw new IntakeLost(fulfillment.market_order_reference);
      }
    });
  }

  /** Runs an intake and, if another transaction created the row, returns that row. */
  private async intake(
    body: (uow: UnitOfWork) => Promise<Fulfillment>,
  ): Promise<Fulfillment> {
    try {
      return await withTransaction(this.tx, body);
    } catch (err) {
      if (!(err instanceof IntakeLost)) throw err;
      const winner = await this.repo.findByOrderReference(err.orderReference);
      // Unreachable unless the winning transaction was itself rolled back after
      // ours saw its index entry, in which case the order genuinely has no
      // fulfillment and the caller should retry rather than be told it has one.
      if (!winner) throw conflict("fulfillment for this order is not readable yet");
      return winner;
    }
  }

  /**
   * What a rejection sees when the fulfillment is already closed — whether it was
   * closed before this command arrived or a moment after it started.
   */
  private rejectionOn(closed: Fulfillment): Fulfillment {
    if (closed.status === "failed") return closed;
    throw conflict("fulfillment is already closed");
  }

  /** What a cancellation sees when the fulfillment is already closed. */
  private cancellationOn(closed: Fulfillment): Fulfillment {
    if (closed.status === "cancelled") return closed;
    throw conflict("fulfillment is already closed");
  }

  /** What a completion sees when the fulfillment is already closed. */
  private completionOn(closed: Fulfillment, jobId: string): Fulfillment {
    if (closed.status === "cancelled") throw conflict("fulfillment was cancelled");
    if (closed.move_job_reference !== jobId) {
      throw conflict("fulfillment already closed by another job");
    }
    return closed;
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
    // One call replaces the type check, the version check and the field-by-field
    // payload check this method used to carry, along with the three near-copies
    // of them in the other consumers. Version interpretation now lives in
    // `platform/eventing/normalize.ts` and nowhere else, so a handler cannot
    // develop its own opinion about what an old event means.
    const payload = canonicalPayload<MarketOrderCreatedPayload>(event, "market.order.created");
    const existing = await this.repo.findByOrderReference(payload.order_id);
    if (existing) return existing;
    const authorizationId = payload.payment_authorization_id ?? null;
    const hold = await this.inspectHold(authorizationId);
    const fulfillment: Fulfillment = {
      fulfillment_id: newId(),
      organization_id: payload.organization_id,
      market_order_reference: payload.order_id,
      move_job_reference: null,
      // A reference CORE cannot resolve is not stored: the column is a foreign
      // key to `payment_authorization`, so a row naming a hold that does not
      // exist is refused by the database and the refusal itself could never be
      // recorded. The declared reference survives on the audit entry below.
      payment_authorization_id: hold.known ? authorizationId : null,
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
      return this.intake(async (uow) => {
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
        this.stageIntake(uow, refused);
        uow.emit(
          this.closureEvent(refused, event.correlation_id, event.event_id, outcome.captured_minor),
        );
        uow.audit(
          this.auditEntry("fulfillment.refused", refused, event.correlation_id, {
            refusal_reason: hold.reason,
            // Deliberately not named *authorization*: the audit scrubber redacts
            // such keys, and this is the only place the reference MARKET declared
            // survives once the row cannot hold it.
            ...(hold.known ? {} : { unresolved_hold_reference: authorizationId }),
          }),
        );
        return refused;
      });
    }

    return this.intake(async (uow) => {
      this.stageIntake(uow, fulfillment);
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
      return fulfillment;
    });
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
    const payload = canonicalPayload<MoveJobAcceptedPayload>(event, "move.job.accepted");
    const current = await this.require(payload.fulfillment_id);
    if (isClosed(current.status) || current.status === "dispatched") {
      return await this.acceptanceOn(current, payload.job_id, event.correlation_id);
    }
    const updated: Fulfillment = {
      ...current,
      move_job_reference: payload.job_id,
      status: "dispatched",
    };
    // Conditional like every other transition: two acceptances of the same job
    // arriving together would otherwise both publish `core.fulfillment.dispatched`
    // for one assignment. Not a closure, but the same defect, so the same guard.
    return await this.transition(async (uow) => {
      this.stageTransition(uow, updated, ["coordinating"]);
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
            // CORE owns tenancy, so CORE is the only system that can state which
            // organization a fulfillment belongs to. Omitting it here forced
            // every consumer to ask CORE back for a fact CORE already had, and
            // made a tenant-scoped notification recipient for this event type
            // unmatchable by construction (B-23).
            organization_id: updated.organization_id,
            order_reference: updated.market_order_reference,
            job_reference: payload.job_id,
            dispatched_at: payload.accepted_at,
          },
        }),
      );
      uow.audit(this.auditEntry("fulfillment.dispatched", updated, event.correlation_id));
      return updated;
    }, (winner) => this.acceptanceOn(winner, payload.job_id, event.correlation_id));
  }

  /**
   * What an acceptance sees when the fulfillment has already moved on — read
   * before the transition, or read back after losing the race to one.
   *
   * A cancellation stays authoritative: the job reference is still recorded, for
   * an operator tracing which MOVE job was created for work CORE had already
   * called off, and no dispatch event is published.
   */
  private async acceptanceOn(
    current: Fulfillment,
    jobId: string,
    correlationId: string,
  ): Promise<Fulfillment> {
    if (current.status === "dispatched") {
      if (current.move_job_reference !== jobId) {
        throw conflict("fulfillment already dispatched to another job");
      }
      return current;
    }
    if (current.status !== "cancelled") throw conflict("fulfillment is already closed");
    if (current.move_job_reference === jobId) return current;
    const traced: Fulfillment = { ...current, move_job_reference: jobId };
    await withTransaction(this.tx, async (uow) => {
      // Unconditional on purpose: this records a reference, it does not move the
      // lifecycle, and it must land on a row that is already closed.
      uow.stage((scope) => this.repo.update(traced, scope));
      uow.audit(
        this.auditEntry("fulfillment.acceptance_after_cancellation", traced, correlationId),
      );
    });
    return traced;
  }

  /** MOVE could not create an operational job — the request fails and money is released. */
  async consumeJobRejected(event: EventEnvelope): Promise<Fulfillment> {
    // This handler used to accept a payload the published contract forbids: it
    // required only `fulfillment_id` and `reason`, while
    // `contracts/events/move.job.rejected.schema.json` also requires
    // `rejected_at`. Four independent payload checks is exactly how a consumer
    // and its contract drift apart without anyone noticing.
    const payload = canonicalPayload<MoveJobRejectedPayload>(event, "move.job.rejected");
    const current = await this.require(payload.fulfillment_id);
    if (isClosed(current.status)) return this.rejectionOn(current);
    // One transaction: the release and the closure commit together or not at
    // all, so MOVE's rejection can never leave a refunded hold on an open
    // fulfillment, or an open hold on a failed one.
    return this.transition(
      async (uow) => {
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
          payload.reason,
          outcome,
          event.correlation_id,
          event.event_id,
        );
      },
      (winner) => this.rejectionOn(winner),
    );
  }

  /**
   * MOVE reported the final outcome. A successful execution captures the money
   * hold; anything else releases it. If the hold can no longer be captured
   * (expired or already released) the fulfillment closes as failed instead —
   * CORE never reports success for work it could not settle.
   */
  async consumeMoveCompletion(event: EventEnvelope): Promise<Fulfillment> {
    const payload = canonicalPayload<MoveJobCompletedPayload>(event, "move.job.completed");
    const current = await this.require(payload.fulfillment_id);
    if (isClosed(current.status)) return this.completionOn(current, payload.job_id);

    // One transaction for the settlement and the closure. Before B-11 the
    // capture committed on its own and the fulfillment row was updated
    // afterwards, so a failure in between left money captured against a
    // fulfillment still recorded as dispatched and held.
    return this.transition(async (uow) => {
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
      this.stageTransition(uow, closed, OPEN_STATUSES);
      uow.emit(
        this.closureEvent(closed, event.correlation_id, event.event_id, settled.captured_minor),
      );
      uow.audit(this.auditEntry("fulfillment.closed", closed, event.correlation_id));
      return closed;
    }, (winner) => this.completionOn(winner, payload.job_id!));
  }

  /** MARKET (or an operator) cancels before execution closes. Idempotent. */
  async cancel(input: {
    fulfillment_id: string;
    reason: string;
    correlation_id: string;
  }): Promise<Fulfillment> {
    const current = await this.require(input.fulfillment_id);
    if (!input.reason.trim()) throw invalid("reason is required");
    if (isClosed(current.status)) return this.cancellationOn(current);
    const reason = input.reason.trim();
    return this.transition(
      async (uow) => {
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
      },
      (winner) => this.cancellationOn(winner),
    );
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

  /**
   * Reconciliation read: open work whose hold can no longer settle it.
   *
   * This is the one contradiction neither read above can see, because it does
   * not live in the fulfillment row. The row says `dispatched` / `held` and is
   * internally consistent; the hold it names has meanwhile expired, been voided
   * or been captured out of band. Only comparing the two modules reveals it, and
   * nothing had gone wrong at the moment the row was written — which is why it is
   * a liveness problem, not a false record.
   *
   * No state is added to detect it: the condition is computed from the money
   * module's current answer through the same `inspectHold` that guards intake, so
   * the read cannot drift from the rule the write path uses. Nothing is mutated,
   * on purpose — what should happen to work whose funding is gone is a decision
   * (re-authorise, abandon, charge nothing), and CORE has not been given it.
   *
   * It reads one authorization per open funded fulfillment. That is acceptable
   * for a reconciliation sweep and would not be for a hot path; if the volume of
   * open work makes it expensive, the fix is a set-based query, not a stored
   * duplicate of the money state.
   */
  async listStaleHolds(organizationId?: string): Promise<readonly StaleHold[]> {
    const open = (await this.repo.all()).filter(
      (item) =>
        !isClosed(item.status) &&
        item.payment_authorization_id !== null &&
        (!organizationId || item.organization_id === organizationId),
    );
    const stale: StaleHold[] = [];
    for (const item of open) {
      const hold = await this.inspectHold(item.payment_authorization_id);
      // `usable` is exactly the predicate intake applies: a hold that could not
      // guard a new execution cannot guard this one either.
      if (hold.usable) continue;
      stale.push({
        fulfillment: item,
        reason: hold.reason ?? "payment_hold_unusable",
        hold_captured_minor: hold.captured_minor,
        // What the settlement state WOULD become if this fulfillment closed now.
        // Reported so an operator can see which of these cases will need a B-20
        // decision the moment they are closed, without CORE closing anything.
        settlement_state_if_closed: hold.settlement,
      });
    }
    return stale;
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
    this.stageTransition(uow, closed, OPEN_STATUSES);
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
    // Present on both closure shapes rather than on one: a consumer routing by
    // tenant must be able to do it for every terminal outcome, and a field that
    // appears on completion but not cancellation is a field nobody can rely on.
    const tenant = { organization_id: fulfillment.organization_id };
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
            ...tenant,
            order_reference: fulfillment.market_order_reference,
            reason: fulfillment.closure_reason ?? "cancelled",
            cancelled_at: fulfillment.completed_at,
            ...money,
          }
        : {
            fulfillment_id: fulfillment.fulfillment_id,
            ...tenant,
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
      const hold = await this.payments.captureHoldWithin(uow, {
        authorization_id: fulfillment.payment_authorization_id,
        correlation_id: correlationId,
      });
      // The amount is now reported, because money hands the hold back and its
      // running total is a fact CORE was given rather than one it would have to
      // guess. Previously this was `null` on the reasoning that no consumer had
      // asked for it — which made the success event the only closure event that
      // stated no amount, so "how much did this order actually cost" was
      // answerable for cancelled work and not for delivered work.
      //
      // The settlement state is read off the hold rather than assumed to be
      // `captured`. Today this call captures the whole remainder, so the hold
      // always comes back closed and the second branch is a guard rather than a
      // live path — but it is the guard that keeps this seam honest if
      // fulfillment ever settles in legs: writing `captured` unconditionally
      // would claim the entire consented ceiling moved on the strength of the
      // call having not thrown, which is the class of assumption that produced
      // the `released`-for-`partially_captured` defect on the release path.
      const settlement: SettlementState =
        hold.status === "captured" ? "captured" : "partially_captured";
      return { ok: true, settlement, captured_minor: hold.captured_minor };
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
      return { usable: true, known: true, settlement: "none", reason: null, captured_minor: null };
    }
    if (!this.payments?.getAuthorization) {
      return { usable: true, known: true, settlement: "held", reason: null, captured_minor: null };
    }
    let authorization: { status: string; captured_minor: number; expires_at: string | null };
    try {
      authorization = await this.payments.getAuthorization(authorizationId);
    } catch {
      return {
        usable: false,
        known: false,
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
        known: true,
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
        known: true,
        settlement: "partially_captured",
        reason: "payment_hold_partially_captured",
        captured_minor: authorization.captured_minor,
      };
    }
    if (authorization.status !== "authorized") {
      return {
        usable: false,
        known: true,
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
        known: true,
        settlement: "held",
        reason: "payment_hold_expired",
        captured_minor: authorization.captured_minor,
      };
    }
    return {
      usable: true,
      known: true,
      settlement: "held",
      reason: null,
      captured_minor: authorization.captured_minor,
    };
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
    extra: Record<string, unknown> = {},
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
        ...extra,
      },
    };
  }
}
