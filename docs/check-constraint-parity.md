# Check-constraint parity

Two backends implement every persistence port: the reference stores in `src/` and
the Postgres adapters. Tests run against both, which is only worth something if a
row the database would refuse is also refused in memory. Otherwise a green
reference-store suite certifies a bug instead of catching it — the failure B-12
names, closed for uniqueness rules in `docs/uniqueness-parity.md` and closed here
for `CHECK` constraints.

This file records what the schema declares, how parity is measured, what the
measurement found, and the twelve constraints that cannot be probed through the
ports along with the reason for each.

## What the schema declares

The live schema declares **100 `CHECK` constraints** across 28 tables. They fall
into five families:

- **Closed vocabularies** (32): every `status`, `channel`, `kind`,
  `owner_type`, `actor_type`, `billing_interval`, `subject_kind` and
  `rate_class` column. TypeScript unions describe the same sets at compile time,
  and a value arriving in an HTTP body or an external event payload is a `string`
  at runtime, so the compile-time half does not enforce anything about stored
  data.
- **Formats** (8): `^[A-Z]{3}$` on every currency column, `^[A-Z]{2}$` on country
  codes, `core.%` on the event type a notification recipient may subscribe to.
- **Non-empty text** (10): endpoint URLs, signing secrets, notification addresses
  and bodies, service principal names — plus the stricter
  `length(trim(x)) > 0` form on feature keys, source references and correlation
  ids, where whitespace is not content.
- **Numeric bounds**: a hold must be for more than nothing, a ledger entry
  must move something, latitudes and longitudes must be on the planet, a service
  area must be under 500 km, reclaim counts cannot go negative.
- **Couplings**: two columns that are one fact told twice. A claim
  only on pending work; a fencing token only with a claim; `delivered` exactly
  when there is a delivery time; a merged identity that names its survivor; a
  cancelled subscription that records why; a coordination status that agrees with
  its settlement state.

Before this cycle the reference stores restated **31** of the 100. The remaining
69 were enforced by Postgres alone, so the reference backend accepted rows
production refuses — a notification reported delivered with no delivery time, a
wallet in a currency that is not a currency, a fencing token with no claim behind
it — and the dual-backend suite passed on all of them.

## How parity is enforced

`src/platform/persistence/row-rules.ts` restates the rules **once** — 67 rules
over 25 tables, built from 23 shared closed vocabularies — as a table keyed by
table name. Each rule carries the constraint's exact schema name, the
columns it reads, and a predicate. `assertRow(table, row)` throws
`new row for relation "<table>" violates check constraint "<name>"` — the message
Postgres produces — and `putRow(table, map, key, row)` is the only way a
reference store stores a row, so a transition added later cannot forget to check.

Three properties keep the table honest:

- **Field presence is checked, not assumed.** A rule declares the columns it
  reads; if a row lacks one, `assertRow` throws a different error saying the rule
  can no longer be evaluated. Without that, renaming a column would silently
  disable its rule — the predicate would read `undefined` and pass.
- **Vocabularies live in one place.** The runtime arrays are in `row-rules.ts`,
  and nothing else in `src/` restates them.
- **Rows are treated structurally.** The platform does not import domain types
  for this; rules address columns by name (including dotted paths for the queue
  records that nest their envelope), so no module boundary is crossed to make the
  guard work.

Constraints a store already restated in place — the money ceilings, the plan and
subscription timestamp couplings, the reputation shape rules — are not repeated
in the table. They are probed where they are, so both paths are measured and
neither is duplicated.

## The gate

`tests/check-parity.test.ts` holds one case per constraint. A case names the
constraint, says what accepting the row would mean, takes a valid row from
`tests/support/rows.ts` and breaks exactly one field. Each case runs on both
backends and asserts:

1. the write is refused, and
2. the refusal **names the constraint** in the schema, so the two backends refuse
   for the same stated reason and an operator reading a reference-store stack
   trace is looking at the production constraint name.

