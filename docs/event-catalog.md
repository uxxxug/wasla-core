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
| `core.payment.voided` | 1 | implemented | payment authorization | MARKET | `contracts/events/core.payment.voided.v1.schema.json` |
| `core.payment.refunded` | 1 | implemented | payment authorization | MARKET | `contracts/events/core.payment.refunded.v1.schema.json` |
| `core.fulfillment.created` | 1 | implemented | fulfillment | MOVE | `contracts/events/core.fulfillment.created.v1.schema.json` |
| `core.fulfillment.dispatched` | 1 | implemented | fulfillment | MARKET | `contracts/events/core.fulfillment.dispatched.v1.schema.json` |
| `core.fulfillment.completed` | 1 | implemented | fulfillment | MARKET | `contracts/events/core.fulfillment.completed.v1.schema.json` |
| `core.fulfillment.cancelled` | 1 | implemented | fulfillment | MARKET, MOVE | `contracts/events/core.fulfillment.cancelled.v1.schema.json` |
| `core.subscription.created` | 1 | implemented | subscription | MARKET, MOVE | `contracts/events/core.subscription.created.v1.schema.json` |
| `core.subscription.period_settled` | 1 | implemented | subscription | MARKET | `contracts/events/core.subscription.period_settled.v1.schema.json` |
| `core.subscription.past_due` | 1 | implemented | subscription | MARKET, MOVE | `contracts/events/core.subscription.past_due.v1.schema.json` |
| `core.subscription.renewed` | 1 | implemented | subscription | MARKET | `contracts/events/core.subscription.renewed.v1.schema.json` |
| `core.subscription.cancelled` | 1 | implemented | subscription | MARKET, MOVE | `contracts/events/core.subscription.cancelled.v1.schema.json` |
| `core.subscription.expired` | 1 | implemented | subscription | MARKET, MOVE | `contracts/events/core.subscription.expired.v1.schema.json` |

## Consumed by CORE

| Event type | Version | Producer | Status | Handler |
|---|---|---|---|---|
| `market.order.created` | 1 | MARKET | implemented in local bus | `core.fulfillment.market-order` |
| `move.job.accepted` | 1 | MOVE | implemented in local bus | `core.fulfillment.move-acceptance` |
| `move.job.rejected` | 1 | MOVE | implemented in local bus | `core.fulfillment.move-rejection` |
| `move.job.completed` | 1 | MOVE | implemented in local bus | `core.fulfillment.move-completion` |

`implemented in local bus` means the schema, idempotent consumer and tests exist;
production transport remains unproven until a broker or durable queue is selected.

## Lifecycle of a fulfillment as seen on the bus

```
market.order.created            (MARKET -> CORE)
  └─ core.fulfillment.created   (CORE -> MOVE)     status: coordinating
       ├─ move.job.accepted     (MOVE -> CORE)
       │    └─ core.fulfillment.dispatched (CORE -> MARKET)  status: dispatched
       │         └─ move.job.completed (MOVE -> CORE)
       │              └─ core.fulfillment.completed (CORE -> MARKET) status: completed | failed
       ├─ move.job.rejected     (MOVE -> CORE)
       │    └─ core.fulfillment.completed (outcome failed)   status: failed
       └─ cancellation (MARKET or operator, via CORE API)
            └─ core.fulfillment.cancelled (CORE -> MARKET, MOVE)     status: cancelled
```

Every transition of the fulfillment lifecycle is published. A consumer that
replays the CORE stream can reconstruct the exact state without querying CORE.

## Lifecycle of a subscription as seen on the bus

```
POST /v1/subscriptions            (operator or tenant, via CORE API)
  └─ core.subscription.created                          status: active | past_due
       ├─ collection succeeded
       │    └─ core.subscription.period_settled          period:  settled
       │         └─ end of period (renewal sweep)
       │              └─ core.subscription.renewed       period:  pending
       │                   └─ core.subscription.period_settled | .past_due
       ├─ collection refused
       │    └─ core.subscription.past_due                period:  uncollectible
       │         └─ later collection of the SAME period
       │              └─ core.subscription.period_settled  status: active
       └─ cancellation (owner, via CORE API)
            └─ core.subscription.cancelled               status: cancelled
                 └─ paid coverage runs out (renewal sweep)
                      └─ core.subscription.expired       status: expired
```

`cancelled` and `expired` are separate facts and are published separately. A
cancelled subscription still entitles its owner until the period it already
paid for ends; only then does coverage stop. A consumer that treated the two as
one could not tell a customer who left from one whose payment failed.

Usage is deliberately not on the bus. It is high-volume bookkeeping with no
consumer outside CORE, and the stream carries business facts (ADR 0009).
Neither is a draft plan: its terms can still change, so nothing outside CORE
can act on them. A plan becomes visible to others only through the
subscriptions that reference it.

## Compatibility rules

- Additive optional fields only within a version.
- A removed or retyped field ships as `vN+1`; the previous version stays
  published for the documented overlap window.
- `event_type` and `version` together identify the contract. Consumers must
  ignore unknown fields.
