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

Nothing is mid-change in the working tree. `uxxxug/wasla-core` is the working
remote, pushes are fast-forward, and CI runs and passes there.

Persistence is no longer the open question: every port has a Postgres adapter,
the composition root can be wired to either backend, and the whole suite runs
against both. Migrations 0001–0007 are applied and verified on two real engines
(PostgreSQL 18.4 locally, 17.6 managed), rollbacks included.

## Remaining, in dependency order

Every line below was checked against the code, the tests and the commits in
this cycle rather than carried over from the previous text. Postgres adapters
and B-1 were never the goal; they are the floor CORE's actual work stands on.

| # | Milestone | Verified status | Evidence / what is missing |
|---|---|---|---|
| 1 | External event ingress: MARKET and MOVE can actually reach CORE | **Started this cycle, CORE side substantially complete** | `POST /v1/events`, `inbound_event` (migration 0007) on both backends, `InboundDispatcher`, trust boundary tied to the credential, 11 tests × 2 backends. Outbound delivery to MOVE/MARKET endpoints is still local-bus only — see external dependencies |
| 2 | Settlement beyond one hold per fulfillment: partial capture, refunds, multi-hold | **Partially complete** | `held -> captured \| released` is driven and atomic with execution state (B-11). The schema has the states but the service has no partial-capture, refund or multi-hold path, and no event contract for them |
| 3 | Subscriptions, plans, periods, entitlements (ADR 0013) | **Not started** | No module, no tables, no contract. No external dependency — CORE can build this alone |
| 4 | Channels and notifications; Telegram adapter | **Not started** | Telegram exists only as an identity channel type (correctly, per ADR 0004). No delivery path |
| 5 | Publish and adopt the versioned contracts in MOVE and MARKET | **Blocked — external dependency** | 14 event schemas and the OpenAPI contract are published in-repo. Adoption is not CORE's to do |
| 6 | Event normalisation and historical replay tooling | **Not started** | `inbound_event` now makes replay possible for the first time: the envelopes are kept. No tooling yet |
| 7 | Migration and reconciliation tooling; dry runs | **Blocked — B-2, B-3** | Financial reconciliation exists (`listFinanciallyInconsistent`, `/v1/fulfillments/reconciliation/inconsistent`). Data migration cannot be planned without a production inventory or a merge policy |
| 8 | Security hardening pass and observability export | **Partially complete** | Deny-by-default RLS on every table, hardened `search_path`, token hashing, audit scrubbing, correlation ids. No metrics/trace export, no rate limiting on the new ingress edge |
| 9 | Staging readiness, cutover and rollback rehearsal | **Blocked — B-5, B-6** | Migrations and rollbacks are rehearsed against real engines. No environment is chosen |

### What was claimed complete and actually is

Spot-checked against code rather than accepted from the list: the transactional
outbox (`uow.emit` + `PendingAuditEntry` ordering), the consumer inbox, role →
permission mapping as data (`ROLE_PERMISSIONS`), append-only audit enforced by
trigger, opaque session tokens stored as hashes only, geography as reference
data with no tracking or routing, and the authorization lifecycle including the
expiry sweep. All present, all covered by tests on both backends.

### What the list said was done and was overstated

- "Behaviour under a real message broker (the bus is in-process today)" was
  filed under *Not proven yet*, which undersold it. It was not a proving gap,
  it was a **functional gap**: with only an in-process bus, no external system
  could start any of the coordination CORE exists to do. Milestone 1 above is
  that gap, and it was invisible in the old wording.
