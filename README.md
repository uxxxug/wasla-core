# WASLA CORE

Shared operating layer for the WASLA system. Independent repository,
independent build, independent database, independent release.

```
MARKET creates the work.  MOVE executes the work.  CORE coordinates it.
```

CORE is **not** a gateway, not an API proxy, not a shared library, not a shared
database. It owns the capabilities that both products need and must not
duplicate: identity and access, organizations, money, subscriptions,
reputation, channels, notifications, the event backbone and fulfillment
coordination.

## Related repositories

| System | Repository | Owns |
|---|---|---|
| WASLA MOVE | `noor-seez/ceezr` | drivers, vehicles, operational jobs, rides, delivery execution, dispatch, tracking, POD |
| WASLA MARKET | `skyosv10-art/wasla` | merchants, stores, products, inventory, commercial orders, search |

The three repositories are permanently separate. No monorepo, no shared runtime
package, no cross-database access.

## What runs today

| Area | State |
|---|---|
| Event envelope, outbox, relay with backoff and DLQ, consumer inbox, idempotent handlers | implemented, 12 tests |
| Identity, identity links, principals, sessions, memberships, roles, permissions | implemented, 8 tests |
| Organizations / tenancy | implemented |
| Postgres adapters for every repository port, with a real transaction boundary | implemented, 48 conformance assertions |
| HTTP surface with correlation ids, canonical errors, structured logs, health/readiness | implemented, 8 tests |
| Append-only audit trail with metadata scrubbing | implemented |
| Executable architecture governance | implemented, 4 tests |
| Wallet, balanced append-only ledger, payment authorization/capture/expiry | implemented, running on Postgres |
| Fulfillment coordination via MARKET/MOVE events | implemented on local bus; production transport unproven |
| Execution/money consistency: `settlement_state`, hold verification at intake, reconciliation read | implemented, covered by the fulfillment settlement tests |
| Subscriptions: periods, collection, past-due, renewal sweep, cancellation, expiry | implemented |
| Notifications: recipients, tenant-scoped fan-out, rendering, dispatcher with leases | implemented; provider delivery confirmation missing (D-8) |
| Reputation: append-only signals, exactly-once ingestion, retraction marker, standing derived on every read | implemented; no producer publishes `market.review.*` yet, and weighting/decay/thresholds are undecided (B-31…B-34) |

**385 tests** pass in the dependency-free default run, and the same gates run in
CI on the working remote. With `DATABASE_URL` set that becomes **687**, because
the database-backed files stop being skipped and the dual-backend suites run
their Postgres half.

Per-area test counts used to be listed in the table above and were wrong within
two cycles of being written, so they are no longer kept there — the suite is the
authority, and `ROADMAP.md` records the verified figure per cycle.

Persistence is real. Every repository port — identity, organization,
geography, money, fulfillment — has a Postgres adapter, as do the outbox, the
inbox and the audit trail, behind a `BEGIN`/`COMMIT`/`ROLLBACK` transaction
boundary. `createCoreApp({ persistence })` selects the backend as one bundle,
never a mix, and `/ready` reports which one is wired.

Two test files are worth knowing about:

- `tests/pg-adapters.test.ts` runs the **same** assertions against the
  in-memory and the Postgres adapters. Running both is what proves they are
  substitutable; testing only Postgres would prove the SQL parses.
- `tests/vertical-slice-postgres.test.ts` runs the whole
  MARKET → CORE → MOVE → CORE → MARKET flow, money capture included, against a
  real database — so foreign keys, check constraints and the deferred ledger
  balance trigger all get a chance to refuse what a `Map` would have accepted.

All **13** migrations are applied and verified on real instances (managed 17.6 and
local 18.4) with the full rollback chain exercised.

### Working against a database

```bash
export DATABASE_URL=postgres://user:pass@host:5432/db   # never committed
npm run db:status
npm run db:up
npx vitest run              # every skipped file now runs
```

`pg` is a devDependency and stays one: `src/` imports only its *types*. The
composition root receives a pool from the caller, so the application has no
runtime dependency and never reads a connection string itself.

## Development

```bash
npm ci              # a lockfile is committed, so installs are reproducible
npm run typecheck
npm test
npm run verify      # typecheck + tests + governance + contracts
npm run check:migrations
npm run check:roadmap
```

## Layout

```
src/platform/       eventing, audit, http, ids, errors, clock
src/modules/        one folder per bounded module; only service.ts, domain.ts and
                    http.ts are importable from outside the module
contracts/openapi/  API contract (source of truth for the HTTP surface)
contracts/events/   JSON Schema per event type, plus the shared envelope
db/migrations/      forward and rollback SQL
docs/               ownership, event catalog, ADR enforcement
scripts/            governance, contract and roadmap gates run in CI
```

## Rules that CI enforces

- No MOVE- or MARKET-owned entity or table in CORE.
- No module reaching into another module's internals.
- No committed secrets.
- Every emitted event type has a published schema and a catalog entry.
- `ROADMAP.md` is updated in the same push as any implementation change.
