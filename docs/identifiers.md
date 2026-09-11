# Identifiers in CORE

## Decision

**Every identifier CORE issues is a UUID v4.** This is not a new decision; it
is a decision that was already made in three places and simply never stated in
the fourth.

| Layer | What it already said |
|---|---|
| Database | Every CORE-owned key is declared `uuid`: `organization_id`, `identity_id`, `identity_link_id`, `principal_id`, `session_id`, `membership_id`, `wallet_id`, `transaction_id`, `entry_id`, `authorization_id`, `fulfillment_id`, `region_id`, `city_id`, `service_area_id`, `event_id`, `audit_id`, `actor_id` |
| API contract | Every one of those declares `schema: { type: string, format: uuid }` in `contracts/openapi/core-v1.yaml` |
| Code that mints them | `newId()` has always returned `randomUUID()` |
| Code that accepts them | **Nothing.** Services took `string` and passed it straight to a repository |

That fourth gap is what made this worth resolving. An in-memory `Map`
accepts `"org-1"` as a key; Postgres raises `invalid input syntax for type
uuid`. So the two backends disagreed not about behaviour but about *which
commands were even well formed* — exactly the class of divergence this
repository has decided not to hide behind tests.

`assertId` in `src/platform/ids.ts` closes it. The domain now asserts the same
rule the schema enforces, so a malformed identifier is rejected identically on
both backends, as a malformed request (`invalid`) rather than a missing row
(`notFound`) or a driver-level crash. `notFound` was the wrong answer anyway: a
syntactically impossible identifier does not describe a row that is absent, it
describes a request that cannot be satisfied.

**No migration was made, and none was needed.** The schema was right. Changing
`uuid` to `text` would have thrown away the database's own type check, the
uniqueness guarantees that come with it, and the index efficiency, in exchange
for nothing but letting the old fixtures keep passing.

## Where the guard applies

At intake — the point an identifier crosses into CORE from an HTTP request or
an inbound event. Not on identifiers CORE has just generated itself.

- `MoneyService`: `owner_id` (createWallet), `wallet_id` (via `requireWallet`,
  covering credit, authorize and balance), `authorization_id` (capture, void)
- `IdentityService`: `principal_id` (issueSession, grantMembership),
  `organization_id` (grantMembership), `session_id` (revokeSession)
- `GeographyService`: `region_id` (addCity), `city_id` (defineServiceArea)
- `FulfillmentService`: `organization_id` and `payment_authorization_id` on the
  inbound `market.order.created` payload

## What is deliberately *not* a UUID

These are `text` in the schema on purpose. Constraining their format would be
CORE inventing rules for data it does not issue.

| Column | Why |
|---|---|
| `market_order_reference`, `move_job_reference` | Another product's identifier. CORE keeps it opaque and must accept whatever MARKET or MOVE uses — today that is a UUID, but CORE does not get to require it |
| `identity_link.external_id` | A channel's own user id. A Telegram user id is a signed 64-bit integer, not a UUID |
| `business_reference` | A caller-supplied idempotency key, chosen to be meaningful to the caller |
| `correlation_id`, `causation_id` | Trace identifiers that frequently originate outside CORE |
| `outbox.entity_id`, `audit_entry.entity_id` | Polymorphic. The same column holds a fulfillment UUID, a two-letter `country_code` and an external order reference |
| `country_code` | A natural key (ISO 3166-1 alpha-2), not a surrogate |
| `legacy_id` | A key from the system being migrated from, whose format is not ours to choose |

`assertId` is therefore never applied to any of these, and
`tests/identifiers.test.ts` asserts that a non-UUID `order_id` is still
accepted, so a later well-meaning tightening cannot break MARKET.

## Fixtures

All test fixtures now go through `testId(label)` in `tests/support/ids.ts`,
which hashes a readable label into a well-formed v4. This keeps the call sites
saying what they mean (`testId("org-1")`) while making every fixture valid on
both backends. Tests that need genuine randomness keep using `randomUUID()`.

The previous state — `"org-1"` in the in-memory suites and `randomUUID()` in
the Postgres ones — meant the two suites were not running the same scenarios,
which is the thing that hid the gap in the first place.
