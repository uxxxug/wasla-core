# WASLA CORE — Roadmap

**Last updated:** 2026-09-11
**Last milestone:** Every port has a Postgres adapter and the whole coordination flow — MARKET → CORE → MOVE → CORE → MARKET, including the money capture — now runs against a real database. 155 tests pass with `DATABASE_URL` set.
**Verification at this working tree:** `tsc --noEmit` clean; `vitest run` green; governance, contract, migration and roadmap gates passing. Measured on the actual working tree, not assumed from the previous cycle.

## What this project is

WASLA CORE is the shared operating layer of the WASLA system: an independent
service (modular monolith) with its own repository, build, tests, release and
database.

- MARKET creates the work (`skyosv10-art/wasla`).
- MOVE executes the work (`noor-seez/ceezr`).
- CORE coordinates it.

## Ownership boundary

**Owns:** identity, identity links, sessions, principals, roles, permissions,
organizations/tenancy, geography reference, shared pricing and negotiation
rules, payments, wallets, ledger, settlement, subscriptions, plans, periods,
entitlements, usage, reputation and trust signals, notifications, messaging,
support, documents/KYC, referrals, audit, eventing/outbox/inbox, channels and
adapters, integration layer, fulfillment coordination.

**Does not own:** drivers, vehicles, fleets, dispatch, matching, assignment,
tracking, route state, proof of delivery, rides, delivery execution,
merchants, stores, products, catalog, inventory, reservations, commercial
orders, marketplace search, store pricing, or any product-specific UI.

## Done

- [x] Repository created as an independent project (no fork, no monorepo).
- [x] Canonical event envelope with structural validation at every boundary.
- [x] Transactional outbox — state and event commit together or not at all.
- [x] Outbox relay with exponential backoff, attempt limits and dead-lettering.
- [x] Consumer inbox — per-consumer idempotency under at-least-once delivery.
- [x] Logical event bus with per-consumer retry and a dead-letter record.
- [x] Identity, identity links, principals, sessions, memberships.
- [x] Telegram modelled strictly as a channel link, never as the identity.
- [x] Opaque session tokens; only the SHA-256 hash is persisted.
- [x] Role → permission mapping as data; tenant isolation on every check.
- [x] Organizations as flat tenants.
- [x] HTTP surface: correlation ids, canonical error model, structured request
      logs, health and readiness.
- [x] Append-only audit trail with sensitive-metadata scrubbing, enforced by a
      database trigger in the schema.
- [x] Postgres schema authored, with a rollback script.
- [x] OpenAPI 3.1 contract and JSON Schema event contracts.
- [x] Executable governance: boundary, module-isolation, secret and TODO gates.
- [x] Contract gate: every emitted event type must have a published schema.
- [x] Roadmap gate: implementation changes without a roadmap update fail CI.
- [x] CI pipeline: install, typecheck, tests, governance, contracts, roadmap.
- [x] CORE-owned wallets using integer minor units and ISO currency codes.
- [x] Balanced double-entry ledger with append-only database enforcement authored.
- [x] Idempotent payment authorization and capture with transactional outbox events.
- [x] Fulfillment coordination using opaque MARKET order and MOVE job references.
- [x] Idempotent local-bus consumers for `market.order.created` and `move.job.completed`.
- [x] Versioned JSON Schemas and API contract additions for this cycle.
- [x] Geography reference module: countries, regions, cities and service areas
      with radius coverage and coordinate resolution — reference data only, no
      tracking, routing, dispatch or driver state.
- [x] Payment authorization lifecycle: explicit idempotent void, optional hold
      expiry, expiry sweep that releases funds without moving money, and
      capture refused after expiry.
- [x] `core.payment.voided` v1 event schema, void endpoint and expiry field in
      the published contract.
- [x] Migration 0003 with its rollback for geography reference tables and the
      authorization lifecycle columns.

## In progress

Nothing is mid-change in the working tree. Remote publication and remote CI are
**no longer pending**: `uxxxug/wasla-core` is the working remote, pushes are
fast-forward, and the CI workflow runs and passes there — confirmed against the
Actions API on 2026-09-11 rather than assumed from the previous text.