- The *Done* list credits "migration 0003 with its rollback" and stops there,
  though 0004–0007 exist. Corrected by the table above.

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
| B-11 | **Resolved.** Money and execution state were settled in two separate transactions, so a failure between them left funds captured against a fulfillment still recorded as `dispatched`/`held`. `MoneyService.captureWithin` / `voidWithin` now enlist in the caller's unit of work; `capture`/`voidAuthorization` are thin wrappers that open their own | resolved |
| B-12 | **Resolved.** The in-memory money store enforced only primary keys, so two concurrent captures both inserted a `capture:<authorization_id>` ledger transaction and the money moved twice, while Postgres refused the second. The reference store now enforces the schema's UNIQUE constraints, synchronously | resolved |
| B-13 | **Resolved.** `LocalEventBus.publish` resolved successfully even when every subscriber had exhausted its attempts, recording the failure only in an in-process array. Both durable relays decide whether to retry from that answer, so an event could be marked `published`/`processed` in the database while nothing had consumed it. `publish` now throws once any subscriber dead-letters | resolved |
| B-8 | *Resolved.* Managed repository credentials are available; CORE is published to `uxxxug/wasla-core` by fast-forward without rewriting history. `package-lock.json` is now committed, so installs are reproducible; previously `npm ci` failed outright because no lockfile existed | — | — |

## Open questions

- Single database with three schemas, or three databases? Ownership is settled
  either way; only the physical topology is open.
- Event transport for production: broker or database-backed queue.
- Session lifetime and refresh policy per channel (currently a fixed 12 hours).

## Risks

- Migration 0006 enables row-level security from a hardcoded list, so every
  future table must remember to opt in. `tests/db-schema.test.ts` catches an
  omission against a live database, but nothing catches it at authoring time.

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

### Identity of identifiers: resolved without a migration

See `docs/identifiers.md`. In short: the database, the OpenAPI contract and
`newId()` had all already decided that every CORE-owned identifier is a UUID.
The only layer with no opinion was the domain itself — services took `string`
and handed it to a repository — and the test fixtures lived in that gap.

That gap was a real divergence, not cosmetics: a `Map` accepts `"org-1"` and
Postgres raises `invalid input syntax for type uuid`, so the two backends
disagreed about which commands were even well formed. `assertId` now rejects a
malformed identifier at intake on both backends, as `invalid` rather than
`notFound`, because a syntactically impossible identifier does not describe an
absent row — it describes an unsatisfiable request.

**No migration was made and none was needed.** Turning `uuid` into `text`
would have discarded the database's type check, its uniqueness guarantees and
its index efficiency in exchange for letting stale fixtures pass.

References CORE does not issue stay free-form on purpose —
`market_order_reference`, `move_job_reference`, `identity_link.external_id`,
`business_reference`, `correlation_id`, the polymorphic `entity_id` columns,
`country_code` and `legacy_id`. `tests/identifiers.test.ts` asserts a non-UUID
MARKET order id is still accepted, so a later tightening cannot break MARKET.

Fixtures are unified behind `testId(label)` in `tests/support/ids.ts`. Before
this, the in-memory suites used `"org-1"` and the Postgres suites used
`randomUUID()`, which meant the two were not running the same scenarios — the
reason the gap stayed hidden.

174 tests pass with `DATABASE_URL`, 112 without.

### B-11 resolved: money and execution state commit together

Found while closing B-9, and the most serious defect in the repository so far.

`settle()` called `money.capture`, which opened **its own** transaction and
committed. `release()` called `money.voidAuthorization`, likewise. The
fulfillment row was then updated in a **separate** transaction afterwards. Every
SQL statement was correct. The pair was not.

So a failure in between — a dropped connection, a constraint violation on the
fulfillment row, a process restart — left this:

- the hold `captured` and `core.payment.captured` published,
- the fulfillment still `dispatched` with `settlement_state = 'held'`.

That is a financial inconsistency that retrying cannot repair. The retry
re-reads a fulfillment that is still open, tries to capture again, and money
refuses because the hold is already captured — so the fulfillment can never
close as completed. The `fulfillment_settlement_alignment_check` constraint
does not catch it either, because each row is individually legal; it is the
*pair* of rows that disagrees.

