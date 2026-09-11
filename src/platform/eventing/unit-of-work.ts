import type { TransactionBoundary, TransactionScope } from "../persistence/transaction.js";
import type { EventEnvelope } from "./envelope.js";
import type { OutboxStore } from "./outbox.js";

/**
 * Transactional boundary. Domain mutations and outbox appends either both land
 * or neither does.
 *
 * Mutations are staged rather than applied inline so that the commit point is
 * a single, obvious place. A staged mutation receives the transaction scope and
 * must pass it to every repository write it performs, otherwise that write
 * escapes the transaction.
 */
export interface UnitOfWork {
  stage(mutation: (scope: TransactionScope) => Promise<void> | void): void;
  emit(event: EventEnvelope): void;
}

/** What a service needs in order to commit: a boundary and the outbox to append to. */
export interface TransactionContext {
  boundary: TransactionBoundary;
  outbox: OutboxStore;
}

export async function withTransaction<T>(
  context: TransactionContext,
  fn: (uow: UnitOfWork) => Promise<T> | T,
): Promise<T> {
  const mutations: Array<(scope: TransactionScope) => Promise<void> | void> = [];
  const events: EventEnvelope[] = [];
  const uow: UnitOfWork = {
    stage: (mutation) => mutations.push(mutation),
    emit: (event) => events.push(event),
  };

  return context.boundary.run(async (scope) => {
    const result = await fn(uow);

    // Commit point: nothing above this line has been made visible.
    for (const mutation of mutations) await mutation(scope);
    for (const event of events) await context.outbox.append(event, scope);
    return result;
  });
}
