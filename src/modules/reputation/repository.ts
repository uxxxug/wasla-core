import {
  journalMapWrite,
  type TransactionScope,
} from "../../platform/persistence/transaction.js";
import {
  groupSignals,
  ratingShapeIsValid,
  type ReputationKindGroup,
  type ReputationSignal,
  type ReputationSubject,
} from "./domain.js";
import { putRow } from "../../platform/persistence/row-rules.js";

/**
 * Whether the insert was the first report of this fact.
 *
 * A named outcome rather than a thrown duplicate-key error, for the same reason
 * `insertIfAbsent` exists on the fulfillment port: at-least-once delivery makes
 * a redelivered signal the *expected* case, not an exception, and the write is
 * the only thing that can decide which copy arrived first.
 */
export type SignalInsertOutcome = "inserted" | "duplicate_source_reference";

/**
 * Whether the retraction marker was written by this call.
 *
 * `stale` covers three different situations on purpose — no such signal, a
 * signal in another tenant, or a signal already retracted — because the caller
 * does the same thing in all three: nothing, idempotently. Distinguishing them
 * would tell an event handler something it must not act on differently, and a
 * tenant probe is not a thing this port should answer.
 */
export type RetractionOutcome = "applied" | "stale";

export interface ReputationRepository {
  /**
   * Records a signal unless its `(organization_id, source_system,
   * source_reference)` triple is already present.
   *
   * The uniqueness is the exactly-once guarantee, and it lives in the write
   * rather than in a preceding read: two copies of the same event delivered
   * concurrently would both pass a read-then-write check and both insert, which
   * is B-12's defect in a new module.
   */
  insertIfAbsent(
    signal: ReputationSignal,
    scope?: TransactionScope,
  ): Promise<SignalInsertOutcome>;
  /**
   * Marks a signal withdrawn, conditional on it not already being withdrawn.
   *
   * Single-valued by the write itself (B-29's marker pattern), so a redelivered
   * retraction produces one marker, one event and one audit entry.
   */
  retractIfStanding(
    input: {
      organization_id: string;
      source_system: string;
      source_reference: string;
      retracted_at: string;
      reason: string;
    },
    scope?: TransactionScope,
  ): Promise<RetractionOutcome>;
  findBySource(
    organizationId: string,
    sourceSystem: string,
    sourceReference: string,
  ): Promise<ReputationSignal | undefined>;
  get(signalId: string): Promise<ReputationSignal | undefined>;
  /**
   * A page of a subject's signals, newest first by CORE's clock.
   *
   * Ordered by `(recorded_at, reputation_signal_id)` rather than by the
   * producer's `occurred_at`, for the reason `docs/replay.md` gives: a producer's
   * clock can reorder another producer's facts, and a page that is not totally
   * ordered cannot be paged through without repeating or skipping rows.
   */
  listForSubject(
    subject: ReputationSubject,
    limit: number,
  ): Promise<readonly ReputationSignal[]>;
  /**
   * Per-kind aggregates for a subject, grouped in the store.
   *
   * Deliberately not "return the signals and let the service count them": a
   * subject accumulates signals for as long as it is active, and a standing read
   * that loads all of them gets slower every day it is used. `usageTotal` made
   * the same call for billing. `deriveStanding` folds these rows for both
   * backends, so the arithmetic still has one implementation.
   */
  groupsForSubject(subject: ReputationSubject): Promise<readonly ReputationKindGroup[]>;
}

/**
 * The reference reputation store.
 *
 * Restates the schema's UNIQUE and CHECK constraints and the append-only
 * trigger rather than only the primary key. That redundancy is the standing rule
 * of this repository: a memory backend more permissive than Postgres certifies
 * bugs the real database would have refused (B-12), and every constraint below
 * names the constraint in migration 0018 it is standing in for.
 */
export class InMemoryReputationRepository implements ReputationRepository {
  private readonly rows = new Map<string, ReputationSignal>();