`listFinanciallyInconsistent` would have reported it, which is worth noting:
the reconciliation read was doing its job, and the response to a reconciliation
read that keeps finding real inconsistencies is to remove the cause, not to
watch it.

**The fix.** Both boundaries now refuse nested transactions (B-10), so the
answer could not be "open a transaction around the existing calls". Instead
money learned to participate in someone else's:

- `MoneyService.captureWithin(uow, input)` and `voidWithin(uow, input)` do all
  reads and validation first, then stage the mutation, the event and the audit
  entry on the **caller's** unit of work.
- `capture(input)` and `voidAuthorization(input)` remain, as thin wrappers that
  open their own transaction, for callers with nothing else to commit.
- Refusals (`notFound`, `conflict`, expired hold) are raised during the read
  phase, before anything is staged, so a refusal leaves the caller's unit of
  work clean rather than half filled. `settle()` relies on exactly this when it
  falls back to releasing a hold it could not capture.
- `FulfillmentPaymentPort` now declares only the `*Within` forms. A port that
  could open its own transaction made the invariant impossible to express no
  matter how carefully each side was written, so the type no longer offers it.
- `closeWithin` stages the closure instead of committing it, and each of
  `consumeMoveCompletion`, `consumeJobRejected`, `cancel` and the intake
  refusal path now opens exactly one transaction covering settlement, state,
  event and audit entry.

**The tests.** `tests/settlement-atomicity.test.ts` injects a repository whose
`update` fails, which places the failure precisely where it matters: after the
money mutation has been applied, while the fulfillment update is being
applied. It runs on both backends and asserts the hold went back to
`authorized`, the balance is untouched, and neither `core.payment.captured` nor
`core.fulfillment.closed` reached the outbox.

These tests were verified to **fail against the previous design** — the old
shape was temporarily restored and they reported `expected 'captured' to be
'authorized'` and an outbox containing `core.payment.captured`. A rollback test
that has never seen the bug it describes is not evidence.

182 tests pass with `DATABASE_URL`, 116 without.

### B-12 resolved: the reference store now enforces the schema's uniqueness

Found by the new concurrency tests, and it is the clearest example yet of why
the "no hidden divergence" rule is worth the trouble.

Every existing idempotency test called the same command twice *in sequence*,
which only proves the second call can see the first one's row. Issuing both at
once asks a different question. On Postgres, `money.capture` is safe: two
racing captures both try to insert a ledger transaction whose
`business_reference` is `capture:<authorization_id>`, and
`ledger_transaction_business_reference_key` refuses the second, which rolls
back with it. In memory, both succeeded, and **the money moved twice** —
`posted_minor` went to 2000 instead of 6000.

So the in-memory store was more permissive than production, which means it was
certifying a double spend as correct. The service code was identical in both
cases; the guarantee came entirely from a constraint only one backend had.

`InMemoryMoneyRepository` now enforces what `db/migrations/0002` declares:
`ledger_transaction.business_reference` UNIQUE,
`payment_authorization.business_reference` UNIQUE, and
`wallet (owner_type, owner_id, currency)` UNIQUE. The error messages
deliberately mirror the Postgres text, so a caller matching on them behaves
the same either way.

**The subtle part, which cost a debugging cycle and is worth recording.** The
first version of the guard called the existing async finder:

```ts
const clash = await this.findTransactionByReference(ref);   // wrong
if (clash) throw ...;
this.ledger.set(...)
```

That still double-spent. A single `await` between the check and the write is
enough to lose the race in a single-threaded runtime: both captures suspend on
the lookup, both find nothing, both resume and write. The guards are therefore
synchronous, scanning the maps inline rather than calling the async finders.
In this runtime, **atomic means no `await` between the check and the write** —
which is the same reason the transaction boundary journals inverses instead of
deferring writes.

Under concurrency `capture` is exactly-once but not always success-returning:
one caller may receive a refusal and must retry, at which point
`findTransactionByReference` returns the existing transaction idempotently. The
test asserts on the balance rather than on both calls succeeding, because the
balance is the invariant and the return value is not.

