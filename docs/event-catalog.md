# WASLA CORE — Event Catalog

Every event uses the canonical envelope in `contracts/events/envelope.schema.json`.
Delivery is at-least-once. Consumers must be idempotent on `event_id` via their inbox.

## Published by CORE

| Event type | Version | Status | Entity | Consumers | Schema |
|---|---|---|---|---|---|
| `core.identity.verified` | 1 | implemented | identity | MOVE, MARKET | `contracts/events/core.identity.verified.v1.schema.json` |
| `core.money.credited` | 1 | implemented | wallet | authorized consumers | `contracts/events/core.money.credited.v1.schema.json` |
| `core.payment.authorized` | 1 | implemented | payment authorization | MARKET | `contracts/events/core.payment.authorized.v1.schema.json` |
| `core.payment.captured` | 1 | implemented | payment authorization | MARKET | `contracts/events/core.payment.captured.v1.schema.json` |
| `core.fulfillment.created` | 1 | implemented | fulfillment | MOVE | `contracts/events/core.fulfillment.created.v1.schema.json` |
| `core.fulfillment.completed` | 1 | implemented | fulfillment | MARKET | `contracts/events/core.fulfillment.completed.v1.schema.json` |

## Consumed by CORE

| Event type | Version | Producer | Status | Handler |
|---|---|---|---|---|
| `market.order.created` | 1 | MARKET | implemented in local bus | `core.fulfillment.market-order` |
| `move.job.completed` | 1 | MOVE | implemented in local bus | `core.fulfillment.move-completion` |

`implemented in local bus` means the schema, idempotent consumer and tests exist;
production transport remains unproven until a broker or durable queue is selected.

## Compatibility rules

- Additive optional fields only within a version.
- A removed or retyped field ships as `vN+1`; the previous version stays
  published for the documented overlap window.
- `event_type` and `version` together identify the contract. Consumers must
  ignore unknown fields.
