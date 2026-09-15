# Operations state counts

Milestone 43. The metrics exposition now reports fulfillment, subscription, and
money state alongside the queue and reconciliation depths it already carried.

## What was added

Three new gauges in the declared catalogue:

- `core_fulfillment_depth{status}` — fulfillments by status: `coordinating`,
  `dispatched`, `completed`, `failed`, `cancelled`
- `core_subscription_depth{status}` — subscriptions by status: `active`,
  `past_due`, `cancelled`, `expired`
- `core_money_depth{kind, status}` — wallets by status (`active`, `frozen`,
  `closed`) and payment authorizations by status (`authorized`, `captured`,
  `partially_captured`, `voided`), under `kind="wallet"` and
  `kind="payment_authorization"` respectively

Each is a gauge sampled by the depth sampler, not read at scrape time, for the
same reason the queue-depth gauges are not: a scrape is not a database query.

## What it answers

An operator can now see, from the metrics exposition alone:

- How many fulfillments are stuck in `coordinating` (never dispatched) — a
  queue that was not visible before because it is not a durable queue, it is
  a fulfillment state
- How many subscriptions are `past_due` — the count behind B-16, the grace
  policy decision
- How many payment authorizations are still `authorized` (held but not
  captured) — money tied up in open orders
- How many wallets are `frozen` or `closed`

## What deliberately was not

No new HTTP endpoint. The metrics exposition is the single operational surface,
and adding a product route would have opened a path under ADR 0008. The counts
are platform-wide and name nobody, the same line milestone 8 drew for the
reconciliation depths.

No composite health score. A system with three `coordinating` fulfillments and
zero `past_due` subscriptions is not healthier than one with one of each; the
counts are the facts, and the decision about what they mean is an operator's.