### Transaction boundary coverage, against the required list

| Required | Where | Backends |
|---|---|---|
| state + event + outbox + audit commit together | `commits state, audit entry and event together`, `commits a multi-table unit of work as one visible change` | in-memory + Postgres |
| complete rollback on failure | `leaves no audit entry behind when the command is rolled back`, `appends no event when a later write in the same unit of work fails`, `restores the previous value of a row the transaction overwrote` | in-memory + Postgres |
| duplicate commands | `authorizes, holds and captures funds exactly once`, `treats upsertCountry as an update, not a duplicate`, idempotent `cancel` and `consumeMarketOrder` | in-memory + Postgres |
| duplicate events | `duplicate delivery of every event changes nothing`, `ignores a duplicate append of the same event id`, `survives a duplicated delivery of every event` | in-memory + Postgres |
| concurrent claims | `hands one event to exactly one of two simultaneous claimants`, `captures a hold once when two callers capture it at the same time`, `closes a fulfillment once when cancellation races the MOVE completion` | in-memory + Postgres |
| retry after failure | `a transient consumer failure is retried and then succeeds`, `allows a retry after release` | in-memory + Postgres |
| restart then reload | `replaying the whole event history after a restart produces no new effects` (in-memory), `reloads state from the database and refuses to redo settled work` (new, Postgres only — a restart is only meaningful where state outlives the process) | both, separately |
| capture / release in money | `carries an order through to completion and captures the hold`, `releases the hold when MOVE rejects the job`, the settlement-atomicity suite | in-memory + Postgres |
| completion / failure / cancellation | `fulfillment-settlement.test.ts` (11 tests), vertical slice 5–7 | in-memory + Postgres |
| money and state atomic together | `tests/settlement-atomicity.test.ts` (4 tests, both backends) | in-memory + Postgres |

189 tests pass with `DATABASE_URL`, 119 without.

## Milestone: MARKET and MOVE can actually reach CORE

### Why this was next, and not settlement refinement

The roadmap listed partial capture and refunds first. Reading the code instead
of the list changed the order.

CORE's whole purpose is to coordinate MARKET → CORE → MOVE → CORE → settlement
→ MARKET. That loop is implemented and proven, on both backends, end to end.
But every one of those tests reaches it the same way: by calling a consumer
directly, or by publishing onto an in-process `LocalEventBus`. There were 24
HTTP routes and **not one of them could be told that an order exists**.
`consumeMarketOrder`, `consumeJobAccepted`, `consumeJobRejected` and
`consumeMoveCompletion` were unreachable from outside the process.

MARKET and MOVE are separate services in separate repositories. So the
coordination was real and entirely unreachable — correct logic behind no door.
Refining settlement would have made a richer version of something nothing could
start. `Not proven yet` described the in-process bus as a proving gap; it was a
functional one, which is the sort of thing a roadmap only reveals when it is
read against the code.

### What was built, CORE side only

**`POST /v1/events`, answering 202.** Not 200. CORE has taken durable
responsibility for the envelope and has done nothing else with it, and 200
would describe work that has not happened.

**`inbound_event` (migration 0007), the mirror of `outbox`.** The outbox exists
so a state change and its event cannot become two writes that disagree. This
exists so an accepted event and its processing cannot become one request that
disappears. Processing in-request would mean a crash just after the 2xx loses
the event while the producer has been told it arrived — and at-least-once
delivery only helps a producer that has been told to retry. So ingress records
and commits, and `InboundDispatcher` hands the event to the bus afterwards.

**The trust boundary is the interesting part.** Which events a caller may
assert is derived from the credential, never from the request:

- `principal.service_name` (migration 0007, UNIQUE, NULL for every person) says
  which external system a credential *is*. A header naming the producer would
  have let MOVE's credential assert MARKET's facts.
