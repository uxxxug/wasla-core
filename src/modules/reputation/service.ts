import type { AuditLog } from "../../platform/audit/audit.js";
import type { Clock } from "../../platform/clock.js";
import { invalid } from "../../platform/errors.js";
import { makeEvent, type EventEnvelope } from "../../platform/eventing/envelope.js";
import {
  canonicalPayload,
  type MarketReviewRatedPayload,
  type MarketReviewRetractedPayload,
} from "../../platform/eventing/normalize.js";
import type { OutboxStore } from "../../platform/eventing/outbox.js";
import { withTransaction } from "../../platform/eventing/unit-of-work.js";
import { assertId, newId } from "../../platform/ids.js";
import type { TransactionBoundary } from "../../platform/persistence/transaction.js";
import {
  deriveStanding,
  isReputationSignalKind,
  isReputationSubjectType,
  ratingShapeIsValid,
  RATED_KIND,
  type ReputationSignal,
  type ReputationSignalKind,
  type ReputationStanding,
  type ReputationSubject,
  type ReputationSubjectType,
} from "./domain.js";
import type { ReputationRepository } from "./repository.js";

const PRODUCER = "wasla-core";

/** Upper bound on a signal listing. Mirrors the replay scope's refusal to be unbounded. */
export const MAX_SIGNAL_PAGE = 200;

export interface RecordSignalInput {
  organization_id: string;
  subject_type: ReputationSubjectType;
  subject_id: string;
  signal_kind: ReputationSignalKind;
  rating_value?: number | null;
  source_system: string;
  source_reference: string;
  /** The producer's claim about when the fact happened. */
  occurred_at: string;
  correlation_id: string;
}

export interface RecordSignalResult {
  signal: ReputationSignal;
  /**
   * False when this exact report had already been recorded. Not an error: at
   * least-once delivery makes a second copy the expected case, and the honest
   * answer is the signal that is already stored.
   */
  recorded: boolean;
}

export interface RetractSignalResult {
  signal: ReputationSignal | undefined;
  /** False when there was nothing standing to withdraw. */
  retracted: boolean;
}

/**
 * Reputation and trust signals (ADR 0015).
 *
 * Three rules shape everything here, and each one is a decision this cycle took
 * deliberately rather than by default:
 *
 *   1. **A standing is derived on every read.** There is no score table and no
 *      cached aggregate. The service reads per-kind groups from the store and
 *      folds them with the pure `deriveStanding`, so the answer cannot disagree
 *      with the signals it summarises. ADR 0013 made the same call for
 *      entitlement; the settlement cycle is what happens when a summary is
 *      allowed to drift from its source.
 *
 *   2. **A recorded signal is a business fact and is published; a standing is
 *      not.** `core.reputation.signal_recorded` carries what was reported and
 *      nothing derived. Putting the running average in the event was considered
 *      and rejected: two signals recorded concurrently would each publish a
 *      total computed without the other, so every consumer would receive two
 *      contradictory claims about the same subject and have no way to order
 *      them. A consumer that needs a standing accumulates the stream it already
 *      receives exactly-once, or asks CORE — and asking CORE synchronously
 *      needs an ADR (recorded as a blocker, exactly as B-14 records it for
 *      entitlement).
 *
 *   3. **CORE never judges.** It stores what a producer reported and counts it.
 *      Weighting a kind, ageing a signal, or deciding what standing is good
 *      enough for anything is product policy (ADR 0018) and is recorded as a
 *      blocker rather than implemented here.
 */
export class ReputationService {
  constructor(
    private readonly repo: ReputationRepository,
    private readonly outbox: OutboxStore,
    private readonly boundary: TransactionBoundary,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
  ) {}

  private get tx() {
    return { boundary: this.boundary, outbox: this.outbox, audit: this.audit };
  }

