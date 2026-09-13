/**
 * The order a listing returns its rows in.
 *
 * Milestone 21 found that the eventing queues stated their order twice — once
 * in an `order by`, once in a `Map` iteration that was not an order at all —
 * and that the two disagreed. Milestone 22 is the same question asked of every
 * other listing in the repository, and the answer was the same: the Postgres
 * repositories sort, the reference repositories return whatever order rows
 * happened to be inserted in, and the two agree only as long as a test inserts
 * its fixtures in the order the SQL would have sorted them into.
 *
 * Two rules follow, and this module exists so that both are written once:
 *
 *   - **A reference listing sorts by the same keys as its SQL.** Insertion
 *     order is not a sort; it is a coincidence that holds until a caller
 *     back-dates a row, replays history, or updates a row in a backend that
 *     reinserts it.
 *   - **The keys must be total.** `order by created_at` over rows that share a
 *     timestamp leaves the rest to the query plan, which is a real difference
 *     the moment a caller adds a `limit`. Every listing therefore ends its key
 *     list with the row's own primary key.
 *
 * Values are compared as strings — every key used here is a timestamp in ISO
 * form, an identifier, or a code — except for `numericKey`, which wraps a
 * numeric column so that 2 sorts before 10.
 */

/** One sort key: the value to compare, already reduced to a comparable. */
export type SortKey<T> = (row: T) => string | number;

/** Marks a key as descending, for the one listing that reads newest-first. */
export function descending<T>(key: SortKey<T>): SortKey<T> & { readonly desc: true } {
  return Object.assign(key, { desc: true as const });
}

function isDescending<T>(key: SortKey<T>): boolean {
  return (key as { desc?: boolean }).desc === true;
}

/**
 * Code-unit comparison, not `localeCompare`, and this is the third defect
 * milestone 23 measured rather than a style choice.
 *
 * `localeCompare` sorts the way a human reads a phone book: case-insensitively,
 * ignoring punctuation, accents near their base letter. No Postgres collation
 * this repository can be deployed against sorts that way. Measured on the same
 * eight subscriber names:
 *
 *   postgres (`collate "C"`) : MOVE-c Move-b "move a" move-A move-a move1 move_a móve
 *   javascript `<`           : MOVE-c Move-b "move a" move-A move-a move1 move_a móve
 *   javascript localeCompare : móve "move a" move_a move-a move-A Move-b MOVE-c move1
 *
 * The first two agree exactly; the third agrees with neither. Worse, the server
 * collation is a property of the *deployment*: this machine's database was
 * initialised `C`, and CI's `postgres:16` container comes up `en_US.utf8`, so a
 * declared text order asserted against the server default would have been a test
 * whose verdict depended on which database it met. Both halves are therefore
 * pinned: every collatable `order by` in the repository carries `collate "C"`,
 * and this comparison is by code unit. Same order, stated twice, and neither
 * statement can be moved by an operator's `initdb` flags.
 *
 * Exported because the same comparison is needed by the hand-written comparators
 * that order the queues and the replay/revival selections. They each called
 * `String.prototype.localeCompare` directly, which ignores the hyphens in a
 * UUID and the punctuation in a code, so two comparators in one process could
 * disagree about the same pair of rows. One function, one order.
 */
export function compareValues(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The rows, sorted by the given keys in order, each key breaking the ties the
 * previous ones left. Returns a new array; the caller's collection is not
 * reordered.
 */
export function orderedBy<T>(rows: Iterable<T>, ...keys: readonly SortKey<T>[]): T[] {
  return [...rows].sort((left, right) => {
    for (const key of keys) {
      const result = compareValues(key(left), key(right));
      if (result !== 0) return isDescending(key) ? -result : result;
    }
    return 0;
  });
}
