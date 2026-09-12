# WASLA CORE — Roadmap

**Last updated:** 2026-09-12
**Last milestone:** Claim fencing — a claim is now exclusive for as long as it is held, not only at the instant it is taken. B-22 made claiming a write, B-24 made an abandoned claim visible, B-25 bounded how often it may be recovered; all three are about the moment of claiming, and none of them stopped a worker that stalled past its lease from waking up and acknowledging work that had already been reclaimed and finished by somebody else. Migration 0016 adds `claim_token text` to `outbox`, `inbound_event` and `event_delivery`; `claimDue` stamps it, recovery and every acknowledgement clear it, and the nine acknowledgements across six store implementations match on it and return `boolean`. The three workers report a `fenced` count, so `core_worker_outcomes_total{outcome="fenced"}` is finally reportable by all four workers rather than by `notification` alone. The relay's refusal throws `FencedError` so its fan-out rolls back and no attempt is charged. **B-26 resolved.** 608 tests pass with `DATABASE_URL` set.
**Verification at this working tree:** `tsc --noEmit` clean; `DATABASE_URL=… npm test` **608 passed / 36 files**; `npm test` without a database 342 passed / 47 skipped; governance, contract, migration and roadmap gates passing. Verified on **real PostgreSQL 18.4** (locally hosted), all **16** migrations applied, with 0016 executed against that database and its `.down.sql` executed and re-applied rather than merely written. Falsifiable and checked by mutation: making `isFenced` never fence fails 5 of the 14 new tests, dropping the `claim_token = $2` predicate from the Postgres `markPublished` fails 2, and letting the in-memory recovery keep the token fails 2 — each mutation restored and `tsc` re-run clean afterwards. The `claim_token` column, its nullability, its absent default and the `*_claim_token_check` constraint are asserted against the **live** schema in `tests/db-schema.test.ts`, including that the constraint actually rejects a token on an unclaimed row. One pre-existing flake persists: `tests/migration-0011-lifecycle.test.ts` can time out in its teardown hook under full-suite contention and passes in isolation; its assertions pass in both cases.
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
- [x] Notifications to people: recipient registry bound to verified identity
      links, five event templates rendered against a published payload
      contract, a four-outcome channel port, a leased and fenced dispatcher,
      and an operator read surface. Fake adapters only, by choice.
- [x] Every background worker claims work by writing a lease (B-22), so two
      workers polling together cannot receive the same row.
- [x] One canonical normalisation layer owns event-version knowledge, so no
      consumer interprets a version itself; an event that cannot be normalised
      safely is refused by name rather than guessed at.
- [x] Historical replay of stored inbound events: narrow reviewable scopes, a
      dry-run that a read-only connection proves cannot write, no double
      financial effect, no tenant inference, and a resumable failure report.

## In progress

Nothing is mid-change in the working tree. `uxxxug/wasla-core` is the working
remote, pushes are fast-forward, and CI runs and passes there.

Persistence is no longer the open question: every port has a Postgres adapter,
the composition root can be wired to either backend, and the whole suite runs
against both. Migrations 0001–0011 are applied and verified on real engines
(PostgreSQL 18.6 locally in the latest cycle, 18.4 and 17.6 managed earlier),
rollbacks included — 0009 and 0011 verified as *refusing* to roll back while
money history would be falsified by doing so.

## Remaining, in dependency order

Every line below was checked against the code, the tests and the commits in
this cycle rather than carried over from the previous text. Postgres adapters
and B-1 were never the goal; they are the floor CORE's actual work stands on.

