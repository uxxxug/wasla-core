import type { AuditEntry, AuditLog } from "../audit/audit.js";
import type { TransactionBoundary, TransactionScope } from "../persistence/transaction.js";
import type { EventEnvelope } from "./envelope.js";
import type { OutboxStore } from "./outbox.js";

/** An audit entry as a caller supplies it; the log assigns id and timestamp. */
export type PendingAuditEntry = Omit<AuditEntry, "audit_id" | "occurred_at">;

/**
 * Transactional boundary. Domain state, the outbox append and the audit entry
 * either all land or none of them does.
 *
 * Mutations are staged rather than applied inline so that the commit point is
 * a single, obvious place. A staged mutation receives the transaction scope and
 * must pass it to every repository write it performs, otherwise that write
 * escapes the transaction — staging alone is not rollback (see
 * `MemoryJournal`).
 */
export interface UnitOfWork {
  stage(mutation: (scope: TransactionScope) => Promise<void> | void): void;
  emit(event: EventEnvelope): void;
  /**
   * Records an audit entry **inside this transaction**.
   *
   * Use this for an entry that describes a change this unit of work is making.
   * Its invariant is that every entry describes something that happened, so an
   * entry surviving a rolled-back command would make the trail actively
   * misleading — worse than a missing entry, because the trail is what an
   * investigation treats as authoritative.
   *
   * Do *not* use it for an entry that records a refusal or a detected
   * inconsistency, where there is no committed change to describe. Rollback
   * would erase the only evidence of why nothing happened. Those are written
   * directly on the log, out of band, and each call site says so.
   */
  audit(entry: PendingAuditEntry): void;
}

/**
 * What a service needs in order to commit.
 *
 * `outbox` is optional because some state changes deliberately publish nothing
 * — geography and organization are reference and tenancy data, and ADR 0009
 * says events carry business facts, not reference-table churn. Those services
 * still need a transaction, because their audit entry has to commit with the
 * row. Handing them an outbox they never append to would advertise a
 * capability they do not have; `emit` throws if one is used anyway.
 */
export interface TransactionContext {
  boundary: TransactionBoundary;
  outbox?: OutboxStore;
  audit: AuditLog;
}

export async function withTransaction<T>(
  context: TransactionContext,
  fn: (uow: UnitOfWork) => Promise<T> | T,
): Promise<T> {
  const mutations: Array<(scope: TransactionScope) => Promise<void> | void> = [];
  const events: EventEnvelope[] = [];
  const audits: PendingAuditEntry[] = [];
  const uow: UnitOfWork = {
    stage: (mutation) => mutations.push(mutation),
    emit: (event) => {
      if (!context.outbox) {
        throw new Error("this unit of work has no outbox and cannot emit an event");
      }
      events.push(event);
    },
    audit: (entry) => audits.push(entry),
  };

  return context.boundary.run(async (scope) => {
    const result = await fn(uow);

    // Commit point: nothing above this line has been made visible.
    for (const mutation of mutations) await mutation(scope);
    for (const entry of audits) await context.audit.record(entry, scope);
    // The outbox append stays last so that a failure anywhere earlier means no
    // event was ever written, on either backend.
    for (const event of events) await context.outbox?.append(event, scope);
    return result;
  });
}
