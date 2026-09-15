# Event Payload Declaration

## Cycle 40

### The problem

The contract gate (`scripts/check-contracts.mjs`) proves every event type CORE
emits has a published JSON Schema. It has never read a payload. The
fulfillment-lifecycle-contract test validates the five fulfillment event
payloads against their schemas, and nothing validates the other fourteen. A
correct answer with no enforcement is a coincidence, not a guarantee: a
producer that adds a field or changes a type can ship without anything
noticing, and the first thing that breaks is a consumer that reads the
contract.

### What this gate does

`tests/event-payload-declaration.test.ts` drives every core event type CORE
can produce over the in-memory backend, reads the emitted payloads from the
outbox, and asserts each one satisfies its published contract:

- every required field is present
- no field the contract does not declare is carried
- every present field's type matches the declaration (integer checked with
  `Number.isInteger`, `null` accepted where the contract allows it)

No database: every event is produced over the in-memory backend, since the
question is about the producer's contract, not the store's.

### What it covers

All 19 core event types that have a published schema:

| Module | Event types |
|--------|------------|
| identity | `core.identity.verified` |
| money | `core.money.credited` |
| payment | `core.payment.authorized`, `core.payment.captured`, `core.payment.refunded`, `core.payment.voided` |
| fulfillment | `core.fulfillment.created`, `core.fulfillment.dispatched`, `core.fulfillment.completed`, `core.fulfillment.cancelled`, `core.fulfillment.executed_after_cancellation` |
| reputation | `core.reputation.signal_recorded`, `core.reputation.signal_retracted` |
| subscription | `core.subscription.created`, `core.subscription.period_settled`, `core.subscription.renewed`, `core.subscription.past_due`, `core.subscription.expired`, `core.subscription.cancelled` |

### How events are produced

| Event | How |
|-------|-----|
| `core.identity.verified` | `registerIdentity()` |
| `core.money.credited` | `money.credit()` |
| `core.payment.authorized` | `money.authorize()` |
| `core.payment.captured` | `money.capture()` |
| `core.payment.refunded` | `money.capture()` then `money.refund()` |
| `core.payment.voided` | `money.voidAuthorization()` |
| `core.subscription.created` | `billing.subscribe()` |
| `core.subscription.period_settled` | emitted during `subscribe()` |
| `core.subscription.renewed` | `billing.renewDuePeriods()` after advancing the clock |
| `core.subscription.past_due` | unfunded subscription charge fails during `renewDuePeriods()` |
| `core.subscription.expired` | cancelled subscription's period ends during `renewDuePeriods()` |
| `core.subscription.cancelled` | `billing.cancelSubscription()` |
| `core.reputation.signal_recorded` | publish `market.review.rated` to the bus |
| `core.reputation.signal_retracted` | publish `market.review.retracted` to the bus |
| `core.fulfillment.created` | publish `market.order.created` to the bus |
| `core.fulfillment.dispatched` | publish `move.job.accepted` to the bus |
| `core.fulfillment.completed` | publish `move.job.completed` to the bus |
| `core.fulfillment.cancelled` | `fulfillment.cancel()` |
| `core.fulfillment.executed_after_cancellation` | cancel then publish `move.job.completed` |

### Falsification

The gate includes four falsification cases, each applied to a conformed
payload from the published schema's examples and restored:

1. A required field removed — the validator must catch it
2. An undeclared field added — the validator must catch it
3. A field's type changed (string where integer is declared) — the validator
   must catch it
4. A conforming payload — the validator must pass it

The validation function is the same one the gate uses, so a mutation that
survives is a gate that measures the wrong thing.

### Shared support module

`tests/support/event-schemas.ts` loads all published JSON Schemas from
`contracts/events/` and provides:

- `CORE_EVENT_TYPES` — every core event type with a published schema
- `schemaFor(eventType)` — the published contract
- `payloadErrors(eventType, payload)` — structural errors in a payload
- `assertMatchesContract(eventType, payload)` — throws on the first error

Deliberately not a full JSON Schema validator (no ajv dependency): this checks
the three properties that actually go wrong between a producer and its
contract — a required field the producer forgot, a field the producer invented
that the contract forbids, and a value whose type the contract does not
declare. A full validator would be stronger but would also be a dependency,
and the contract gate already proves every schema parses.