| # | Milestone | Verified status | Evidence / what is missing |
|---|---|---|---|
| 1 | External event ingress and egress: MARKET and MOVE can reach CORE, and CORE can reach them | **CORE side complete** | Inbound: `POST /v1/events`, `inbound_event` (migration 0007), `InboundDispatcher`, trust boundary tied to the credential. Outbound: `event_subscription` + `event_delivery` (migration 0008), `DeliveryFanOut` committing with the outbox row, `DeliveryWorker` with failure classification, HMAC-signed bodies, operator-only subscription routes. 11 + 13 tests × 2 backends. What remains is not CORE's: MOVE and MARKET must stand up endpoints and deduplicate on `event_id` |
| 2 | Settlement beyond one hold per fulfillment: partial capture, refunds, multi-hold | **Partial capture and refunds complete on both the money and the fulfillment side; multi-hold blocked — external dependency** | Migration 0011 finishes what 0009 started: `fulfillment.settlement_state` gained `partially_captured`, so a hold that moved part of the payer's money is no longer recorded as `released` — a value documented to mean no money moved. `FulfillmentPaymentPort.voidWithin` publishes `{ status, captured_minor }` instead of `unknown`, `release()` derives the state from it, `inspectHold()` has a `partially_captured` case, and the reconciliation read now surfaces money moved against work that did not complete (B-20). 18 tests × 2 backends. Earlier: migration 0009 splits the consent ceiling from the amounts that moved (`captured_minor`, `refunded_minor`), adds `partially_captured`, makes `ledger_transaction.authorization_id` a foreign key and enforces aggregate-vs-ledger agreement with two deferred constraint triggers. Service has `capture(amount?, capture_reference?)` and `refund`, both exactly-once on the ledger reference; `balance()` holds only the uncaptured remainder. `core.payment.refunded` contract published, `captured`/`voided` payloads extended. Routes: `POST .../capture` (optional body), `POST .../refund`. 15 tests × 2 backends. The 2026-09-12 (second) cycle then made the consequence explicit rather than implicit: a derived `financial_disposition`, `financial_decision_required` + `captured_minor` on both closure events, a separate pending-decision reconciliation read, the full terminal-path table in `docs/settlement.md`, and 14 + 1 tests. Multi-hold needs a MARKET contract decision — see "External dependencies" |
| 3 | Subscriptions, plans, periods, entitlements (ADR 0013) | **Complete, except policy decisions that are not CORE's to make** | Migration 0010 adds `plan`, `plan_grant`, `subscription`, `subscription_period`, `usage_record` with RLS, an `EXCLUDE USING gist` constraint against overlapping periods, immutability triggers on an active plan's terms and grants, append-only triggers on usage, and a deferred constraint trigger reconciling a settled period against the hold that settled it. Module: `domain.ts` (entitlement derived, never stored), `repository.ts` + `pg-repository.ts`, `service.ts`, `http.ts`. Ten routes, `subscription.read` / `subscription.write` permissions, six event contracts. 23 tests × 2 backends. **No entitlement-check endpoint** — ADR 0008 requires a new ADR first (B-14). Proration, grace, trials, rollover and comped access are recorded as B-15…B-19 |
| 4 | Channels and notifications; Telegram adapter | **Complete inside CORE, with a fake adapter rather than a live provider** | Migration 0012 adds `notification_recipient` and `notification` with RLS. Module: `domain.ts` (five templates, money wording derived from `settlement_state`), `ports.ts` (a four-outcome `ChannelResult`, never `void` or a boolean), `repository.ts` + `pg-repository.ts` (lease claim + `claim_token` fencing), `service.ts` (`NotificationFanOut` inside the relay transaction, `NotificationDispatcher` with backoff and fencing), `identity-directory.ts` (verified links only), `http.ts` (four routes). Published payload contract `contracts/notifications/notification-message.v1.schema.json`. 23 tests × 2 backends plus 5 claim-atomicity tests × 2 backends; `docs/notifications.md` states the guarantee. **No live provider is wired** — deliberately: the contract is adapter-shaped so a real Telegram/SMTP/SMS client is a new file and no domain change. `delivered` is unreachable until a provider confirmation callback exists (D-8) |
| 5 | Publish and adopt the versioned contracts in MOVE and MARKET | **Blocked — external dependency** | 14 event schemas and the OpenAPI contract are published in-repo. Adoption is not CORE's to do |
| 6 | Event normalisation and historical replay tooling | **Complete inside CORE** | Two layers, deliberately separate. `src/platform/eventing/normalize.ts`: one registry that owns version knowledge, so a consumer receives a `CanonicalEvent` and never branches on `version` — required fields, `additionalProperties: false` enforced in code and not only in the schema, timestamps normalised to ISO UTC, absent-optional ≡ null, and four reported rejections (`envelope_malformed`, `unknown_event_type`, `unsupported_version`, `payload_malformed`) that name offending keys and never values. It is now called at the ingress edge too, so a malformed payload is a 400 to the producer instead of a consumer's problem later. `src/platform/replay/`: a scope that **must** narrow (`limit` 1…1000, no "replay everything"), ordering on `(received_at, event_id)` rather than the producer's `occurred_at`, `plan()` proved non-writing by a `ReadOnlyQueryable` that refuses writes with SQLSTATE 25006, two named modes (`pending_only` letting the inbox decide, `reapply` explicit and documented), per-event publication with no wrapping transaction so a run is resumable, `resume_after` pointing *before* the failing event, a session-scoped `pg_try_advisory_lock` refusing a concurrent run between processes, tenant refusal rather than inference, two audit entries and no new table, and a CLI (`npm run replay`) gated on a new `events.replay` permission held by `platform_admin` only. 17 + 46 tests. `docs/replay.md` states the guarantees and the trades. **No migration, no new index, no `claimed_at`** |
| 7 | Migration and reconciliation tooling; dry runs | **Blocked — B-2, B-3** | Financial reconciliation exists in two reads that answer different questions: `/v1/fulfillments/reconciliation/inconsistent` (needs an engineer) and `/v1/fulfillments/reconciliation/pending-financial-decision` (needs a business decision). Migration 0011's whole lifecycle — clean apply, apply over existing rows, refused rollback, permitted rollback, re-apply — is now rehearsed by a test against a throwaway database. Data migration cannot be planned without a production inventory or a merge policy |
| 8 | Security hardening pass and observability export | **Observability export and ingress rate limiting complete; the hardening pass itself is bounded by B-5** | Deny-by-default RLS on every table (including the new `rate_limit_counter`), hardened `search_path`, token hashing, audit scrubbing, correlation ids — unchanged. Added in the 2026-09-12 (fifth) cycle: `src/platform/observability/` (a **declared** metric catalogue that refuses an undeclared name, a missing label, an extra label or an identifier-shaped label value; a deterministic Prometheus 0.0.4 renderer; per-worker counters and histograms; a `DepthSampler` on the operator's cadence, never on the scrape, with `core_sample_timestamp_seconds` and `core_sample_failures_total` so staleness is visible) and `src/platform/http/rate-limit.ts` + `pg-rate-limit.ts` + migration 0013 (fixed window, per hashed credential and route class, one atomic `insert … on conflict … do update … returning`, 429 with `retry-after`, workers unreachable from the limiter by construction). Scope decisions recorded in `docs/observability.md`: **system-level metrics only, never tenant-scoped**, and per-credential rather than per-organization keying because resolving a token to a tenant would put a database read in front of the limiter. 48 new tests × both backends where applicable, including a real-Postgres concurrency test falsified against a deliberately racy store. Still open: no tracing/span export (nothing consumes it; `correlation_id` already threads the audit trail), `/metrics` is unauthenticated and therefore depends on network placement (B-5), and lease expiry was not countable for three of the four workers (**B-24**, resolved in the 2026-09-12 worker-lease cycle by migration 0014) |
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
| B-14 | Entitlement-check endpoint needs a new ADR (ADR 0008) | `SubscriptionService.checkEntitlement` is implemented and tested, but reachable in-process only. MARKET and MOVE cannot ask CORE whether an owner is entitled | An owner ADR opening a new synchronous path, or a decision that entitlement is answered by consuming `core.subscription.*` instead |
| B-15 | Proration on mid-period cancellation or plan change undecided | CORE cancels without refunding and without prorating, and has no plan-change path at all. Nothing partial is charged or returned | An owner decision on what a partial period is worth |
| B-16 | Grace policy for `past_due` undecided | CORE's recorded default is that `past_due` entitles nothing. Chosen because it is the reversible direction: grace can be granted retroactively, service already given cannot be recalled | An owner decision on whether, and for how long, an uncollected period keeps entitling |
| B-17 | Trial periods undecided | No trial exists. A zero-amount plan is expressible and settles without an authorization, which is not the same thing as a trial that converts to a paid plan | An owner decision on trial length, conversion and what a lapsed trial entitles |
| B-18 | Quota rollover versus reset undecided | Quota resets each period, because usage is counted per period. Unused allowance does not carry forward | An owner decision on whether unused allowance accumulates |
| B-19 | Entitlement overrides (comped or granted access) undecided | There is no way to entitle an owner without a paid subscription. Adding one would introduce a second source of truth beside the subscription, which is exactly what the derived design avoids, so it needs a decision rather than an implementation | An owner decision on who may override and how it is audited |
| B-20 | What is owed when work fails after part of the hold was already captured | CORE records the truth and stops. A `failed`/`cancelled` fulfillment holding `settlement_state = 'partially_captured'` derives `financial_disposition = 'decision_required'`, both closure events carry `financial_decision_required: true` with the observed `captured_minor`, and `GET /v1/fulfillments/reconciliation/pending-financial-decision` lists exactly these cases apart from CORE defects. CORE does **not** refund, retain, split, or mark the operation settled. `MoneyService.refund` is exactly-once, so whichever answer is chosen is executable the day it exists | Five separate owner decisions, listed under "B-20 as a contract gap" in the 2026-09-12 (second) cycle: who states the executed amount, who decides whether partial work earns partial settlement, who authorises a refund, whether a cancellation fee exists, and which system sends the final disposition |
| B-21 | **Resolved.** Two overlapping closures both committed, because the closing `update` named the row and not its version, so the loser overwrote the winner's terminal row and published a second closure event. `updateIfStatusIn` / `insertIfAbsent` return `applied` \| `stale` and the service treats `stale` as "somebody else closed it", so one closure produces one closure event. Money was never wrong; only the events were multi-valued | resolved | — |
| B-22 | **Found and resolved in the Milestone 4 cycle.** A claim was a read, not a write. `PgOutbox.claimDue`, `PgInboundEventStore.claimDue` and `PgDeliveryStore.claimDue` each ran one `select … order by … limit … for update skip locked` statement, which in its own implicit transaction releases the row locks the moment it returns. Measured before the fix: two pools claiming five due outbox rows received **five rows each, all five shared**. In production that is two signed POSTs to a partner's webhook and two runs of the same inbound event. The in-memory doubles marked nothing at all, so they could not fail a test either (B-12 again, in a different module). All six implementations now claim by writing the lease in the same statement — `update … set next_attempt_at = now + lease where id in (select … for update skip locked) returning …` — with `claimDue(now, limit, leaseMs = 30_000)`. No schema change: the lease rides on `next_attempt_at`, so an abandoned claim returns on the same clock that schedules retries. `attempts` is deliberately not incremented for the three pre-existing workers, which would have changed their backoff under cover of a concurrency fix. Proven by `tests/worker-claim-atomicity.test.ts`, which fails when the claiming write is removed | resolved | — |
| B-23 | **Resolved.** The three closure/dispatch payloads carried no `organization_id`, so a tenant-scoped notification recipient for them could never match and had to be refused outright (HTTP 400), and MARKET/MOVE could not route a closure without calling CORE back. CORE owns tenancy and is the only system that can state it, so the omission was CORE's to fix. `core.fulfillment.dispatched`, `.completed` and `.cancelled` now carry a **required** `organization_id`, read from the fulfillment row rather than from any prior event — which is what makes it correct on the intake-refusal path, where the row is created and closed in one transaction and no `created` event is ever published. `TENANT_SCOPED_EVENT_TYPES` widened accordingly; the registry's refusal is unchanged and still guards `core.*` events that genuinely name no organization (`core.payment.captured`). Proven by `tests/fulfillment-lifecycle-contract.test.ts`, which also validates emitted payloads against the published schemas, and by an end-to-end fan-out test in `tests/notifications.test.ts` showing two tenants watching one event type and only the right one being messaged | resolved | — |
| B-24 | **Resolved.** Lease expiry was indistinguishable from a scheduled retry for three of the four workers, so `core_worker_outcomes_total{outcome="reclaimed"}` could only be reported for notifications. The B-22 fix made every claim write a lease, but for the outbox relay, the inbound dispatcher and the delivery worker that lease rode on `next_attempt_at`, which is also the retry-schedule field — one column, two meanings, nothing on the row saying which. Migration 0014 adds a nullable `claimed_at timestamptz` to `outbox`, `inbound_event` and `event_delivery`, which makes the overloaded column readable: `claimed_at is null` means `next_attempt_at` is a retry schedule, `claimed_at is not null` means it is a lease expiry. `claimDue` sets it and takes only rows where it is null, so an expired lease is no longer silently re-served; `reclaimExpired(now, limit)` on all three ports (mirroring the one `PgNotificationStore` already had) clears it, makes the row due immediately and records `last_error = 'abandoned claim reclaimed after attempt N'`; every worker recovers **before** claiming, so a recovered row is worked in the same tick; every acknowledgement clears it, enforced by a per-table check constraint (`claimed_at IS NULL OR status = 'pending'`) so a finished row cannot be counted in flight for ever. `counts()` gains `in_flight` and `abandoned`, both subsets of `pending` and both cut at the injected clock so the two backends agree. Rejected: a `processing` status, which would change what every existing reader means by `pending` — a contract change to fix a metric; and a `claim_token`, which is real fencing and is recorded separately as B-26. **Decision about existing rows** (the roadmap required this be stated): they get `NULL` = "not held", which is safe for rows genuinely in flight during the migration — they keep their future `next_attempt_at`, stay invisible until the lease would have expired anyway, then are claimed as today. No downtime and no worker stop; the one cost is that claims held across the migration are not counted when taken over. Rollback is the reverse order — code first, then `0014_worker_claim_visibility.down.sql` — because code that writes `claimed_at` against a schema without it fails every claim and stops all three queues | resolved | — |
| B-25 | **Resolved.** An abandoned claim did not spend an attempt, so a row whose worker died on it every time was recovered for ever and never dead-lettered: the one queue state that requires a human was the one state it could not reach. Fixed with a **second budget** rather than by reusing the first — `reclaims integer not null default 0` on `outbox`, `inbound_event` and `event_delivery` (migration 0015), incremented by `reclaimExpired(now, maxReclaims, limit)`, which dead-letters the row on the increment that passes the limit (default 3, `DEFAULT_MAX_RECLAIMS`) instead of freeing it. The three workers report the two counts as `reclaimed` and `failed_permanent`, plus a `reclaim_exhausted` field on their result. Charging `attempts` was rejected on evidence, not taste: the backoff is `baseBackoffMs * 2 ** attempts`, so a crash loop would impose exponential delays a healthy row never earned, and `retrying` is derived as `pending and attempts > 0`, so a row nobody had tried would report as retrying. Charging the attempt at claim time — the notification store's single-counter approach — was rejected because B-22 declined to change `attempts` semantics for these three workers and it would silently halve every retry limit. `tests/reclaim-budget.test.ts` covers all three queues plus the worker-level result and metrics on both backends; the column, its default and its check constraint are asserted against the live schema | — |
| B-26 | **Resolved.** A claim was exclusive at the instant it was taken (B-22), visible while held (B-24) and bounded in how often it could be taken back (B-25) — and none of that made it exclusive *over time*. A worker that stalled past its lease, was reclaimed, and then called `markPublished`/`markProcessed`/`markDelivered` succeeded, because the acknowledgement named the row and not the claim; the row then recorded the abandoned attempt instead of the one that happened. The worst case is a stale success on `inbound_event`: an event marked `processed` whose live attempt actually failed is never dispatched again and the failure is invisible. Migration 0016 adds `claim_token text` to `outbox`, `inbound_event` and `event_delivery` — the shape `notification` has had since 0012 — stamped by `claimDue`, cleared by recovery and by every acknowledgement, and matched by all nine acknowledgements across the six store implementations, which now return `boolean`. `src/platform/eventing/fencing.ts` holds `newClaimToken()`, `isFenced()`, `UNFENCED` and `FencedError`. The three workers report a `fenced` count and emit `core_worker_outcomes_total{outcome="fenced"}`, an outcome that has been in the catalogue since Milestone 8 and that only `notification` could produce until now. The relay is the one transactional case: `markPublished` runs inside the transaction that queues the fan-out, so a refusal throws `FencedError` to roll those delivery rows back, and the catch block checks for it **before** the attempts arithmetic — a fence is not a failed publish and must not charge an attempt or impose a backoff. Replay passes `UNFENCED` and is the only caller in CORE entitled to: an operator advancing a `dead` row holds no claim, and a fence that applied to every caller would have broken the only recovery path this queue has. Rejected: `uuid` (to match `notification.claim_token text`), `gen_random_uuid()` in the database (unavailable to the in-memory backend — B-12), a token per row rather than per batch claim (one statement per row, refusing nothing extra), and the strong constraint "every claimed row carries a token" (false for rows already claimed when the migration runs, and a backfilled token would fence out a worker still doing real work). What it does **not** fix: the duplicate side effect. A POST or a bus publish that already happened is not undone — delivery stays at-least-once and subscribers still deduplicate on `event_id`. The fence protects what the row records | resolved | — |
| B-27 | A dead `outbox` or `event_delivery` row has no revival path in CORE at all | Replay (`src/platform/replay/service.ts`) reads `inbound_event` only; its `DEFAULT_STATUSES = ["pending", "dead"]` is what makes a dead inbound event operator-recoverable. There is no `requeue`, no `revive` and no equivalent for the other two queues anywhere in the repository, so a dead `outbox` row — an event MOVE and MARKET will now **never** receive — and a dead `event_delivery` row are durable and unreachable at the same time, which is precisely the defect Milestone 6 was created to remove for inbound events. B-25 makes this matter more, not less: it adds a second, entirely new way for rows in exactly those two tables to reach `dead`. Recovering one today means a manual `update` against the database, unreviewed and unaudited | A revival command per queue that resets `status` to `pending`, clears `claimed_at`, zeroes `reclaims` and leaves `attempts` alone, under the same compulsory-narrowing and audit rules replay already enforces; or extend the replay service to cover all three queues rather than adding a third mechanism. Needs an owner decision on whether reviving a dead outbox row should re-publish the original envelope unchanged or emit a fresh one with a new `event_id` |
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

**488 of 488 across 31 files** with `DATABASE_URL` set (both backends), 273
passed / 41 skipped without. Counted by running the suite at this commit, twice.

The per-area list below was written when the suite stood at 71 tests across 11
files and describes those cases only; it was never extended as later cycles
added files. Each cycle section further down carries the tests it added, and
those sections are the current record. The list is kept because the cases in it
still exist and still pass, not because it is complete.

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
- **Outbound delivery exists as of migration 0008** (see the section below).
  What CORE cannot supply is the other end of the wire.
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

## Outbound delivery — CORE can now reach MOVE and MARKET

Migration 0007 gave the external systems a way in. Nothing gave CORE a way out:
`LocalEventBus` reached in-process subscribers only, so a fulfillment could be
created, dispatched and settled and no system outside CORE's process would ever
learn of it. The coordination loop had an entrance and no exit, which made the
loop MARKET → CORE → MOVE → CORE → MARKET unbuildable no matter how correct
each half was.

Migration 0008 adds `event_subscription` (who wants which event type, and
where) and `event_delivery` (one row per `(event_id, subscription_id)`).
`docs/outbound-delivery.md` holds the full reasoning; the decisions that
constrain future work:

**Queueing the deliveries and marking the outbox row published are one
transaction.** As two, a crash between them leaves an event marked `published`
that no subscriber will ever be sent — the dual-write problem the outbox exists
to prevent, moved one step downstream. The test for this was verified to fail
when the transaction is removed, rather than assumed to work.

**Fan-out happens at relay time, not emit time**, so an endpoint registered
today is used by the next event relayed. The consequence is accepted and
written down: a subscription created after an event was relayed does not
receive that event. Back-filling is replay, and replay is a decision, not a
side effect of editing configuration.

**A failed attempt is either worth repeating or it is not.** 5xx, a timeout, a
refused connection, 408 and 429 are retried with exponential backoff. Every
other 4xx kills the delivery on the first attempt, because identical bytes get
the identical refusal and repeating them only delays someone noticing. Dead
rows stay visible at `GET /v1/event-deliveries/undelivered`.

**Delivery is at-least-once; deduplication is the receiver's job.** CORE can
only promise it keeps trying and never silently stops. `event_id` travels in
the `x-wasla-event-id` header as well as the envelope so a receiver can discard
a repeat before parsing.

**Bodies are HMAC-SHA256 signed over the exact bytes transmitted**, not over
selected fields — a receiver verifying a reconstruction is verifying its own
serialiser. `verifyBody` is exported as a reference implementation. The
plaintext secret therefore lives in the database, and the constraints that
follow (never returned on any read path, never rotated implicitly,
`https`-only endpoints, `core.*` types only) are in the doc.

### A difference between the backends, documented rather than hidden

Postgres `claimDue` orders by `(next_attempt_at, created_at)` and leaves ties
to the planner; the in-memory store drains in insertion order. Under a
`FixedClock` every timestamp ties, so the two backends attempt deliveries in
different orders. There is nothing to unify here: CORE makes no cross-subscriber
ordering promise, and inventing a tie-breaker would imply one. A test written
during this milestone depended on which subscriber was attempted first, passed
in memory and failed on Postgres — that is how the difference was found, and the
test was rewritten to assert the invariant that actually holds (one
subscriber's outage does not affect another).

### A latent bug found on the way

`InMemoryOutbox.markPublished` mutated the stored record in place. That was
harmless while it ran outside any transaction, but it now commits together with
the delivery rows, and `MemoryJournal` records a pre-image by reference — so a
rollback would have restored the mutated object to itself and undone nothing.
All three mark methods now replace the record. Same shape as the `revokeSession`
bug from B-10.

### External dependencies this creates — recorded, not implemented

- **MOVE must expose an HTTPS endpoint** for `core.fulfillment.created` and
  `core.fulfillment.cancelled`; **MARKET** for `core.fulfillment.dispatched`.
  CORE will not invent these; an operator registers them.
- **Both must verify `x-wasla-signature`** as `sha256=HMAC-SHA256(secret, raw
  body)` over the bytes received, before parsing.
- **Both must deduplicate on `event_id`.** Delivery is at-least-once; a repeat
  is normal, not an error.
- **Both must answer 2xx only once the event is durably recorded**, and a 4xx
  only when the payload is genuinely unacceptable — a 4xx stops CORE retrying
  permanently.
- **An operator must register the subscriptions and hold the secrets.** There
  is no self-registration, for the same reason there is none for service
  credentials.

### Tests

`tests/outbound-delivery.test.ts` — 13 tests on both backends plus 3 backend-
independent: no read path leaks a secret, refused subscriptions (`market.*`,
plain HTTP, short secret), fan-out to every interested subscriber, a verifiable
signature over the transmitted body, a second fan-out queueing nothing, retry
with backoff that does not fire early, a 422 dying on the first attempt and
never being retried, a timeout recorded as a failure with no status, the
attempt budget running out with the row left visible, a deactivated subscriber
queueing nothing, one subscriber's outage not blocking another, the outbox row
not marked published when queueing fails, and a delivery whose subscription
vanished dying unsent rather than being sent unsigned.

242 tests pass with `DATABASE_URL`, 147 without.

---

## Settlement beyond a single all-or-nothing hold

Milestone 2. Reasoning and the full invariant list are in `docs/settlement.md`;
this is what changed and why it was judged correct.

### The defect this closes

`payment_authorization.amount_minor` meant two things at once — what the payer
consented to, and what would move. Capture was therefore all-or-nothing. A job
quoted at 6 000 that costs 4 000 could only capture 6 000 or nothing, and a
completed job that was later disputed had no way to give money back. The only
workaround was to void and re-authorize, which discards the payer's consent and
can then fail for want of funds that were held a moment earlier.

Migration 0009 separates the meanings: `amount_minor` is an immutable ceiling,
`captured_minor` and `refunded_minor` grow and never shrink, and the remaining
hold is **derived** rather than stored so it cannot disagree with itself.

### Decisions, and why the easy alternative was rejected

- **A refund is not a void.** A void releases money that never moved and posts
  nothing; a refund posts a balanced reversal of money that did move. Their
  limits differ — a void is bounded by what is still held, a refund by what was
  captured. Reusing the void path would have been less code and would have let
  a caller pay out money the payer never spent.
- **A refund does not un-capture.** `captured_minor` is never reduced and the
  status does not change, so the history shows money going out and coming back
  rather than never having left. It does not restore the hold either.
- **`partially_captured` is necessary, not convenient.** When a hold moved some
  money and released the rest, `captured` overstates what moved and `voided`
  claims nothing moved when some did — and the status is what a reconciliation
  trusts. While `captured_minor < amount_minor` the row stays `authorized`, so
  split captures remain possible.
- **A partial capture must carry its own idempotency key, and CORE refuses
  without one.** It is by definition one of several, so a key derived from the
  authorization cannot tell a retry from an additional capture; guessing means
  charging twice or dropping a legitimate capture. A *full* capture keeps
  `capture:<authorization_id>` unchanged, so an in-flight retry from before the
  migration still resolves to the same transaction.
- **The aggregates are enforced against the ledger by the database.**
  `ledger_transaction.authorization_id` is now a foreign key rather than a
  parsed reference string, and two deferred constraint triggers check agreement
  from both sides, summing per kind so two equal errors cannot cancel out. Same
  argument as `ledger_transaction_is_balanced`. Deferred because the
  authorization row and its ledger rows are written in one transaction in
  either order.
- **The rollback refuses rather than rounding money.** There is no value of the
  old single-meaning `amount_minor` that tells the truth about a hold where
  2 500 of 6 000 moved, so `0009...down.sql` refuses while any authorization is
  partially captured or refunded. Verified by reproducing that state on a real
  database and running the down migration against it.

### The in-memory store was made to enforce the same rules

`InMemoryMoneyRepository` now restates 0009's CHECK constraints and runs the
same ledger-agreement check. A memory backend more permissive than Postgres
certifies bugs — that was B-12.

Expressing a *deferred* constraint in memory needed a new facility:
`MemoryJournal.defer(key, check)`, run by `InMemoryTransactionBoundary` just
before the scope completes, which is the moment Postgres fires a
`DEFERRABLE INITIALLY DEFERRED` trigger. Without it the memory store would have
to judge the world half way through a transaction and would either accept what
production refuses or refuse what production accepts. Outside a transaction the
check runs immediately, matching autocommit.

### A backend difference, documented rather than hidden

`transactions()` orders by `(occurred_at, transaction_id)` on Postgres and by
insertion on the memory store, so under a fixed clock two captures at the same
instant come back in different orders. CORE promises no ordering between two
transactions at the same instant, so there is nothing to unify; the tests key
on the ledger reference instead of position. An ordered assertion would pass on
one backend, fail on the other, and test nothing CORE guarantees.

### Proven, not assumed

The three fixes were each reverted in turn — `balance()` counting the whole
hold, a partial closure recorded as `voided`, and the capture ceiling removed.
Twelve of thirty settlement tests failed, six per backend, symmetrically. With
the service's ceiling check removed **both** databases still refused the
over-capture by constraint name, so the storage layer is a real backstop rather
than a restatement.

### Tests

`tests/settlement.test.ts` — 15 tests on both backends: a partial capture not
counted twice in `held_minor` and the freed remainder actually authorizable; a
hold staying open and capturable across two captures with both movements
attributed by foreign key; capture refused past the consented ceiling even when
the wallet could fund it; a partial capture refused for want of a retry-safe
key; a retried partial capture charging once; a whole hold still captured under
the reference it always used; a part-captured hold closing as
`partially_captured` and releasing only the remainder; the void event reporting
the released remainder rather than the whole hold; a refund as a balanced
reversal that does not un-capture and does not restore the hold; refunds
refused past what was captured and on a hold that never moved money; a retried
refund paying out once; a part-captured hold refundable up to what moved; the
aggregates refused when written out of step with the ledger; and a part-captured
hold expiring with only its remainder released.

272 tests pass with `DATABASE_URL`, 162 without.

### External dependency this records — not implemented

- **Multiple holds against one fulfillment needs a MARKET contract decision.**
  `fulfillment.payment_authorization_id` is a single column and MARKET only
  ever sends one id. Whether several holds are alternatives or additive, which
  one a partial capture draws from, and what a total means across currencies
  are all MARKET's decisions, and a join table nobody feeds is worse than none.
  The sketch is in `docs/settlement.md`; nothing in this milestone blocks it,
  and the amounts split here are what make it expressible at all.

## Cycle 2026-09-12 — subscriptions, plans and entitlement (ADR 0013)

ADR 0013 has no body text in this repository: `docs/adr/README.md` carries only
its title and states that the ADR text is maintained as the project's decision
record and is not restated here. So the title was the whole brief. Everything
below was derived from the invariants CORE already enforces and from the
ownership boundary; every policy question the title does not answer is recorded
as a blocker above rather than guessed at, because guessing a billing policy
puts money on an undecided rule.

### The question the module exists to answer

`POST /v1/access/check` answers "may this principal do this?" from roles.
"Has this owner paid for this?" is a different question, and answering both from
one mechanism would make an unpaid subscription indistinguishable from a missing
role — a billing failure that reads as a permissions bug, and the reverse.
Entitlement is therefore a separate decision that never returns a bare boolean:
`EntitlementReason` has eight values, and `subscription_past_due`,
`period_unpaid`, `not_in_plan` and `limit_exhausted` lead to four different
answers for the customer.

### Entitlement is derived, never stored

There is no entitlement table. CORE owns entitlement by being the only place
that can answer the question, not by keeping a copy of the answer. A stored
verdict would be a second source of truth beside the subscription, the period
and the usage that produced it, and it would drift precisely when it mattered.

### Decisions recorded, with the reasoning

- **Feature keys are rows, not columns or an enum.** ADR 0018 keeps
  product-specific logic out of CORE; the moment CORE knows a feature's name it
  has an opinion about a product. `limit_value NULL` (unmetered) and `0` (none)
  are kept distinguishable, because collapsing them makes a revoked quota read
  as an unlimited one — and `POST /v1/plans` refuses an absent `limit_value`
  rather than defaulting it, since the two candidate defaults are opposites.
- **A plan's terms and grants freeze on activation**, by trigger. A price that
  could be edited after anyone subscribed would leave the period saying 5000 and
  the plan saying 9000, with nothing recording which the customer agreed to.
  Changing a price means publishing a new plan. Retiring closes a plan to new
  subscribers only, and is one-way.
- **`amount_minor` is operator data.** No rate is fixed anywhere in code, which
  is what B-4 requires while regulatory pricing policy is undecided.
- **The period is the invoice**, so it copies `currency` and `amount_minor` from
  the plan instead of reading through to it. Otherwise retiring a plan would
  take the price of settled history with it.
- **Overlapping periods are refused by an `EXCLUDE USING gist` constraint, not a
  deferred trigger.** A trigger sees only rows committed before it runs, so two
  concurrent inserts each see nothing and both succeed — the same hole as B-12.
  The constraint is what actually closes the race. Adjacent periods are accepted
  because half-open ranges that touch do not overlap.
- **Collection is an ordinary payment authorization** whose
  `business_reference` is derived as `subscription-period:<period_id>`. The
  UNIQUE constraint on that reference, not any check in the service, is what
  makes collection exactly-once.
- **Signup and first charge are separate units of work.** Sharing a transaction
  would let an empty wallet roll the subscription away, leaving nothing to retry
  and inviting a second signup. `POST /v1/subscriptions` therefore answers 201
  with `collected: false`.
- **A refusal is audited in its own transaction** (B-9), and returns
  `collected: false` rather than throwing, so one empty wallet cannot abort a
  renewal sweep for everyone behind it.
- **`cancelled` and `expired` stay separate facts** — the same argument as
  `partially_captured` in 0009. A cancelled subscription keeps entitling until
  the period it paid for ends; an unpaid period is voided instead.
- **Usage is append-only and recorded past the limit.** The port has no
  `updateUsage` and no `deleteUsage` at all, which is the strongest form of the
  rule, and 0010 refuses UPDATE and DELETE by trigger. Over-quota consumption is
  still recorded, because dropping it would leave the billing and dispute basis
  incomplete; refusing further work is the entitlement decision's job.
- **No usage event and no draft-plan event** (ADR 0009): high-volume
  bookkeeping with no external consumer, and terms nobody outside CORE can act
  on yet.

### Two real backend differences found and unified, not documented away

The standing rule is that no difference between the in-memory and Postgres
backends may hide behind the tests. Two were found while making the tests pass
on both:

1. **The memory money store could not express 0010's deferred agreement
   trigger**, because it has no view of the ledger. Rather than record the
   difference, `InMemoryMoneyRepository` gained a synchronous
   `authorizationSnapshot`, and the composition root hands it to the
   subscription store. Removing that wiring makes the agreement test fail on
   memory — verified.
2. **`audit_entry.actor_id` is a `uuid` column.** The new service was passing
   the producer name into it; the memory audit log accepted the string and
   Postgres refused it outright. Fixed to `null`, which is what "no principal"
   means, with `actor_type` already saying who acted. This one was only ever
   visible because every test runs against both backends.

A third, smaller one: the memory usage store compared an unparseable
`recorded_at` instead of refusing it, and `NaN` makes every window comparison
false — so it accepted a row Postgres refuses for being null.

### Proven, not assumed

Four fixes were reverted in turn:

- Overlap detection disabled in the memory store → the overlap test fails on
  memory.
- The money-reader wiring removed from the composition root → the
  period-versus-hold agreement test fails on memory.
- `actor_id` restored to the producer name → the first-collection test fails on
  **Postgres only** while memory still passes, which is the backend-difference
  class itself.
- The early return in `chargePeriod` removed → **nothing failed.** That is
  recorded rather than hidden: the exactly-once guarantee comes from the derived
  `business_reference` and the UNIQUE constraint beneath it, not from the
  service check. Removing the early return *and* randomising the reference fails
  the double-charge test on both backends, which locates the invariant where it
  actually lives. The test now asserts on the authorization's `captured_minor`
  as well as the balance, and says all of this in a comment.

### Migration 0010

Applied and rolled back on both real engines (PostgreSQL 18.4 locally,
PostgreSQL 17.6 managed). Needed `btree_gist`, which was not installed on
either. All five tables carry explicit `ENABLE ROW LEVEL SECURITY`, because
migration 0006's RLS list is hardcoded and does not cover tables added later.
The down migration refuses while any settled period or any usage record exists —
dropping billing history is not a rollback — and does not drop the extension it
found missing.

Twenty-one invariants were probed directly against the local database before the
adapters were written, of which one was wrong on the first attempt and corrected
in the migration: a free-tier plan priced at zero settles with no authorization,
so `subscription_period_settlement_fields` had to tie `amount_minor = 0` to
`authorization_id IS NULL` as an equivalence rather than requiring an
authorization outright.

### Tests

`tests/subscription.test.ts` — 23 tests on both backends: a first period
collected through the ledger with the balance to prove it; a subscription that
survives a wallet with no money, and refuses entitlement while it does; the same
period collected later returning the subscription to active; a period charged at
most once across repeated attempts; a second live subscription to one plan
refused; a plan in one currency refused against a wallet in another; draft and
retired plans refused; an active plan's price and grants both frozen;
overlapping periods refused and adjacent ones accepted; a settled period refused
when it disagrees with the hold that paid it, asserted through a real commit;
quota counted and exhausted while an unmetered grant on the same plan is
unaffected; an unmetered grant distinguished from a grant of nothing; a repeated
usage reference counted once; usage outside the period window and with an
unparseable instant both refused; the absence of any way to change or delete
usage; coverage kept to the end of a paid period after cancellation and then
expired; an unpaid period voided on cancellation; renewal opening and charging
the next period with no gap and a fresh quota; a sweep not aborted by one empty
wallet; the reason for a refusal when the owner has no subscription at all; a
feature the plan does not grant; one event per business fact with none for usage
or for a draft plan; and an audit entry for a refused collection.

318 tests pass with `DATABASE_URL`, 185 without.

### A note on savepoints

A savepoint release does **not** check `DEFERRABLE INITIALLY DEFERRED`
constraints; only COMMIT does. Any test of 0010's agreement trigger has to use a
real transaction rather than `ROLLBACK TO SAVEPOINT`, and 0009's own deferred
trigger refuses a fabricated authorization whose `captured_minor` has no ledger
entries behind it — so the fixture goes through the real `MoneyService`.

### External dependencies this records — not implemented

- **MARKET and MOVE reporting usage** belongs on the inbound event path
  (`POST /v1/events`), which needs an event contract from the producing system.
  `POST /v1/subscriptions/{id}/usage` is an operator route, not a product
  integration path, and no MARKET or MOVE code was touched.
- **Answering entitlement across systems** is B-14 and needs an ADR before any
  endpoint exists.

## Cycle 2026-09-12 — the fulfillment side of partial settlement (CORE-only agent)

A CORE-only audit cycle. No MOVE or MARKET code was read or touched; the two
external dependencies it surfaces are recorded below for their owning agents.

### The audit came first, and the roadmap held up

The instruction was not to trust this document. So the starting point was the
code, the commits and the suite, on a real engine: PostgreSQL 18.6 provisioned
locally, migrations 0001–0010 applied, **318 of 318 tests passing** at
`f2c13a9` with `DATABASE_URL` set, `tsc --noEmit` clean, all four gates green.
Every claim spot-checked in the "Remaining" table and the cycle sections matched
the code. One stale claim was found — the "Tests that pass at this commit"
header still said 71 of 71 across 11 files, four cycles out of date — and is
corrected above rather than quietly deleted.

### The defect: a settlement state that lied about money

Migration 0009 made a hold capturable in legs and gave it a fourth status,
`partially_captured`. The fulfillment row that binds money to execution was
never widened to match. Its vocabulary stayed
`none | held | captured | released | unsettled`, where `released` is documented
in the domain as **"the hold was voided; no money moved"**.

`FulfillmentPaymentPort.voidWithin` returned `Promise<unknown>`, so fulfillment
could not ask how much had moved and assumed nothing had. Three reachable paths
therefore recorded `released` over money that was gone. Reproduced on a real
database before anything was changed, with 2 500 of a 6 000 hold captured:

| # | Path | Recorded | Actual | Reconciliation saw |
|---|---|---|---|---|
| G-9 | `move.job.rejected` (or `cancel`) after a partial capture | `released` | `partially_captured`, `captured_minor = 2500`, wallet down 2 500 | nothing — `isFinanciallyConsistent` returned `true` |
| G-10 | intake of an order whose hold had already closed part-captured | `released`, reason `payment_hold_not_authorized` | hold `partially_captured` | nothing |
| G-11 | `move.job.completed` on a hold already closed | `released`, reason `payment_settlement_failed` | hold `partially_captured` | nothing |

G-10's reason was also wrong on its own terms: the hold was not
"not authorized", it was spent. The refusal was right; the explanation MARKET
receives was not.

The severity is in the last column. `listFinanciallyInconsistent()` returned
zero rows in all three cases, and the closure event told MARKET the money had
been returned. This is worse than an unsettled hold, which at least announces
itself: CORE was asserting a false fact about money and the one mechanism built
to catch that was structurally unable to see it.

### The fix, and the seam it closes

- `SettlementState` gains `partially_captured`, documented as the hold having
  closed with part of the consented amount moved and the remainder released.
- `voidWithin` now publishes `{ status, captured_minor }`. `MoneyService`
  already returned `PaymentAuthorization`, so no money code changed — the port
  was hiding information the implementation had all along. `release()` derives
  `partially_captured` when `captured_minor > 0` and `released` otherwise, so
  the state comes from what money reports rather than from what the call site
  assumed.
- `getAuthorization?` gains `captured_minor`; `inspectHold()` gains a
  `partially_captured` case returning reason `payment_hold_partially_captured`.
- `isFinanciallyConsistent`: `completed` accepts `partially_captured` (a job
  that cost less than the ceiling); `failed`/`cancelled` does **not**, so those
  cases surface in the reconciliation read.

No contract was redesigned and no existing value changed meaning. The change is
additive in both the schema and the published schemas, and the ordinary
`released` path is asserted unchanged.

### Why a truthful state is still reported as inconsistent

`fulfillment_settlement_alignment_check` stores `partially_captured` against
`failed` and `cancelled`, while `isFinanciallyConsistent` calls it inconsistent.
That is deliberate and not a contradiction: one governs what is recordable, the
other what needs a human. The payer has paid for work that did not complete, and
whether that is refunded, retained as a cancellation fee or split is a policy
decision CORE has not been given — recorded as **B-20**, not invented.

Refusing to store the state would only push the service back to writing
`released`, which is the falsehood being removed. Reporting it is the reversible
direction: an operator can act on a case CORE surfaced and cannot act on one it
hid.

### Migration 0011

Additive. Extends `fulfillment_settlement_state_check` and
`fulfillment_settlement_alignment_check`, and widens the partial index behind
the reconciliation read to `('unsettled', 'partially_captured')` — a partial
index that excluded the row the read exists to find would have left it scanning.
No column added, no data rewritten.

The rollback **refuses** while any row is `partially_captured`, for the same
reason 0009's does: there is no earlier value that states the fact truthfully.
`released` claims nothing moved, `captured` claims all of it did. Verified by
inserting such a row on the real database and watching the rollback abort by
name, then verified again that it completes on a clean table.

### Proven, not assumed

The fix was reverted with the tests and the migration left in place: **12 of the
18 new tests fail on both backends**, each on the specific state or event field
it pins. The 6 that still pass are the regression guards — the plain `released`
path, the remainder-capture path, and the two that check the TypeScript union,
the CHECK constraint and both published schemas still declare one vocabulary.

An existing schema test used `partially_captured` as its example of an *unknown*
settlement state. It now asserts a genuinely unfamiliar value instead, and the
accepted/refused pair lists were extended in both directions, including
`coordinating`/`dispatched` against `partially_captured` being refused: open
work may not claim a terminal money state.

### Tests

`tests/fulfillment-partial-settlement.test.ts` — 9 cases × 2 backends: a
rejection after a partial capture recorded as `partially_captured` with the
wallet balance proving 2 500 moved; the same case surfacing in the
organization-scoped reconciliation read; `partially_captured` published on the
closure contract MARKET consumes; a cancellation that moved nothing still
recorded as `released` and still consistent; intake refusing an order whose hold
had already closed part-captured, with the honest reason and no
`core.fulfillment.created`; a success claim against a closed hold still failing
but no longer claiming the money never left; a partial capture that leaves the
hold open still capturing the remainder on success and settling as `captured`;
and a completed fulfillment that cost less than the ceiling accepted as
consistent — asserted through a real commit, so Postgres' alignment constraint
judges it too.

`tests/db-schema.test.ts` extended as described. **341 tests pass with
`DATABASE_URL`, 185 without.**

### External dependencies this records — not implemented

- **MARKET** consumes `settlement_state` on `core.fulfillment.completed` and
  `core.fulfillment.cancelled`. Both enums now include `partially_captured`.
  A consumer that maps this field to customer-facing wording must not treat an
  unrecognised value as `released`; the schema descriptions say so explicitly.
  No MARKET code was touched.
- **A completed fulfillment settling for less than the consented ceiling** is
  storable and consistent, but CORE has no path that produces it: capturing part
  of a hold and completing needs the actual amount, which only MARKET or MOVE
  knows. Recorded here rather than guessing an amount inside CORE.

### An environment observation, not a finding

On the first `npm run verify` of this cycle three tests failed on the sandbox —
two timeouts in `concurrency-and-restart.test.ts` and one `deadlock detected` in
`settlement-atomicity.test.ts`. Both files deliberately create contention, and
they pass on repeated runs of the same commit. The machine has 2 vCPUs and runs
the database beside the suite, so the likeliest explanation is scheduling
pressure rather than a defect. It is recorded because a flake that is only
mentioned when it fails is indistinguishable from one nobody noticed: if these
two files fail intermittently in CI, this is the note that says it was already
happening on 2026-09-12 and was not introduced by this change.

## Cycle 2026-09-12 (second) — making the pending financial decision explicit (CORE-only agent)

The previous cycle made `partially_captured` storable, so CORE stopped claiming
that 2 500 had come back when it had not. That fixed the record and left the
consequence implicit. This cycle closes the part of **B-20** that is CORE's, and
states the rest as decisions somebody else owns.

Scope discipline, unchanged: CORE only. No commercial or financial policy was
invented, and nothing outside `uxxxug/wasla-core` was touched.

### What was actually wrong, after the last fix

| # | Finding | Evidence |
|---|---|---|
| G-12 | The consequence of a partial capture was reachable but not sayable. `settlement_state = 'partially_captured'` on a `cancelled` fulfillment is a true record, but the only mechanism that surfaced it was `isFinanciallyConsistent`, which also reports CORE's own bookkeeping defects. An operator opening that queue could not tell a case waiting on a pricing decision from a case waiting on an engineer, and both were counted as "CORE is inconsistent" | `listFinanciallyInconsistent` returned the `unsettled` intake refusal and the `partially_captured` cancellation as one undifferentiated list |
| G-13 | `core.fulfillment.cancelled` was still readable as a refund. The event carried `settlement_state`, documented as optional and ignorable, and nothing in the payload said the money question was open. A consumer that ignores the field — which the contract permits — takes a cancellation to mean the payer was made whole | The payload had no field a consumer must read before telling a customer they were refunded |
| G-14 | Amounts CORE did know were thrown away. `voidWithin` reports `captured_minor`, `release()` read it to pick a state and then dropped the number, so the closure event named a state without the amount and no consumer could say *how much* was undecided | `release()` returned `SettlementState`, not the amount behind it |
| G-15 | Two overlapping closures publish the closure event twice. Recorded as **B-21**; measured, not theorised | `tests/fulfillment-financial-decision.test.ts`, postgres backend, intermittent |

### Every terminal path, in one table

`docs/settlement.md` now carries the full table the audit asked for: 19 rows,
one per way a fulfillment can reach a terminal state, each with execution state,
hold state, captured amount, remaining held amount, `settlement_state`,
`financial_disposition` and whether a decision is owed. Six distinct paths reach
the same fact — money left the payer and the work was not delivered — and the
table names them so none is discovered later by accident.

Two rows in it are honest gaps rather than behaviour:

- **Row 10**, a completed job that cost less than the ceiling, is representable
  and consistent but unreachable: nothing tells CORE a smaller amount, so a
  completed job always draws the full ceiling. That is the MOVE dependency below,
  not a CORE decision.
- **Row 19**, a hold that expires while execution is still open, leaves
  `settlement_state = 'held'` on the row until a MOVE event arrives. When one
  arrives the outcome is truthful; if none ever does, neither reconciliation read
  can see the contradiction, because both look only at the fulfillment row while
  the contradiction lives across two modules. A liveness gap, not a false record.

### What changed in CORE

- **`financialDisposition(fulfillment)`** — derived on read, never stored, five
  values: `no_money`, `awaiting_execution`, `settled`, `decision_required`,
  `inconsistent`. `isFinanciallyConsistent` is now expressed through it so the
  two cannot drift. `decision_required` is deliberately not a settled outcome.
- **`requiresFinancialDecision(fulfillment)`** — the factual predicate: money
  moved, work did not complete, CORE was not told what happens next. It encodes
  no policy and picks no outcome.
- **Both closure events now carry `financial_decision_required`**, and
  `captured_minor` when CORE observed it. The contract text is explicit: while
  the flag is true a consumer MUST NOT tell the payer they were refunded, MUST
  NOT invoice the amount as earned, and MUST NOT treat the operation as settled.
  A cancellation is not a refund.
- **`captured_minor` is omitted rather than sent as 0 when CORE did not observe
  it.** Zero is a claim that nothing moved; absent is a claim about CORE's
  knowledge. Threaded end to end as `number | null` — `release()`, `settle()` and
  `inspectHold()` all report the amount alongside the state instead of dropping
  it.
- **`GET /v1/fulfillments/reconciliation/pending-financial-decision`** — the
  B-20 queue, separate from the defect queue. A non-empty list here is not a CORE
  defect. Reads also return the derived `financial_disposition`.
- **No new state, no new event, no migration.** The four settlement states and
  migration 0011 were enough; `decision_required` is derived from what is already
  stored. Adding a fifth stored state would have created a second source of truth
  next to `settlement_state`, and a stored flag can disagree with the row it
  describes.

### What CORE will not do while a decision is owed

No transition writes `released` when `captured_minor > 0`. No path emits a
refund from a fulfillment outcome — `refundWithin` is only ever called by an
explicit request naming its own reference. No closure marks the case settled: it
stays in both reconciliation reads until an answer exists.

### B-20 as a contract gap: five decisions, none of them CORE's

Each row is a decision, not an implementation. CORE has no defensible default for
any of them, so none was chosen.

| # | Question | Who can answer it | What CORE needs when it is answered | Current risk |
|---|---|---|---|---|
| D-1 | Who states the actual executed amount when a job costs less than the consented ceiling? | MOVE — it is the only system that observes the work | An amount in minor units plus the currency on `move.job.completed`, asserted by MOVE, with a rule for "more than the ceiling" (refuse, or cap). Until it exists, `settle()` captures the whole hold | A completed job always draws the full ceiling. If MOVE's real cost is lower, the payer overpays and CORE has no record that it did |
| D-2 | Does partial work earn partial settlement, and how much? | Commercial owner (MARKET's domain) | A disposition per case, not a formula CORE invents: how much of `captured_minor` is earned | Nothing is earned or returned. The amount sits recorded and undecided |
| D-3 | Who authorises a refund of the captured part? | Commercial owner — a refund moves real money back | The existing `POST /v1/wallets/{id}/authorizations/{id}/refund` with a reference, called by whoever holds the authority | CORE will not infer a refund from a cancellation. It cannot be triggered by accident |
| D-4 | Is there a cancellation fee, and on what basis? | Commercial owner | If yes, whether the fee is the already-captured amount or an independent charge — they are different ledger movements | No fee exists anywhere in CORE. Treating the captured amount as a fee by leaving it in place would be a policy decided by inaction |
| D-5 | When is the operation financially settled, and who says so? | Commercial owner, then whichever system sends it | A single explicit inbound signal that closes the case, with the amount refunded and the amount retained, so the two sum to `captured_minor`. It must be a decision CORE receives, not a state CORE infers | `financial_disposition` stays `decision_required` forever. The queue grows and nothing drains it |

D-5 is the load-bearing one: until an inbound "this is the disposition" contract
exists, CORE can report the queue but cannot empty it. That contract is one
event or one route and CORE can build either in a day — the blocker is the
decision, not the code.

### External dependencies — precise, and still not implemented

Nothing outside CORE was modified. These are stated at the level an agent working
on MARKET or MOVE can act on without asking a follow-up question.

**Dependency 1 — the new enum value.**

| Field | Value |
|---|---|
| Exact value | `partially_captured` (lower snake case, exactly this spelling) |
| Field | `settlement_state` |
| Events | `core.fulfillment.completed` v1, `core.fulfillment.cancelled` v1 |
| Produced by | CORE, on the paths listed as rows 3, 6, 8, 12, 15, 17 of the table in `docs/settlement.md` |
| Consumed by | MARKET (customer-facing wording, invoicing, order state) |
| Correct handling | Part of the consented amount has moved and only the remainder was returned. Not a refund, not a full charge. Read `financial_decision_required` alongside it |
| Behaviour per value | `none` no hold; `held` should not appear on a closure; `captured` the whole ceiling moved; `partially_captured` part moved, rest returned; `released` nothing moved; `unsettled` CORE could not close the hold — treat as unknown and do not settle |
| Risk today, if an unknown value arrives | A consumer that maps unknown values onto `released` tells the customer they were refunded when they were not. The schema descriptions forbid it explicitly. A consumer that ignores the field entirely reads a cancellation as a refund — which is why `financial_decision_required` exists as a separate, plainly named boolean |

**Dependency 2 — the executed amount.** Minimum CORE needs on
`move.job.completed`: `executed_amount_minor` (integer, minor units) and
`currency` (ISO 4217, must match the hold's). Correct source: MOVE, because it is
the only system that observes the work. MARKET cannot supply it — it knows the
consented ceiling, which is what CORE already has. Without it row 10 of the table
stays unreachable and every completed job draws the full ceiling.

**Dependency 3 — the disposition signal (D-5).** CORE needs one inbound decision
carrying: the fulfillment id, the amount refunded, the amount retained (the two
summing to `captured_minor`), a reference for exactly-once handling, and the
identity of whoever authorised it. CORE will not design the policy behind it and
will not act without it.

### Tests

`tests/fulfillment-financial-decision.test.ts` — 7 cases × 2 backends = **14
tests**, covering the five shapes the audit asked for plus two more:

1. no capture — 6 000 reserved, 0 captured, cancel → `released`, event says
   `financial_decision_required: false` and `captured_minor: 0`, both queues
   empty, wallet fully spendable again;
2. partial capture — 6 000 reserved, 2 500 captured, cancel → `partially_captured`
   with `captured_minor: 2 500` and the flag true, wallet at 3 500, no refund
   posted, `decision_required`, in the pending queue and not in the settled pile;
3. full capture — 6 000 reserved, completion → `captured`, `settled`, flag false,
   `captured_minor` **absent** (pinned so it is never quietly turned into a 0);
4. repeated closure — a second `cancel` and a late completion cannot move the
   money truth twice; the late completion is refused, one closure event, one
   capture;
5. concurrent duplicate delivery — both the settle path and the release path:
   money moves exactly once (proved through wallet balances, which a double
   release would inflate), closure events all agree, and the duplicate-event race
   is pinned as B-21;
6. the two reconciliation reads separate a pending decision from an `unsettled`
   defect;
7. the HTTP surface: the new route, the derived `financial_disposition`, and that
   the route is not swallowed by `/v1/fulfillments/{id}`.

`tests/migration-0011-lifecycle.test.ts` — **1 test**, Postgres only, against a
database it creates and drops so it cannot disturb the development one: apply
clean → roll back with no rows in the new state (succeeds) → insert pre-0011 rows
→ apply over existing data (rows survive untouched) → the widened constraint
accepts `partially_captured` and still refuses a value outside the list → roll
back **with** a real `partially_captured` row (**refuses**, row and version both
still present) → remove the row → roll back (succeeds, narrowed constraint
refuses the pair again) → re-apply. The refusal decision from the previous cycle
was not weakened to make this easier; it is the property under test.

**356 tests across 25 files pass with `DATABASE_URL`; 202 pass and 39 skip
without it.** Gates green: `typecheck`, `check:governance`, `check:contracts`,
`check:migrations`.

### Proven, not assumed

- With `src/modules/fulfillment/{domain,service,http}.ts` stashed, **all 14** new
  tests fail on both backends.
- With the API present but `requiresFinancialDecision` forced to `false` — the
  implicit behaviour this cycle removes — **10 of 14** fail. That is the
  behavioural proof rather than a compile-time one.
- B-21 was observed, not inferred: repeated runs produce one closure event
  usually and two occasionally on Postgres, with the money correct in both cases.

### Roadmap triage after this cycle

**Complete inside CORE:** external event ingress and egress; partial capture and
refunds on both the money and the fulfillment side; the settlement truth table
and the pending-decision queue; subscriptions, plans, periods and entitlements
except the policy questions; RLS, token hashing, audit scrubbing, correlation
ids; migrations 0001–0011 with rehearsed rollbacks.

**Blocked on a decision outside CORE:** B-20 (D-1…D-5 above); multi-hold per
fulfillment (MARKET); the entitlement-check endpoint (B-14, needs an ADR);
proration, grace, trials, rollover, overrides (B-15…B-19); contract adoption in
MARKET and MOVE (B-2…B-6); staging and cutover.

**Actionable inside CORE right now, needing no external answer:**

1. **B-21 — one closure, one closure event.** Make the closing update
   conditional on the row still being open, so a losing concurrent transaction
   rolls back and takes its outbox row with it.
2. **Row 19 — cross-module reconciliation.** A read that lists open fulfillments
   whose authorization is no longer `authorized`, so a hold that expired under an
   open execution stops being invisible.
3. Channels and notifications (milestone 4) — a large piece of product surface
   with no external blocker.
4. Metrics and trace export, rate limiting on the ingress edge (milestone 8).

### Next task, and why it is this one

**B-21: make a closure single-valued in events as well as in money.**

It is next because it is the last place where CORE's output can mislead a
consumer through no fault of the consumer, and because it needs nobody's
permission. The stated priority for CORE is financially truthful, transactionally
atomic, idempotent, auditable, contractually explicit — B-21 is the idempotency
half of that, and it is the only item on the actionable list that touches money
semantics. Cross-module reconciliation (row 19) comes after it: it is a read, and
a read is worth more once the writes it reconciles are single-valued.

It is also not cosmetic. The fix changes the repository contract — a conditional
update that reports whether it matched — and both backends must agree about it,
which is exactly the class of difference that produced B-12.

## Cycle 2026-09-12 (third) — one closure, one closing event (CORE-only agent)

B-21, taken as the approved next task, and then the row-19 reconciliation that the
previous cycle put behind it. Both were done in the recorded order; nothing was
reordered because it looked easier.

### B-21 root cause, precisely

The closure was an unconditional write:

```sql
update fulfillment set status = $2, settlement_state = $3, ... where fulfillment_id = $1
```

Under READ COMMITTED two transactions can both read an open row. The first
commits. The second was already blocked on the row lock, wakes up, re-evaluates
its predicate — `fulfillment_id = $1`, which still matches — overwrites the
winner's terminal row with its own, and commits its own outbox row. Both had
staged a closing event, so MARKET received the same closure twice under two event
ids.

Two properties of SQL made this invisible to the service:

1. an `update` that matches zero rows is not an error, so nothing distinguished a
   first closure from a second;
2. the predicate said which row, never which version of it, so the row lock only
   serialised the writes — it never rejected the second one.

Money was never wrong, because the ledger keys its capture and the second
transaction re-read the same transaction instead of drawing again. Only the events
were multi-valued, which is why the previous cycle classified this as a delivery
defect rather than a money defect — and why it still had to be fixed: a consumer
that reacts to a closure has no way to tell CORE's second copy from a real second
closure.

### The repository contract, now explicit

`FulfillmentRepository` gained two writes whose result is a value, not a hope:

```ts
type ConditionalWrite = "applied" | "stale";
type InsertOutcome = "inserted" | "duplicate_order_reference";

updateIfStatusIn(f: Fulfillment, expected: readonly FulfillmentStatus[], scope?): Promise<ConditionalWrite>;
insertIfAbsent(f: Fulfillment, scope?): Promise<InsertOutcome>;
```

- `applied` — this call moved the row, and no other call did.
- `stale` — the row is not in any `expected` status any more, so nothing was
  written. Not an error, not a silent success: a distinct answer the caller must
  handle.
- `duplicate_order_reference` — another transaction already created the
  fulfillment for this order.

The store decides, never the service: PostgreSQL adds `and status = any($8::text[])`
and reports `rowCount === 1 ? "applied" : "stale"`; the insert is
`on conflict (market_order_reference) do nothing` and reports its own `rowCount`.
There is no read-then-write anywhere in either path, no in-process mutex, no
cache — the decision happens inside one statement in the database that owns the
row.

`InMemoryFulfillmentRepository` implements the same semantics in one uninterrupted
step, and its `insert` now throws on a duplicate `market_order_reference`, which
the schema has enforced since migration 0002 and the double silently allowed. A
memory store more permissive than PostgreSQL certifies bugs, so this was a defect
in the double, not a convenience.

`insert` and `update` remain for writes that are not transitions (traceability
back-fill) and say so in their doc comments.

### How the operation became atomic

`stale` is raised as a sentinel *inside* the staged mutation, at the point of the
write, so `withTransaction` unwinds everything the loser staged:

- money mutation staged **before** the closure → rolled back;
- the closure row itself → never applied;
- outbox append staged **after** it → rolled back;
- audit entry → rolled back.

The loser then re-reads the committed row and answers through the same resolver
the sequential repeat uses (`completionOn`, `cancellationOn`, `rejectionOn`,
`acceptanceOn`). That is the part that makes the guarantee stable rather than
lucky: a concurrent duplicate and a redelivered duplicate are the same question,
so they cannot return different answers.

Success is therefore exactly one commit containing new status + closing event +
outbox row; failure by prior closure is no event, no outbox row, no financial
mutation, no state change.

### Proven on a real database, not with mocks

`tests/fulfillment-single-closure.test.ts` — 10 cases, both backends, 20 tests,
`Pool({ max: 12 })` so the contenders are genuinely concurrent:

| Scenario | Before the fix | After |
| --- | --- | --- |
| 2 concurrent cancels | 2 closure events, 2 outbox rows | 1 event, 1 outbox row, 1 release |
| 8 concurrent cancels | up to 8 closure events | exactly 1 |
| 2 concurrent identical completions | 2 completed events | 1 event, 1 capture |
| cancel racing completion | 2 conflicting closures | 1 event, and it matches the stored row |
| loser's partial trace (2 500 already captured) | extra outbox row + duplicate money attempt | 3 outbox rows total, wallet 3 500, 1 pending-decision row |
| retry after a committed closure | new event each retry | no new event, same answer |
| 2 concurrent intakes of one order | 2 fulfillments possible | 1 fulfillment, 1 created event |
| 2 concurrent acceptances | 2 dispatch events | 1 `core.fulfillment.dispatched` |

The fix was proven by removing it: dropping `and status = any($8::text[])` and the
in-memory status check makes **14 of the 20 fail**; restoring them makes all 20
pass. The two earlier assertions that had to tolerate the defect
(`expect(events.length).toBeGreaterThanOrEqual(1)` in
`tests/fulfillment-financial-decision.test.ts`) are now `toHaveLength(1)`.

InMemory and PostgreSQL produce identical results on all 10 cases, with one honest
asymmetry, asserted rather than hidden: when two identical completions overlap,
the loser's capture collides with the ledger's own idempotency key while both
transactions are open, and that surfaces as a write conflict instead of a silent
no-op. CORE reports it rather than claiming the command was applied, and the
retrying consumer is then answered from the committed row — which the same test
asserts. Command idempotency (the same command twice) and delivery idempotency
(the same event twice) stay separate guarantees; the inbox was not touched.

### A second defect, found by reviewing the paths instead of the race

Reviewing every terminal closure path turned up one that no concurrency test would
have found: **the refusal of an order whose declared hold does not exist could not
commit on PostgreSQL at all.** `fulfillment.payment_authorization_id` is a foreign
key, the refusal row named a hold CORE does not have, and the insert violated
`fulfillment_payment_authorization_id_fkey`. The path was only ever exercised in
memory (`tests/fulfillment-settlement.test.ts` runs in-memory), so a documented,
tested refusal was unreachable on the real database: MARKET sending a stale or
mistyped reference got an error and endless redelivery instead of a refusal.

Fixed without inventing policy: the unresolvable reference is not stored — the
column exists to point at a hold CORE holds — and the declared reference is kept
on the audit entry as `unresolved_hold_reference`, under a key the scrubber does
not redact. Status, `closure_reason`, and the closing event are unchanged, MOVE is
still never asked to work, and no money exists to move.

### Row 19 — cross-module reconciliation, and what it is not

A hold can stop being able to settle its execution while the execution is still
open: the expiry sweep closed it, an operator voided it, or it was captured out of
band. Detection: `listStaleHolds` / `GET /v1/fulfillments/reconciliation/stale-holds`
compares every open funded fulfillment against its authorization through the same
`inspectHold` predicate that guards intake, so the sweep cannot drift from the rule
the write path applies.

The broken invariant is *open work is guarded by a hold that can still settle it*
— which lives in neither module alone. Classification, deliberately:

- **not `inconsistent`** — the row is not false. It says the work is open, and it
  is; a hold guarded it when the row was written.
- **not `decision_required`** — that queue means money moved for work that did not
  complete. Here the work has not finished at all.
- **not a new state** — "open but unfunded" would be a second, staler copy of the
  money state inside the fulfillment row, the exact duplication
  `financial_disposition` exists to avoid. Detection must not create state.

It is a liveness condition. CORE's action is to report it, with why the hold is
unusable, how much already moved, and the `settlement_state` the fulfillment would
take if it closed now — so an operator sees in advance which cases will land in the
`decision_required` queue. CORE does **not** act: re-authorising, abandoning the
execution, or completing it unfunded are three commercial answers, recorded as
dependency **D-6** rather than invented. `tests/fulfillment-stale-holds.test.ts`
(8 tests, both backends) asserts the read finds each case, ignores closed and
unfunded work, changes nothing, and is stable across repeated reads.

### External dependencies — unchanged, plus one

D-1…D-5 stand exactly as recorded (partial-capture policy, `partially_captured`
adoption, `executed_amount_minor` + currency, the financial decision command and
its contract). Nothing was implemented on their behalf and B-21 did not wait for
them.

- **D-6 — the fate of open work whose funding disappeared.** Who decides between
  re-authorising, abandoning the execution and completing it unfunded; whether
  MOVE must stop working on a job whose hold is gone; and whether MARKET is told
  before or after that decision. Until it exists the stale-hold queue is reported
  and never drained automatically.

### Regression

- `npx tsc --noEmit` clean; governance, contracts (21 schemas, 14 emitted types)
  and migrations (11 forward, all with rollbacks) green.
- `DATABASE_URL=… npm test`: **384 passed / 27 files** (356 before this cycle;
  +20 single-closure, +8 stale-hold). No previously passing test was changed to
  accommodate the fix — the only edits to existing assertions tightened two that
  had been pinned loose *because* of B-21.
- `npm test` without a database: 216 passed, 39 skipped.

### Roadmap triage after this cycle

**Complete inside CORE:** everything listed in the previous cycle, plus a
single-valued closure on every terminal path, an intake refusal that works on the
real database, and the cross-module stale-hold reconciliation read.

**Blocked on a decision outside CORE:** B-20 (D-1…D-5); the stale-hold policy
(D-6); multi-hold per fulfillment (MARKET); the entitlement-check endpoint (B-14,
needs an ADR); proration, grace, trials, rollover, overrides (B-15…B-19); contract
adoption in MARKET and MOVE (B-2…B-6); staging and cutover.

**Actionable inside CORE right now, needing no external answer:**

1. **Channels and notifications (milestone 4).** The largest remaining piece of
   product surface with no external blocker, and the natural consumer of the
   closing events that are now single-valued.
2. Metrics and trace export, rate limiting on the ingress edge (milestone 8).
3. A set-based stale-hold sweep, if the volume of open work makes the current
   one-read-per-fulfillment reconciliation expensive. Not needed yet, and the fix
   would be a query, never a stored copy of the money state.

### Next task, and why it is this one

**Milestone 4 — channels and notifications.** It is next because the write side of
coordination is now closed: every terminal path emits exactly one event, that
event carries the money truth including `financial_decision_required`, and the two
reconciliation queues plus the stale-hold read cover the cases where truth and
policy diverge. Notification is the first thing that *consumes* those events, and
it was never worth building on top of a closure that could be published twice.

Not chosen: B-14…B-19 and B-20 need answers CORE does not own, and inventing one
to make progress would be the one thing this repository is not allowed to do.

## Cycle 2026-09-12 (fourth) — Milestone 4, notifications to people (CORE-only agent)

### What Milestone 4 actually meant, read from the code

The roadmap line said "channels and notifications; Telegram adapter" and the
evidence column said "Telegram exists only as an identity channel type. No
delivery path". Checking that against the code rather than the sentence:

- Events already reach **systems**: `event_subscription` + `event_delivery`
  (migration 0008), signed bodies, failure classification, a dead-letter state.
- `identity_link.channel_type` already included `telegram`, but as an **inbound**
  identity only (ADR 0016) — a way to recognise who is talking to CORE. Nothing
  turned an event into something a person reads, and no message contract existed.

So the milestone is the missing person-facing half of an existing mechanism, not a
new mechanism. It was built on the same outbox, the same claim discipline and the
same clock, and no general notification framework was introduced: five templates,
one dispatcher, three channel types, four routes.

### The path, and the two properties that fall out of it

```
domain state change + outbox append ── one transaction ──→ commit
        │
        ▼ relay claims the outbox row
   fan-out inside the relay's markPublished transaction
        ├─→ event_delivery  (systems, pre-existing)
        └─→ notification    (people, this milestone)
                │
                ▼ dispatcher claims with a lease + a fencing token
          channel adapter → accepted │ delivered │ retryable │ permanent
```

- **No notification without committed state.** The notification row is derived
  from the outbox row, which commits with the state change. A rolled back
  transaction leaves neither; tested by rolling back a dispatch and draining.
- **No notification lost after committed state.** The fan-out runs inside the
  transaction that marks the event published, so there is no window in which an
  event is published and its notification rows do not exist.

Nothing external is called inside a domain transaction, so no provider can roll
back CORE state. The outbox stays the commit point.

### The channel contract, and why it is not a boolean

`ChannelResult` is a four-way union — `accepted`, `delivered`, `retryable(reason,
retry_after_ms?)`, `permanent(reason)` — each carrying an optional
`provider_message_id`. A boolean or `void` would erase the only distinctions that
matter operationally: whether to try again, whether to stop forever, and whether
anyone can be asked about the message later.

`accepted` (a provider took it) and `delivered` (a provider confirmed receipt) are
kept apart even though **no adapter can produce `delivered` today**. Every real
transport confirms acceptance synchronously and receipt, if at all, out of band.
Collapsing them would be a claim CORE cannot support; leaving `delivered`
modelled-but-unreachable costs one enum value and records the gap as **D-8**.

A thrown adapter error and a missing adapter for a channel are both treated as
`retryable`, not `permanent`: a deployment without that adapter is a configuration
fact somebody may fix, and burning the message would turn an operational gap into
lost information.

### Idempotency, in three places rather than one

1. **Fan-out** — `idempotency_key = ${event_id}:${recipient_id}` is unique in the
   database, so a duplicated outbox delivery of the same event inserts nothing the
   second time.
2. **Claim** — one statement sets `processing`, increments `attempts`, moves
   `next_attempt_at` out by the lease and stamps a fresh `claim_token`. A second
   dispatcher polling at the same instant matches nothing.
3. **Acknowledgement** — every mark is fenced on the token it was claimed with and
   returns whether it applied, so a worker that stalled past its lease cannot
   overwrite the attempt that replaced it. The dispatcher counts those as `fenced`.

`attempts` is spent at claim time, not at acknowledgement, so a message that kills
its worker every time cannot loop forever.

The honest statement of the guarantee, which is what `docs/notifications.md` says
and what the tests assert: **at most one attempt in flight** and **at least once**
are CORE's to guarantee and are guaranteed; **exactly once end to end** is not,
and is not claimed; **effectively once** holds with a provider that honours the
idempotency key, which is why the key is stable across retries, restarts and
races, and is passed to the adapter on every send.

### Retry and failure semantics

Six attempts, exponential backoff from 1s, provider-supplied `retry_after_ms`
overriding the computed delay, `permanent` never retried, exhaustion terminal and
visible at `GET /v1/notifications?status=failed`. `retrying` is **derived**
(`pending` with `attempts > 0`) and never stored: one row cannot be both, and a
stored copy of a derivable fact drifts.

### What is sent, decided rather than assumed

Five templates, mapped explicitly: `core.fulfillment.dispatched` → assigned;
`core.fulfillment.completed` with `outcome: completed` → done; the same event with
`outcome: failed` → could not be completed (there is no `core.fulfillment.failed`
event — failure rides on the completion, which the roadmap did not say and the code
does); `core.fulfillment.cancelled` → cancelled; `core.subscription.past_due` →
unpaid period. Everything else emits nothing: `core.payment.*` is settlement
mechanics rather than news, `core.identity.verified` is the recipient's own action,
`core.fulfillment.created` has nothing to report yet.

Bodies are rendered against a published contract, not serialised from a domain
object, so no internal field becomes an external interface by accident.

**Money wording is derived from `settlement_state` and says nothing otherwise:**
`decision_required` → "a payment amount is held pending review; no refund or
charge has been decided yet"; `released` → "no payment was taken"; `captured` /
`partially_captured` → "the authorised payment was charged"; anything else →
silence. A test asserts the absence of "has been refunded", "will be refunded",
"settled", "reimburs" and "credited back" from the undecided case. This is D-6
held open in the product vocabulary: `decision_required ≠ settled`, and no message
may read as a refund or a final settlement before the decision exists.

### Who may be told

`notification_recipient` binds `(event_type, identity_id, channel)`, optionally
scoped to an organization, operator-only. Registration refuses more than it
accepts: only `telegram` / `email` / `phone` (channels a person can receive on),
only against a **verified** `identity_link` (an unverified address is somebody's
claim, and messaging it is how an account takeover becomes a notification), and
only a tenant scope the event payload can actually carry (B-23).

An unroutable recipient at fan-out time produces a row born `failed` with a null
address rather than no row: the fact that somebody should have been told and could
not be is exactly the fact worth keeping.

### B-22 — the finding that had to be fixed first

Recorded in full in the blockers table. In short: the "atomic claim semantics
proven in PostgreSQL" that this milestone was meant to build on **did not exist**.
Three claim implementations marked nothing, and two workers polling together
received identical rows — measured at five out of five before the fix. The
notification dispatcher could not have been correct on top of that, and neither
were the outbox relay, the inbound dispatcher or the outbound delivery worker.

`for update skip locked` was not wrong, it was incomplete: it needed the write.

### Backend parity, and the one documented difference

`InMemoryNotificationStore` writes the lease and the token synchronously so it
fails the same tests as Postgres; a memory double more permissive than the
database certifies a bug (B-12, twice learned). The single difference: the memory
claim is synchronous, so two in-process dispatchers serialise rather than race,
while on Postgres disjointness is enforced by `for update skip locked` plus the
claiming write. Both are asserted, and the Postgres case is the one that proves
the property.

### Migration 0012

`notification_recipient` and `notification`, both with RLS, forward and down
scripts, applied and rolled back against a real database. Two authoring mistakes
worth recording because the schema tests caught them and a reviewer would not:
the tenant and identity columns had to be `uuid` to match the foreign keys from
0001, and an explicitly named check constraint collided with the name PostgreSQL
auto-assigns to an inline column check (`notification_address_check`), so it was
renamed rather than the column check removed.

### API and observability — four routes, no new concepts

`POST` / `GET /v1/notification-recipients`, `POST
/v1/notification-recipients/{id}/deactivate`, `GET /v1/notifications` with
`organization_id`, `status` and `limit` plus a `summary` of counts including the
derived `retrying`. There is deliberately no `/pending`, `/failed` or `/retrying`
path: same question, different filter, and a path per status is how one concept
acquires five sources of truth. Nothing folds into
`/v1/event-deliveries/undelivered`, which answers whether a *system* received an
event — this answers whether a *person* was told.

Channel errors are recorded with `sanitiseChannelError`: bearer tokens, api keys,
secrets, passwords and the recipient's own address are redacted and the reason is
truncated, so a provider's error text cannot smuggle a credential or a phone
number into `last_error`, the audit trail or the logs. Deactivating a recipient
stops future notifications and leaves queued ones queued — they describe something
that already happened.

### Tests

`tests/notifications.test.ts` — 23 × 2 backends: one event produces exactly one
notification; a duplicated outbox delivery does not double it; two concurrent
dispatchers never send the same row; retryable retries on the policy; permanent is
never retried; attempts exhaust into a visible terminal failure; a worker killed
between sending and acknowledging is recovered after its lease and repeats with
the same key; an adapter that fails after the provider took the message repeats
rather than loses it; a cooperating provider collapses the repeat; a stalled
worker's late acknowledgement is fenced out; a rolled back transaction produces no
notification; restart resumes from the database; an unverified channel cannot be
registered; a tenant scope the event cannot carry is refused; a deactivated
recipient stops receiving; the existing vertical slice is unaffected; provider
errors leak neither secrets nor addresses; and the undecided financial case never
reads as a refund.

`tests/worker-claim-atomicity.test.ts` — 5 × 2 backends over the outbox, the
inbound store, the outbound delivery store and the notification store: two
claimants issued concurrently receive disjoint sets, a third poll inside the lease
receives nothing, and an abandoned claim returns when the lease expires. Verified
to fail against the pre-fix claim, not merely to pass against the fixed one.

### Regression

- `npx tsc --noEmit` clean; governance, contracts (21 event schemas + 1 published
  message contract, 14 emitted event types covered) and migrations (12 forward,
  all with rollbacks) green.
- `DATABASE_URL=… npm test`: **440 passed / 29 files** (384 / 27 before this
  cycle; +46 notifications, +10 claim atomicity, both counted across backends).
- `npm test` without a database: 246 passed, 39 skipped.
- One existing test was edited and only to remove an assumption, not an
  assertion: `tests/migration-0011-lifecycle.test.ts` assumed 0011 was the newest
  migration, so it now peels newer ones first.

### External dependencies — two new, none solved

D-1…D-5 stand exactly as recorded. **D-6 was not touched**, which is the point of
the money wording above.

- **D-7 — who the end customer is.** CORE holds an opaque `order_reference` from
  MARKET, not a customer identity, so CORE cannot notify the person who placed an
  order. Per-customer routing belongs to MARKET, either by MARKET notifying its
  own customers from the events it already receives, or by a contract that passes
  a CORE identity on the order. Until then recipients are operators and tenant
  staff, which is what CORE actually knows.
- **D-8 — delivery confirmation from a provider.** Without an inbound callback,
  `accepted` is the strongest truth CORE has and `delivered` is unreachable. When
  a provider offers a status webhook, the state and the `provider_message_id` to
  correlate it are already there; nothing in the domain changes.

### Roadmap triage after this cycle

**Complete inside CORE:** everything from the previous cycle, plus notifications
to people end to end with fake adapters, and a claim discipline that actually
holds under concurrency across all four workers.

**Blocked on a decision outside CORE:** B-20 (D-1…D-5); the stale-hold policy
(D-6); per-customer notification routing (D-7); delivery confirmation (D-8);
multi-hold per fulfillment (MARKET); the entitlement-check endpoint (B-14, needs
an ADR); proration, grace, trials, rollover, overrides (B-15…B-19); contract
adoption in MARKET and MOVE (B-2…B-6); staging and cutover.

**Actionable inside CORE right now, needing no external answer:**

1. **Milestone 8 — observability export and ingress rate limiting.** Metrics and
   traces for the four workers, and a limit on the public ingress edge.
2. **Milestone 6 — replay tooling.** `inbound_event` keeps the envelopes, so
   replay is now possible and has no consumer-side blocker.
3. A live channel adapter, whenever a provider credential exists. It is a new
   file behind the existing port, and B-23's payload widening is the only thing
   that would make it more than that.

### Next task, and why it is this one

**Milestone 8 — observability export and rate limiting on the ingress edge.** It
is next because CORE now has four background workers with retry, backoff, leases
and terminal states, and the only way to see any of them is to query a table. The
notification cycle needed a measurement harness to find B-22 at all; exporting
those numbers turns a one-off measurement into something continuously visible, and
it needs no answer from MARKET, MOVE or a commercial owner.

Not chosen: a real Telegram adapter (no credential, and the port makes it a later
one-file change); B-23's payload widening (a versioned contract change that MOVE
and MARKET consume, so it belongs in a contract cycle); D-6 and D-7, which are not
CORE's to decide and were not started.

## Cycle 2026-09-12 (fifth) — Milestone 8, metrics export and ingress rate limiting (CORE-only agent)

**Scope:** CORE only. MOVE (`noor-seez/ceezr`) and MARKET (`skyosv10-art/wasla`)
untouched. No contract change to any existing endpoint or event payload; the
OpenAPI additions are a new read-only path, a new reusable 429 response, and a
new error code in the `Error` enum — all additive within v1.

### What the milestone actually meant, after reading the code

The ROADMAP line said "no metrics/trace export, no rate limiting on the new
ingress edge" and named neither a format nor a scope, so both were decided in
this cycle and written down rather than left implicit. Reading the code first
changed three things about the plan:

1. **There is no middleware layer.** `Router.handle()` is the single funnel every
   HTTP request passes through. So the instrumentation and the limiter went
   *there*, and no middleware abstraction was introduced to host them. One call
   site does not need a pipeline.
2. **There is no metrics abstraction, and none was added.** One registry, one
   declared catalogue, one renderer. No exporter interface, no tracing layer —
   nothing in CORE consumes those today.
3. **The four workers already had every fact worth counting**, but they were
   reporting it only as a return value from `drainOnce()`. The counters are
   recorded at those same points, so no metric describes a state the system does
   not have. Where a state genuinely does not exist, it is *not* invented — see
   B-24.

### Metrics: the catalogue and its dimensions

Declared in `src/platform/observability/metrics.ts`. The registry refuses an
undeclared name, a missing label, an extra label and a wrong metric type.

| Metric | Type | Labels |
|---|---|---|
| `core_http_requests_total` | counter | `route`, `method`, `status` |
| `core_http_request_duration_seconds` | histogram | `route`, `method` |
| `core_http_rate_limited_total` | counter | `rate_class`, `subject_kind` |
| `core_worker_claims_total` | counter | `worker` |
| `core_worker_outcomes_total` | counter | `worker`, `outcome` |
| `core_worker_item_duration_seconds` | histogram | `worker` |
| `core_queue_depth` | gauge | `queue`, `state` |
| `core_reconciliation_depth` | gauge | `queue` |
| `core_sample_timestamp_seconds` | gauge | — |
| `core_sample_failures_total` | counter | — |

`worker` ∈ `outbox_relay`, `inbound_dispatcher`, `event_delivery`,
`notification`. `outcome` ∈ `completed`, `retried`, `failed_permanent`, `fenced`,
`reclaimed` — `retried` and `failed_permanent` are separate because a retry is
the system working and a permanent failure is work that will not happen without a
person; `fenced` is a stale acknowledgement refused (the B-22 protection firing)
and must never be counted as a completion.

`route` is always the route **template**, and an unmatched path collapses to the
literal `unmatched`: an unknown path is attacker-controlled text and would be
unbounded cardinality. `status` is the exact numeric code, because "how many
401s" and "how many 500s" are different questions.

`core_queue_depth{state}` includes `retrying`, which is **derived at read time**
(`pending` with `attempts > 0`) inside the same aggregate query on both backends.
No table has a `retrying` status, and the gauge does not pretend one exists.

`core_reconciliation_depth` covers `inconsistent`, `pending_financial_decision`
and `stale_holds` as counts only — the size of a queue a human must work
through, never who is in it.

### Export

One endpoint, `GET /metrics`, Prometheus text exposition **0.0.4**,
`text/plain; version=0.0.4; charset=utf-8`. Chosen because a consumer for it
already exists everywhere; inventing a JSON shape would have meant writing the
consumer too. It renders in catalogue order, so two scrapes of unchanged state
are byte-identical, and it walks in-memory maps only: **no query, no lock, no
transaction, no state change**, asserted by snapshotting the outbox, inbound
events, notifications, audit trail and reconciliation queues around repeated
scrapes. The one thing a scrape does is count itself, like every other request,
and the test asserts exactly that difference and nothing more.

The depth gauges are refreshed by `DepthSampler.sample()` on the operator's
cadence, **not** by the scrape: sampling in the scrape would turn monitoring
frequency into database load and would make the endpoint fail exactly when the
database is unwell. The cost of that choice — staleness — is made visible instead
of hidden, by `core_sample_timestamp_seconds` next to the gauges and
`core_sample_failures_total` for sampling errors. A failed sample leaves the
previous values and the old timestamp in place rather than publishing zeros,
because "empty" and "I could not look" are different facts.

### Rate limiting: where it sits and what it counts

At the HTTP edge in `Router.handle()`, **after route matching and before any
handler**, and nowhere else. Not in domain services: a limit there would be a
business rule with a status code attached and would fire for background work done
on nobody's behalf. It does not join the request's transaction — the counter is
one statement on the pool — so a rolled-back request cannot refund budget and a
refusal cannot roll back domain work.

**Subject:** sha256 of the presented bearer token (`credential`), falling back to
the hashed first hop of `x-forwarded-for` / `x-real-ip` / `x-client-ip`, else the
constant `unattributed` (`network`). The address is never used when a credential
is present, so two callers behind one NAT are two budgets. Only the hash is ever
stored, and the metrics carry `subject_kind` only, never the hash.

**Organization is deliberately not the key:** resolving a token to a tenant needs
a session lookup, i.e. a database read *in front of* the limiter, which would mean
a flood of invalid tokens still costs a query per request — the exact thing the
limiter exists to prevent. Recorded as a scope decision, not an oversight.

**Policy:** fixed 60 s window aligned to the epoch; per subject, per route class.
`ingress_events` 600, `write` 120, `read` 300, `unmatched` 60. `/health`,
`/ready` and `/metrics` are never limited and advertise no budget headers.
Class, not route, because the class is both a policy key and a metric label. The
known cost of a fixed window is the boundary burst, bounded at twice the limit and
documented rather than discovered.

**Refusal semantics:** HTTP **429**, code `rate_limited`, `retryable: true` — a
first-class error code mapped to 429 in `src/platform/errors.ts`, not a
repurposed `unavailable` and not a domain error. `retry-after` in whole seconds,
minimum 1; `x-ratelimit-limit`/`-remaining`/`-reset` on allowed responses too.
The message carries no subject, no hash and no address.

**Workers are unreachable from the limiter by construction**, not by an exemption
list: they are invoked directly by the process that runs them and there is no code
path from a worker to the router.

### Concurrency

The store contract is one operation returning the post-increment count, so there
is no version of the code where a `select` precedes an `update` — the shape that
was B-22. Postgres does it as `insert … on conflict … do update set hits = hits +
1 … returning hits`, which holds a row lock for the statement, run on the pool and
never inside the request's transaction scope. The in-memory store is atomic only
because its increment contains no `await`, which is correct within one process and
explicitly not across processes; that is why the limiter backend is bound to the
persistence bundle rather than chosen separately.

Asserted on **real Postgres**: 40 requests issued before anything is awaited over
a pool with `max: 16`, against a limit of 5 → exactly 5 admitted, 35 refused, and
the stored counter equal to 40. The assertion was **falsified** against a
deliberately racy read-then-write implementation of the same store, which admitted
all 40 — so the test is known to be capable of failing.

### Privacy

**Decision: system-level metrics only. No metric carries a tenant dimension, and
tenant-scoped metrics were not added alongside them.** A count alone is enough to
leak: a per-organization request counter tells any reader that a tenant exists,
roughly how large it is, and when it is in trouble. Per-tenant operational
answers already exist, already authorized, through the reconciliation and
delivery endpoints. Enforced three ways: the catalogue is asserted to declare no
tenant- or entity-named dimension; every label value is checked against a strict
pattern that rejects uuids, addresses, phone numbers and token-shaped strings
(and the rejection message never echoes the value it refused); and a full
lifecycle test — ingress, dispatch, publication, a notification whose adapter
fails with an error containing both the recipient's address and an api key —
asserts the exposition contains no token, tenant id, order reference, identity id,
address or provider error text, and **no uuid anywhere at all**.

### Tests added (48, both backends where applicable)

- `tests/observability.test.ts` (25): registry refuses an undeclared name, a
  missing/extra label and a wrong type; refuses uuid, email, phone, api-key and
  overlong label values without echoing them; deterministic exposition with
  cumulative buckets, `_sum` and `_count`; the catalogue declares no
  tenant/entity dimension; ingress counted by template and exact status with the
  concrete path absent; relay and dispatcher counters matching actual drains;
  retry vs permanent failure kept apart for outbound delivery; an abandoned claim
  appearing as `reclaimed` and then completing; a **fenced** acknowledgement
  produced by a real in-flight lease expiry (gated channel) counted as `fenced`
  and never as a completion; queue-depth and reconciliation gauges with no tenant
  in the output; `retrying` derived identically on both backends; `/metrics`
  serving without touching the database and changing nothing; the leak test; the
  sampler reporting its own failure instead of publishing zeros or throwing; and
  the bounded request log.
- `tests/rate-limit.test.ts` (23): route classification and exemptions; subject
  keying and the network fallback; finite defaults; under/at/over the limit →
  429 with usable `retry-after` and the `x-ratelimit-*` headers; the caller
  admitted again after obeying `retry-after`; **a refused request changing no
  state at all** across fulfillments, ledger transactions, authorizations,
  outbox, inbox, inbound events, deliveries, notifications and audit — and not
  consuming idempotency; per-credential isolation with a shared address; route
  class isolation; liveness and the scrape never refused; workers still draining
  while the edge refuses; an unauthenticated flood attributed to `network` and
  refused before authentication; probes of unknown paths counted without the path
  becoming a label; and, on real Postgres, the concurrency guarantee plus
  per-window counting and pruning.

### Measured cost

`scripts/measure-ingress-overhead.mjs`, 20 000 requests per configuration
against the same no-op handler: bare router p50 ≈ 8 µs; **+ metrics ≈ +1 µs**
(within run-to-run noise); + in-process limiter ≈ +5 µs; + Postgres limiter
≈ +200 µs, which is one database round trip and the intrinsic price of a limit
that holds across instances. Nothing in the sampler runs on a request path.

### Fixed on the way, because the milestone made them visible

- `router.logs` was an unbounded in-memory array — one record per request for the
  lifetime of the process. Now capped at 1000.
- `/ready` reported outbox depth by loading **every** pending row, so the
  readiness probe got more expensive the busier the system was. Queue `counts()`
  is now an aggregate query on all four queues, which the sampler needed anyway.

### New blocker

**B-24** — lease expiry is not countable for the outbox relay, the inbound
dispatcher or the delivery worker, because their lease rides on `next_attempt_at`,
which is also the retry-schedule field. Recorded, not worked around: inventing a
`reclaimed` count for them would have meant a metric describing a state the
schema does not have. Needs a `processing` status or a `claimed_at` column on
three eventing tables, with a rollback path and a decision about existing rows.

### Did this unblock B-23, D-7 or D-8?

No, and none was touched. **B-23** (closure payloads carry no `organization_id`)
is unchanged: it is a versioned change to three published event contracts that
MOVE and MARKET consume, so it belongs in a contract cycle. **D-7** (routing
ownership) and **D-8** (provider delivery confirmation) are external decisions.
Observability makes their absence *visible* — `core_worker_outcomes_total` will
show notifications ending as `accepted` and never `delivered`, which is exactly
D-8 — but visibility is not a resolution.

### Next task, and why it is this one

**Milestone 6 — event normalisation and historical replay tooling.** It is next
because it is the only remaining milestone that is entirely inside CORE and has
no external dependency: `inbound_event` now keeps every envelope, the inbox
deduplicates per consumer, and this cycle added the aggregate reads that make a
replay's effect observable while it runs. It also has a real operational
customer: with four workers, terminal failures and a `failed_permanent` counter,
the question "replay these events safely" is now one an operator will actually
ask.

Not chosen: **B-24**, which is a schema change to three eventing tables and
deserves its own cycle rather than being appended to this one (it is the strongest
candidate after milestone 6); a live channel adapter (no provider credential, and
the port keeps it a one-file change); B-23's payload widening and D-6/D-7/D-8,
which are contract or external decisions; milestone 9, which is blocked on B-5
and B-6.

## Cycle 2026-09-12 (sixth) — Milestone 6, event normalisation and historical replay (CORE-only agent)

### What the milestone actually meant, after reading the code

The audit came before the abstraction, and it changed the shape of the work
twice.

First finding: `inbound_event` has kept every accepted envelope since migration
0007, and the only thing that could ever act on one was `InboundDispatcher`,
which looks exclusively at rows that are `pending` and due. A row that went
`dead` after exhausting its attempts, or that was accepted while a consumer had a
defect, was **durable and unreachable at the same time**. The data was being kept
for a recovery that had no mechanism. That is the gap replay closes — and it is a
much smaller gap than "build a replay engine".

Second finding, and the more serious one: each of the four fulfillment consumers
validated its own payload, in its own way, at the moment it ran. Unifying that
into one layer immediately exposed two defects that were live in the repository:

- the `move.job.rejected` consumer accepted payloads with **no `rejected_at`**,
  a field the published contract marks required;
- a `move.job.completed` fixture carried a `reason` key the contract forbids
  (`additionalProperties: false`), and the consumer took it.

Neither was caught because nothing was responsible for deciding what an event
*is*. So normalisation was not scaffolding for replay; it was the defect fix, and
replay is what made it necessary to look.

No event bus was built, no inbox or outbox was redesigned, and no published
contract was changed.

### Four stages, kept distinct

raw inbound → validated envelope (`assertEnvelope`) → **canonical event**
(`normalize()`) → consumer effect (`service.ts`). A consumer now receives a
`CanonicalEvent` and asks for its payload by expected type; it does not see
`version` and does not branch on it. The reason for the layer is exactly that: if
every consumer interprets versions itself, "what does this event mean" has as many
answers as there are consumers, and they drift in silence.

`CanonicalEvent` carries `event_id`, `event_type`, `version`, `producer`,
`occurred_at`, `received_at`, `correlation_id`, `causation_id`,
`entity_type`/`entity_id`, `organization_id` (`string | null`, where null means
*the envelope does not say*), the canonical `payload`, and the original
`envelope` verbatim — retained because replay republishes the original bytes
rather than a reconstruction, and a reconstruction would be a new event with a new
identity that the inbox has never seen.

`normalize()` is total and pure: `{ ok: true, event }` or
`{ ok: false, rejection, detail }`, never a throw. It runs at the ingress edge
(rejection → 400 to the producer) and inside replay (rejection → reported
outcome). Four rejections: `envelope_malformed`, `unknown_event_type`,
`unsupported_version`, `payload_malformed`. The detail names offending **keys,
never values**, so a report is safe to paste into a ticket.

An unnormalisable row is left **exactly** as it was — not its status, not its
attempt count. A refusal costs an operator an investigation; a guessed
`organization_id` settles money against the wrong party.

**Stated honestly:** only version 1 exists for all four inbound types, so the
multi-version dispatch path is exercised only by the `unsupported_version`
refusal. The real backwards-compatibility case handled is the additive optional
`payment_authorization_id` (absent ≡ null). This cycle did **not** prove a
version-1-to-version-2 migration, because there is no version 2.

### Replay scope, and the refusal to mean "everything"

`assertNarrow` rejects a scope unless at least one filter narrows it, and `limit`
is mandatory and bounded to 1…1000. Filters: `event_ids`, `event_types`,
`producer`, `statuses`, `received_from`/`to`, `occurred_from`/`to`,
`organization_id`, `after` (cursor), `limit`. `statuses` defaults to
`["pending", "dead"]` — the rows replay exists to rescue; asking for `processed`
rows is allowed but must be explicit. The reason for compulsory narrowing is
reviewability: an operator, and later an auditor, must be able to read the command
and know what it touches before it runs.

### Ordering

`(received_at, event_id)` — CORE's own receipt time, tie-broken deterministically
so a cursor can be exact. `occurred_at` is deliberately **not** the key: it is
the producer's claim, and ordering by it would let a producer with a skewed clock
reorder CORE's history retroactively. Paging uses a row-value cursor
`(received_at, event_id) > (:at, :id)` matching the sort exactly, so no event is
visited twice or skipped.

There is no sequence column, so the order is deterministic rather than
semantically total. Where ordering genuinely matters it is the **domain** that
enforces it, not the replay: a stale acceptance arriving after a cancellation
records what it can and does not reopen closed work, because the consumers use
conditional transitions on the current status.

### Dry-run, proved rather than promised

`plan()` returns the same report shape as a real run and writes nothing. That is
not asserted by reading the code: `ReadOnlyQueryable` wraps a pool so every
statement runs inside `begin transaction read only`, and the test runs the
identical service on it — `plan()` succeeds, `run()` on the same scope fails with
PostgreSQL **SQLSTATE 25006**, and afterwards `fulfillment`, `inbound_event`,
`inbox`, `outbox`, `notification`, the ledger and `audit_entry` are unchanged.
The falsification is the point: the guarantee is "the database refuses the
write", not "the code does not call the handler" (W-8).

**A dry-run writes no audit entry either.** A deliberate trade: journaling a
rehearsal would mean the rehearsal writes, which destroys the only property that
makes a rehearsal worth having.

### Redelivery is not replay

Redelivery is a producer resending an `event_id`, handled at ingress and
unchanged. Replay is CORE offering a stored event to consumers again, and the
inbox is per `(consumer, event_id)`.

Two modes, only one of which can cause a second execution. `pending_only`
(default) publishes and lets the inbox decide, so it is safe against any scope.
`reapply` clears this event's inbox entries for its consumers first — **explicit,
named and documented, never a hidden side effect** — for a consumer whose handler
was wrong and has been fixed. It is not a way around idempotency: the handlers
still enforce their own invariants, so a re-executed capture is refused by the
ledger rather than permitted by the replay.

Replay never rewrites an `event_id` or re-wraps an envelope. That is the cheapest
possible way to cause a double effect, which is precisely why the stored envelope
is republished byte for byte; a test submits a deliberately re-wrapped duplicate
to show the order-reference uniqueness still holds even then.

### Financial safety

There is **no replay-specific branch anywhere in the money path**. The guarantee
is not that replay is careful, it is that replay has no privileges. On real
PostgreSQL, over wallet → credit → authorize → `market.order.created` with a hold
→ `move.job.accepted` → `move.job.completed`: first replay captures
(`settlement_state = captured`, held 0, available 6 000); the same two events
replayed again, dragged back into scope on purpose so the inbox is the only thing
in the way, report `skipped_duplicate` × 2 and leave the balance, the
authorization row and the settlement state byte-identical. A replayed
`move.job.rejected` releases once; `reapply` of it does not credit twice. No
second capture, release, ledger entry or settlement.

### Failure semantics

No wrapping transaction. Thousands of events in one transaction would make
resumption impossible and hold locks for the length of the run, so each event is
published on its own and the report is the record.

`stopOnError` defaults to true, because later facts must not land on top of an
earlier one that never did. The report names the failing event and the reason,
shows what preceded it as applied and what followed as not started, and
`resume_after` points **before** the failing event so a resume retries it rather
than stepping over the one event that did not work. The failing row keeps the
dispatcher's own schedule — `attempts`, `next_attempt_at` and `status` untouched
— so a failed replay cannot spend the live queue's retry budget.
`--continue-on-error` answers the different question "how bad is it", opt-in.

### Concurrency

One run at a time, **refused rather than queued**: a replay waiting behind
another would run against a state the operator never inspected. In memory,
`InProcessReplayLock`, documented as single-process only. On PostgreSQL, a
session-scoped `pg_try_advisory_lock` on a dedicated client, tested from a
genuinely separate pool — which is what a second CORE instance is, and which an
in-process lock would let through. The lock is released in a `finally`, tested by
making the first store call throw, so one unexpected error cannot lock replay out
until a restart.

### Tenant isolation, and where B-23 bites

Scope by organization has three outcomes: match, `skipped_tenant_mismatch`, or
`skipped_tenant_unknown` when the envelope carries no tenant scope. CORE *could*
resolve a `move.*` closure to a tenant by looking up the fulfillment and
deliberately does not — the envelope is the evidence, and resolving tenancy by
inference is how one organization's history is replayed under another's scope.
The underlying cause is **B-23**: the three closure contracts carry no
`organization_id`. Widening them is a versioned change to contracts MOVE and
MARKET consume, so it stays a recorded dependency, cited in the refusal reason
rather than worked around.

### Auditability, without a second source of truth

**No new table.** Two entries on entity `event_replay` keyed by `replay_id`:
`event_replay.started` (actor, time, mode, full scope) and
`event_replay.finished` (counts per outcome, plus up to 20 `failed_event_ids`).
Counts and identifiers only, never a payload — an event can describe a real
person's order, and the audit trail is read by more people than the database is.

A counters table was considered and rejected: audit already carries the truth, and
a table describing what replay did would become a competing account of what the
domain state is. Replay records its own activity and nothing about the domain.

### Operating surface: CLI, and no endpoint

`npm run replay -- --event-types … --limit 100`, dry-run by default, `--execute`
required to write — the dangerous form is the longer one to type. There is
deliberately **no replay endpoint on the ingress**: ingress is reachable by MARKET
and MOVE with service credentials, and a route there would let a producer replay
CORE's history. B-5 also means an HTTP surface has nowhere safe to be placed yet.
`REPLAY_TOKEN` comes from the environment, never argv, so it does not reach shell
history or a process list; it is authenticated and then checked for a new
`events.replay` permission granted to `platform_admin` **only** — asserted in a
test, because every service credential holds `events.submit` and reusing it would
have let MARKET and MOVE replay everything. Rate control is the lock plus the
bounded limit. Exit code 1 on any failure or early stop.

### Tests (63 new)

`tests/event-normalisation.test.ts` — 17. `tests/replay.test.ts` — 24 in memory,
46 with a database. On **real PostgreSQL**: the dry-run zero-mutation snapshot and
the read-only 25006 proof, the financial lifecycle with no double effect, the
cross-pool advisory lock, and failure/resume. Also covered: scope refusal and
limit bounds, replaying a `dead` row without erasing its attempt history, the
re-wrapped duplicate, unnormalisable and unsupported-version rows left untouched,
tenant unknown and tenant mismatch, receipt-order versus a skewed producer clock,
no lifecycle regression from a stale event, cursor paging with no repeats,
`continue-on-error` surveying every failure, lock release on an unexpected error,
the audit journal's contents and its absence of payloads, the authorisation
boundary, and the CLI parser's defaults and refusals.

### Regression

`tsc --noEmit` clean. `DATABASE_URL=… npm test` **551 passed / 33 files**
(baseline 488). Without a database **314 passed / 43 skipped** (baseline
273 / 41). Results agree between backends everywhere both run. One pre-existing
flake persists and is **not** new: `tests/migration-0011-lifecycle.test.ts` times
out in its teardown hook under full-suite contention and passes in isolation; its
assertions pass in both cases.

### Fixed on the way, because normalisation made them visible

- The `move.job.rejected` consumer accepted payloads missing `rejected_at`, which
  the published contract requires. Now refused at the edge.
- A `move.job.completed` payload in the notification tests carried a `reason` key
  the contract forbids. Removed; the contract is now enforced in code, so the
  fixture could not have kept it.
- `payment_authorization_id` had two spellings for one meaning (absent, and
  explicitly null). Normalised to one, so no consumer has to know both.
- The CLI shipped silently broken inside this cycle and was caught by trying it:
  its entry point was guarded on `process.argv[1]`, which the TypeScript runner
  replaces with its own path, so `npm run replay` printed nothing and exited 0.
  The guard is gone, the entry point is its own file (`main.ts`) whose only job is
  to run, `fail()` throws a `CliUsageError` instead of calling `process.exit`
  inside a parser, and the parser is exported and tested. Then the whole surface
  was exercised end to end against the real database with a real
  `platform_admin` session token: dry-run, `--execute`, a second `--execute`
  discovering nothing, one fulfillment created, and four journal entries naming
  the principal.

### External dependencies — none new, none solved

**B-24** untouched: no `claimed_at`, no `processing` status, no schema column, no
migration. Replay needed none of them, and adding one here would have pre-empted
a decision that needs its own cycle. **B-23** unchanged, and now cited by name at
the point where it costs something. **D-6**, **D-7**, **D-8** unchanged and not
circumvented from inside replay. No new blocker was found: the milestone needed
nothing CORE does not own, which is why it was chosen.

### Next task, and why it is this one

**B-24 — make a claim countable and an abandoned lease recoverable.** No
unblocked *milestone* remains: 1, 3, 4, 6 and 8 are CORE-complete, 2 and 5 wait on
MARKET, 7 waits on B-2/B-3, 9 waits on B-5/B-6. So the next task is the largest
CORE-only correctness gap, and after this cycle it is clearly B-24.

The argument is not that it is interesting; it is that this milestone made the
cost of it concrete. Replay exists to reach events the dispatcher cannot, and the
one category it still cannot see is work whose lease was abandoned mid-flight: the
outbox relay, the inbound dispatcher and the delivery worker all ride their lease
on `next_attempt_at`, which is also the retry-schedule field, so a row being
processed by a dead process is indistinguishable from a row waiting to be retried.
That is why lease expiry is uncountable in the metrics added last cycle, and it is
also why an operator cannot ask "what is stuck" — the question replay is most
often run to answer. Fixing it needs a `processing` status or a `claimed_at`
column on three eventing tables, a rollback path, and a decision about rows that
exist when the migration runs. It is a schema cycle with no external dependency,
it removes an invisibility rather than adding a feature, and it is what stands
between CORE and a staging rehearsal it could trust.

Not chosen: **B-14…B-19** and the multi-hold work need answers CORE does not own;
**B-23** is a versioned widening of three published contracts and belongs in a
contract cycle with MOVE and MARKET; a live channel adapter has no provider
credential and the port keeps it a one-file change; **milestone 9** is blocked on
B-5 and B-6. Contract expansion was also deliberately not chosen: adding event
types would widen the surface before the existing one is operationally trustworthy.

---

## Cycle 2026-09-12 (third) — the events CORE publishes are now self-sufficient

Chosen after reading the code rather than this file. The previous cycle nominated
B-24 as next, and B-24 is genuinely CORE-only; it was **not** taken, for a stated
reason: it is a schema cycle on three eventing tables with a decision about
pre-existing rows, and two defects were sitting in front of it that cost
consumers something today, needed no migration, and were provably CORE's alone to
fix. B-24 remains the next task and its argument from last cycle stands unaltered.

Baseline verified before any edit, because the instruction was not to trust this
document: `tsc --noEmit` clean, 551 tests passing on real PostgreSQL 18.4, all 13
migrations applied. The roadmap's claim of 551 was accurate. The audit also
confirmed that the lifecycle (coordinating → dispatched → completed/failed/
cancelled), the B-21 single-closure conditional writes, the B-11 shared unit of
work across money and state, hold verification at intake, `financialDisposition`
and the three reconciliation reads are all genuinely present and correct — the
gaps found were not in the lifecycle, they were in what the lifecycle *tells
anybody*.

### Defect 1 — a closure event that does not name its tenant (B-23)

CORE owns tenancy. It is the only system in WASLA that can state which
organization a fulfillment belongs to. And it was publishing dispatch and closure
events that named the fulfillment, the order, the job and the money, and not the
organization.

The visible cost was in notifications: `organizationScope()` reads
`organization_id` off the payload and `recipientsFor(type, organizationId)`
narrows by it, so a recipient scoped to a tenant for one of these types matched
nothing and would have notified nobody, for ever, silently. The previous cycle
handled that honestly but narrowly — `register` **refused** the registration with
HTTP 400 rather than storing something inert. A loud refusal beats quiet silence,
but the refusal was a symptom being managed, not the defect. The invisible cost
was larger: MARKET and MOVE could not route, filter or authorize a closure without
calling CORE back for a fact CORE already had.

Fixed by adding a **required** `organization_id` to `core.fulfillment.dispatched`,
`.completed` and `.cancelled` (`.created` already carried one). Three details
matter more than the field itself:

- The value is read from **the fulfillment row**, not from an earlier event or a
  service field. That is what makes the intake-refusal path correct: when a
  `market.order.created` names a hold that does not exist, the fulfillment is
  created and closed in one transaction and the *only* event ever published is
  the closure. A tenant sourced from a prior `created` event would have been
  absent exactly there. `tests/fulfillment-lifecycle-contract.test.ts` pins that
  path specifically, and pins a two-tenant interleaving that any cached or
  service-level tenant would pass the single-tenant tests and fail.
- `TENANT_SCOPED_EVENT_TYPES` was widened, and deliberately left **explicit**
  rather than derived from the schemas. The list asserts a property of each
  published payload; deriving it would start permitting a tenant scope the moment
  some unrelated event grew an `organization_id` for its own reasons.
- The registry's refusal is **kept**, unchanged, and still tested — against
  `core.payment.captured`, which names an authorization and a wallet and no
  organization. The guard was never wrong; only its example was.

### Defect 2 — the amount was reported for failure and withheld for success

`FulfillmentPaymentPort.captureWithin` was typed `Promise<unknown>`. `settle()`
called it, discarded the answer and published `captured_minor: null`. So
`core.fulfillment.completed` — the closure where money had certainly and finally
moved — was the only closure event carrying no figure, while
`core.fulfillment.cancelled` after a partial capture carried one. A consumer
reconciling CORE's events could see what was kept when work failed and not what
was charged when work succeeded.

The root cause was a type, not an oversight: `MoneyService.captureWithin` returns
a `LedgerTransaction`, and a transaction is **one capture leg**. The figure the
event needs is the authorization's running total. A hold of 6 000 part-captured
2 500 out of band and then closed by CORE for the 3 500 remainder has a last leg
of 3 500 and a total of 6 000 — publishing the leg would have been a true number
about the wrong thing, understating what the payer paid by 2 500.

So `MoneyService` gained `captureHoldWithin`, returning the `PaymentAuthorization`
and mirroring the existing `voidWithin`; `captureWithin` keeps its signature and
its behaviour, and both now share one private implementation, so no existing
caller changed. The fulfillment port method was retyped to
`captureHoldWithin(...): Promise<{ status, captured_minor }>` — the same shape the
release path already used, which is the point: the two closure paths now report
money the same way instead of one of them reporting nothing.

`settle()` derives the settlement state (`captured` when the hold is fully
captured, `partially_captured` otherwise) rather than hardcoding `captured`. Today
only the first branch is reachable, because `settle()` captures the whole
remaining hold; it is written as a derivation because a hardcoded `captured`
would silently misreport the day a partial-settlement policy exists (B-20).

`captured_minor` stays **optional** on both closure schemas. An order with no hold
completes without it, and absence means "CORE observed no amount" — turning that
into `0` would convert having nothing to say into a positive claim that nothing
moved. There is a test asserting exactly that it is absent, not zero.

### Verification

- 551 → **572** tests. New file `tests/fulfillment-lifecycle-contract.test.ts`
  (19 tests, both backends) plus a tenant fan-out test in `tests/notifications.test.ts`.
- The new tests validate emitted payloads against the **published JSON Schemas**
  read from `contracts/`, for required fields and for `additionalProperties`, so a
  payload and its contract can no longer drift apart by hand — which is how the
  `move.job.rejected` consumer came to accept a payload its own contract forbade
  last cycle.
- Falsifiability checked by mutation, not assumed: replacing the tenant spread in
  `closureEvent()` with `{}` fails **10** tests; reverting the settle path to
  `captured_minor: null` fails **6**. Both across both backends.
- Four tests that pinned the old behaviour were updated rather than deleted, and
  each carries a comment saying which guarantee replaced what it used to assert.

### Corrections to this repository's own documentation

`README.md` was materially wrong and is fixed. It claimed "Subscriptions,
reputation, notifications — **not implemented**" when subscriptions and
notifications are both implemented and tested, and it cited 100/155 tests against
an actual 326/572 and migrations `0001`–`0006` against an actual 13. Per-area test
counts have been removed from that table rather than corrected: they were wrong
within two cycles of being written, and the suite is the authority.
`docs/event-catalog.md`, `docs/settlement.md` and `docs/notifications.md` were
updated in the same push as the code they describe.

### External dependencies — one new, for the other repositories' agents

**New, and it needs action outside CORE.** `organization_id` is an additive field,
but a consumer validating `core.fulfillment.dispatched`, `.completed` or
`.cancelled` with `additionalProperties: false` against a copy of the schema taken
before this change **will now reject valid CORE events**. MOVE and MARKET should
refresh the three schemas from `contracts/events/`. No version bump was made: the
payloads remain v1, since a required addition that consumers must accept is
indistinguishable in effect from a compatible one for any consumer that does not
validate strictly, and bumping would have forced every consumer to migrate for a
field most of them will simply ignore. If either repository's agent judges a v2
necessary for its own validator, that is a contract conversation, not a CORE
decision to take alone.

Second, smaller: events **persisted before this commit** have no
`organization_id`. Replay and history readers must treat its absence as unknown
rather than as an error or as a tenantless event — on replay such events fan out
to platform-wide recipients only.

**B-24** untouched again: no `claimed_at`, no `processing` status, no migration.
**B-20** untouched and unchanged — this cycle reports the amount more honestly and
still refuses to decide what is owed. **D-6**, **D-7**, **D-8** unchanged.
**B-2…B-6** and **B-14…B-19** still need answers CORE does not own.

### Next task, and why it is still this one

**B-24 — make a claim countable and an abandoned lease recoverable.** Unchanged
from last cycle and now the largest remaining CORE-only correctness gap with
nothing in front of it. The lease for the outbox relay, the inbound dispatcher and
the delivery worker rides on `next_attempt_at`, which is also the retry-schedule
field, so a row held by a dead process is indistinguishable from a row waiting to
be retried: lease expiry is uncountable, and an operator cannot ask what is stuck.
It needs a `claimed_at` column or a `processing` status on `outbox`,
`inbound_event` and `event_delivery`, a rollback path, and a stated decision about
rows existing when the migration runs.

Not chosen next: **B-14…B-19** and **B-20** need owner decisions; **milestone 9**
is blocked on B-5/B-6; a live channel adapter has no provider credential and the
port keeps it a one-file change. Contract *expansion* is still deliberately not
chosen — this cycle completed two existing contracts rather than adding any new
event type, and the existing surface should be operationally trustworthy before it
grows.

## Cycle 2026-09-12 (eighth) — B-24, an abandoned claim is now a fact (CORE-only agent)

Scope: `src/platform/eventing/`, `db/migrations/0014_*`, `docs/`, tests. No MOVE,
no MARKET, no new module, no contract change to any published event.

### The defect, precisely

B-22 made every claim a write: `claimDue` pushes `next_attempt_at` out by a lease
so a second worker's identical query matches nothing. For the notification
dispatcher that was complete, because it also has a `claim_token` and a separate
`reclaimExpired`. For the other three queues — `outbox`, `inbound_event`,
`event_delivery` — the lease was stored in `next_attempt_at`, **which is also the
retry-schedule field**. One column, two meanings, and nothing on the row saying
which one applied.

Three consequences, none of them cosmetic:

1. `core_worker_outcomes_total{outcome="reclaimed"}` was unreportable for three of
   the four workers. A crash-looping worker and a badly-shaped payload produced
   *identical* metrics: claims that never became completions.
2. When a lease expired the row was silently re-served by the next `claimDue`, so
   the recovery was not an event anybody could count, alarm on, or find in a log.
3. Nobody could ask the two questions an operator actually asks — *what is a
   worker doing right now*, and *what is stuck*. Every pending row with a future
   timestamp looked the same.

### The fix, and the two designs that were rejected

Migration 0014 adds a nullable `claimed_at timestamptz` to the three tables. That
one column makes the overloaded one readable:

- `claimed_at IS NULL` → `next_attempt_at` is a **retry schedule**.
- `claimed_at IS NOT NULL` → `next_attempt_at` is a **lease expiry**.

- `claimDue` now writes `claimed_at` and matches only `claimed_at is null`, so an
  expired lease is no longer silently re-served. Both backends now return the
  **post-claim** rows; the in-memory double used to return the pre-claim ones,
  which is the sort of difference that certifies a bug (B-12).
- `reclaimExpired(now, limit = 100): Promise<number>` on all three ports, modelled
  on the notification store's: clears `claimed_at`, sets `next_attempt_at = now`
  (due immediately — the row has already waited out a whole lease) and records
  `last_error = 'abandoned claim reclaimed after attempt N'`.
- Every worker runs **recovery first, then claims**, so a recovered row is worked
  in the same tick and `result.reclaimed` is reported on
  `PublisherResult`, `DispatcherResult` and `DeliveryWorkerResult`.
- Every acknowledgement (`markPublished`, `markFailed`, `markDead`,
  `markProcessed`, `markDelivered`) clears `claimed_at`, and a check constraint
  per table (`claimed_at IS NULL OR status = 'pending'`) makes the database refuse
  the mistake even if a future writer forgets. Without it, one missed release
  would pin `in_flight` above zero for ever and make the new gauges useless.
- `counts()` gains `in_flight` (pending, claimed, lease live) and `abandoned`
  (pending, claimed, lease expired). Both are **subsets of `pending`**, like the
  existing `retrying` — cuts through the same rows, never additions to them. Both
  are cut at the injected clock (`iso(this.clock.now())` bound as `$1` on
  Postgres) so a fixed clock in a test moves the store and the worker together.
  `DepthSampler` already publishes every key from `counts()` as
  `core_queue_depth{queue,state}`, so both surface with **no new metric**.
- A partial index per table on `(next_attempt_at) WHERE status = 'pending' AND
  claimed_at IS NOT NULL`. Recovery runs on every tick; without it the cheapest
  thing a worker does on a healthy queue becomes a scan of everything it has ever
  published. The existing `*_due_idx` is untouched.

**Rejected: a `processing` status.** It reads well and is wrong here. Every
existing reader of these tables — `byStatus`, the replay selection, the depth
gauges, the readiness probe, MARKET's and MOVE's mental model — treats `pending`
as "not yet done". Moving claimed rows out of `pending` changes what all of them
mean, which is a contract change made in order to fix a metric.

**Rejected: a `claim_token`.** That is real fencing and it is worth doing, but it
needs a token threaded through every acknowledgement in six store
implementations and three workers, plus an answer to "what should a refused
acknowledgement do about the POST it already sent". Bigger, separately reviewable,
and not what B-24 asked for. Recorded as **B-26** rather than half-built.

### Existing rows, and how to deploy and roll this back

The roadmap required this be stated rather than assumed. Existing rows get
`NULL`, meaning "not held". That is safe even for rows a worker genuinely holds
while the migration runs: they keep their future `next_attempt_at`, so they stay
invisible to `claimDue` until the lease would have expired anyway, and are then
claimed exactly as they are today. No downtime, and the workers do not have to be
stopped. The one cost is that claims held across the migration are not *counted*
when they are taken over — a one-time undercount of `reclaimed`, not a lost row.

Rolling back is **not** symmetric and `0014_worker_claim_visibility.down.sql`
says so in the file: roll the **code** back first, then the migration. Code that
writes `claimed_at` against a schema without the column fails every claim, and
all three queues stop.

### A real backend divergence found on the way

`InMemoryDeliveryStore.markDelivered` stamped `delivered_at` from
`existing.next_attempt_at`. Before B-22 that was merely odd; after B-22 that field
is the lease, so the in-memory backend recorded every delivery as having happened
**one whole lease (30s) in the future**, while Postgres used the clock. B-12 again,
in a module that already had it. Fixed to `this.clock.now()` and asserted.
`InMemoryDeliveryStore` now **requires** a `Clock` rather than defaulting to one,
because a store reading a different clock than the worker polling it is exactly
how this class of bug survives.

`tests/outbound-delivery.test.ts` had the same fault in its harness: each backend
was opened with its own fresh `FixedClock`, so advancing the test clock moved the
app and left the store behind. Nothing read the clock inside a store until
`counts()` did, at which point rows were reported as in flight for ever. The
harness now passes the test's clock in, as the other suites already did.

### Tests — 10 new, and what each one would catch

- `tests/worker-claim-atomicity.test.ts`: the abandoned-claim test now asserts the
  full B-24 contract — `claimed_at` is set by the claim; `claimDue` refuses the
  row *even after the lease expires* (it is owed a recovery, not up for grabs);
  `reclaimExpired` returns 0 inside the lease and 1 after it; the recovered row is
  pending, unclaimed, due, and **still on attempt 0**. Plus a new test that every
  acknowledgement releases the claim, so a published/failed/dead row never looks
  held.
- `tests/observability.test.ts`: two rows, one acknowledged as a retry and one
  abandoned, are told apart — `retrying: 1, in_flight: 1, abandoned: 0` inside the
  lease and `retrying: 1, in_flight: 0, abandoned: 1` after it — the
  `core_queue_depth{state="abandoned"}` gauge appears, the relay reports
  `reclaimed` and publishes in the same pass, and the retrying row is untouched
  with its attempt still spent. The same for the inbound dispatcher.
- `tests/outbound-delivery.test.ts`: a delivery whose worker died is recovered and
  sent, with `reclaimed: 1`, one attempt rather than two, and `delivered_at` equal
  to the clock — which is the assertion that fails if the divergence above returns.
- `tests/db-schema.test.ts`: against the live database, the check constraint
  refuses `status = 'published'` while `claimed_at` is set (by constraint **name**,
  so the failure is attributable), accepts the release in the same statement, and
  all three lease indexes exist. A migration that has only been read is an
  unverified claim.

Falsified by mutation, both backends: making `reclaimExpired` a no-op fails 4
tests; restoring the in-memory `delivered_at` bug fails 1.

### Verification

`tsc --noEmit` clean. `DATABASE_URL=… npm test` → **582 passed / 34 files**
(was 572). Without a database → 330 passed / 45 skipped. Governance, contract,
migration and roadmap gates pass. Migration 0014 was **executed** against real
PostgreSQL 18.4, not merely written; `schema_migrations` now lists 14.

### Documentation

`docs/observability.md` — the B-24 blocker section is replaced by a resolution
that states the defect, the fix, both rejected designs, the deployment and the
rollback order; `in_flight` and `abandoned` are documented as derived subsets of
`pending` with a table of their derivations, and `abandoned` is named as the gauge
to alarm on. `docs/outbound-delivery.md` — a claim is a lease and a lease is not a
backoff. `docs/replay.md` — the "B-24 not touched" note now records that it is
resolved and that replay is unaffected, since replay selects by status and time
and never by lease.

### External dependencies — none new

This cycle changed no published contract, no event payload and no HTTP response
shape. `claimed_at` is internal to CORE's queue tables and is not exposed by any
endpoint. **MOVE and MARKET need do nothing.** The store *ports* changed
(`reclaimExpired` is new, `claimed_at` is on three record types), which matters
only to code inside this repository.

**B-25** and **B-26** are new and recorded above: the first is the honest cost of
not charging an attempt for an unobserved failure, the second is the fencing gap
`claimed_at` does not close. **B-20** untouched. **D-6**, **D-7**, **D-8**
unchanged. **B-2…B-6** and **B-14…B-19** still need answers CORE does not own.

### Next task

**B-25 — bound the reclaim loop.** It is now the only *unbounded* failure mode in
the queues and it was introduced, knowingly, by this cycle. A row whose worker
dies on it every time is reclaimed for ever and never dead-lettered, so the one
queue state that requires a human is the one state it can never reach. It is
CORE-only, it is small (one column or one decision about `attempts`, one migration,
one limit check per worker), and it is the natural completion of this cycle rather
than a new direction. It does need one operations answer — what a reasonable
reclaim limit is — which should be asked before the code is written, not after.

Not chosen next: **B-26** (fencing) is larger and is a change to the store ports;
it should follow B-25 rather than precede it, because a bounded reclaim loop makes
a refused acknowledgement a bounded problem too. **B-14…B-19** and **B-20** need
owner decisions. **Milestone 9** is still blocked on B-5/B-6. Contract expansion is
again deliberately not chosen: the existing surface should be operationally
trustworthy before it grows, and this cycle is what that means in practice.

## Cycle 2026-09-12 (ninth) — B-25, recovery is bounded (CORE-only agent)

Scope: `src/platform/eventing/`, `db/migrations/0015_*`, `docs/`, tests. No MOVE,
no MARKET, no new module, no contract change to any published event.

### The defect, precisely

The previous cycle resolved B-24 and, in the same breath, recorded the cost of how
it did so. `reclaimExpired` frees an abandoned claim without touching `attempts`,
because nobody observed the work fail and charging an attempt for an unobserved
outcome would let five rolling restarts dead-letter five perfectly healthy events
at `maxAttempts = 5`. That reasoning still holds. What it left behind does not:

1. Recovery had **no limit at all**. A payload that kills whichever worker touches
   it — an OOM on one oversized event, a hang on one malformed field — was claimed,
   killed, reclaimed on the next tick, claimed again, indefinitely.
2. The row never reached `dead`, so it never appeared in a dead-letter query and
   never triggered the one queue state that is defined as "a person must look".
3. `core_worker_outcomes_total{outcome="reclaimed"}` climbed steadily, which is
   *visible* but not *actionable*: the same signal is produced by a healthy queue
   during a deploy. Nothing separated "recovering" from "will never recover".

So the queue held work it would never finish, and said so in a counter that also
says everything is fine.

### The fix, and the two designs that were rejected

**Chosen: a second budget, with its own column.** Migration 0015 adds `reclaims
integer not null default 0` and a `*_reclaims_check (reclaims >= 0)` to `outbox`,
`inbound_event` and `event_delivery`. The port becomes `reclaimExpired(now,
maxReclaims, limit?)` and returns `{ reclaimed, dead }`. On Postgres it stays a
single statement per queue — `set reclaims = reclaims + 1`, `status = case when
reclaims + 1 > $3 then 'dead' else status end`, `next_attempt_at` left where it is
on the dead branch (matching `markDead`) and moved to now on the recovered branch,
two different `last_error` strings, `returning status` — so recovery cannot
interleave with itself and produce a row that was both freed and killed. The limit
is `DEFAULT_MAX_RECLAIMS = 3` in `src/platform/eventing/reclaim.ts`, passed as the
**last** constructor argument of each worker so no existing positional caller
moved.

The two counters are deliberately not the same counter:

| Counter | Incremented when | Bounds | Also drives |
| --- | --- | --- | --- |
| `attempts` | the work was tried and observed to fail | `maxAttempts` (5 / 5 / 8) | backoff, and the derived `retrying` state |
| `reclaims` | a claim was abandoned with nothing reported | `maxReclaims` (3) | nothing else |

**Rejected: increment `attempts` in `reclaimExpired`.** A two-word change, and the
first thing tried on paper. It is wrong twice over, and both are checkable rather
than aesthetic: the backoff is `baseBackoffMs * 2 ** attempts`, so a crash loop
would push a healthy row into exponentially long delays it never earned; and
`retrying` is derived as `pending and attempts > 0`, so a row nobody had ever tried
would be reported as retrying. Mutation-testing this design confirms it — charging
the attempt fails 4 tests, one of them a B-24 test that has nothing to do with this
cycle.

**Rejected: charge the attempt at claim time.** This is how the notification store
solves the identical problem with one counter: its `claimDue` does `attempts =
attempts + 1`, so its own `reclaimExpired(now, maxAttempts, limit)` is bounded for
free. It was left exactly as it is. Adopting it for the other three would change
what `attempts` means for them — which B-22 explicitly declined to do — and would
silently halve every effective retry limit in the system, since an attempt would be
spent on claiming rather than on failing.

### The exhausted row, and what it is called

A row that runs out of reclaims is dead-lettered, and the workers report it as
`failed_permanent` — not as a new outcome label, because the metric vocabulary
already has a word for "terminal, no worker will pick this up again", and adding a
label to `core_worker_outcomes_total` would break every existing dashboard query
that sums over outcomes. The distinction that *is* worth keeping is exposed on the
result object instead: `PublisherResult`, `DispatcherResult` and
`DeliveryWorkerResult` gained a `reclaim_exhausted` field, so a caller can tell an
exhausted recovery from an ordinary permanent failure without parsing
`last_error`. `last_error` records it too, in prose an operator can grep:
`reclaim limit exceeded: abandoned N times after attempt M`.

A dead `event_delivery` row keeps `last_status` and `delivered_at` null. Nothing was
ever sent to the subscriber, and the record must not imply one answered.

### Existing rows, and how to deploy and roll this back

Existing rows get `0`, so everything in flight when the migration runs starts with
a full budget; the deploy itself dead-letters nothing. The limit lives in the
workers, not in the schema, so it can be tuned without a migration. Rolling
**back** is code first, then `0015_worker_reclaim_budget.down.sql`, for the same
reason as 0014: code that writes `reclaims` against a schema without the column
fails every recovery, which stops all three queues. Rows already dead-lettered by
an exhausted budget stay dead — which is what B-27 below is about.

### Tests — 10 new, and what each one would catch

`tests/reclaim-budget.test.ts`, `describe.each(backends)` so all five cases run on
in-memory and on real Postgres:

1. **Outbox exhaustion.** Three abandonments recovered, the fourth dead-letters,
   `last_error` reads `reclaim limit exceeded`. Catches an off-by-one on the limit
   and an unbounded budget.
2. **The two budgets spend separately.** A real `markFailed` moves `attempts` and
   leaves `reclaims` alone; an abandonment does the reverse. This is the test that
   fails if anyone ever "simplifies" the design back to one counter.
3. **Inbound exhaustion is replayable.** The dead row appears in `byStatus("dead")`,
   which is what `docs/replay.md` promises an operator can act on.
4. **Delivery exhaustion invents nothing.** `last_status` and `delivered_at` stay
   null on the dead row.
5. **The worker reports it.** A real `OutboxPublisher` against a rejecting bus and a
   deliberately huge `maxAttempts`, abandoned once per round: `reclaimed` 1 per
   round then `reclaim_exhausted` 1, `dead` 0 throughout, and the exposition shows
   `reclaimed` 3 and `failed_permanent` 1. The final row is at `reclaims = 4`,
   `attempts = 3` — the two budgets advancing independently inside a live worker.

`tests/db-schema.test.ts` gained one case asserting the column is `not null`,
defaults to `0` and carries its check constraint **on the live database**, so a
migration that was written but never applied cannot pass. `MAX_RECLAIMS = 3` is
re-declared as a literal in the test files rather than imported, so changing the
default in `src/` fails the tests instead of moving them silently.

### Verification

`tsc --noEmit` clean. `DATABASE_URL=… npx vitest run`: **592 passed / 35 files**
(582 → 592). Without a database: 335 passed / 46 skipped. Governance, contract and
migration gates pass; 15 forward migrations, all with rollbacks. Falsifiable and
checked by mutation, each mutation restored and `tsc` re-run clean afterwards:
making the in-memory budget never exhaust fails 4 tests, raising the Postgres
threshold to 999 fails 3, and charging `attempts` on reclaim fails 4.

Sixteen existing `toEqual` assertions in `tests/outbound-delivery.test.ts` had to
gain `reclaim_exhausted: 0`. They are exact-shape assertions on the worker result,
which is why adding a field broke them — and why they are worth keeping exactly as
they are.

### Documentation

`docs/observability.md` — the paragraph stating that a reclaimed item is not
charged an attempt now explains the second budget, the exhaustion outcome and the
table separating the two counters; a new "B-25, resolved" section records the
defect, the fix, both rejected designs and the rollback order.
`docs/outbound-delivery.md` — the lease paragraph now ends at the dead letter
rather than at "the next drain sends it". `docs/replay.md` — records that a dead
inbound row now has two possible causes, that a reclaim-exhausted row has never
been processed at all so replaying it is a first attempt, and that `outbox` and
`event_delivery` have no revival path.

### External dependencies — none new

No published contract, no event payload and no HTTP response shape changed.
`reclaims` is internal to CORE's queue tables and is exposed by no endpoint.
**MOVE and MARKET need do nothing.** The store ports changed (`reclaimExpired` now
takes a limit and returns a shape), which matters only inside this repository.

**B-27** is new and recorded above. **B-26** unchanged and now next. **B-20**
untouched. **D-6**, **D-7**, **D-8** unchanged. **B-2…B-6** and **B-14…B-19** still
need answers CORE does not own.

### Next task

**B-26 — fencing tokens on the three eventing queues.** With recovery now bounded,
the remaining hole in the lease design is the one `claimed_at` cannot close: a
worker that stalls past its lease, is reclaimed, then wakes up and acknowledges
work that has since been re-served. The acknowledgement lands, and
`core_worker_outcomes_total{outcome="fenced"}` stays unreportable for three of the
four workers. The notification store already has the shape to copy. It is
CORE-only, and it is deliberately sequenced after B-25 because a refused
acknowledgement on a bounded queue is a bounded problem.

Not chosen next: **B-27** (reviving a dead `outbox` or `event_delivery` row) is the
honest follow-on to this cycle, but it needs an owner answer first — whether
reviving a dead outbox row re-publishes the original envelope or emits a fresh one
with a new `event_id` — and that answer changes the shape of the code, so it should
not be guessed. **B-14…B-19** and **B-20** need owner decisions. **Milestone 9** is
still blocked on B-5/B-6.

## Cycle 2026-09-12 (tenth) — B-26, a claim is exclusive for as long as it is held (CORE-only agent)

Reviewed the working tree at `0edb7af` before planning anything: 592 tests over 35
files pass with `DATABASE_URL` set, 335 pass and 46 skip without one, `tsc --noEmit`
is clean, all four gates pass and all 15 migrations are applied to a real
PostgreSQL 18.4. The state matched what the previous cycle claimed, so B-26 — the
blocker that cycle's own B-24 work had recorded — was the next honest piece of work.

### The defect, stated precisely

Three cycles have now been spent on claiming, and each fixed a different property of
the same instant:

| Blocker | What it made true |
| --- | --- |
| B-22 | claiming is a write, so two workers cannot claim the same row |
| B-24 | a held claim is visible, so an abandoned one can be found and counted |
| B-25 | recovery is bounded, so an abandoned claim cannot be recovered for ever |

None of them said anything about the interval **after** the claim. The sequence that
still misbehaved:

1. worker A claims row R, lease 30s, and stalls — a GC pause, a blocked syscall, a
   subscriber that takes 40 seconds to answer a POST;
2. the lease expires; `reclaimExpired` frees R; worker B claims it and finishes it;
3. A wakes up and calls `markPublished` / `markProcessed` / `markDelivered`. Its
   statement is `update … where event_id = $1`. It names the row. It applies.

The row now records A's outcome: A's status, A's `last_error`, and for a delivery a
`last_status` from a response B never received. Two attempts happened and the row
describes the abandoned one. The most damaging variant is a stale **success** on
`inbound_event` — an event marked `processed` whose live attempt actually failed will
never be dispatched again, and nothing anywhere reports a failure.

This was not a hypothesis about the schema. `core_worker_outcomes_total` has had a
`fenced` outcome in its catalogue since Milestone 8, described in
`docs/observability.md` as "an acknowledgement refused because the claim token was
stale". For three of the four workers that counter could only ever be zero, because
their tables had no token to match on. The metric existed; the mechanism did not.

### The fix

`claim_token text` on `outbox`, `inbound_event` and `event_delivery` (migration
0016) — deliberately the same shape `notification` has had since 0012, since this is
the same concept and `PgNotificationStore` already proved the pattern works.

- `src/platform/eventing/fencing.ts` — `newClaimToken()` (a v4 UUID from
  `node:crypto`), `isFenced(rowToken, fence)`, `UNFENCED` for a caller that holds no
  claim, and `FencedError` for the one case where returning `false` is not enough.
- `claimDue` generates **one** token per call and stamps it on every row in the
  batch, in the statement that already writes the lease. A batch is claimed and
  abandoned as a unit, so a token per row would cost a statement per row and refuse
  nothing extra.
- All nine acknowledgements across six store implementations take the fence as their
  second argument and return `Promise<boolean>`; `false` means refused. Postgres does
  it in the same statement — `where event_id = $1 and ($2::text is null or
  claim_token = $2) returning event_id`, then `rows.length === 1` — so there is no
  read-then-write race in the fence itself.
- Recovery clears the token, and so does every acknowledgement: a claim that has
  ended leaves no token behind that a later write could match.
- `OutboxPublisher`, `InboundDispatcher` and `DeliveryWorker` each report a `fenced`
  count on their result and emit `core_worker_outcomes_total{outcome="fenced"}`. No
  catalogue change was needed — the outcome was already defined.

**The relay is the one transactional case.** `markPublished` runs inside the same
transaction that queues the fan-out deliveries; that dual-write is the entire reason
the outbox exists. Returning `false` there is not sufficient, because the delivery
rows are already written in that scope, so a refused `markPublished` throws
`FencedError` and the transaction rolls back with them. The catch block checks for
`FencedError` **first**, before the attempts arithmetic, and `continue`s: a fence is
not a failed publish, and charging an attempt would impose a backoff on a row whose
only problem is a worker slower than its lease — and could eventually dead-letter an
event the current claim holder is publishing successfully.

**Replay is the only unfenced caller**, and passes `UNFENCED` explicitly with a
comment saying why. An operator advancing a `dead` inbound event was never a worker
and never held a claim; a fence that applied to every caller would have broken the
only recovery path this queue has. `UNFENCED` is a named constant rather than a bare
`null` so that every unfenced acknowledgement in CORE is findable in one search.

### What was rejected, and why

- **`uuid` instead of `text`.** Four bytes a row cheaper and self-validating, but
  `notification.claim_token` is `text`; one type for one concept across four queues
  is worth more than the bytes.
- **`default gen_random_uuid()` in the schema.** Puts token generation outside the
  in-memory backend's reach and makes the two backends disagree about what a claim
  returns — B-12, the divergence this repository keeps paying for.
- **The strong constraint, "every claimed row carries a token."** It reads better and
  it is false: rows already claimed when the migration runs have `claimed_at` and no
  token, and backfilling one would fence out a worker still doing real work. The
  constraint shipped is the weak direction only — a token implies a claim.
- **Fencing replay too.** Rejected above.
- **Treating a refusal as a failure.** Rejected above for the relay; the same
  reasoning applies to the other two workers, which count it and move on.

### What this does not fix

It does not prevent the duplicate side effect. If the stalled worker already
published to the bus or POSTed to a subscriber, that happened. Delivery is
at-least-once and stays at-least-once; subscribers still deduplicate on `event_id`.
What the fence protects is the **record**: status, error, response code and
timestamps stay those of the attempt that actually completed. Saying otherwise in the
docs would be a false guarantee, so `docs/outbound-delivery.md` now states the limit
next to the at-least-once paragraph it qualifies.

Operationally, a persistently non-zero `fenced` is a tuning signal rather than a bug
report: it means workers routinely take longer than their lease, so the lease is too
short or the work too slow. For the delivery worker it usually means `timeoutMs` is
close to or above `LEASE_MS`.

### A defect found in the migration runner contract

The first version of `0016_worker_claim_fencing.sql` applied cleanly and then broke
`tests/migration-0011-lifecycle.test.ts`, which runs `down` and `up` again. The
runner does not record migrations — `scripts/db-migrate.mjs` says so in its header
comment, and each migration is expected to insert its own `schema_migrations` row.
0016 was missing that insert, and its `.down.sql` was missing the matching delete, so
`up` re-ran it for ever and failed on the second `ADD COLUMN`. Both are now present.
Beyond that, every statement in the forward migration was made re-runnable — `ADD
COLUMN IF NOT EXISTS`, and a `DROP CONSTRAINT IF EXISTS` before each `ADD
CONSTRAINT`, since Postgres has no `ADD CONSTRAINT IF NOT EXISTS`. A migration that
records itself should never run twice, but one that cannot survive running twice
turns any interrupted deploy into a manual repair before the next deploy can
proceed — which is exactly the state this cycle had to clean up by hand.

### Verification

`tests/claim-fencing.test.ts` adds 14 tests (7 cases across both backends): a stale
acknowledgement is refused on each of the three queues; the token is cleared whenever
a claim ends; the dispatcher reports `fenced` and the exposition shows
`core_worker_outcomes_total{worker="inbound_dispatcher",outcome="fenced"} 1`; a fenced
relay rolls its fan-out delivery rows back; and `UNFENCED` still applies. The stall is
simulated rather than asserted about — the publish callback advances the injected
clock past the lease and runs recovery, so the reclaim genuinely happens before the
acknowledgement.

`tests/db-schema.test.ts` asserts against the **live** schema: the column exists on
all three tables, is nullable, has no default, and the `*_claim_token_check`
constraint has the expected definition; then it inserts an `outbox` row and shows
that setting a token without `claimed_at` is actually rejected with
`constraint === "outbox_claim_token_check"` while setting both succeeds.

608 tests over 36 files pass with `DATABASE_URL`; 342 pass and 47 skip without one;
`tsc --noEmit` clean; governance, contract, migration and roadmap gates pass; 0016
was applied, rolled back and re-applied against real PostgreSQL 18.4. Three mutations
confirm the tests can fail: `isFenced` always returning false fails 5 tests, dropping
the fence predicate from the Postgres `markPublished` fails 2, and leaving the token
in place during in-memory recovery fails 2. Each was restored and `tsc` re-run clean.

### What CORE still needs from elsewhere

Nothing new. **B-27** remains the honest next piece of work inside CORE and is still
blocked on one owner answer: does reviving a dead `outbox` row re-publish the original
envelope unchanged, or emit a fresh one with a new `event_id`? That answer changes the
shape of the code, so it should not be guessed. B-25 and now B-26 both make it matter
more: there are more ways to reach `dead`, and the rows that get there are still
unreachable. **B-14…B-19** and **B-20** need owner decisions. **Milestone 9** is still
blocked on B-5/B-6. No MOVE or MARKET code was read or written in this cycle.
