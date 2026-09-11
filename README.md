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
| HTTP surface with correlation ids, canonical errors, structured logs, health/readiness | implemented, 8 tests |
| Append-only audit trail with metadata scrubbing | implemented |
| Executable architecture governance | implemented, 4 tests |
| Wallet, balanced append-only ledger, payment authorization/capture/expiry | implemented in memory, 9 tests; schema authored, not executed |
| Fulfillment coordination via MARKET/MOVE events | implemented on local bus, 18 tests; production transport unproven |
| Execution/money consistency: `settlement_state`, hold verification at intake, reconciliation read | implemented, covered by the fulfillment settlement tests |
| Subscriptions, reputation, notifications | **not implemented** |

71 tests pass locally across 11 files, and the same gates run in CI on the
working remote.

Persistence today is the in-memory reference implementation of each repository
port. The Postgres schema is authored across
`db/migrations/0001_core_foundation.sql` through
`0005_fulfillment_settlement_state.sql`, each with a rollback, but **none has
been executed against any database** — no CORE database has been provisioned
yet, so the schema-level guarantees (including the settlement alignment check)
are unverified. See `ROADMAP.md`, blocker B-1.

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
