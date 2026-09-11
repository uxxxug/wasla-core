# WASLA CORE — Event Catalog

Every event uses the canonical envelope in `contracts/events/envelope.schema.json`.
Delivery is at-least-once. Consumers must be idempotent on `event_id` via their inbox.

## Published by CORE

| Event type | Version | Status | Entity | Consumers | Schema |
|---|---|---|---|---|---|
| `core.identity.verified` | 1 | implemented | identity | MOVE, MARKET | `contracts/events/core.identity.verified.v1.schema.json` |
| `core.fulfillment.created` | 1 | not implemented | fulfillment | MOVE | planned — Fulfillment cycle |
| `core.fulfillment.completed` | 1 | not implemented | fulfillment | MARKET | planned — Fulfillment cycle |

## Consumed by CORE

| Event type | Version | Producer | Status | Handler |
|---|---|---|---|---|
| `market.order.created` | 1 | MARKET | not implemented | planned — Fulfillment cycle |
| `move.job.completed` | 1 | MOVE | not implemented | planned — Fulfillment cycle |

`not implemented` means exactly that: no producer, no consumer, no schema file yet.
Rows are promoted to `implemented` only when a schema, a producer and a passing
test all exist.

## Compatibility rules

- Additive optional fields only within a version.
- A removed or retyped field ships as `vN+1`; the previous version stays
  published for the documented overlap window.
- `event_type` and `version` together identify the contract. Consumers must
  ignore unknown fields.
