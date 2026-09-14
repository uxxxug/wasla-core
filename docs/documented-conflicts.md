# The documented conflict surface

Milestone 39. The gate is `tests/documented-conflicts.test.ts`; it needs no
database and runs in both CI jobs.

## The question

Milestone 36 built the response gate — every operation the contract publishes is
driven over `router.handle`, and every answer is checked against what the contract
says that operation returns — and named the two statuses its matrix does not
reach: `409` and `500`. Milestone 37 closed `500` by replaying the scenario against
a persistence layer that throws, and found `50` of `52` operations answering a
`500` the contract documented nowhere, plus two error codes published with no
producer at all.

`409` cannot be closed the same way. A conflict is not a broken backend: it is a
business fact that has to be *made* before the route will refuse. So the question
this cycle asks is the same one in both directions, and both halves have to be
driven rather than read:

- does every operation that documents `409` actually produce one, and
- does every route that can produce one document it?

## What was measured first

On `main` at `eda030b`, before any edit:

- **17 of 52 operations document `409`**, all of them `POST`.
- A second capture with a *different* `capture_reference`, against a hold of
  `5,000` minor units with `2,000` already captured, answers `409 conflict` — and
  so do the third, fourth and fifth.
- `POST /v1/geography/countries` with an existing `country_code`, a fresh
  idempotency key and a changed body answers **`201`** and **overwrites the stored
  row**: `QA` went from `Qatar`/`QAR` to `OVERWRITTEN`/`USD`, visible through the
  list read. The upsert is a recorded decision, and the route's own retry reason in
  `src/modules/geography/http.ts` says so, measured on `main` at `bd92b69`.

