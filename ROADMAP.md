# WASLA CORE — Roadmap

**Last updated:** 2026-09-11
**Last milestone:** Foundation cycle — eventing, identity/access, organization, governance gates, CI.
**Verification at this commit:** `tsc --noEmit` clean; `vitest run` 32/32 passing; governance and contract gates passing.

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

## In progress

Nothing is in flight at this commit.

## Remaining, in dependency order

1. Postgres adapters for the identity and organization ports; run migration
   0001 against a provisioned database.
2. Geography reference module.
3. Money: payments, wallet, immutable ledger, settlement (ADR 0005).
4. Subscriptions, plans, periods, entitlements, usage (ADR 0013).
5. Channels and notifications; Telegram adapter.
6. Fulfillment coordination: `core.fulfillment.created`, `core.fulfillment.completed`,
   consumption of `market.order.created` and `move.job.completed` (ADR 0006).
7. Real cross-system contracts with MOVE and MARKET.
8. End-to-end vertical slice: identity → commercial order → fulfillment →
   operational job → execution → completion → commercial reaction.
9. Event normalisation and historical replay tooling.
10. Migration and reconciliation tooling; dry runs.
11. Security hardening pass and observability export.
12. Staging readiness, cutover and rollback rehearsal.

## Migrated

Nothing. No data has been migrated from any system. No legacy component has
been retired.

## Retired

Nothing.

## Blockers

| # | Blocker | Impact | What unblocks it |
|---|---|---|---|
| B-1 | No CORE database provisioned; no connection credentials | Migration 0001 is authored but unexecuted; persistence runs on in-memory reference adapters | A database instance and credentials supplied through the environment, never committed |
| B-2 | Production data inventory unknown for Ceezr and Wasla | Identity, money and order migrations cannot be planned against real volumes or duplicates | Read access to production, or an exported inventory (row counts, duplicate profile) |
| B-3 | Duplicate-identity merge policy undecided | Detection tooling can be built; no merge may execute | An owner decision on canonical selection and conflict rules |
| B-4 | Regulatory pricing policy undecided (ADR 0012) | Pricing engine can be built rule-driven, but no rates may be fixed | A legal/regulatory decision |
| B-5 | Deployment target and topology not chosen | Manifests stay vendor-neutral; no environment is provisioned | An infrastructure decision |
| B-6 | No production release approval | No production deployment will be attempted | Explicit owner approval |
| B-7 | GitHub Actions is blocked on the `noor-seez` account | The CI workflow in this repository cannot run: every job fails at start with "recent account payments have failed or your spending limit needs to be increased". The same block affects the MOVE repository. All gates are therefore verified locally only | Resolve GitHub billing for the account, then re-run the workflow |

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

32 of 32.

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
- Governance (4): no MOVE/MARKET entities, no hardcoded secrets, no
  cross-module internal imports, no TODO markers.

## Not proven yet

- Behaviour against a real Postgres database (migration 0001 unexecuted).
- Behaviour under a real message broker (the bus is in-process today).
- Any production or staging deployment.
- Any data migration, reconciliation or cutover.
- Performance and load characteristics.
