# Parity for the runtime tables no gate reached

Milestone 19. The seventh parity cycle, and the first one whose subject is the
*scope* of the previous six rather than a new kind of rule.

## The claim that turned out to be false

The cycle that closed column parity (milestone 18) wrote this about the four
tables with no `ROW_RULES` entry:

> Four of the schema's 32 tables have no `ROW_RULES` entry and therefore no
> column shape: they are migration bookkeeping, written by the migration runner
> rather than by a store.

Re-measuring before starting the next item found it wrong. The sentence stays
where it was written — corrections in this repository are additive — and what
measurement actually found is:

| Table | Columns | `NOT NULL` | Defaults | `CHECK`s | Written by |
|---|---|---|---|---|---|
| `inbox` | 3 | 3 | 1 | 0 | every consumer claim (ADR 0009) |
| `rate_limit_counter` | 6 | 6 | 1 | **3** | every request |
| `idempotency_key` | 5 | 4 | 1 | 0 | **nothing** |
| `schema_migrations` | 2 | 2 | 1 | 0 | the migration files themselves |

Two tables on the hottest write paths in CORE sat outside every gate six cycles
had built. The untrusted claim was larger than the claim.

`schema_migrations` is not written by the runner either: each forward migration
inserts its own version row as its last statement, inside the same transaction
as its DDL. That is a stronger arrangement than a runner that records the work
it did — the record cannot survive a rolled-back migration — and it is now
asserted for all 19 migrations instead of assumed.

## Measured before anything changed

Every value below was inserted into a real PostgreSQL 16 and the message copied
from what came back:

| Write | Postgres | Reference backend, before |
|---|---|---|
| `inbox.claim(consumer, "not-a-uuid")` | `invalid input syntax for type uuid: "not-a-uuid"` | accepted, and `seen` then returned true |
| `rate_limit_counter.subject_kind = "nope"` | violates `rate_limit_counter_subject_kind_ck` | no such rule existed |
| `rate_limit_counter.rate_class = "nope"` | violates `rate_limit_counter_rate_class_ck` | no such rule existed |
| `rate_limit_counter.hits = -1` | violates `rate_limit_counter_hits_ck` | no such rule existed |
| duplicate `(consumer, event_id)` | `duplicate key value violates unique constraint "inbox_pkey"` | modelled, by the `Set` |

The three `rate_limit_counter` constraints were not simply missing: they were
recorded in `tests/check-parity.test.ts` as **unprobeable**, with reasons of the
form "the subject kind is part of the reference limiter's in-process map key,
not a stored column". The reasons were true. They were true because the
reference limiter held no row — which is a description of the gap, not a
justification for it.

## What changed

Both reference stores are row stores now, writing through `putRow`, so they
inherit every gate the six previous cycles built at once — columns, checks,
foreign keys, transitions — rather than getting a bespoke check each:

- `InMemoryInbox` holds `Map<string, InboxRow>` and writes
  `{consumer, event_id, received_at}`. `received_at` is written from an injected
  clock, never defaulted, so the store remains the one source of truth for the
  value. The `uuid` on `event_id` now applies: a claim for a non-id is refused
  in Postgres' words, and nothing is claimed.
- `InMemoryRateLimitWindowStore` holds `Map<string, RateLimitCounterRow>` and
  writes all six columns. Two of the three exemptions became real dual-backend
  probes in `check-parity`. The third — `hits_ck` — was **narrowed** rather than
  deleted: no caller can express a negative count, so it stays unprobeable, but
  it is `declared: true` now, so the rule is restated in `ROW_RULES` and runs on
  the store's own writes.

`ROW_RULES` gained `inbox: []` (a claim ledger whose only rule is its primary
key — the entry exists so the column gate reaches it) and the three
`rate_limit_counter` rules. `COLUMN_SHAPES` gained both tables: the whole-schema
coverage gate now reads **263 columns, 206 `NOT NULL`, 47 defaults**, up from
254/197/45.

## A third divergence, found on the way