  /**
   * Records a reported signal, exactly once per producer reference.
   *
   * The uniqueness decision is the store's, not this method's: a read-then-write
   * check would let two concurrent copies of one report both insert, and a
   * duplicated rating is a number in front of a person that nobody can explain.
   * When the write reports a duplicate, the stored signal is returned and no
   * event is published — the fact was already announced when it first landed.
   */
  async recordSignal(input: RecordSignalInput): Promise<RecordSignalResult> {
    assertId("organization_id", input.organization_id);
    assertId("subject_id", input.subject_id);
    if (!isReputationSubjectType(input.subject_type)) {
      throw invalid("subject_type must be identity or organization");
    }
    if (!isReputationSignalKind(input.signal_kind)) {
      // Refused by name rather than stored as an unknown kind. A kind CORE does
      // not know counts towards nothing, so accepting it would discard a fact
      // the producer was told had landed.
      throw invalid("signal_kind is not a declared reputation signal kind", {
        signal_kind: String(input.signal_kind),
      });
    }
    const rating = input.rating_value ?? null;
    if (!ratingShapeIsValid(input.signal_kind, rating)) {
      throw invalid(
        input.signal_kind === RATED_KIND
          ? "rating_value must be an integer between 1 and 5"
          : "rating_value is only carried by a service_rating",
      );
    }
    const sourceSystem = input.source_system.trim();
    const sourceReference = input.source_reference.trim();
    if (sourceSystem.length === 0) throw invalid("source_system is required");
    if (sourceReference.length === 0) throw invalid("source_reference is required");
    const occurredAt = new Date(input.occurred_at);
    if (Number.isNaN(occurredAt.getTime())) {
      throw invalid("occurred_at is not a readable timestamp");
    }
    if (input.correlation_id.trim().length === 0) {
      throw invalid("correlation_id is required");
    }

    const signal: ReputationSignal = {
      reputation_signal_id: newId(),
      organization_id: input.organization_id,
      subject_type: input.subject_type,
      subject_id: input.subject_id,
      signal_kind: input.signal_kind,
      rating_value: rating,
      source_system: sourceSystem,
      source_reference: sourceReference,
      occurred_at: occurredAt.toISOString(),
      // CORE's own clock, kept apart from the producer's claim. This is what
      // orders a listing, because one producer's skew must not reorder another's
      // facts.
      recorded_at: this.clock.now().toISOString(),
      correlation_id: input.correlation_id,
      retracted_at: null,
      retraction_reason: null,
    };

    let recorded = false;
    await withTransaction(this.tx, async (uow) => {
      uow.stage(async (scope) => {
        const outcome = await this.repo.insertIfAbsent(signal, scope);
        recorded = outcome === "inserted";
        if (!recorded) {
          // Nothing to publish and nothing to audit. Throwing would turn an
          // ordinary redelivery into a retried failure, which is the defect
          // B-29 closed on the fulfillment side.
          throw new DuplicateSignal();
        }
      });
      uow.emit(
        makeEvent({
          event_type: "core.reputation.signal_recorded",
          entity_type: "reputation_signal",
          entity_id: signal.reputation_signal_id,
          version: 1,
          producer: PRODUCER,
          occurred_at: this.clock.now(),
          correlation_id: input.correlation_id,
          payload: {
            reputation_signal_id: signal.reputation_signal_id,
            organization_id: signal.organization_id,
            subject_type: signal.subject_type,
            subject_id: signal.subject_id,
            signal_kind: signal.signal_kind,
            rating_value: signal.rating_value,
            source_system: signal.source_system,
            source_reference: signal.source_reference,
            occurred_at: signal.occurred_at,
            recorded_at: signal.recorded_at,
          },
        }),
      );
      uow.audit({
        actor_type: "system",
        actor_id: null,
        action: "reputation.signal_recorded",
        entity_type: "reputation_signal",
        entity_id: signal.reputation_signal_id,
        correlation_id: input.correlation_id,
        // The subject and the kind, never the value's provenance beyond the
        // producer's own reference. No review text reaches CORE at all, so none
        // can reach the audit trail either (ADR 0015).
        metadata: {
          organization_id: signal.organization_id,
          subject_type: signal.subject_type,
          subject_id: signal.subject_id,
          signal_kind: signal.signal_kind,
          source_system: signal.source_system,
        },
      });
    }).catch(async (error) => {
      if (!(error instanceof DuplicateSignal)) throw error;
    });

    if (recorded) return { signal, recorded: true };
    const stored = await this.repo.findBySource(
      input.organization_id,
      sourceSystem,
      sourceReference,
    );
    // The row must exist: the insert refused because it was already there.
    // Returning the stored one rather than the rejected candidate matters —
    // they differ in `reputation_signal_id` and `recorded_at`, and the stored
    // one is the fact.
    return { signal: stored ?? signal, recorded: false };
  }