The Postgres adapters themselves are the next step, and the port refactor
described below is what makes them possible. The composition root still wires
the in-memory adapters; nothing has changed about which implementation runs.

## Remaining, in dependency order

1. Settlement beyond the single hold-per-fulfillment case: partial capture,
   refunds and multi-hold orders. The states exist in the schema; the service
   only drives `held -> captured | released` today.
2. Subscriptions, plans, periods, entitlements, usage (ADR 0013).
3. Channels and notifications; Telegram adapter.
4. Durable external event ingress/transport for the implemented Fulfillment contracts.
5. Publish and adopt the versioned contracts in MOVE and MARKET.
6. Event normalisation and historical replay tooling.
7. Migration and reconciliation tooling; dry runs.
8. Security hardening pass and observability export.
9. Staging readiness, cutover and rollback rehearsal.

The end-to-end vertical slice that used to sit in this list is done, on both
backends: `tests/vertical-slice.test.ts` and `tests/vertical-slice-postgres.test.ts`.

## Migrated

Nothing. No data has been migrated from any system. No legacy component has
been retired.

## Retired

Nothing.

## Blockers

| # | Blocker | Impact | What unblocks it |
|---|---|---|---|
| B-1 | *Resolved.* A PostgreSQL instance was provided and migrations 0001–0006 were applied and verified on it (PostgreSQL 17.6 managed, and PostgreSQL 18.4 locally). The full rollback chain was exercised. Persistence itself still runs on the in-memory reference adapters | Postgres repository adapters, now unblocked and next in line | — |
| B-2 | Production data inventory unknown for Ceezr and Wasla | Identity, money and order migrations cannot be planned against real volumes or duplicates | Read access to production, or an exported inventory (row counts, duplicate profile) |
| B-3 | Duplicate-identity merge policy undecided | Detection tooling can be built; no merge may execute | An owner decision on canonical selection and conflict rules |
| B-4 | Regulatory pricing policy undecided (ADR 0012) | Pricing engine can be built rule-driven, but no rates may be fixed | A legal/regulatory decision |
| B-5 | Deployment target and topology not chosen | Manifests stay vendor-neutral; no environment is provisioned | An infrastructure decision |
| B-6 | No production release approval | No production deployment will be attempted | Explicit owner approval |
| B-7 | *Resolved on the working remote.* GitHub Actions was billing-blocked on the `noor-seez` account. The repository CORE is actually developed and pushed to is `uxxxug/wasla-core`, where the CI workflow runs and passes — verified against the Actions API in this cycle, not assumed. If work moves back to a `noor-seez` remote the billing block returns | — | — |
| B-9 | **Resolved.** Audit entries that describe a change now commit inside that change's transaction via `uow.audit`; geography and organization gained a boundary. Entries that record a refusal or a detected inconsistency stay deliberately out of band, because rollback would erase the only evidence of why nothing happened | resolved |
| B-10 | **Resolved.** `InMemoryTransactionBoundary` journals the inverse of every write it is given a scope for, so it unwinds like `ROLLBACK` does. The rollback tests that used to be Postgres-only now run against both adapters | resolved |
| B-8 | *Resolved.* Managed repository credentials are available; CORE is published to `uxxxug/wasla-core` by fast-forward without rewriting history. `package-lock.json` is now committed, so installs are reproducible; previously `npm ci` failed outright because no lockfile existed | — | — |

## Open questions

- Single database with three schemas, or three databases? Ownership is settled
  either way; only the physical topology is open.
- Event transport for production: broker or database-backed queue.
- Session lifetime and refresh policy per channel (currently a fixed 12 hours).

## Risks

| Risk | Severity | Mitigation in place |
|---|---|---|
| Identity duplication across the two legacy systems | high | No automatic merge is possible in code; `canonical_identity_id` requires an explicit merged status |
| Silent event loss between commit and publish | high | Transactional outbox; a crash leaves the record pending and it is retried |
| Duplicate side effects from at-least-once delivery | high | Consumer inbox keyed by `(consumer, event_id)`; tested for triple delivery |
| CORE drifting into a god service | medium | Governance gate fails the build on MOVE/MARKET entities; no proxy endpoints |
| Contract drifting ahead of implementation | medium | Contract gate cross-checks emitted event types against published schemas |
| Roadmap drifting behind the code | medium | Roadmap gate fails the build |