`PgRateLimitWindowStore` wrote `updated_at` from the database's `now()` — the
one store in CORE that told the time by itself. Under a fixed clock the
reference limiter wrote the fixed instant and the Postgres limiter wrote wall
time, for the same write. The clock is injected now, used by both the insert and
the `on conflict do update` branch, and a database probe with a fixed clock is
what keeps it that way.

This is the third divergence in three cycles with the same shape: a column one
backend writes and the other never surfaces. All three were invisible to the
suite for the same reason, and that reason is the next actionable item
(milestone 20: gate the *read* path, not only the write path).

## `idempotency_key`

A table nothing writes. Migration 0001 creates it with a key, a scope, a
response body and an expiry; no code in `src/` or `scripts/` inserts, updates or
deletes from it, and the notification module's identically-named *column* is
unrelated.

It is **not** dropped here. Removing it needs `DROP TABLE`, which
`scripts/check-migrations.mjs` refuses in a forward migration on purpose, and
weakening a gate to tidy up a dead table is the trade this repository does not
make. Implementing request idempotency against it is an owner decision about
what a repeated `POST` means. So it is recorded as blocker **B-37** and held as
an enforced exemption: a source scan fails the moment anything starts writing
it.

## The gates

`tests/runtime-table-parity.test.ts`, 12 assertions, 4 requiring a database:

- **No table is ungoverned.** `CREATE TABLE` is parsed out of every migration
  and each table must be either gated (it has a column shape) or excused by name
  with a reason. A table that is both is a failure, and an exemption naming a
  table the schema no longer creates is a failure.
- **Each exemption is tried, not trusted.** A source scan over `src/` and
  `scripts/` for `insert into` / `update` / `delete from` against the table
  compares the writers it finds with the writers the exemption declares. This
  gate is what corrected the first draft of this cycle's own exemption: the
  runner reads `schema_migrations` and does not write it.
- **Every forward migration records its own version** — the other half of that
  exemption, asserted for all 19.
- **Both vocabularies come from one place.** The two `CHECK` expressions are
  read out of `pg_constraint` and compared with the arrays the reference limiter
  enforces, so widening one side fails. (Falsified by adding a value: the gate
  fails.)
- **Both tables are stamped from the injected clock**, checked by reading the
  stored `received_at` and `updated_at` back out of Postgres.
- **The same bad claim is refused in the same words** on both backends.
- **The live shape of both tables** is declared, by name, independently of the
  whole-schema count gate.
- Behaviour is unchanged where it should be: claim-exactly-once, release,
  counting within a window, a new window starting at 1, and pruning.
- Vacuity guards on every scan and query — the migration parse, the source scan,
  the constraint read, the column read.

## Falsification

Six attempts, six caught:

| Change | Result |
|---|---|
| the reference limiter stops writing rows (back to a plain `Map.set`) | the vocabulary probes stop refusing; 1 failure |
| the Postgres limiter goes back to `now()` | the fixed-clock probe fails |
| the inbox row drops `received_at` | refused by the column gate; 1 failure |
| a migration adds a table with neither a shape nor an exemption | the ungoverned-table gate fails, and the migration-count vacuity guard fires |
| the enforced `rate_class` vocabulary is widened by one value | the schema comparison fails and the `check-parity` probe stops refusing |
| (earlier, milestone 18's gates re-run against these changes) | the defaulted-column count gate caught the two new defaults |

## Measurements

- `npm run typecheck`, `check:governance`, `check:contracts`,
  `check:migrations`: pass.
- `npm test` without `DATABASE_URL`: 584 passed, 64 skipped, 43 files.
- `npm test` with `DATABASE_URL` against local PostgreSQL 16: 1063 passed in 45
  files, plus the migration-lifecycle file.
- One local flake, recorded rather than hidden: in the first combined
  `npm test` run against Postgres, `tests/migration-0011-lifecycle.test.ts`
  reported its single test passing and the file failing, after a 60-second run.
  It passed standalone and on re-run. Noted here because CI is the verdict and
  a flake that is not written down is a flake that gets rediscovered.
- CI verdict for the cycle: recorded in `ROADMAP.md` under
  `## Cycle 2026-09-13 (seventh)`.
