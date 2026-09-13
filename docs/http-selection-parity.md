# Selection parity for the HTTP read surface

Milestone 23. The ninth parity cycle, and the third to gate a predicate.
Companions: `docs/selection-parity.md` (milestone 21, the platform queues) and
`docs/module-selection-parity.md` (milestone 22, the module repositories).

Those two cycles proved that a **store** selects the same rows in the same order
on both backends. Neither of them reads the layer a caller actually talks to. A
route decides which store method to call, what to pass it, what to do when a
query parameter is missing or repeated or malformed, and what to hand back — and
milestone 22's own finding was that a correct selection can be destroyed by the
step after it. `tests/http-selection-parity.test.ts` closes that step.

## What the gate does

One population, seeded **through the stores** and read **through
`core.router.handle`** — the real router, the real authorisation, the real
serialisation. Seeding through the stores is deliberate: several of these rows
cannot be created over HTTP at all (there is no route that writes a delivery, an
inbound event or a reputation signal), so driving the population through the API
would have shrunk the gate to the subset of state the API can build.

- Fixed ids (`00000000-0000-4000-9000-…`), a fixed clock from
  `2026-06-01T00:00:00.000Z`, two tenants, and **deliberate ties** on every
  timestamp a listing sorts by, so a non-total order has something to get wrong.
- **19 listing cases.** Each declares its expected row count *and* its expected
  order, computed from the fixture definitions rather than read back out of a
  store, so "both backends agree" cannot mean "both are wrong in the same way".
  The count is asserted on the reference backend in the run without a database,
  so a case that silently stops selecting anything fails instead of passing
  vacuously.
- **22 refusal cases**, each asserted to return 400 with the canonical error
  code on both backends: repeated parameters, empty parameters, padded and
  signed and hexadecimal and exponential and decimal integers, a limit past the
  maximum, a zero limit, values outside a closed vocabulary, a vocabulary value
  in the wrong case, and a missing required tenant scope.
- **A coverage gate.** `router.registrations()` is new in this cycle: the router
  now reports its own `(method, template)` pairs, and the test fails if any
  registered `GET` is neither exercised by a listing case nor named in
  `NOT_LISTINGS` with a reason. A route added later cannot arrive ungated.
- **A premise test** asserting that both backends start from the same census,
  and that the run is measuring the halves it claims to: with `DATABASE_URL` set
  the backend list must be exactly `["memory", "postgres"]`, so a run that
  quietly lost its Postgres half cannot report the same green count as a run
  that compared both.

## What it found

Five defect classes, all fixed at the root, none exempted.

### 1. The platform reference stores returned insertion order

Milestone 22 gated the *module* repositories and its record said it had covered
"every other listing in the repository". It had not. The outbox, the inbound
store and the delivery store still walked a `Map` while their SQL sorted, and
two of those listings are reachable over HTTP (`GET /v1/event-subscriptions`,
`GET /v1/event-deliveries/undelivered`). Of eleven probed listings **seven
disagreed between the backends** before this cycle: `delivery.listSubscriptions`,
`delivery.subscriptionsFor`, `registry.list`, `delivery.byStatus`,
`registry.undelivered`, `delivery.all`, `inbound.all` and `inbound.byStatus`.
All eleven agree now, through the same `orderedBy` doctrine milestone 22
established in `src/platform/persistence/list-order.ts`. The milestone 22 record
is corrected additively — the overclaiming sentence stands where it was written,
with the correction beside it.

### 2. `undelivered()` concatenated two ordered queries

`SubscriptionRegistry.undelivered()` called `byStatus("pending")` and
`byStatus("dead")` and concatenated the results. Each half was ordered; the
concatenation was not. Every pending delivery preceded every dead one no matter
how old, so an operator reading the queue to find what has been stuck longest
was shown the wrong row first — and neither backend was "wrong", because both
produced the same wrong answer, which is exactly the failure a cross-backend
comparison alone cannot see. `DeliveryStore` gained `byStatuses`, one query with
`status = any($1::text[]) order by created_at, delivery_id`, and `byStatus`
delegates to it.

### 3. Eight non-total SQL orders

`order by created_at` with rows sharing a timestamp leaves the tie to the plan.
Eight statements across `pg-delivery.ts`, `pg-ingress.ts`,
`geography/pg-repository.ts` and `subscription/pg-repository.ts` were completed
with a primary-key tiebreak.

### 4. Query parsing accepted things it then ignored

The routes read parameters with `query.get()` and `Number()`. Measured
consequences, each now a refusal:

- A **repeated** parameter silently kept the first value and dropped the rest,
  so `?status=failed&status=pending` was answered as if the caller had asked one
  question when they had asked two.
- `?organization_id=` (present, empty) filtered on the empty string and returned
  a count of 0 — indistinguishable from a tenant with no rows.
- `Number()` accepted `0x10` as 16, `1e3` as 1000, `" 5"` as 5, `+5` as 5 and
  `5.0` as 5. A limit of `0x10` is not a limit anybody typed on purpose.

