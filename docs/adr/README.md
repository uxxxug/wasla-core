# Architecture Decision Records

ADRs 0001–0020 were accepted before implementation started. They are binding
constraints, not suggestions. This file records how each one is enforced in
this repository — the ADR text itself is maintained as the project's decision
record and is not restated here.

| ADR | Decision | Enforcement in this repository | State |
|---|---|---|---|
| 0001 | Three permanently independent repositories | No shared runtime package; contracts are published as files, not imported code | enforced |
| 0002 | CORE ownership boundary | `scripts/check-governance.mjs` rejects MOVE/MARKET tables; `tests/governance.test.ts` rejects their entities in code | enforced |
| 0003 | CORE is the source of truth for identity | `src/modules/identity-access` + `db/migrations/0001` | implemented (migration not yet executed) |
| 0004 | Organization = Tenant, flat | `src/modules/organization` — no hierarchy column | implemented |
| 0005 | Money owned entirely by CORE | Wallet, authorization and balanced append-only ledger module plus migration 0002 | implemented (migration not yet executed) |
| 0006 | Commercial Order / Fulfillment / Operational Job separation | Fulfillment stores opaque order/job references and communicates by versioned events | implemented on local bus |
| 0007 | No direct MOVE ↔ MARKET business communication | Governance gate; no MOVE/MARKET client exists in CORE | enforced |
| 0008 | Closed list of synchronous paths | Only `/v1/access/check`, `/v1/sessions/current` exposed so far | enforced |
| 0009 | Event backbone with outbox/inbox | `src/platform/eventing/*`, 12 passing tests | implemented |
| 0010 | CORE degradation rules | not yet implemented | pending |
| 0011 | Database ownership | `db/migrations/0001` contains CORE tables only; identifier types are recorded in `docs/identifiers.md` and asserted by `src/platform/ids.ts` | enforced |
| 0012 | Pricing / regulatory | not implemented — regulatory policy is an open blocker | blocked |
| 0013 | Subscription / entitlement in CORE | not yet implemented | pending |
| 0014 | Party profile folded onto Identity | `identity.display_name` only; no separate profile table | implemented |
| 0015 | Reputation in CORE, review content in MARKET | not yet implemented | pending |
| 0016 | Channel architecture, Telegram is a channel | `channel_type` on identity links and sessions; Telegram is never the identity | implemented |
| 0017 | CORE internal modularity | Module-boundary test rejects internal cross-imports | enforced |
| 0018 | God-service prevention | Governance gate + no proxy endpoints | enforced |
| 0019 | Deployment independence | Own CI, own manifests, no shared build | implemented |
| 0020 | Pre-implementation gate | Passed for foundation scope only | partial |

Any new synchronous path between systems, or any change to an ownership
boundary, requires a new ADR before the code is written.