  /**
   * Withdraws a signal on its producer's instruction.
   *
   * A marker, not an edit and not a compensating entry. The row keeps saying
   * what was reported and gains the fact that it was withdrawn, which is the
   * only shape in which both statements stay true. A compensating negative
   * signal was rejected: a derived average would then mix a rating with its own
   * reversal, and no reader could tell "withdrawn" from "rated twice".
   */
  async retractSignal(input: {
    organization_id: string;
    source_system: string;
    source_reference: string;
    retracted_at: string;
    reason: string;
    correlation_id: string;
  }): Promise<RetractSignalResult> {
    assertId("organization_id", input.organization_id);
    const reason = input.reason.trim();
    if (reason.length === 0) throw invalid("reason is required to retract a signal");
    const retractedAt = new Date(input.retracted_at);
    if (Number.isNaN(retractedAt.getTime())) {
      throw invalid("retracted_at is not a readable timestamp");
    }
    const existing = await this.repo.findBySource(
      input.organization_id,
      input.source_system.trim(),
      input.source_reference.trim(),
    );
    // Nothing standing to withdraw. Deliberately not an error: a retraction for
    // a signal CORE never received, or already withdrew, is answered rather than
    // refused, because a refusal here would be retried until it dead-lettered
    // and the producer's intent is already satisfied.
    if (!existing || existing.retracted_at !== null) {
      return { signal: existing, retracted: false };
    }

    let applied = false;
    await withTransaction(this.tx, async (uow) => {
      uow.stage(async (scope) => {
        const outcome = await this.repo.retractIfStanding(
          {
            organization_id: input.organization_id,
            source_system: existing.source_system,
            source_reference: existing.source_reference,
            retracted_at: retractedAt.toISOString(),
            reason,
          },
          scope,
        );
        applied = outcome === "applied";
        if (!applied) throw new DuplicateSignal();
      });
      uow.emit(
        makeEvent({
          event_type: "core.reputation.signal_retracted",
          entity_type: "reputation_signal",
          entity_id: existing.reputation_signal_id,
          version: 1,
          producer: PRODUCER,
          occurred_at: this.clock.now(),
          correlation_id: input.correlation_id,
          payload: {
            reputation_signal_id: existing.reputation_signal_id,
            organization_id: existing.organization_id,
            subject_type: existing.subject_type,
            subject_id: existing.subject_id,
            signal_kind: existing.signal_kind,
            source_system: existing.source_system,
            source_reference: existing.source_reference,
            retracted_at: retractedAt.toISOString(),
          },
        }),
      );
      uow.audit({
        actor_type: "system",
        actor_id: null,
        action: "reputation.signal_retracted",
        entity_type: "reputation_signal",
        entity_id: existing.reputation_signal_id,
        correlation_id: input.correlation_id,
        metadata: {
          organization_id: existing.organization_id,
          subject_type: existing.subject_type,
          subject_id: existing.subject_id,
          signal_kind: existing.signal_kind,
          reason,
        },
      });
    }).catch(async (error) => {
      if (!(error instanceof DuplicateSignal)) throw error;
    });

    const stored = await this.repo.get(existing.reputation_signal_id);
    return { signal: stored, retracted: applied };
  }

  /** The derived standing. Computed here, stored nowhere. */
  async standing(subject: ReputationSubject): Promise<ReputationStanding> {
    assertId("organization_id", subject.organization_id);
    assertId("subject_id", subject.subject_id);
    if (!isReputationSubjectType(subject.subject_type)) {
      throw invalid("subject_type must be identity or organization");
    }
    return deriveStanding(subject, await this.repo.groupsForSubject(subject));
  }

  /** The signals behind a standing, newest first, bounded. */
  async listSignals(
    subject: ReputationSubject,
    limit = 50,
  ): Promise<readonly ReputationSignal[]> {
    assertId("organization_id", subject.organization_id);
    assertId("subject_id", subject.subject_id);
    if (!isReputationSubjectType(subject.subject_type)) {
      throw invalid("subject_type must be identity or organization");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_SIGNAL_PAGE) {
      throw invalid(`limit must be an integer between 1 and ${MAX_SIGNAL_PAGE}`);
    }
    return this.repo.listForSubject(subject, limit);
  }

  /**
   * `market.review.rated` → a `service_rating` signal.
   *
   * The rating crosses the boundary; the review does not. MARKET keeps the text,
   * the title and whatever else a person wrote, and sends CORE the number, the
   * subject and its own opaque reference. That is ADR 0015's split enforced by
   * the contract rather than by convention: there is no field in which text
   * could arrive, and `noExtraFields` refuses a payload that invents one.
   */
  async consumeReviewRated(event: EventEnvelope): Promise<void> {
    const payload = canonicalPayload<MarketReviewRatedPayload>(event, "market.review.rated");
    await this.recordSignal({
      organization_id: payload.organization_id,
      subject_type: payload.subject_type,
      subject_id: payload.subject_id,
      signal_kind: RATED_KIND,
      rating_value: payload.rating,
      source_system: event.producer,
      source_reference: payload.review_reference,
      occurred_at: payload.rated_at,
      correlation_id: event.correlation_id,
    });
  }

  /** `market.review.retracted` → the withdrawal marker on the signal it names. */
  async consumeReviewRetracted(event: EventEnvelope): Promise<void> {
    const payload = canonicalPayload<MarketReviewRetractedPayload>(
      event,
      "market.review.retracted",
    );
    await this.retractSignal({
      organization_id: payload.organization_id,
      source_system: event.producer,
      source_reference: payload.review_reference,
      retracted_at: payload.retracted_at,
      reason: payload.reason,
      correlation_id: event.correlation_id,
    });
  }
}

/**
 * Internal signal that the conditional write found the fact already recorded.
 *
 * Thrown to unwind the unit of work — which is what keeps the event and the
 * audit entry from being written for a report that changed nothing — and caught
 * immediately outside it. It never escapes this module and is never reported to
 * a caller, because a redelivery is not a failure.
 */
class DuplicateSignal extends Error {}