The reservation drew the wrong conclusion from the third measurement — see
[Two probe defects](#two-probe-defects-both-of-them-false-negatives) below and the
correction appended to row 39 of `ROADMAP.md`.

## What the gate holds

**One driver per documented conflict, and the set is asserted both ways.** The
driver table's labels must equal the set of operations documenting `409` exactly,
so an operation that starts documenting a conflict cannot go undriven, and one that
stops cannot leave a driver behind measuring nothing.

**Each driver declares the exact refusal it expects**, message and all, and the
whole table is compared in one assertion. That is what makes a producer swap
visible: mutation F3 below only reworded the over-capture refusal, and the gate
failed.

**Each driver declares its mechanism, and the census is exact.** A conflict is
reached either by a domain rule or by the platform's refusal of an idempotency key
reused with a different request. Three keyed creates — `POST /v1/organizations`,
`POST /v1/geography/countries`, `POST /v1/geography/cities` — have **no domain
conflict of their own**, so their documented `409` is only reachable by a caller
reusing a key. That is a fact about the contract, written down in the test rather
than discovered by a helper that tries mechanisms until one works. If a domain rule
is ever added to one of them, the census assertion fails and the driver has to say
what the new rule is.

**The inverse direction is driven, not argued.** Every recorded write is re-sent
under its own idempotency key with one field changed, and every operation that
answers `409` must document `409`. The set that does is asserted exactly:
`/v1/organizations`, `/v1/geography/countries`, `/v1/geography/cities`,
`/v1/geography/service-areas`.

**Every conflict answers in the same shape** — `code: "conflict"`,
`retryable: false`, a correlation id, and a `details` object. Retryability itself
is milestone 34's gate; this is the answer body's shape at the seventeen places the
contract promises it.

**The clock-moving driver is last, and the gate asserts that it is.** Expiring a
subscription needs the renewal sweep, and reaching it needs a fixed clock seventy
days forward — which also expires every session issued before it. That driver
re-issues one; any driver placed after it would measure `401 unauthenticated`
instead of a conflict, and the assertion refuses that ordering.

## The seventeen drivers

| Operation | Mechanism | How the fact is made | Refusal |
| --- | --- | --- | --- |
| `POST /v1/memberships` | domain | the same principal and organization again | `membership already exists` |
| `POST /v1/organizations` | key reuse | the recorded key, a changed name | `this Idempotency-Key was already used with a different request` |
| `POST /v1/payment-authorizations` | domain | a hold larger than the wallet | `insufficient available balance` |
| `POST /v1/payment-authorizations/{id}/capture` | domain | `400` captured of `1000`, then `900` asked for | `capture of 900 exceeds the remaining hold of 600` |
| `POST /v1/payment-authorizations/{id}/refund` | domain | a refund against a hold nothing was captured from | `nothing has been captured on this authorization` |
| `POST /v1/payment-authorizations/{id}/void` | domain | a hold captured in full, then voided | `a captured authorization cannot be voided` |
| `POST /v1/geography/countries` | key reuse | the recorded key, a changed name | `this Idempotency-Key was already used with a different request` |
| `POST /v1/geography/cities` | key reuse | the recorded key, a changed name | `this Idempotency-Key was already used with a different request` |
| `POST /v1/geography/service-areas` | domain | `radius_metres: 600_000` | `radius_metres exceeds the reference-data limit` |
| `POST /v1/plans` | domain | the recorded plan code again | `plan code already exists` |
| `POST /v1/plans/{id}/activate` | domain | the scenario's retired plan | `plan is retired` |
| `POST /v1/plans/{id}/retire` | domain | a plan created and never activated | `a draft plan was never offered and cannot be retired` |
| `POST /v1/subscriptions` | domain | a second subscription while the first is live | `owner already has a live subscription to this plan` |
| `POST /v1/subscriptions/{id}/usage` | domain | usage against a period voided by cancellation | `period was voided and cannot accrue usage` |
| `POST /v1/subscription-periods/{id}/collect` | domain | collecting a period voided by cancellation | `period was voided and cannot be collected` |
| `POST /v1/fulfillments/{id}/cancel` | domain | a fulfillment closed by a failed move, then cancelled | `fulfillment is already closed` |
| `POST /v1/subscriptions/{id}/cancel` | domain | a cancelled subscription expired by the renewal sweep | `subscription has already expired` |

Two facts the drivers had to work around, both of them decisions rather than
defects:

- **Cancelling a cancelled fulfillment is idempotent** (blocker B-29 — a refusal
  there was retried forever by the dispatcher and could never succeed). So the
  conflict needs a fulfillment closed some *other* way, which only MARKET's
  `move.job.completed` event does. That event arrives on a service token this file
  does not hold, so it is consumed through the service; the refusal being measured
  is still taken over `router.handle`.
- **Cancelling a cancelled subscription is idempotent too**, so the expiry
  refusal needs the renewal sweep, which no route exposes.

Setup runs over HTTP everywhere else. An empty wallet is the trick that makes
several of these reachable: a subscription whose first period is charged against a
wallet holding nothing leaves the period `uncollectible` rather than `settled`, and
cancelling then voids it, which is what `collect` and `usage` refuse.

## Falsification

Twelve mutations, one at a time against a clean tree, each reverted afterwards.
Runner `/tmp/falsify39.py`, spec `/tmp/mut39.json`, snapshot `/tmp/snap39/`.

| # | Mutation | Result |
| --- | --- | --- |
| F1 | the duplicate-membership refusal removed | caught |
| F2 | voiding a captured hold silently succeeds | caught |
| F3 | the over-capture refusal loses its numbers | caught |
| F4 | a voided period can be collected again | caught |
| F5 | a voided period can still accrue usage | caught |
| F6 | an expired subscription can be cancelled again | caught |
| F7 | the service-area radius limit dropped | caught |
| F8 | a second live subscription to the same plan allowed | caught |
| F9 | every documented `409` renumbered to `499` | caught |
| F10 | the key-reuse refusal reworded | caught |
| F11 | a draft plan can be retired | caught |
| F12 | cancelling a closed fulfillment silently succeeds | caught |

**Twelve of twelve caught.** F3 and F10 are the two that matter most: they change
nothing but a message, and a gate that only checked for status `409` would have let
both through.

## Two probe defects, both of them false negatives

Cycle 37's `body: {}` probe measured the boundary instead of the backend, and cycle
38's falsification runner mutated only the first of two occurrences of a repeated
anchor. This cycle produced two more of the same species, and both of them read as
*good news*, which is what makes them worth recording.

**The first probe replayed identical bodies.** Re-sending each of the 52 successful
scenario requests with a fresh idempotency key and an unchanged body produced `409`
on only **3** of the 17 documented conflicts, and `2xx` on the other 14. Read
literally that says eleven documented conflicts are unreachable. It is wrong: an
identical body exercises the natural-key and idempotency path, not the conflict
path. The capture measurement above is the direct counter-example — the same route
that answered `200` on an identical replay answers `409` four times in a row once
the body asks for money the hold no longer has.

**The second probe added a field.** The inverse-direction check first changed each
recorded body by *adding* an unknown field, on the reasoning that a body the route
has never seen under that key must reach the key-reuse refusal. Every write in the
surface answered `400 invalid_request` instead: **validation runs before the
idempotency key is compared**, so the probe reported that *no* route can produce
the key-reuse refusal — from an unbroken tree. The fix is in the gate: the changed
body has to stay valid, so `changeOneField` alters one existing field and the four
routes that then answer `409` are asserted by name.

Both defects share the shape of the two before them: a probe that reports green is
reporting about itself until proven otherwise, and a green probe deserves the same
suspicion as a red one.

## What this does not cover

- The `409` responses' bodies are checked for shape, not for `details` contents;
  no route currently populates `details` on a conflict.
- `retry-after` is permitted on `409` by milestone 34's declaration and is not
  produced by any of the seventeen. The in-flight key refusal
  (`idempotencyKeyInFlight`) is the one place that would, and reaching it needs two
  concurrent requests holding the same key — a concurrency probe, not a state one,
  and left to a later cycle.
- Whether `POST /v1/geography/countries` *should* upsert rather than refuse a
  duplicate remains a product decision, not a gate. What the gate now pins is that
  its published `409` has a real producer and that the producer is the key-reuse
  refusal, so the decision cannot be quietly reversed in either direction without a
  failing test.
