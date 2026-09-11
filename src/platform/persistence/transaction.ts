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
export interface TransactionScope {
  /** Adapter-private handle. Opaque to every module. */
  readonly handle: unknown;
}

export interface TransactionBoundary {
  /**
   * Runs `work` so that every write performed with the scope it is given
   * either all commits or none does.
   */
  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

/**
 * Reference boundary. The staging in `withTransaction` is what provides
 * rollback here: mutations are buffered and only applied once the work
 * completes, so a throw leaves nothing behind.
 */
export class InMemoryTransactionBoundary implements TransactionBoundary {
  private readonly scope: TransactionScope = { handle: null };
  async run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    return work(this.scope);
  }
}

/** A scope for reads and for writes that are deliberately outside a transaction. */
export const NO_SCOPE: TransactionScope = { handle: null };