## Tests that pass at this commit

71 of 71 locally, across 11 files. Counted by running the suite at this commit,
not carried over from a previous cycle.

- Eventing (12): envelope completeness, malformed envelope rejection,
  transaction rollback leaves no event, commit writes state and event together,
  publish-once, retry with backoff, backoff window respected, dead-lettering,
  duplicate delivery handled once, independent consumers, out-of-order
  delivery, handler retry then success.
- Identity (8): create identity/principal/link with exactly one event,
  idempotent re-registration with no second event, no automatic merge,
  input validation, token authenticates and is never stored in plaintext,
  unknown/expired/revoked tokens rejected, permissions follow roles,
  cross-organization access blocked.
- API (8): health, readiness, idempotent registration over HTTP, canonical
  error shape with correlation id, unauthenticated and forged tokens rejected,
  tenant isolation on reads, token never echoed back, unknown route shape.
- Money (6): balanced entries and available balance, idempotent authorize and
  capture, insufficient funds refused, idempotent void returning held funds,
  expiry sweep releasing funds and blocking capture, past expiry rejected.
- Geography (4): reference registration, hierarchy reads, coordinate
  resolution ordered by distance, no coverage outside a service area.
- Fulfillment (2): coordination on opaque references, idempotent consumption.
- Vertical slice (8): MARKET order -> CORE fulfillment + money hold -> MOVE job
  -> execution -> CORE closure -> MARKET closure; duplicate delivery; consumer
  retry; network failure after commit replayed from the outbox; expired money
  hold refusing a success claim; cancellation releasing the hold and stopping
  the job; MOVE job-creation failure; full event replay after restart.
- Governance (4): no MOVE/MARKET entities, no hardcoded secrets, no
  cross-module internal imports, no TODO markers.
- Fulfillment dispatch (5): the `dispatched` transition publishes its contract,
  idempotent acceptance, acceptance after cancellation stays cancelled and
  publishes nothing, rejection closes the fulfillment, unknown job reference.
- Fulfillment settlement (11): capture on success, release on failure, on MOVE
  rejection and on cancellation, `settlement_state` on the published contract,
  intake refusal for a missing, unauthorized, captured and expired hold, an
  unfunded order still coordinating, the `unsettled` path with its audit entry,
  a success claim that could not be captured never reported as success, and the
  organization-scoped reconciliation read.
- Money expired holds (3): the balance transition at expiry, authorizing
  against funds an expired hold no longer guards, and the sweep leaving the
  ledger and the balance unchanged.

## Cycle 2026-09-11 — CORE-only hardening (independent CORE agent)

This cycle was performed by an agent responsible for CORE alone. MOVE and
MARKET were not touched; anything they must implement is recorded under
"External dependencies" below.

### Audit findings against the actual code (not the previous roadmap text)

| # | Finding | Severity | Status |
|---|---|---|---|
| G-1 | The `coordinating -> dispatched` transition mutated state but published **no** event. MARKET could not observe that work had been assigned, and a stream replay could not reconstruct the intermediate state. | high | fixed |
| G-2 | A `move.job.accepted` arriving after a cancellation raised a permanent `conflict`, which would dead-letter the MOVE consumer on a legitimate race. | medium | fixed |
| G-3 | A failed hold release was swallowed by an empty `catch`. A fulfillment could close as cancelled or failed while its money was still held or already captured, with **no** record anywhere — the exact state/money inconsistency CORE is responsible for preventing. | high | fixed |
| G-4 | Execution state and money state were only comparable through a cross-module join, so no query could answer "is CORE financially consistent?". | high | fixed |
| G-5 | `market.order.created` could declare any `payment_authorization_id` and CORE never verified it. A hold that was missing, voided, captured or expired was only discovered at capture time — **after** MOVE had already executed the work. | high | fixed |
| G-6 | `balance()` counted expired holds as held even though capture is already refused past the expiry. The available balance understated the truth and authorizations the wallet could afford were refused, for an unbounded window — the sweep is not guaranteed to have run. | medium | fixed |

### Changes

