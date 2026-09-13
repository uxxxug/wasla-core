# Read-path parity

Milestone 20. Every parity cycle before it gates what a store *accepts*. This
one gates what a store *returns*.

## Why

Three divergences in the three preceding cycles had one shape:

| Column | What was wrong | Found by |
|---|---|---|
| `outbox.created_at` | inserted by the Postgres adapter, selected by neither, absent from the reference record | column parity (milestone 18) |
| `inbound_event.processed_at` | the same, on a nullable column | column parity (milestone 18) |
| `rate_limit_counter.updated_at` | written from the database's `now()` on one backend, the injected clock on the other | runtime-table parity (milestone 19) |

None of them was found by a test of the thing that was broken. They were found
sideways, by a gate built for another purpose, because **a column that one
backend writes and no read returns is a difference nothing in the suite can
observe.** Two were closed by adding a name to a `SELECT_COLUMNS` string, and
nothing kept those strings complete.

## Two halves, on purpose

Neither half subsumes the other, and the three known divergences needed both.

### Static: no column is unreachable

`tests/read-path-parity.test.ts` parses every `select`, and every
`insert`/`update`/`delete … returning`, out of `src/`. The adapters build their
column lists from template constants — sometimes composed
(`` `${COLUMNS}, created_at, …` ``), sometimes aliased
(`const DEL_SELECT_COLUMNS = DEL_COLUMNS;`) — so the constants are expanded to a
fixed point before the statements are read. The result is compared with
`COLUMN_SHAPES` in both directions:

- **A column the schema has that no read surfaces** must appear in `UNREAD`,
  by name, with a reason.
- **A name read that the schema does not have** is a failure. This is the
  reverse gate and also the parser's own honesty check: a mis-parse produces
  ghost columns rather than silent under-reporting.
- **An `UNREAD` entry that has stopped being true** — the column is read now, or
  the column is gone, or the table is no longer shaped — is a failure, so the
  list cannot decay into a permanent excuse.
- **Vacuity guards** on the parser itself: 30 shaped tables, more than 25 tables
  read somewhere, more than 150 columns surfaced. A parser that quietly matched
  nothing would otherwise make every gate above pass.

Measured result: of 263 shaped columns, **all but six are surfaced by some
read**, and there are no ghosts.

### The six exemptions

All six belong to the two tables milestone 19 brought under the write gates, and
the bar for the list is deliberately narrow: **the store's interface has no
reader that returns the row at all.** "No caller needs it yet" is not a reason —
that is exactly how `created_at` stayed invisible for seventeen migrations.

- `inbox.consumer`, `inbox.received_at`. `InboxStore` is
  `claim`/`seen`/`release`/`size`: `claim` reports whether the insert won,
  `seen` is `select 1`. No record type exists on either backend, so no read can
  disagree. `received_at` is asserted directly against the database in
  `tests/runtime-table-parity.test.ts`.
- `rate_limit_counter.subject_kind`, `.subject_hash`, `.rate_class`,
  `.updated_at`. The store answers "how many hits in this window" and prunes;
  the first three are the primary key, bound as predicates on every statement.
  `updated_at` is the milestone-19 divergence, held by a fixed-clock database
  probe that reads the stored value back out of Postgres — which is what a read
  comparison could not do, because no read returns it.

`rate_limit_counter.window_start` is *not* exempt: `prune` surfaces it through
`delete … returning`, and a column a delete returns is a column a caller can
see.

### Behavioural: the two backends return the same record

For the stores that return records, a row is written and read back through
**both** backends and the two records are compared:

- the full set of key paths, at every depth, so a field one backend carries and
  the other does not fails;
- then the values, deep-equal, under one `FixedClock`, one set of ids and one
  input — conditions under which the two records are not merely alike, they are
  the same record.

Probes: outbox (`append` → `get`), inbound (`accept` → `claimDue` →
`markProcessed` → `get`), audit (`record` → `forEntity`, comparing both the
entry the writer returned and the one the reader found), and `event_delivery`,
whose 13-column read list is checked against the declared shape directly.

The inbound probe processes the row before reading it deliberately.
`processed_at` is null on a freshly accepted event, and **a probe that reads a
row whose interesting column is null cannot tell a backend that surfaces the
column from one that does not** — with the first draft of the probe, dropping
`processed_at` from the adapter's select list was caught by the static half
alone. Processing the row first makes both halves catch it.

## Falsification

Six attempts, six caught:

| Change | Caught by |
|---|---|
| the outbox stops selecting `created_at` (the milestone-18 divergence, restored) | static gate + the adapter's own assertion, 3 failures |
| the inbound store stops selecting `processed_at` | static gate + the value comparison |
| the delivery read drops the three claim columns | static gate |
| the audit read drops `metadata` | static gate + 2 behavioural failures |
| the reference outbox stops writing `created_at` | the column write gate, 4 failures |
| an `UNREAD` entry is added for a column that *is* read | the stale-excuse gate |

## Measurements

- `typecheck`, `check:governance`, `check:contracts`, `check:migrations`: pass.
- Without `DATABASE_URL`: **589 passed, 71 skipped** in 44 of 46 files.
- With `DATABASE_URL` against local PostgreSQL 16: **1075 passed** in 46 files,
  plus the migration-lifecycle file.
- CI verdict recorded in `ROADMAP.md` under `## Cycle 2026-09-13 (eighth)`.

## What this does not do

The static half proves no column is unreachable; it cannot prove a read is
*correct* — a `select` that returns the right columns of the wrong rows passes
it, and the predicate is the concern of the behaviour tests each store already
has. The behavioural half proves the two backends answer alike; it cannot see a
column no record carries on either side, which is what the static half exists
for. Both are read-path gates only: the write path stays where the previous six
cycles put it.
