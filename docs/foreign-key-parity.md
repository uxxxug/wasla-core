# Foreign keys, and where they are enforced

The schema declares **30 foreign keys**. Before the cycle that added
`tests/fk-parity.test.ts`, exactly **one** of them was restated anywhere in
`src/`: `usage_record_period_id_fkey`, and only as a side effect of the
period-window trigger needing to read the parent row.

The other 29 were enforced by Postgres alone. That is the defect B-12 names,
in its third family: a dual-backend test suite could store a fulfillment
belonging to no tenant, a membership for no principal, a session for a
principal nobody created, a notification addressed to a recipient row that was
never inserted, or a webhook delivery of an envelope the outbox never
recorded — and pass on the reference half. A green in-memory run then
certified rows production refuses.

This document is the inventory. The enforcement lives in
`src/platform/persistence/reference-keys.ts`; the measurement lives in
`tests/fk-parity.test.ts`.

## How the reference backend now enforces them

`FOREIGN_KEYS` declares one `ForeignKeyRule` per referencing column: the
constraint name, the child column, the parent table, and whether the column is
nullable. `putRow` — already the single write path for every row table —
calls `assertReferences` before storing, and the refusal is worded exactly as
Postgres words it:

```
insert or update on table "membership" violates foreign key constraint "membership_organization_id_fkey"
```

That wording matters beyond tidiness. A test that asserts on the message, and
an operator reading a stack trace, must not be able to tell which backend
produced it; otherwise the reference backend is a different system that merely
passes the same tests.

Nullability is part of the declaration because `MATCH SIMPLE` — Postgres's
default, and what every key here uses — treats a null reference as satisfying
the key. Six columns are nullable, and each means something specific by it:

| Column | What null means |
| --- | --- |
| `identity.canonical_identity_id` | this identity has not been merged into another |
| `ledger_transaction.authorization_id` | a credit, which moves money with no hold behind it |
| `fulfillment.payment_authorization_id` | work with no hold taken against it |
| `subscription_period.authorization_id` | a period that has not been settled |
| `notification.organization_id` | a platform-level message, not a tenant's |
| `notification_recipient.organization_id` | a platform-wide recipient: an operator, not a tenant's person |

The test reads the catalog and fails if any of these flags stops matching the
live column, so a migration that drops or adds a `NOT NULL` cannot silently
change which rows the reference backend accepts.

### How the parent rows are found

A rule has to be able to ask "does this parent exist?", and the parents live in
nine separate stores. Four designs were considered and the reasons are recorded
in the header of `reference-keys.ts`. The one chosen: a single `ReferenceKeys`
registry per persistence bundle, to which each store hands the live `Map` it
already owns. No row is copied and no second source of truth is created — the
registry reads the same map the store writes, so a key can never be evaluated
against a stale shadow of the parent table.

### The one weakening, named

If no registry is attached, or a parent table has no registered source, the
rule is **not evaluable and the write is accepted**. This is a fail-open path
and it is the only one. It exists because a store constructed on its own,
outside a bundle, has no way to see the other stores' rows, and refusing every
reference in that case would break direct-construction tests that are not
about references at all.

Fail-open weakenings are how enforcement quietly disappears, so this one is
measured rather than trusted. `foreign key parity coverage > resolves every
parent table a rule reads` asserts that the bundle the application actually
builds has `unresolvedParents() === []`. If a new store forgets to `attach`,
that test fails — it does not merely stop refusing orphans.

## The inventory

29 keys are probed by a behavioural case on both backends. One is exempt, with
its reason recorded in code.