  async insertIfAbsent(
    signal: ReputationSignal,
    scope?: TransactionScope,
  ): Promise<SignalInsertOutcome> {
    if (!ratingShapeIsValid(signal.signal_kind, signal.rating_value)) {
      throw new Error(
        'new row violates check constraint "reputation_signal_rating_shape"',
      );
    }
    if (signal.source_system.trim().length === 0) {
      throw new Error(
        'new row violates check constraint "reputation_signal_source_system_present"',
      );
    }
    if (signal.source_reference.trim().length === 0) {
      throw new Error(
        'new row violates check constraint "reputation_signal_source_reference_present"',
      );
    }
    if (signal.correlation_id.trim().length === 0) {
      throw new Error(
        'new row violates check constraint "reputation_signal_correlation_present"',
      );
    }
    if (
      (signal.retracted_at === null) !==
      (signal.retraction_reason === null || signal.retraction_reason.trim().length === 0)
    ) {
      throw new Error(
        'new row violates check constraint "reputation_signal_retraction_fields"',
      );
    }
    if (
      this.bySource(signal.organization_id, signal.source_system, signal.source_reference)
    ) {
      return "duplicate_source_reference";
    }
    journalMapWrite(scope, this.rows, signal.reputation_signal_id);
    putRow("reputation_signal", this.rows, signal.reputation_signal_id, signal);
    return "inserted";
  }

  async retractIfStanding(
    input: {
      organization_id: string;
      source_system: string;
      source_reference: string;
      retracted_at: string;
      reason: string;
    },
    scope?: TransactionScope,
  ): Promise<RetractionOutcome> {
    if (input.reason.trim().length === 0) {
      // The both-or-neither constraint again: a retraction with no reason is
      // unreviewable, and the database would refuse it.
      throw new Error(
        'new row violates check constraint "reputation_signal_retraction_fields"',
      );
    }
    const stored = this.bySource(
      input.organization_id,
      input.source_system,
      input.source_reference,
    );
    // The same two predicates the Postgres statement carries in its `where`,
    // and the same two the trigger enforces: the row must exist in this tenant,
    // and the marker must still be absent.
    if (!stored || stored.retracted_at !== null) return "stale";
    journalMapWrite(scope, this.rows, stored.reputation_signal_id);
    putRow("reputation_signal", this.rows, stored.reputation_signal_id, {
      ...stored,
      retracted_at: input.retracted_at,
      retraction_reason: input.reason,
    });
    return "applied";
  }

  async findBySource(
    organizationId: string,
    sourceSystem: string,
    sourceReference: string,
  ): Promise<ReputationSignal | undefined> {
    return this.bySource(organizationId, sourceSystem, sourceReference);
  }

  async get(signalId: string): Promise<ReputationSignal | undefined> {
    return this.rows.get(signalId);
  }

  async listForSubject(
    subject: ReputationSubject,
    limit: number,
  ): Promise<readonly ReputationSignal[]> {
    return this.forSubject(subject)
      .sort(
        (a, b) =>
          b.recorded_at.localeCompare(a.recorded_at) ||
          b.reputation_signal_id.localeCompare(a.reputation_signal_id),
      )
      .slice(0, limit);
  }

  async groupsForSubject(
    subject: ReputationSubject,
  ): Promise<readonly ReputationKindGroup[]> {
    return groupSignals(this.forSubject(subject));
  }

  private forSubject(subject: ReputationSubject): ReputationSignal[] {
    return [...this.rows.values()].filter(
      (row) =>
        row.organization_id === subject.organization_id &&
        row.subject_type === subject.subject_type &&
        row.subject_id === subject.subject_id,
    );
  }

  private bySource(
    organizationId: string,
    sourceSystem: string,
    sourceReference: string,
  ): ReputationSignal | undefined {
    return [...this.rows.values()].find(
      (row) =>
        row.organization_id === organizationId &&
        row.source_system === sourceSystem &&
        row.source_reference === sourceReference,
    );
  }
}
