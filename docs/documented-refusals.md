# A route documents every refusal it can produce

Milestone 36.

## What was wrong

The answer surface has been gated from the contract *outwards* since milestone 27:
every status the contract documents must be producible, every produced body must
satisfy its documented schema, every response must declare the headers it sets
(28), and `401` must be documented wherever it can happen (30).

Nothing gated the other direction — **a status a route can actually answer that
the contract never mentions**. A caller generating a client from
`contracts/openapi/core-v1.yaml` had no branch for it, and no test would ever
have said so.

## What was measured, before anything was changed

On `main` at `2390649`, all 52 registrations were driven twice with a credential:
once with a body naming a property no route in CORE declares, once with no body
at all. Observed refusals were compared against the documented set.

| Finding | Count |
| --- | --- |
| Operations answering a refusal they do not document | **33 of 52** |
| …answering an undocumented `400` | 33 |
| …answering an undocumented `404` | 2 |

The 33 include `GET /health`, `GET /ready` and `GET /metrics`, which documented
only `200`. The two `404`s are `POST /v1/fulfillments/{fulfillment_id}/cancel`
and `GET /v1/geography/regions/{region_id}/cities`, both of which answer `404`
for an id that does not exist and documented it nowhere.

A second, wider defect surfaced while writing the gate for the first, and is the
more serious of the two:

| Finding | Count |
| --- | --- |
| Documented refusals with **no `content`** — a status code and a sentence, no body schema | **18** |
| Documented refusals declaring **none of the headers they carry** | 23 |

Those 18 were written as `"403": { description: Caller is not an operator }`.
Milestone 27's schema gate compares a produced body against its documented
schema; where there is no schema there is nothing to compare, so it passed them
by. A caller generating a client got a status with no type behind it.

## What was decided, and what was rejected

**The three probe routes keep refusing.** `/health`, `/ready` and `/metrics`
answer `400` to a request carrying a body they do not read, because milestone
25's boundary rule applies to every route without exception. The alternative was
to exempt them, so a liveness check cannot be made to refuse by a stray body.
That was rejected: an exception in a uniform boundary rule is three more branches
in the router and a rule with a hole in it, bought to remove a refusal that a
correct caller never triggers. The refusal is real and deliberate, so it is now
documented.

**It is documented against a new `UnlimitedError` response, not the shared
`Error`.** These three routes are on `UNLIMITED_ROUTES` and send no
`x-ratelimit-*` headers. Pointing their `400` at `Error` would publish three
headers CORE does not set there — and milestone 28's gate would not have caught
it, because it compares documented headers against real ones for the status each
operation returns on a *successful* call, and `400` is not that status.

**One reservation claim was wrong and was corrected rather than edited.** The
reservation recorded that `POST /v1/events` documents `429` but could not be
driven to produce one in 400 consecutive calls, and called it "unverified". The
`ingress_events` rate class allows **600** requests a window, against 120 for a
write and 300 for a read, deliberately, because ingress is the one endpoint
another system calls in volume. 400 calls is under the budget: the route was
right and the probe was short. The correction was appended beside the original
claim in `ROADMAP.md` and pushed as its own change before implementation began.

## What is enforced now

`tests/documented-refusals.test.ts`, in both CI jobs (no database required):

1. **Every refusal the matrix produces is documented** for the operation that
   produced it. The matrix is uniform across all 52 registrations: anonymous, a
   body naming a property no route declares, no body, an unknown path parameter,
   and no `Idempotency-Key`.
2. **Coverage** — the operations driven are exactly the operations the contract
   publishes, so a route added later cannot go unmeasured.
3. **Every refusal produced satisfies the documented `Error` schema.**
4. **Every documented refusal declares the headers it carries**, derived from
   `rateClassFor` rather than from a second list: the correlation header always,
   the three budget headers exactly when the route has a rate class, `retry-after`
   required on `429` and permitted on a keyed route's `409` (the in-flight twin
   carries one, the reuse refusal does not — milestones 33 and 34).
5. **Every documented refusal documents a body.**
6. **`429` is documented by exactly the routes a real budget can refuse**,
   decided per rate class rather than per route: one representative of each of
   `ingress_events`, `write` and `read` is driven past its actual limit and must
   answer `429`; the three `UNLIMITED_ROUTES` are driven past every budget in the
   policy and must never answer one.

### What this gate does not claim

The matrix reaches `400`, `401`, `403` and `404`. It does **not** reach `409` or
`500`, and this file makes no claim about them; the routes documenting those are
covered by their own milestones' tests. The status set it reaches is asserted
rather than described, so widening it later is a decision somebody makes on
purpose. This is stated because a whole-surface sweep reads as a stronger claim
than it is — the lesson recorded in milestone 34, where the sweep held vacuously.

## Falsification

Ten mutations, each applied to a clean tree, the gate run, the tree restored.

| # | Mutation | Caught by | Result |
| --- | --- | --- | --- |
| F1 | `/health` stops documenting the `400` it produces | assertion 1 | caught |
| F3 | the new `404` on the cancel route is dropped again | assertion 1 | caught |
| F5 | an unlimited route's `400` is pointed at the shared `Error` | assertion 4 | caught |
| F6 | `UnlimitedError` loses the one header it does carry | assertion 4 | caught |
| F7 | a refusal reverts to a status code with a sentence, no body or headers | assertions 4 and 5 | caught |
| F8 | `/health` is taken off `UNLIMITED_ROUTES`, so it can be throttled while documenting no `429` | assertions 4 and 6 | caught |
| F9 | the event ingress loses its own rate class | assertion 6 | caught |
| F10 | the router gains a route the contract never publishes | assertions 1 and 2 | caught |
| F12 | a documented refusal keeps its description but loses its body schema | assertion 5 | caught |
| F13 | a refusal stops carrying `correlation_id` in its body | assertion 3 | caught |

**10 of 10 caught.** Three of them (F1, F3, F5) initially reported "no anchor"
rather than a result — the mutation text did not match the file — and were
re-anchored and re-run rather than counted. Runner `/tmp/falsify36.py`,
specification `/tmp/mut36.json`; both are outside the repository, as in previous
cycles, because they mutate the tree they run against.

## Measured after

`npm test` against `postgres:16` locally: 1389 passed across 62 files, plus the
cluster pass, all green. Without a database: 806 passed, 147 skipped.