- A caller may only submit its own prefix, so **no external caller can submit
  `core.*` at all**. That is the case that matters: every consumer downstream
  treats `core.*` as authoritative, and an outsider able to announce
  `core.payment.captured` could move the system's belief about money without
  any money moving.
- An envelope whose `producer` contradicts the credential is refused as
  spoofing, not corrected.
- A human principal is refused even holding `events.submit` and
  `platform_admin`. Authorisation answers "may you submit"; this edge also has
  to answer "whose events are you", and a person has no answer.
- An event type CORE has no consumer for is refused, not parked. Accepting it
  would leave a row pending forever while the producer believed something would
  eventually happen.

**Exactly-once effects are not claimed by the dispatcher.** It is
at-least-once by construction: a crash after a handler succeeds but before
`markProcessed` dispatches again. What makes that safe is the consumer inbox,
which claims `(consumer, event_id)` before the handler runs. Retrying is cheap
precisely because the layer below refuses to do the work twice.

`accept` returns whether this was the first delivery, and that answer is
atomic: `on conflict do nothing` plus `rowCount` on Postgres, a synchronous
check-then-set in memory. Deliberately not a read followed by a write — that is
the exact shape of the bug B-12 was.

### B-13, found while testing the above

The first ingress test asserted that a dispatched order produced a fulfillment.
It failed, and the reason was not in the new code.

`LocalEventBus.publish` resolved **successfully** when a subscriber had
exhausted its attempts, recording the failure only in an in-process
`deadLetters` array. `OutboxPublisher` and `InboundDispatcher` both decide
whether to retry from exactly that answer. So an event could be marked
`published` or `processed` in the database while no consumer had done anything,
and the only trace of it died with the process. A relay that cannot be told
about failure cannot recover from it — the durable ingress built above would
have been decorative.

`publish` now attempts every subscriber, then throws if any of them
dead-lettered; one broken consumer still must not decide what the others see.
The unawaited `inbox.claim` in the retry path was awaited at the same time — an
unawaited claim can land after the next attempt has already read the inbox.

Worth noting how this was caught: the test was written to assert an *effect*
(a fulfillment row exists), not that the call returned. An assertion on the
return value would have passed while nothing happened at all.

### Also fixed: a new table escaped deny-by-default

Migration 0006 enables row-level security from a hardcoded list of table names,
so `inbound_event` was not covered by it. `tests/db-schema.test.ts` compares the
live catalogue instead of a count, which is the only reason this surfaced. RLS
is enabled in 0007; the structural weakness (a list that every future migration
must remember) is recorded under risks.

### External dependencies this creates — recorded, not implemented

- **MARKET and MOVE must submit events to `POST /v1/events`** with a service
  credential provisioned by CORE, and must set `producer` to their own service
  name. Their envelopes are otherwise unchanged.
- **Both must treat 202 as success and retry on anything else.** Redelivering
  the same `event_id` is free and answers `first_delivery: false`.
- **Outbound delivery is still local.** CORE's own events reach only in-process
  subscribers; MOVE and MARKET cannot yet receive `core.fulfillment.created`,
  `core.fulfillment.dispatched` or `core.fulfillment.cancelled` over the wire.
  The symmetric outbound edge needs their endpoints, which CORE does not own —
  this is the next piece of milestone 1 and the reason it is "substantially",
  not fully, complete.
- **An operator must provision the two service credentials.** Nothing creates
  them automatically, on purpose: a self-registering service credential would
  be a hole in the boundary described above.

### Tests

`tests/event-ingress.test.ts` — 11 tests on both backends: accepted before
processed, each of the five refusals, redelivery after a timeout, two
simultaneous redeliveries where exactly one is told it was first, consumer
failure retried under backoff and then succeeding, and a replayed dispatch
doing the work only once. Plus a new bus test that a failing consumer does not
stop the healthy ones.

212 tests pass with `DATABASE_URL`, 131 without.
