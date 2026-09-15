# Event Envelope Declaration

## Cycle 42

### The problem

`contracts/events/envelope.schema.json` is a published contract: it is the
wrapper every event carries — `event_id`, `event_type`, `version`, `producer`,
`occurred_at`, `correlation_id`, `causation_id`, `entity_type`, `entity_id`,
`payload`. The payload inside each event is validated against its own schema
by the event-payload-declaration gate (milestone 40), but the envelope itself
is not. A producer that adds a field, changes a type, or uses a producer value
outside the declared enum can ship without anything noticing. A correct
answer with no enforcement is a coincidence, not a guarantee.

### What this gate does

`tests/envelope-declaration.test.ts` drives several core event types over the
in-memory backend, reads every emitted event from the outbox, and validates
each full envelope against the published contract:

- every required field is present
- no field the contract does not declare is carried
- every present field's type matches the declaration
- `producer` is one of the declared enum values

No database: every event is produced over the in-memory backend, since the
question is about the producer's contract, not the store's.

### How events are produced

1. A wallet is created and credited → emits `core.money.credited`
2. A payment is authorized → emits `core.payment.authorized`
3. An identity is registered → emits `core.identity.verified`
4. A market order is published → creates a fulfillment, emits
   `core.fulfillment.created`
5. A move job acceptance is published → dispatches the fulfillment, emits
   `core.fulfillment.dispatched`
6. A move job completion is published → emits `core.fulfillment.completed`

### Falsification

Four cases applied to a conforming envelope constructed from the schema's
required fields and properties (the schema's example is `{}`):

1. A required field removed — the validator must catch it
2. An undeclared field added — the validator must catch it
3. A field's type changed (string where integer is declared) — the validator
   must catch it
4. A conforming envelope — the validator must pass it

### Shared support module

The gate reuses `tests/support/event-schemas.ts`, which now loads the envelope
schema alongside the event-specific schemas and notification message schemas.
The same `payloadErrors()` function validates against all three contract
families.