- New published contract `core.fulfillment.dispatched` v1, emitted inside the
  same transaction as the state change (transactional outbox), carrying only
  opaque references — the MOVE job id is passed through and never interpreted.
- A late acceptance after cancellation now records the job reference for
  traceability, stays `cancelled`, publishes nothing and does not fail the
  consumer.
- `docs/event-catalog.md` documents the full published lifecycle tree.
- `settlement_state` (`none` | `held` | `captured` | `released` | `unsettled`)
  is now part of the fulfillment aggregate and is set on every transition.
  `unsettled` is the single explicit inconsistent value.
- A void that cannot be applied is no longer silent: the fulfillment is marked
  `unsettled` and an audit entry (`fulfillment.settlement_inconsistent`, with
  the hold reference deliberately named so the audit scrubber keeps it) records
  the mismatch. Closure still proceeds — CORE reports the truth rather than
  blocking.
- Holds are verified at intake through the published money port. An order whose
  hold is missing, not authorized, already captured or expired is closed as
  `failed` immediately, `core.fulfillment.created` is never published, and a
  still-authorized hold is released as part of the refusal. CORE no longer asks
  MOVE to execute work it already knows it cannot settle.
- `isFinanciallyConsistent` encodes the invariant; `listFinanciallyInconsistent`
  and `GET /v1/fulfillments/reconciliation/inconsistent?organization_id=` expose
  it. An empty result is the expected state.
- `settlement_state` added as an optional, additive field to
  `core.fulfillment.completed.v1` and `core.fulfillment.cancelled.v1`; the
  closure `reason` vocabulary is now documented in the contract.
- Migration `0005_fulfillment_settlement_state` (additive, with backfill and
  rollback) adds the column, a value check and an alignment check that stops
  the database from storing a closed fulfillment that is still holding money.
- `held_minor` now counts only capturable holds. An expired hold is reported in
  the new additive `expired_hold_minor` field and its funds are immediately
  available again; the sweep still releases it formally and the ledger is never
  touched by expiry. No existing balance field changed meaning for a wallet
  without expiring holds.

### Migrations executed against a real engine for the first time

A PostgreSQL instance was provided, so the migrations stopped being an
unverified claim. All six were applied to a managed PostgreSQL 17.6 instance
and to a local PostgreSQL 18.4 instance, and the whole rollback chain
0006 → 0001 was exercised down to an empty schema. The result: 20 tables, 32
check constraints, 47 indexes.

Executing them exposed two defects that no amount of in-memory testing could
have found, because both live in the database layer itself:

| # | Finding | Severity | Status |
|---|---|---|---|
| G-7 | The three trigger functions were created with a **mutable** `search_path`. `ledger_transaction_is_balanced` resolves `ledger_entry` through the caller's search_path, so a session that puts a decoy `ledger_entry` ahead of ours makes the balance check read the wrong table and pass. **Demonstrated, not theorised:** with 0006 rolled back, an unbalanced ledger transaction committed successfully; with 0006 applied, the identical attempt is refused | high | fixed |
| G-8 | Every table was readable by any role holding USAGE on the schema. On a managed host that exposes the schema over HTTP, identities, wallets, the ledger and the audit trail were reachable without authenticating against CORE at all | high | fixed |

Migration `0006_harden_trigger_functions` pins each function's `search_path`
to the schema it was installed in and enables row-level security with **no**
policies on all 20 tables, which is deny-by-default for every role except the
table owner. CORE connects as the owner, so the application is unaffected; any
non-owner role must be granted explicit policies. Nothing in the migration
hardcodes a schema name — it pins to `current_schema()` — so it stays correct
if the tables do not live in `public`. On the managed instance the security
advisor went from one ERROR plus one WARN to informational only.

Both the backfill in 0005 and the rollbacks were verified with real rows:
pre-existing fulfillments correctly derived `held`, `captured`, `released` and
`none` from their authorization status, and `0005.down` removed the column
cleanly.

### Tooling added

- `scripts/db-migrate.mjs` — `status`, `up`, `down [--all]`, driven by
  `DATABASE_URL`, wrapping each file in a transaction so a migration that fails
  halfway leaves nothing behind. Version bookkeeping stays in the migration
  files, which already record themselves. Exposed as `npm run db:status|db:up|db:down`.