| # | Child | Constraint | Parent | Null? |
| --- | --- | --- | --- | --- |
| 1 | `region` | `region_country_code_fkey` | `country` | no |
| 2 | `city` | `city_country_code_fkey` | `country` | no |
| 3 | `city` | `city_region_id_fkey` | `region` | no |
| 4 | `service_area` | `service_area_city_id_fkey` | `city` | no |
| 5 | `service_area` | `service_area_country_code_fkey` | `country` | no |
| 6 | `identity` | `identity_canonical_identity_id_fkey` | `identity` | yes |
| 7 | `identity_link` | `identity_link_identity_id_fkey` | `identity` | no |
| 8 | `principal` | `principal_identity_id_fkey` | `identity` | no |
| 9 | `session` | `session_principal_id_fkey` | `principal` | no |
| 10 | `membership` | `membership_organization_id_fkey` | `organization` | no |
| 11 | `membership` | `membership_principal_id_fkey` | `principal` | no |
| 12 | `payment_authorization` | `payment_authorization_wallet_id_fkey` | `wallet` | no |
| 13 | `ledger_transaction` | `ledger_transaction_authorization_id_fkey` | `payment_authorization` | yes |
| 14 | `fulfillment` | `fulfillment_organization_id_fkey` | `organization` | no |
| 15 | `fulfillment` | `fulfillment_payment_authorization_id_fkey` | `payment_authorization` | yes |
| 16 | `event_delivery` | `event_delivery_event_id_fkey` | `outbox` | no |
| 17 | `event_delivery` | `event_delivery_subscription_id_fkey` | `event_subscription` | no |
| 18 | `notification_recipient` | `notification_recipient_identity_id_fkey` | `identity` | no |
| 19 | `notification_recipient` | `notification_recipient_organization_id_fkey` | `organization` | yes |
| 20 | `notification` | `notification_event_id_fkey` | `outbox` | no |
| 21 | `notification` | `notification_organization_id_fkey` | `organization` | yes |
| 22 | `notification` | `notification_recipient_id_fkey` | `notification_recipient` | no |
| 23 | `plan_grant` | `plan_grant_plan_id_fkey` | `plan` (ON DELETE CASCADE) | no |
| 24 | `subscription` | `subscription_plan_id_fkey` | `plan` | no |
| 25 | `subscription` | `subscription_wallet_id_fkey` | `wallet` | no |
| 26 | `subscription_period` | `subscription_period_subscription_id_fkey` | `subscription` | no |
| 27 | `subscription_period` | `subscription_period_authorization_id_fkey` | `payment_authorization` | yes |
| 28 | `usage_record` | `usage_record_period_id_fkey` | `subscription_period` | no |
| 29 | `reputation_signal` | `reputation_signal_organization_id_fkey` | `organization` | no |
| — | `ledger_entry` | `ledger_entry_transaction_id_fkey` | `ledger_transaction` | **exempt** |

### The exemption

`ledger_entry_transaction_id_fkey` has no rule and no case. Entries are not a
row table of their own in the reference backend: `insertTransaction` takes the
header with its entries nested inside it, so there is no `ledger_entry` map to
declare a rule against, and no entry a caller could point at a different
transaction. The key stays enforced by Postgres. The reference direction a
caller *can* express — a transaction naming a hold that does not exist — is
covered by case 13.

The exemption is a named entry in `UNPROBEABLE` with that reason, and the
coverage gate treats that list, and only that list, as an excuse: a key added
by a future migration with neither a case nor a recorded reason fails the
build.

## Two findings this cycle recorded

**1. The keys were absent, not partly present.** The gap was not "some keys are
weaker in memory". Twenty-nine of thirty did not exist in the reference
backend at all.

**2. Three tables were not writing through `putRow`.** The previous cycle
recorded that `putRow` is the single write path for every row table. Re-reading
the code found that `session`, `plan_grant` and `usage_record` bypassed it, so
the claim held for 25 of 28 tables, not all of them. Two consequences: the
check constraints those three tables have were restated inline instead of
declared in `ROW_RULES` — five duplicated rules — and, once `putRow` became the
place foreign keys are checked, those three tables would have been skipped
silently. All three now go through `putRow`, their CHECKs are declared in
`ROW_RULES`, and the earlier claim is corrected here by addition rather than by
editing the earlier record.

**3. A stale comment.** `seedOrganization` in `tests/support/rows.ts` is
commented "an organization with a country behind it, which its foreign key
requires". `organization` has **no** foreign key to `country` — the catalog
lists none. The fixture seeding a country is harmless, and the comment is
wrong. Noted here rather than silently deleted, because the fixture is used by
many suites and the comment records what its author believed.

## What the measurement caught

The first full run after `assertReferences` went live produced **29 failures**
across six memory-only suites, every one of them
`fulfillment_organization_id_fkey` or `membership_organization_id_fkey`. The
fixtures had never created the tenant they were writing into. Those suites had
been passing against a store that did not care.

That is precisely the defect, demonstrated: the tests were asserting behaviour
on rows production would have refused. The fix was in the fixtures — a
`seedTenant` helper and a `coreWithTenants` app builder — not in the rule. No
key was relaxed, no test was skipped, and no refusal was downgraded to make the
suite green.

## What this does not cover

- `ON DELETE` behaviour. Only `plan_grant_plan_id_fkey` has a non-default
  action (`CASCADE`); nothing here probes what a delete does, and the reference
  backend does not model cascades. A delete-behaviour parity cycle is a
  separate item.
- Deferred reference checks. Every key here is immediate in Postgres, which is
  why the probes can assert refusal at the write. If a future migration adds a
  `DEFERRABLE` key, this file's assumption stops holding and the case for it
  must assert at commit instead.
- The 12 triggers. Trigger-invariant parity is the next family in B-12 and is
  not touched here.
