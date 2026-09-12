# Reputation and trust signals (ADR 0015)

CORE stores **signals**. It does not store scores, and it does not store reviews.

That single sentence is the whole design, and both halves of it are refusals:

- **A review stays in MARKET.** The text, the title, the photographs and
  everything else a person wrote belong to the product that collected them.
  CORE receives the rating, the subject and MARKET's own opaque reference for
  the review. There is no column and no contract field in which text could
  arrive, and the inbound schemas refuse a payload that invents one — so there
  is exactly one place to moderate content, redact it, and honour a deletion
  request.
- **A standing is derived on every read.** There is no `reputation_score` table
  and no cached aggregate anywhere. `GET /v1/reputation/{subject_type}/{subject_id}`
  groups the signals and folds them, at request time, through the pure
  `deriveStanding`. A stored aggregate would be a second source of truth for
  something already fully determined by the signals, and this repository has
  paid that bill twice: settlement state drifting from the ledger, and the
  entitlement table ADR 0013 refused to create.

## The table

One table, `reputation_signal` (migration 0018), append-only.

| Column | Why it exists |
|---|---|
| `organization_id` | Tenant scope. A signal that cannot be attributed to a tenant cannot be routed, authorized or filtered (B-23). |
| `subject_type`, `subject_id` | Who the signal is about: an `identity` or an `organization`, never a MOVE or MARKET entity. A rating of work done is recorded against the CORE identity that did the work. |
| `signal_kind` | A closed vocabulary: `service_rating`, `completion`, `cancellation`, `dispute`, `compliment`, `complaint`. |
| `rating_value` | 1…5, and only for `service_rating`. `NULL` for every other kind, because a dispute has no score. |
| `source_system`, `source_reference` | Who reported it and their own reference for the report. `UNIQUE (organization_id, source_system, source_reference)` — this is the exactly-once guarantee. |
| `occurred_at` | The producer's claim about when the fact happened. Reported, never trusted for ordering. |
| `recorded_at` | CORE's own clock. Every ordering uses this, so one producer's skew cannot reorder another's facts. |
| `retracted_at`, `retraction_reason` | The withdrawal marker. Both or neither, written once. |

### Why the vocabulary is closed

An open vocabulary would let a producer invent a kind, have CORE store it, and
have every derived standing silently ignore it. A fact accepted and then
discarded is worse than a fact refused, because the producer was told it landed.
An unknown kind is refused by name, by the service and by a `CHECK` constraint.

### Why a retraction is a marker

MARKET moderates a review after it was reported. CORE must be able to record
that, and the row must keep saying what was reported: both statements are true,
and only a marker keeps both.

The two alternatives were rejected explicitly. Deleting the row destroys the
evidence that a rating was ever reported and counted. A compensating negative
signal makes a derived average mix a rating with its own reversal, so no reader
can tell "withdrawn" from "rated twice".

A retracted signal counts towards `signal_count` and `retracted_count`, and
towards nothing else. It is not hidden: the listing shows it, with its reason.

## Exactly once, decided by the write

Ingestion is idempotent twice over, because the two mechanisms cover different
failures:

- The **inbox** refuses a redelivery of the same `event_id`.
- The **unique constraint** refuses a *different* envelope carrying the same
  report — which is what a producer retrying after a timeout actually sends. The
  inbox cannot see that two `event_id`s are one fact; only the producer's own
  reference can.

Both decisions live in the write, never in a preceding read: two concurrent
copies of one report would both pass a read-then-write check and both insert
(B-12). The same applies to a retraction — the `UPDATE` carries
`AND retracted_at IS NULL`, so the second of two concurrent withdrawals updates
nothing and is reported as stale rather than raised. A duplicate is not an
error: at-least-once delivery makes it the expected case, and the honest answer
is the signal that is already stored.

## What CORE publishes

`core.reputation.signal_recorded` and `core.reputation.signal_retracted` carry
the reported fact and nothing derived — no count, no average, no score.

Putting the running average in the event was considered and rejected. A total
computed at publication time is computed without any signal recorded
concurrently with it, so two events about one subject would each carry a
different total and no consumer could tell which is current. A consumer that
needs a standing either accumulates this stream, which it receives
exactly-once, or asks CORE.

## What CORE deliberately does not do

None of the following is missing by accident. Each is product policy under
ADR 0018, and inventing an answer in CORE would be CORE deciding MARKET's and
MOVE's product rules:

| Not built | Recorded as |
|---|---|
| A composite trust score across kinds — how much a dispute is worth against a five-star rating | B-31 |
| Decay: whether a rating from two years ago still counts, and how fast it fades | B-32 |
| Thresholds and gating: what standing is good enough to be offered work, and who is suspended | B-33 |
| Cross-tenant aggregation: whether one subject's standing spans organizations | B-34 |

The schema can express none of them silently. A standing is per tenant because
that is the only reading the table can produce, rather than a global one nobody
decided on.

## Reachability, stated plainly

Signals arrive **only** as events. There is no HTTP route that writes one: a
second ingestion path would have none of the properties the first one has —
exactly-once on the producer's reference, auditable, replayable — and ADR 0008
keeps the list of synchronous cross-system paths closed.

Today the only inbound contracts are `market.review.rated` and
`market.review.retracted`, and **MARKET does not publish them yet**. So the
`service_rating` kind is the only one reachable in a deployed system, and no
reputation signal exists in one until MARKET starts publishing. The remaining
kinds are recordable in process and have no producer contract.

`completion` and `cancellation` are the sharpest case, and the reason is a
finding rather than an oversight: CORE closes a fulfillment and therefore knows
the outcome, but it cannot attribute that outcome to a subject. The executor is
identified in CORE only by an opaque `move_job_reference`; the CORE identity
that did the work is not in any field CORE owns. MOVE must name that identity
before CORE can record a completion signal about it. Recorded as an external
dependency in `ROADMAP.md`.

## Reading a standing

```
GET /v1/reputation/{identity|organization}/{subject_id}?organization_id=…
GET /v1/reputation/{identity|organization}/{subject_id}/signals?organization_id=…&limit=…
```

Both require `reputation.read`, held by `platform_admin`, `org_admin` and
`support_agent`. Not by `org_member`: reading everyone's standing is an
administrative act. `organization_id` is stated rather than inferred from the
caller's memberships, because a principal can belong to several organizations
and inferring would mean CORE choosing which tenant an ambiguous read meant.

`average_rating_milli` is an integer in thousandths of a rating point — a float
would make two backends, and two languages, disagree in the last digit of a
number that ends up in front of a person. It is `null`, never `0`, when nothing
has been rated: a subject with no ratings is not a subject rated badly.

The signals listing exists so a support agent can see what a number is made of
instead of having to believe it.

## Evidence

`tests/reputation.test.ts` runs every assertion against both backends and
compares their answers to each other, down to the grouped rows a standing is
folded from — a memory double more permissive than the database certifies bugs
(B-12). The append-only guarantee is asserted against real SQL, because a
trigger is the only thing that stops a hand-written `UPDATE`, and so are the
constraints: a `service_rating` with no number, a rating out of range, a value
on a kind that carries none, an unknown kind, and a withdrawal with no reason.

Two defects were found by those tests during implementation and are recorded in
the cycle entry in `ROADMAP.md`: both `CHECK` constraints, written in the
obvious disjunctive form, evaluated to `NULL` on exactly the rows they existed
to refuse — and a `CHECK` only rejects `FALSE`. They are now written as `CASE`
expressions, which are total.