- `tests/db-schema.test.ts` — 24 assertions against a live engine: the recorded
  migration ledger, the `settlement_state` default, all nine execution/money
  combinations CORE produces, all eight it must never store, the pinned
  function `search_path`, the decoy-schema ledger bypass, deny-by-default row
  security, and the partial index behind the reconciliation read. Skipped when
  `DATABASE_URL` is absent, so the default suite and CI are unchanged.
- `pg` is a **devDependency** only. The application still has no runtime
  dependencies; this is tooling, not served code.

### Integration reviewed from the CORE side only

`MARKET -> CORE -> MOVE -> CORE -> MARKET` is exercised end to end by
`tests/vertical-slice.test.ts` against the contract simulators in
`tests/support/product-simulators.ts`. Those simulators are CORE-side test
doubles: they prove the contracts are consumable, they do **not** prove the
real MOVE or MARKET services implement them.

CORE is the source of truth for coordination state and for every intermediate
event in that round trip. It holds opaque references only — no order items,
prices, drivers, vehicles or routes cross into CORE payloads, and the
governance gate fails the build if they do.

### External dependencies

Recorded, not implemented. This cycle changed nothing outside CORE.

**MOVE must:**

| Direction | Contract | Note |
|---|---|---|
| consume | `core.fulfillment.created` v1 | the request to execute |
| consume | `core.fulfillment.cancelled` v1 | must stop work already dispatched |
| publish | `move.job.accepted` v1 | CORE turns this into `dispatched` |
| publish | `move.job.rejected` v1 | CORE closes as `failed` and releases the hold |
| publish | `move.job.completed` v1 | CORE captures the hold on success |

CORE now tolerates a `move.job.accepted` that arrives after a cancellation: it
is absorbed, not rejected, so MOVE will not see a dead-lettering `conflict` on
that race. MOVE should still treat the cancellation as authoritative.

**MARKET must:**

| Change | Contract | Compatibility |
|---|---|---|
| consume the new event | `core.fulfillment.dispatched` v1 | new; without it MARKET cannot show that work was assigned |
| read the new field | `settlement_state` on `core.fulfillment.completed` / `.cancelled` v1 | additive and optional — existing consumers keep working |
| send the hold | `payment_authorization_id` on `market.order.created` | an order without it still coordinates, but CORE cannot bind money to that execution |

MARKET should expect a fulfillment to be closed as `failed` at intake, before
any MOVE dispatch, when the declared hold is missing, not authorized, already
captured or expired. In that case `core.fulfillment.created` is never
published at all.

## Cycle 2026-09-11 — cross-system vertical slice (CORE side)

- Fulfillment lifecycle extended: `coordinating -> dispatched -> completed |
  failed | cancelled`, with `move.job.accepted` and `move.job.rejected`
  consumed and `core.fulfillment.cancelled` published.
- Money is now bound to fulfillment through a published port: success captures
  the hold, failure/rejection/cancellation releases it, and an unsettleable
  hold turns a reported success into a failed closure. CORE never reports
  success for work it could not settle.
- Contracts added: `move.job.accepted.v1`, `move.job.rejected.v1`,
  `core.fulfillment.cancelled.v1`; `market.order.created.v1` gained an optional
  `payment_authorization_id`; `core.fulfillment.completed.v1` gained `reason`.
- Migration `0004_fulfillment_lifecycle` (additive) with rollback.
- MOVE and MARKET are exercised through contract-conformant simulators in
  `tests/support/product-simulators.ts` — the repositories stay independent and
  no runtime code or database is shared.

## Not proven yet

- The MOVE and MARKET repositories implementing their side of these contracts
  (next cycle; CORE-side simulators prove the contract, not their code).

- Behaviour against a real Postgres database (migration 0001 unexecuted).
- Behaviour under a real message broker (the bus is in-process today).
- Atomic rollback of in-memory staged mutations if a later staged mutation throws;
  production persistence must supply a real database transaction boundary.
- Any production or staging deployment.
- Any data migration, reconciliation or cutover.
- Performance and load characteristics.

### The ports could not have had a database adapter

This cycle's finding is not a bug in behaviour. It is that the next roadmap item
was impossible as written, and the roadmap did not say so.