`src/platform/http/query.ts` is the single strict reader now: `optionalParam`
(refuses repeats, empty values and surrounding whitespace), `requiredParam`,
`enumParam` over a closed vocabulary, `limitParam` (`^(?:0|[1-9][0-9]*)$` with
declared default/min/max) and `decimalParam`
(`^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$`). Every read route was migrated to it and
the two local ad-hoc parsers were deleted, so there is one place a parameter can
be read and one place the rules live.

### 5. `localeCompare` matches no Postgres collation

This is the finding no static reading would have produced. The reference
comparator used `String.prototype.localeCompare`, and the assumption that it
approximates a database's text order is false. Measured on the same eight
strings:

| Order | Values |
|---|---|
| Postgres `C`, and JavaScript `<` | `MOVE-c` `Move-b` `"move a"` `move-A` `move-a` `move1` `move_a` `móve` |
| `localeCompare` | a different order entirely |

The local engine's databases are `C`; CI's `postgres:16` service is
`en_US.utf8`. So with `localeCompare` on one side, **which text order CORE
produced depended on where it was deployed**, and the gate would have been green
on one machine and red on the other for reasons nothing in the repository
recorded. Two changes, together: `compareValues` compares code units, matching
`C`; and every text order in SQL that a reference listing is compared against is
pinned with `collate "C"` — country code, region code, city name, service-area
name, plan code, plan-grant feature key, subscriber and event type. The
comparison is now defined by the repository rather than by the server's locale.

## Falsification log

Every gate was broken on purpose and the suite re-run. Ten attempts, ten caught.

| # | Sabotage | Result |
|---|---|---|
| F1 | `delivery.listSubscriptions` returns `Map` insertion order again | 1 failed |
| F2 | `undelivered()` concatenates two ordered queries again | 1 failed |
| F3 | drop `delivery_id` from the SQL undelivered order | **passed at first** — see below; 1 failed after the fixture was fixed |
| F4 | `compareValues` back to `localeCompare` | 2 failed |
| F5 | `limitParam`'s integer regex replaced by `Number.isFinite` | 3 failed |
| F6 | `optionalParam` accepts repeats and empty values again | 36 failed |
| F7 | a new `GET /v1/geography/unmeasured` route added | 1 failed (coverage gate) |
| F8 | `decimalParam`'s regex replaced by `Number.isFinite` | 2 failed |
| F9 | the notification `status` filter reads a free string instead of the vocabulary | **passed at first**; 2 failed after two cases were added |
| F10 | the required tenant on a reconciliation queue becomes optional | 3 failed |

**F3 and F9 are the useful ones.** Both passed against the first draft, and in
both cases the gate — not the code — was the weak part.

F3 passed because every undelivered row in the first fixture had a distinct
`created_at`, so there was no tie for the tiebreak to decide. Two rows were moved
onto the same instant, given **different statuses** so they also exercise the
single-query merge, and **inserted in the opposite order to their ids**, so heap
order and the declared order disagree. Without that inversion a coincidence
would have looked like a guarantee.

F9 passed because the refusal list checked empty and repeated vocabulary values
but never an unknown one. An unknown status was accepted and filtered on,
returning an empty page — which tells the caller "you have no failed
notifications" when what happened is "you asked for a status that does not
exist". Two cases were added (`status=pendng`, `status=FAILED`).

## What this cycle does not claim

- **Unknown query parameters are still ignored.** `?limit=abc` on
  `GET /v1/notification-recipients` — a route with no `limit` — returns 200 and
  every row, because nothing rejects a parameter no handler reads. A caller who
  believes they bounded the response gets everything. This was measured here,
  found while writing F9's neighbours, and is **out of this cycle's declared
  scope**: refusing it needs a per-route parameter declaration and a coverage
  gate over it, which is a change to what every read route is permitted to
  accept. Reserved as milestone 24 rather than half-built or quietly dropped.
- **No pagination contract.** `limit` is capped and validated; there is still no
  cursor, and no route promises stability across pages. Ordering is now total
  everywhere, which is the precondition for a cursor, not a cursor.
- **`GET /v1/geography/service-areas/resolve` is ordered by distance**, a float
  computed per row, and its ties fall through to the repository's `(name, id)`
  order. The test states this rather than pretending distance is a total key.
- **Ten `GET` routes are not listings** and are named in `NOT_LISTINGS` with a
  reason each; the coverage gate asserts the list is exhaustive against the
  router, not against a reader's memory.

## Measured

- Gate: **49 tests**, all green on both backends.
- Suite: **648 passed / 148 skipped** without `DATABASE_URL`; **1211 passed**
  with one (1210 in `test:suite` + 1 in `test:cluster`). Baseline before the
  cycle was 599/1162.
- Local engine: embedded PostgreSQL 18.4, databases in `C`. CI's Postgres half
  runs `postgres:16` in `en_US.utf8` — the divergence in defect class 5 is only
  visible because those two differ.
