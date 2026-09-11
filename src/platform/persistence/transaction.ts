/**
 * Transaction boundary (ADR 0009).
 *
 * Every repository port is asynchronous and every write takes a
 * `TransactionScope`, because a durable adapter cannot answer a read
 * synchronously and cannot make two writes atomic without a shared handle.
 * The in-memory reference adapters ignore the scope; the Postgres adapters use
 * it to pick the client that is inside `BEGIN`.
 *
 * Services never inspect a scope. They receive one, pass it to repository
 * writes, and that is all they are allowed to know about it.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface TransactionScope {
  /** Adapter-private handle. Opaque to every module. */
  readonly handle: unknown;
}

/**
 * Tracks whether the *current async call chain* is already inside a
 * transaction.
 *
 * A boolean field on the boundary would be wrong: two concurrent HTTP requests
 * legitimately open two independent transactions on the same boundary, and a
 * flag cannot tell that apart from a service calling another service inside its
 * own unit of work. Async context can.
 */
const inTransaction = new AsyncLocalStorage<true>();

/**
 * Refuses a transaction opened inside another one.
 *
 * Nesting is not supported, in either implementation, and silently allowing it
 * would be worse than refusing it. `PgTransactionBoundary` would hand out a
 * *second pooled connection*, so the inner work would commit on its own while
 * the outer transaction was still open — two transactions that look like one.
 * Callers that need one commit point must share a unit of work instead.
 */
export function assertNotNested(): void {
  if (inTransaction.getStore()) throw new NestedTransactionError();
}

/** Marks `fn` as running inside a transaction, for `assertNotNested`. */
export function insideTransaction<T>(fn: () => Promise<T>): Promise<T> {
  return inTransaction.run(true, fn);
}

/** Thrown when a boundary is entered while one is already open on it. */
export class NestedTransactionError extends Error {
  constructor() {
    super(
      "a transaction is already open on this boundary; nesting is not supported " +
        "because the inner commit point would be ambiguous",
    );
    this.name = "NestedTransactionError";
  }
}

export interface TransactionBoundary {
  /**
   * Runs `work` so that every write performed with the scope it is given
   * either all commits or none does.
   */
  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

/**
 * Undo log for the in-memory adapters.
 *
 * Postgres can roll back because the server remembers the pre-image of every
 * row a transaction touched. A `Map` remembers nothing, so the in-memory
 * adapters have to say, at the moment they write, how that write is undone.
 *
 * Staging alone is not rollback, and this is the distinction that matters: if
 * three writes are applied at the commit point and the third throws, the first
 * two have already happened. Deferring the writes only narrows the window in
 * which a failure can leave half the change behind — it does not close it.
 * That is what this journal closes.
 */
export class MemoryJournal {
  private readonly undo: Array<() => void> = [];
  private readonly deferred: Array<() => void> = [];

  /**
   * Registers the inverse of a write. Must be called *before* the write, while
   * the pre-image is still readable.
   */
  record(inverse: () => void): void {
    this.undo.push(inverse);
  }

  /** Applies every inverse in reverse order, so overlapping writes unwind correctly. */
  rollback(): void {
    while (this.undo.length > 0) {
      // Reverse order matters: two writes to the same key must be undone
      // last-first, or the first write's pre-image would win.
      this.undo.pop()?.();
    }
  }

  /**
   * Registers a check to run just before the scope completes, the way a
   * Postgres `DEFERRABLE INITIALLY DEFERRED` constraint trigger does.
   *
   * Without this an in-memory store cannot express an invariant that spans
   * two writes, because it would have to judge the world half way through and
   * reject a state the transaction was about to make consistent. The result
   * would be a memory backend that either accepts what production refuses or
   * refuses what production accepts, and both make the test suite lie.
   *
   * Checks are deduplicated by key so N writes to the same row verify once.
   */
  defer(key: string, check: () => void): void {
    if (this.deferredKeys.has(key)) return;
    this.deferredKeys.add(key);
    this.deferred.push(check);
  }

  private readonly deferredKeys = new Set<string>();

  /** Runs every deferred check. Throws on the first violation, as Postgres does. */
  verify(): void {
    for (const check of this.deferred) check();
  }

  get size(): number {
    return this.undo.length;
  }
}

/** The journal behind a scope, or undefined when the write is not in a transaction. */
export function journalOf(scope: TransactionScope | undefined): MemoryJournal | undefined {
  return scope?.handle instanceof MemoryJournal ? scope.handle : undefined;
}

/**
 * Journals a `Map` write. Call immediately before `set` or `delete`.
 *
 * A write outside a transaction registers nothing, which is not an oversight:
 * it mirrors Postgres, where a statement issued on the pool autocommits and is
 * equally impossible to take back.
 */
export function journalMapWrite<K, V>(
  scope: TransactionScope | undefined,
  map: Map<K, V>,
  key: K,
): void {
  const journal = journalOf(scope);
  if (!journal) return;
  const existed = map.has(key);
  const previous = map.get(key);
  journal.record(() => {
    if (existed) map.set(key, previous as V);
    else map.delete(key);
  });
}

/** Journals an append to an array. Call immediately before `push`. */
export function journalAppend<T>(scope: TransactionScope | undefined, list: T[]): void {
  const journal = journalOf(scope);
  if (!journal) return;
  const lengthBefore = list.length;
  journal.record(() => {
    list.length = lengthBefore;
  });
}

/**
 * Reference boundary, with real rollback.
 *
 * `run` opens a journal, hands it to the work as the scope's handle, and
 * unwinds it if the work throws. Adapters that ignore the scope are therefore
 * *not* transactional, and that is visible in the conformance suite rather
 * than hidden by it.
 *
 * Nesting is refused for the same reason `PgTransactionBoundary` refuses it:
 * a second `BEGIN` on the same connection is not a nested transaction, and
 * pretending the inner `run` has its own commit point would be a lie in both
 * implementations.
 */
export class InMemoryTransactionBoundary implements TransactionBoundary {
  async run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    assertNotNested();
    const journal = new MemoryJournal();
    return insideTransaction(async () => {
      try {
        const result = await work({ handle: journal });
        // Deferred constraints fire at commit, so a violation still unwinds
        // every write in the scope rather than leaving half of it applied.
        journal.verify();
        return result;
      } catch (error) {
        journal.rollback();
        throw error;
      }
    });
  }
}

/** A scope for reads and for writes that are deliberately outside a transaction. */
export const NO_SCOPE: TransactionScope = { handle: null };
