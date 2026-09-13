# Column-level parity: `NOT NULL`, types, lengths and defaults

Milestone 18. The sixth parity cycle, and the first one about the *column*
rather than the value in it.

## What was missing

Five cycles closed uniqueness, `CHECK` constraints, foreign keys, triggers and
the delete path. Every one of them is a rule *about* a value. None asks whether
the value fits the column it is written into — and that was the largest
remaining way a row Postgres refuses was accepted by the reference backend.

Measured from `pg_attribute` before any code was written, across the 28 ruled
tables (the whole schema is 32 tables, 270 columns; the four unruled ones are
migration bookkeeping):

| | count |
| --- | --- |
| columns | 254 |
| `NOT NULL` | 197 |
| with a database default | 45 |
| distinct types | 11 |

The types are `uuid`, `text`, `character(2)` (country codes), `character(3)`
(currencies), `timestamptz`, `integer`, `bigint`, `double precision`, `boolean`,
`jsonb` and `text[]`. Default expressions in use: `now()`, `'{}'::jsonb`,
`'pending'::text`, `'none'::text`, `'active'::text`, `0`, `1`, `true`.

The reference backend enforced none of it. Nullability only where a `ROW_RULES`
text rule happened to mention the column, no type at all, no length. A currency
of `"SARX"` in a `character(3)` column, a `1` where Postgres wants `text`, a
`2.5` in an `integer`, an `amount_minor` past `int8`, a `null` in any of the 197
`NOT NULL` columns: all accepted in memory, all refused by the database.

## Two divergences that already existed

The same measurement — taken by instrumenting `putRow` to record the key paths
of every row the suite writes, 7578 writes across 26 of the 28 tables, rather
than by reading the stores and guessing — found two live divergences, both of
them default-reliance:

- **`outbox.created_at`** is `NOT NULL DEFAULT now()` and has been since the
  first migration. The Postgres adapter inserted it and never selected it; the
  reference store never wrote it at all. So a reference outbox record was
  missing a value every database row had, and the two backends returned records
  of different shapes for the same event.
- **`inbound_event.processed_at`** is nullable and set by the adapter in the
  same statement that marks an event processed — and also never selected. The
  reference store omitted the key entirely, so `record.processed_at` read
  `undefined` on one backend and a timestamp on the other.

Both are fixed at the root, not declared as exemptions: `created_at` and
`processed_at` are now fields of `OutboxRecord` and `InboundRecord`, written by
the reference stores from the injected clock, and added to `SELECT_COLUMNS` in
both adapters so each backend returns the value it stores.

## The mechanism

`src/platform/persistence/column-shapes.ts` declares, for each of the 28 ruled
tables, every column: its type, its length where the type has one, whether it is
`NOT NULL`, the database default expression if it has one, and **the path the
value takes in the reference row** — because `outbox` and `inbound_event` nest
the envelope's nine columns under `event.*`, and `notification.data` is not at
`notification.data`. Declaring the column without the path would have made the
gate check nothing for 20 columns.

`assertColumns(table, row)` runs in `putRow` **before** the `CHECK` rules, which
is the order Postgres uses: a `NOT NULL` violation is raised before a `CHECK` on
the same column is evaluated. The two ruled tables whose rows never pass through
`putRow` call it directly — `audit_entry` (an append-only array, not a keyed
map) and `ledger_entry` (entries nested inside their transaction).

Three deliberate choices, all of which could have gone the other way:

1. **No defaults are applied.** A column the database would have filled must be
   written by the store, or the row is refused with a message that says so. The
   alternative — completing the row here — makes this file a second source of
   truth for what a row contains, which is exactly the problem the two
   divergences above are.
2. **An absent key is refused even for a nullable column.** A tuple has no
   "absent" state; null is what the database stores, and `undefined` versus
   `null` is a difference a handler can see.
3. **Refusals quote Postgres' wording**, measured by inserting each offending
   value into a real Postgres 16 and copying what came back — not recalled.

## Where the reference backend is stricter, on purpose

Three writes Postgres *accepts*, by converting, and the reference backend
refuses. Each was measured, and each is refused because memory has no conversion
step, so accepting would leave the two backends holding different values for one
write:

| write | Postgres | reference backend |
| --- | --- | --- |
| `1` into a `text` column | stores `"1"` | refused |
| `"yes"` into a `boolean` column | stores `true` | refused |
| an integer past `Number.MAX_SAFE_INTEGER` into `bigint` | stores the rounded double it was sent | refused; a `bigint` value is accepted |

Refusing a write the database would have taken is the safe direction — a store
that trips one of these has a bug the database was papering over — but it is an
asymmetry, so it is written down here, in the file header, and asserted by its
own tests rather than left for a reader to find.

A short `character(3)` value is *not* refused: `character(n)` blank-pads, and
the schema's own `plan_currency_format` CHECK is what rejects `SA`. Refusing it
in the column gate would quote the wrong rule.

## The gates

`tests/column-parity.test.ts`, 21 assertions, 4 of them requiring a database:

- **Coverage, both directions.** Every column in `pg_attribute` for the 28
  tables is declared, and every declared column exists — with the schema's own
  type, the schema's own `character(n)` width, the schema's own nullability, and
  the schema's own default *expression*. A migration that widens a column, drops
  a default or adds a `NOT NULL` fails here instead of being discovered later by
  a reference store that keeps storing what it always stored.
- **Counts as measurements.** 254 columns, 197 `NOT NULL`, 45 defaulted. The
  gate fails if the live count moves, so the declaration has to be extended
  before the number is.
- **Same words, not just same outcome.** Six offending rows are inserted into a
  real `plan` table inside a transaction and rolled back, and the database's
  message is compared to `assertColumns`' message character for character.
- **The strictnesses are strictnesses.** Postgres is asked to accept the number
  in `text` and the string in `boolean`; if a future version stops accepting
  either, the asymmetry documented above is no longer true and the note is
  wrong.
- **Vacuity guards.** The catalog query asserting 254 rows is what stops the
  coverage gate passing because it read nothing.
- Shape tables equal `ROW_RULES` tables; no column declared twice; every
  `character` column has a length (without it the "value too long" refusal
  cannot be raised at all).

## Falsification

Every gate was broken on purpose before it was trusted. Five attempts, five
caught:

| change | result |
| --- | --- |
| `plan.activated_at` declared `notNull: true` | 4 assertions fail |
| `plan.interval_count` declared `bigint` | catalog gate and the wording comparison fail |
| a `databaseDefault: "now()"` removed | defaulted-count gate and catalog gate fail |
| a column entry deleted | catalog gate fails |
| the `NOT NULL` branch of `assertColumns` disabled | refusal probes and the wording comparison fail |

## Measurements

- `npm run typecheck`, `npm run check:governance`, `npm run check:contracts`,
  `npm run check:migrations`: pass.
- `npm test` without `DATABASE_URL`: 574 passed, 60 skipped, 42 files.
- `npm test` with `DATABASE_URL` against local PostgreSQL 16: 1047 passed, 44
  files.
- CI verdict for the cycle: recorded in `ROADMAP.md` under
  `## Cycle 2026-09-13 (sixth)`.