Every persistence port was synchronous:

```ts
getIdentity(identityId: string): Identity | undefined;
insertIdentity(identity: Identity): void;
append(event: EventEnvelope): void;
```

No database adapter can implement those signatures. A query returns a promise,
so `getIdentity` cannot hand back an `Identity` in the same tick, and `void`
gives an adapter nowhere to report that a write failed. The unit of work had the
same problem from the other direction: `stage(mutation: () => void)` buffered
closures that took no argument, so two staged writes had no shared handle and
therefore no way to land in one transaction. Its own comment said the Postgres
implementation "will map onto a real transaction" — with that signature it
could not have.

So the ports were the blocker, not the schema and not the missing database.

| Change | Why |
|---|---|
| Every repository, outbox, inbox and audit method returns a promise | A durable adapter cannot answer synchronously |
| `TransactionBoundary.run(work)` in `src/platform/persistence/transaction.ts` | Gives `withTransaction` something to open and close; the in-memory boundary keeps the existing staged-rollback semantics, a Postgres boundary maps to `BEGIN`/`COMMIT`/`ROLLBACK` |
| Writes take a `TransactionScope`; staged mutations receive it | Two writes in one unit of work now share a handle, which is what makes them atomic in a real engine. A write that ignores the scope escapes the transaction — that is now visible in the signature rather than impossible to express |
| `TransactionContext { boundary, outbox }` passed to `withTransaction` | The commit point stays one obvious place instead of spreading into the services |

Deliberately left synchronous: `IdentityService.authorize`, which is a pure
check against an already-authenticated actor and reads no repository. Making it
async would have added an await to every route for nothing.

Also honest about what this did not fix: audit entries are still written
outside the unit of work, and geography writes one row per command with no
transaction at all. Neither is wrong today — audit is append-only and geography
is reference data — but when the Postgres adapters land, an audit entry for a
rolled-back command would survive. That is recorded as B-9 rather than quietly
fixed in a refactor commit.

`tests/transaction-boundary.test.ts` (6 tests) asserts the boundary is really
used: a recording boundary proves `begin`/`commit` wrap both the mutation and
the outbox append, that every staged mutation receives the same scope, that a
throw in the work *or* in a staged mutation produces `rollback` with nothing
appended, and that mutations are applied before the append rather than after.

The refactor touched all five modules, the eventing platform, the composition
root and all 11 test files. The suite result is unchanged — 71 passing, same
tests, same assertions — which is the point: this is a contract change with no
behavioural change.

### First persistence adapters on Postgres

Four ports now have a real implementation: identity, organization, outbox and
inbox, plus the transaction boundary they all depend on.

| File | What it is |
|---|---|
| `src/platform/persistence/postgres.ts` | `PgTransactionBoundary` (`BEGIN`/`COMMIT`/`ROLLBACK` on one pooled client) and `runner(pool, scope)`, the single place that decides whether a statement joins the caller's transaction or runs autocommit |
| `src/platform/eventing/pg-outbox.ts` | Durable outbox. `append` runs on the caller's scope so the event and the state change commit together; `claimDue` uses `for update skip locked` so two relays never publish the same event |
| `src/platform/eventing/pg-inbox.ts` | Durable inbox. `claim` is one `insert ... on conflict do nothing ... returning`, so a race between two workers is resolved by the database rather than by a check-then-insert window |
| `src/modules/identity-access/pg-repository.ts` | Identities, links, principals, sessions, memberships |
| `src/modules/organization/pg-repository.ts` | Organizations |

`tests/pg-adapters.test.ts` runs the **same** assertions against the in-memory
and the Postgres adapters. That is what makes it worth writing: a test written
only against Postgres proves the SQL parses, while running both proves the two
are substitutable, which is the only property the services rely on. 16 shared
cases run everywhere; with `DATABASE_URL` set they run twice and two
Postgres-only atomicity cases are added — 34 assertions in total, executed
against PostgreSQL 18.4.

Two things this cycle deliberately did not do:

- **The composition root still wires the in-memory adapters.** Money, geography
  and fulfillment have no adapter yet, and a unit of work that wrote a
  fulfillment to a `Map` and its event to Postgres would not be atomic. A
  half-migrated switch would look like progress and remove a guarantee.