Where breaking one field unavoidably breaks a second constraint that reads the
same column — an unknown `fulfillment.status` also falsifies the status /
settlement pairing — the case lists that constraint and either name is accepted.
Postgres does not promise which of two violated constraints it reports.

The gate on the file reads `pg_constraint` at run time and fails when the schema
declares a `CHECK` that has neither a case nor a recorded reason it cannot be
probed. A migration adding a constraint therefore cannot ship without measuring
parity for it. Enumeration needs a database, so that test is skipped without
`DATABASE_URL` and runs in the CI database job on every push.

## What the measurement found

Eighty-eight constraints are probed on both backends. The first run against
Postgres failed on six of them — and in every case it was **Postgres**, not the
reference store, that accepted the row:

- **`membership_roles_check` enforced nothing at all.** It was written as
  `array_length(roles, 1) >= 1`, and `array_length('{}', 1)` is `NULL`, so the
  comparison is `NULL`, and a `CHECK` that evaluates to `NULL` is satisfied. The
  one row it existed to refuse — a membership granting no roles, which reads as
  belonging without permission — was the row it let through, in every migration
  since 0001. Fixed by migration `0019_membership_roles_effective`, which
  replaces the definition with `coalesce(array_length(roles, 1), 0) >= 1` under
  the same name; `ADD CONSTRAINT` validates existing rows, so the migration fails
  rather than passing quietly if such a membership was already stored.
- **`event_delivery` dropped three columns on insert.** `claimed_at`, `reclaims`
  and `claim_token` were left out of the insert list on the grounds that a newly
  queued delivery is unclaimed. The effect was that a caller's values were
  discarded without a word: the reference store kept them, Postgres wrote
  defaults, the two backends held different rows, and the schema's three claim
  constraints never saw the row they exist to refuse. All three columns are now
  bound.
- **`fulfillment` dropped the two execution-after-cancellation markers**, on
  insert for the same reason and on `update` and `updateIfStatusIn` as a
  consequence — a whole-row update that leaves two columns alone silently ignores
  part of what it was given. All three statements now write every mutable column.

Two reference-store gaps were found and fixed in the rules table rather than in
the database: `fulfillment_settlement_alignment_check` was not restated at all,
and `subscription_period_status_check` and the remaining vocabularies had no
runtime form. Both are now in `row-rules.ts`.

Measured after the fixes: **178 assertions pass** — 88 constraints × 2 backends
plus the two coverage tests — and the full suite is green with and without a
database.

## Where the backends legitimately differ

Twelve constraints cannot be violated through any port, so no test can construct
the offending row the way the application would. They are listed in `UNPROBEABLE`
in the parity test with the reason for each, the coverage gate counts them, and a
second test asserts that the ones whose columns exist in the reference rows are
still declared in `ROW_RULES` — an exemption says a caller cannot reach the rule,
not that the store may ignore it.

- **`outbox` (4) and `inbound_event` (4): status, claim, claim token, reclaims.**
  `append` takes an event envelope and `accept` takes an envelope; the status is
  the store's own, set to `pending`, and moved only by acknowledgement. Claims are
  stamped by `claimDue`, tokens are minted there, and reclaim counts are
  incremented by recovery. No caller supplies any of them. All eight are declared
  in `ROW_RULES` and enforced on every internal transition.
- **`inbound_event_processed_at_check`.** `processed_at` is a Postgres column
  with no field in the reference record: the reference store answers "processed"
  from the status it holds, so there is no second value that can disagree with it.
- **`rate_limit_counter` (3): hits, rate class, subject kind.** The reference
  limiter counts in a `Map` keyed by subject and class and increments by one from
  zero. There is no row, and neither the class nor the subject kind is a stored
  column. `docs/observability.md` and the store's own comment already record that
  the in-process limiter is not the deployable one.

The asymmetry between `outbox`/`inbound_event` and `event_delivery` is worth
naming: `queue` takes a whole delivery row from its caller while `append` and
`accept` take envelopes. That is why five of the delivery constraints are
probeable and the equivalent queue constraints are not.
