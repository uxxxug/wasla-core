# Outbound delivery

How a CORE event reaches a system CORE does not run.

Migration 0007 and `EventIngress` gave MARKET and MOVE a way into CORE. Until
migration 0008 there was no way out: `LocalEventBus` reached in-process
subscribers only, so a fulfillment could be created, dispatched and settled and
nothing outside CORE's process would ever learn of it. The coordination loop
had an entrance and no exit.

## The shape

```
outbox (pending) ──OutboxPublisher──▶ local bus
                        │
                        └─ DeliveryFanOut ──▶ event_delivery (one row per subscriber)
                                                     │
                                            DeliveryWorker ──EventTransport──▶ endpoint
```

`event_subscription` is configuration: who wants which event type, and where.
It is data rather than code because CORE must not contain a hardcoded MOVE or
MARKET endpoint, and an operator has to be able to move an endpoint without a
deploy.

`event_delivery` is one row per `(event_id, subscription_id)`, and that pair is
the idempotency key. Per-subscriber rows are what make one subscriber's outage
unable to hold up another, and what make "delivered to MOVE but not yet to
MARKET" a state the system can represent rather than lose.

## Decisions worth stating

**Fan-out happens at relay time, not at emit time.** An endpoint registered
today is used by the next event relayed, not by a subscription list captured
when the event was written. The consequence is deliberate: a subscription
created after an event was already relayed does not receive that event.
Back-filling is a replay operation, and replay is an explicit decision, not a
side effect of editing configuration.

**Queueing the deliveries and marking the outbox row published are one
transaction.** As two, a crash between them would leave an event marked
`published` that no subscriber will ever be sent — the dual-write problem the
outbox exists to prevent, moved one step downstream. Re-running the fan-out is
free because of the unique constraint, so the failure mode is a repeat, never a
loss.

**Delivery is at-least-once, and deduplication is the receiver's job.** CORE
cannot promise a receiver sees an event exactly once; it can only promise it
keeps trying and never silently stops. `event_id` therefore travels both in the
envelope and in the `x-wasla-event-id` header, so a receiver can discard a
repeat before parsing the body. Recorded as an external dependency: MOVE and
MARKET must each deduplicate on `event_id`.

**The order of simultaneously-due deliveries is unspecified.** In-memory drains
in insertion order; Postgres orders by `(next_attempt_at, created_at)` and
leaves ties to the planner. This is a genuine difference between the two
backends and it is not papered over, because there is nothing to unify: CORE
makes no cross-subscriber ordering promise, and inventing a tie-breaker would
imply one. Deliveries to different subscribers are independent. A test that
depends on which subscriber is attempted first is asserting something CORE does
not guarantee — one such test was written during this milestone and it passed
in memory and failed on Postgres, which is how the difference was found.

**A claim is a lease, and a lease is not a backoff.** The worker claims a
delivery by writing `claimed_at` and pushing `next_attempt_at` out by the lease,
so a second worker polling at the same moment matches nothing (B-22). Because
`next_attempt_at` carries both the lease and the retry schedule, `claimed_at` is
what says which one it currently is (B-24): a delivery held by a worker that died
is not silently re-served when the lease runs out — `reclaimExpired` frees it,
counts it as `reclaimed`, and the next drain sends it. An abandoned claim does not
spend an attempt, so a rolling restart cannot walk a healthy delivery to its
attempt limit — it spends a `reclaims` instead, and after three abandonments the
delivery is dead-lettered rather than recovered a fourth time (B-25), so a payload
that kills the worker cannot occupy the queue for ever. A delivery that dies this
way keeps `last_status` and `delivered_at` null: nothing was ever sent, and the
record must not imply a subscriber answered. `counts()` reports `in_flight` and
`abandoned` for the same reason:
a partner outage and a crash-looping worker used to produce identical numbers.

**A stalled worker cannot report on a delivery it no longer holds.** The claim also
stamps a `claim_token`, and `markDelivered`, `markFailed` and `markDead` match on it
(B-26). A worker that stalls past its lease, is reclaimed, and then reports the
response it eventually received is refused rather than applied — otherwise it would
overwrite the live attempt's `last_status` and `delivered_at` with a response code
nobody is waiting on any more, and could reopen a delivered row for retry. The
refusal is counted as `fenced` on the worker's result and in
`core_worker_outcomes_total`; it does **not** mean the subscriber missed anything,
and it does not undo a POST that already went out. That is the at-least-once
guarantee above, unchanged: this only protects what the row records. A persistently
non-zero `fenced` means the lease is shorter than the work, which for this worker
usually means `timeoutMs` is close to or above the lease.

**A failed attempt is either worth repeating or it is not.** This distinction
matters more than the backoff curve:

| Response | Meaning | Action |
| --- | --- | --- |
| 2xx | accepted | `delivered` |
| 5xx | receiver is unwell | retry with exponential backoff |
| timeout, DNS, refused | no answer at all | retry |
| 408, 429 | asked to be retried | retry |
| other 4xx | receiver understood and refused | `dead` immediately |

Retrying a rejected payload cannot produce a different answer; identical bytes
get the identical refusal. Repeating it only delays someone noticing. A `dead`
row stays visible at `GET /v1/event-deliveries/undelivered` so an operator can
find it without reading logs.

Once whatever refused the payload has been fixed, a dead delivery can be put back
into the queue with `npm run revive` (B-27) — see `docs/queue-revival.md`. The
revival changes the row's status and nothing else: the worker then POSTs the
envelope that was already stored, under the same `event_id`, which is why
subscribers must be idempotent on it. A revival is refused if the subscription has
since been deactivated, because deactivating a subscription is how sending to that
subscriber is stopped and the worker itself does not re-check it.

## Signing

Each body is signed `HMAC-SHA256` with the subscription's secret, sent as
`x-wasla-signature: sha256=<hex>`. The signature is over the exact bytes
transmitted, not over selected fields: a receiver that verifies a
reconstruction of the payload is verifying its own serialiser, not what CORE
sent. `verifyBody` exists so a receiver has a reference implementation to
compare against.

HMAC needs the plaintext secret, so `event_subscription.signing_secret` holds
it. The constraints that follow from that:

- It is never returned by any read path, including the response to the request
  that created the subscription. A response body is the easiest place for a
  secret to end up in a log.
- The audit scrubber already redacts `secret`-shaped keys.
- Re-registering an existing `(subscriber, event_type)` returns the existing
  subscription and does **not** rotate the secret. Silently rotating would
  break every in-flight delivery without anyone asking for it. Rotation is a
  separate, deliberate act.
- `endpoint_url` must be `https`. The signature proves origin, not
  confidentiality.

Only `core.*` event types may be subscribed to. A subscription to `market.*` or
`move.*` would hand one external system another's inbound traffic by
configuration alone — the boundary `EventIngress` spends its whole existence
defending.

## Operating it

Subscriptions are operator-provisioned; there is no self-registration. The
management routes require `organization.write` (`organization.read` to view),
which no `service` role holds.

- `POST /v1/event-subscriptions`
- `GET /v1/event-subscriptions`
- `POST /v1/event-subscriptions/:subscription_id/deactivate` — stops new work
  being queued. Deliveries already queued stay queued: they were promised, and
  dropping them silently is worse than delivering them late.
- `POST /v1/event-subscriptions/:subscription_id/activate`
- `GET /v1/event-deliveries/undelivered` — pending plus dead. An empty list is
  the invariant to expect.