- **The in-memory rollback gap was reported, not papered over.** The
  conformance suite found that `InMemoryTransactionBoundary` cannot undo a
  staged write that already succeeded when a later one fails, because staging
  only defers writes, it does not journal them. Postgres has no such gap. Both
  behaviours are now asserted explicitly and the difference is recorded as
  B-10.

### Every port has a Postgres adapter, and the slice runs on it

The remaining adapters — geography, money, fulfillment and the audit trail —
are implemented, and the composition root can now select a backend.

| File | Notes |
|---|---|
| `src/modules/geography/pg-repository.ts` | Reference data. `char` columns are trimmed on read, otherwise a value written as `SA` comes back padded and compares unequal |
| `src/modules/money/pg-repository.ts` | `amount_minor` is `bigint`, which the driver returns as a string; converting in one named place is why the conformance test asserts `typeof amount_minor === "number"`. `insertTransaction` **refuses to run outside a transaction**: the balance trigger is deferred to `COMMIT`, so a header written by itself would trip it and the error would read like a balance bug instead of a missing transaction |
| `src/modules/fulfillment/pg-repository.ts` | MARKET and MOVE references stay opaque strings, exactly as in the domain. `fulfillment_settlement_alignment_check` means the database refuses any status/settlement pair the service should never have produced |
| `src/platform/audit/pg-audit.ts` | Append-only, with the same metadata scrubber as the in-memory log, so a credential cannot reach the table through this path either |
| `src/platform/persistence/backends.ts` | `memoryPersistence(clock)` and `postgresPersistence(pool, clock)` return one bundle. Selecting adapters individually is deliberately not possible: a `Map` repository next to a Postgres outbox compiles, runs, and is not atomic |

`createCoreApp({ clock, persistence })` takes the bundle and `/ready` reports
which one is wired, so the backend is observable rather than assumed. CORE
still never reads an environment variable or imports the driver in `src/`: the
caller builds the pool and owns its lifetime.

**`tests/vertical-slice-postgres.test.ts`** is the test this whole sequence was
for. The in-memory slice proves the coordination logic; it cannot prove that
logic survives a real database, because a `Map` never rejects a row, never
enforces a foreign key and never applies a check constraint. The same
MARKET → CORE → MOVE → CORE → MARKET flow now runs on Postgres and covers
completion with capture, rejection with release, duplicate delivery of every
event, a fully drained outbox with nothing dead, and the audit trail landing in
the table.

Result with `DATABASE_URL` set: **155 tests pass**, 100 of them in the
dependency-free default run.

One thing the database changed that the in-memory suite never could: the
existing tests use identifiers like `"org-1"`, which Postgres rejects because
`organization_id` is a `uuid` with a foreign key. The Postgres slice creates a
real organization first. That is not a test inconvenience — it is the schema
refusing a reference that was never valid, which is the reason to run the
suite against it.

### B-10 resolved: the reference boundary has real rollback

The gap was a specific one, and worth stating precisely because the old
comment in `unit-of-work.ts` claimed it away: **staging is not rollback.**
Deferring writes to a single commit point means a command rejected by a domain
rule leaves nothing behind — that is the common case, and it worked. But once
the commit point starts applying staged writes, a failure on the third has
already let the first two land. Deferral narrows the window; it does not close
it.

`InMemoryTransactionBoundary` now opens a `MemoryJournal` and puts it in the
scope. Every in-memory adapter calls `journalMapWrite(scope, map, key)` (or
`journalAppend`) immediately *before* mutating, which records how to undo that
write while the pre-image is still readable. A throw unwinds the journal in
reverse order, so two writes to the same key undo last-first.

Two consequences that make this more than a test fix:

- A write given `NO_SCOPE` registers nothing and is not undone. That is not an
  omission — it is the same thing Postgres does with a statement issued on the
  pool, which autocommits and is equally impossible to take back. The two
  implementations now agree about what a scope means.
- An adapter that ignores the scope is now *provably* non-transactional rather
  than accidentally fine, because the conformance suite runs the rollback tests
  against both backends.

