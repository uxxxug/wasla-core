# Notification Message Declaration

## Cycle 41

### The problem

`contracts/notifications/notification-message.v1.schema.json` is a published
contract: it is the shape a channel adapter receives, and the shape a real
provider implementation is written against. The `NotificationMessage` interface
in `domain.ts` is hand-coded to match it, and the dispatcher constructs a
message from the stored row and hands it to the adapter. Nothing validated that
the message a real dispatch produces actually conforms to the contract. A
correct answer with no enforcement is a coincidence, not a guarantee: a
producer that adds a field or changes a type can ship without anything
noticing.

### What this gate does

`tests/notification-message-declaration.test.ts` drives a notification through
the fan-out and the dispatcher, captures the `NotificationMessage` the adapter
receives, and asserts it satisfies the published contract:

- every required field is present
- no field the contract does not declare is carried
- every present field's type matches the declaration

No database: every message is produced over the in-memory backend, since the
question is about the producer's contract, not the store's.

### How the message is produced

1. A market order is consumed → creates a fulfillment
2. A move job acceptance is consumed → dispatches the fulfillment, emitting
   `core.fulfillment.dispatched` to the outbox
3. The outbox publisher relays the event → the notification fan-out queues a
   notification row
4. The notification dispatcher claims the row, constructs a `NotificationMessage`
   from it, and hands it to a capturing channel adapter
5. The captured message is validated against the published contract

### Falsification

Four cases applied to a conformed payload from the published schema's examples:

1. A required field removed — the validator must catch it
2. An undeclared field added — the validator must catch it
3. A field's type changed (string where integer is declared) — the validator
   must catch it
4. A conforming payload — the validator must pass it

### Shared support module

The gate reuses `tests/support/event-schemas.ts`, which now loads both event
schemas from `contracts/events/` and notification message schemas from
`contracts/notifications/`. The same `payloadErrors()` function validates
against both contract families.
