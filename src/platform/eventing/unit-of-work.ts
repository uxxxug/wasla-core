import type { EventEnvelope } from "./envelope.js";
import type { OutboxStore } from "./outbox.js";

/**
 * Transactional boundary. Domain mutations and outbox appends either both land
 * or neither does. The in-memory implementation buffers mutations and applies
 * them on commit; the Postgres implementation will map onto a real transaction.
 */
export interface UnitOfWork {
  stage(mutation: () => void): void;
  emit(event: EventEnvelope): void;
}

export async function withTransaction<T>(
  outbox: OutboxStore,
  fn: (uow: UnitOfWork) => Promise<T> | T,
): Promise<T> {
  const mutations: Array<() => void> = [];
  const events: EventEnvelope[] = [];
  const uow: UnitOfWork = {
    stage: (mutation) => mutations.push(mutation),
    emit: (event) => events.push(event),
  };

  const result = await fn(uow);

  // Commit point: nothing above this line has been made visible.
  for (const mutation of mutations) mutation();
  for (const event of events) outbox.append(event);
  return result;
}