Also unified: **nesting is refused by both boundaries.** It used to be refused
only by Postgres, and only by accident of implementation. A nested
`PgTransactionBoundary.run` takes a *second pooled connection*, so the inner
work commits on its own while the outer transaction is still open — two
transactions that look like one. The guard uses `AsyncLocalStorage`, not a flag
on the boundary, because two concurrent HTTP requests legitimately open two
independent transactions and a flag cannot tell that apart from real nesting.
Both behaviours are asserted: `refuses a transaction opened inside another one`
and `keeps two concurrent transactions independent`.

New conformance tests, running on both backends:

| Test | What it would catch |
|---|---|
| `discards writes already applied earlier in the same transaction` | The original B-10 gap. Trigger is a duplicate identity link, which both adapters reject on their own terms |
| `restores the previous value of a row the transaction overwrote` | A journal that only deleted keys instead of restoring pre-images. This passes the test above and fails this one |
| `refuses a transaction opened inside another one` | A service calling another service inside its own unit of work |
| `keeps two concurrent transactions independent` | A nesting guard implemented as a flag, which would break concurrency |

163 tests pass with `DATABASE_URL` set, 104 without.

### B-9 resolved: the audit trail commits with the change it describes

Every service write path was reviewed. The audit entry was always written
*after* `withTransaction` returned, so with Postgres adapters a rolled-back
command could leave a trail entry claiming it happened. That is worse than a
missing entry: the trail is what an investigation treats as authoritative, so
a false entry sends the investigation to the wrong place.

The decision was made per record, on what the record means — not on what was
easier to wire.

| Write path | Decision | Why |
|---|---|---|
| Identity registration, session issue/revoke, membership grant | **Inside the transaction** | A session or a membership is an authorization fact. One that exists with no record of being granted is exactly what an access review is looking for |
| Organization creation | **Inside the transaction** | Publishes no event (tenancy is read through the API, ADR 0009) but still needs a transaction, purely so the row and its audit entry land together |
| Geography: country, region, city, service area | **Inside the transaction** | Same shape as tenancy — reference rows, no events, audited administrative writes |
| Wallet creation, credit, authorize, capture, void, expiry sweep | **Inside the transaction** | An audit entry saying money moved, when the ledger transaction rolled back, is the record a reconciliation would trust |
| Fulfillment created / refused / dispatched / closed / cancelled | **Inside the transaction** | A trail saying a fulfillment was dispatched when the update rolled back would send an operator to the wrong product |
| `fulfillment.settlement_inconsistent` | **Deliberately out of band** | Nothing was mutated, so there is no change to be atomic with, and it is the *only* record of why money and execution disagree. Writing it inside the caller's transaction would let a rollback erase the evidence of the inconsistency that caused the rollback |

So the rule is not "audit goes in the transaction". It is: **an entry that
describes a committed change belongs in that change's transaction; an entry
that records a refusal belongs outside one.** `UnitOfWork.audit` carries the
first case and its doc comment refuses the second.

Mechanically: `TransactionContext` now carries the audit log, `uow.audit(entry)`
stages an entry, and the commit point applies mutations, then audit entries,
then outbox appends. The append stays last so a failure anywhere earlier still
means no event was ever written — the property the relay depends on.

`TransactionContext.outbox` became optional. Geography and organization
publish nothing by design, and handing them an outbox they never append to
would advertise a capability they do not have; `emit` throws if one is used
without an outbox.

Two smaller things this review surfaced:

- `revokeSession` mutated the stored session object in place. With `Map`
  repositories that made the revocation visible before the commit, and left
  the journal nothing to restore because the pre-image and the new value were
  the same object. It builds a copy now.
- `OrganizationService` and `GeographyService` take a `TransactionBoundary` as
  a required constructor argument rather than defaulting to a private one. A
  default would have quietly given them their own boundary, which is the kind
  of thing this whole sequence exists to stop.

New conformance tests, on both backends: `commits state, audit entry and event
together`, `leaves no audit entry behind when the command is rolled back`, and
`keeps an out-of-band audit entry even when the caller rolls back` — the last
one pins the deliberate exception so it cannot be "tidied up" later. The
ordering test now asserts `mutation, audit, append`.

169 tests pass with `DATABASE_URL` set, 104 without.
