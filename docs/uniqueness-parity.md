# Uniqueness parity

Two backends implement every persistence port: the reference stores in `src/`
and the Postgres adapters. Tests run against both. That is only worth something
if a write the database would refuse is also refused in memory — otherwise a
green reference-store suite certifies a bug instead of catching it, which is the
failure B-12 names.

This file records how uniqueness parity is measured, what it currently covers,
and the one place where the two backends legitimately differ.

## What the schema declares

The live schema declares 24 uniqueness rules of three kinds:

- 21 `UNIQUE` constraints,
- one `EXCLUDE USING gist` — `subscription_period_no_overlap`, which is a
  uniqueness rule over ranges rather than values,
- three partial unique indexes — `identity_legacy_idx`,
  `organization_legacy_idx`, `subscription_period_authorization_unique` — which
  are constraints in effect but not `pg_constraint` rows, so any inventory that
  reads only `pg_constraint` misses them.

## The gate

`tests/uniqueness-parity.test.ts` holds one case per rule. A case states the
rule name, what a violation would mean in business terms, and a probe that
seeds a legitimate row and then attempts the row that must be refused. Each
case runs on both backends. A case asserts two things:

1. the write is refused, and
2. the refusal **names the schema rule**, so the reader can check the two
   backends refuse for the same reason rather than coincidentally.

Naming matters because "already exists" is not evidence: it does not say which
rule fired, and it lets a rule be renamed, widened, or dropped in a migration
without a single test noticing.

The same file also reads `pg_constraint` and `pg_indexes` at run time and fails
if the schema declares a uniqueness rule that has no parity case. That is the
part that keeps this file honest as the schema grows: a migration adding a
`UNIQUE` cannot ship without a case, and it cannot ship with a case that only
passes on Postgres.

Two rules are matched by alias rather than by exact name, because Postgres
truncates identifiers at 63 characters and the generated name for the
notification recipient tuple is cut mid-word.

## Refusal shapes

Not every refusal is an exception, and the difference is deliberate:

- Most writes **throw**, quoting the constraint the way Postgres does.
- `EventDeliveryStore.queue` and `NotificationStore.queue` **return `false`**
  for the pair the relay is expected to replay — `(event_id, subscription_id)`
  and `(event_id, recipient_id)`. The Postgres adapters absorb that pair with
  `on conflict … do nothing`, so an at-least-once relay is not an error path.
- `insertIfAbsent` returns an outcome string for the same reason.

The one asymmetry inside a single method is `notification`. Its Postgres insert
absorbs `(event_id, recipient_id)` only; nothing absorbs
`notification_idempotency_key_key`, so reusing one idempotency key for a
different message raises there. The reference store used to return `false` for
both, which would have let a genuine key collision — two different messages
claiming one identity — disappear silently in tests while failing in
production. It now returns `false` for the replayed pair and throws for the key
collision, matching the adapter.

## Where the rules are restated

| Rule | Restated in |
| --- | --- |
| `identity_legacy_idx`, `identity_link_channel_type_external_id_key`, `principal_identity_id_key`, `principal_service_name_key`, `session_token_hash_key`, `membership_principal_id_organization_id_key` | `src/modules/identity-access/memory-repository.ts` |
| `organization_legacy_idx` | `src/modules/organization/service.ts` |
| `region_country_code_code_key` | `src/modules/geography/repository.ts` |
| `wallet_owner_type_owner_id_currency_key`, `payment_authorization_business_reference_key`, `ledger_transaction_business_reference_key` | `src/modules/money/repository.ts` |
| `fulfillment_market_order_reference_key`, `fulfillment_move_job_reference_key` | `src/modules/fulfillment/service.ts` |
| `event_subscription_subscriber_event_type_key` | `src/platform/eventing/delivery.ts` |
| `notification_recipient_…_key`, `notification_idempotency_key_key` | `src/modules/notification/repository.ts` |
| `plan_code_key`, `subscription_period_sequence_unique`, `subscription_period_no_overlap`, `subscription_period_authorization_unique`, `usage_record_once` | `src/modules/subscription/repository.ts` |

Three rules are enforced without a message, because their refusal is a return
value rather than an exception and there is nothing to quote:
`event_delivery_event_id_subscription_id_key` and
`notification_event_id_recipient_id_key` (`queue` returns `false`) and
`reputation_signal_source_unique` (`insertIfAbsent` returns
`duplicate_source_reference`). Their parity cases assert the outcome instead of
the wording.

## Two constraints of the check itself

**Check then set, with no `await` between.** A reference store runs on one
thread, so a check and its write are atomic only while no `await` separates
them. Every check above is synchronous over a `Map` for that reason; an `await`
in the middle would let two concurrent callers both pass the check.

**Journalled writes.** Each write goes through `journalMapWrite`, so a refusal
later in the same transaction rolls the accepted rows back. A check that guards
an unjournalled write would leave a row behind that the database would not have
kept.
