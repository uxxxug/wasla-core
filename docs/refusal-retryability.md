# A refusal that says when to come back says so twice — milestone 34, blocker B-44

Milestone 33 shipped a refusal whose header said "try again in a second" and
whose body said "this cannot be retried". It said so in the contract, opened a
blocker, and left it. This is the record of closing it.

## What was measured first

Measured on `main` at `cdc09ce`, before a line of the fix was written, by
producing every refusal the published surface can produce: all 52 registrations
driven anonymously, all 52 driven again with a credential and a body they
reject, and the five-way concurrent keyed write from milestone 33.

**105 refusals.**

| code | count | `retryable` | `retry-after` | agree? |
| --- | --- | --- | --- | --- |
| `invalid_request` | 53 | `false` | absent | yes |
| `unauthenticated` | 48 | `false` | absent | yes |
| `conflict` (in-flight twin) | **4** | **`false`** | **`1`** | **no** |

Four contradictions in 105, and all four the same refusal.

The one refusal that already got it right is not in the sweep because a
rate-limited caller has to be provoked rather than found: `rate_limited` is
`429`, `retryable: true`, with a `retry-after` — asserted since milestone 12 in
`tests/rate-limit.test.ts`. Read against it, the rule CORE was already
following everywhere is visible:

> a refusal carries `retry-after` if and only if its body says
> `retryable: true`

and the in-flight twin was the only place it was broken.

## Why it was broken

Not locally. `retryable` was derived from the error code by a set in
`src/platform/errors.ts`:

```ts
const RETRYABLE = new Set(["unavailable", "internal", "rate_limited"]);
get retryable() { return RETRYABLE.has(this.code); }
```

while `retry-after` was written by hand in two unrelated places — inside
`rateLimitHeaders` for the limiter, and as an exported `IN_FLIGHT_HEADERS`
constant in `retry.ts` for the claim, merged into the response by the router.

So the flag and the header were two independent statements about one fact, made
in three files, with nothing that could notice them disagreeing. The in-flight
refusal was not a mistake in the sense of a typo: every line was correct on its
own, and the defect existed in the space between them.

## What it is now

The time to come back is a property of the refusal.

```ts
readonly retryAfterSeconds?: number;

get retryable(): boolean {
  return this.retryAfterSeconds !== undefined || RETRYABLE.has(this.code);
}

get headers(): Readonly<Record<string, string>> {
  return this.retryAfterSeconds === undefined
    ? {}
    : { "retry-after": String(this.retryAfterSeconds) };
}
```

Both the flag and the header are read off one field, so they cannot disagree.
Every path in the router that renders a `CoreError` — the header-parse refusal,
the limiter's refusal, the authentication and body refusals, the retry-safety
refusal and the handler's own — merges `error.headers`, so a refusal that
states a time cannot be sent without its header and a header cannot appear
without the flag agreeing. `IN_FLIGHT_HEADERS` is deleted; `rateLimitHeaders`
no longer writes `retry-after` and returns only the three budget headers.

There are still **two ways to be retryable**, and they are different claims:

| | means | states a time |
| --- | --- | --- |
| the code (`unavailable`, `internal`, `rate_limited`) | CORE or a dependency is unwell and will likely recover | no — CORE does not know when |
| a stated `retryAfterSeconds` | the obstacle is temporary and CORE knows how long | yes |

An override rather than a reclassification: `conflict` still means "the state
moved" and a reuse refusal still reports `retryable: false`. What changed is
that a refusal may now say more about itself than its code implies — and only
in the direction CORE can justify, because CORE states a time only when it
knows the refusal comes good by itself.

A time that is not a whole number of seconds of at least one is **refused at
construction**, the way `anonymous("")` is. `response-headers.ts` refuses such
a header too, but by then the error exists and something downstream has to
decide what to do with a refusal it cannot render.

## The decision: keeping `details.retry_after_ms`

Left open at reservation, because removing a published field is a breaking
change and this milestone is about not having two representations of one thing.

The 429 body carries `details.retry_after_ms` and the header carries whole
seconds rounded up. Those are two numbers for one duration — but not two
sources of truth: both are computed from the same `decision.retry_after_ms`
inside `rateLimited`, neither can move without the other, and
`tests/refusal-retryability.test.ts` asserts the header equals
`retryAfterSeconds(details.retry_after_ms)` on a real refused request. The
millisecond precision is useful to a client scheduling its own backoff and the
whole second is what RFC 9110 permits on the wire. Dropping the detail to make
a tidiness point would break callers for nothing, so it stays, and the rounding
lives in one exported function (`retryAfterSeconds`) rather than in two
expressions.

## Falsifications

Ten mutations, each applied to a byte-exact md5-verified snapshot, measured
against five gates (`refusal-retryability`, `rate-limit`, `retry-claim`,
`retry-idempotency`, `http-response-header-declaration`) on both backends, then
restored.

| # | mutation | gate fails | caught by |
| --- | --- | --- | --- |
| F1 | `retryable` derived from the code alone again — **B-44 restored exactly** | yes | one-field rendering; in-flight twin, both backends |
| F2 | `CoreError.headers` always empty | yes | 6 cases across 3 files |
| F3 | the in-flight refusal states no time | yes | 6 cases across 2 files |
| F4 | a retry time of `0` is accepted | yes | the construction-time refusal |
| F5 | the rate-limited refusal states no time | yes | 6 cases across 3 files |
| F6 | `rateLimitHeaders` writes `retry-after` by hand again | yes | budget-headers exactness |
| F7 | the limiter's answer drops the error's own headers | yes | 6 cases across 3 files |
| F8 | the retry-safety refusal drops the error's own headers | yes | 6 cases across 2 files |
| F9 | the retry time rounds down instead of up | yes | header-vs-detail agreement |
| F10 | every `conflict` states a time, so a reuse claims to come good | yes | reuse stays untimed, both backends |

**A finding, reported rather than smoothed over.** The whole-surface sweep —
the case that asserts the biconditional over all 105 refusals and is the one
written to stop B-44 recurring — **did not catch F1**, the exact restoration of
B-44. It cannot: every refusal that sweep reaches is `invalid_request` or
`unauthenticated`, neither of which states a time, so the biconditional holds
vacuously on that side no matter what `retryable` is derived from. What caught
F1 was the three named cases about the refusals that do state a time.

That is worth saying plainly, because the sweep is the case that *looks* like
the guarantee. It is a real one — it is what fails when a new refusal is added
with a time and a stale flag, which is how B-44 would come back — but it is a
guard against the future, not the gate that proves the present. The gate that
proves the present is the named cases, and the two are not interchangeable. The
sweep was kept as written rather than stretched to reach a timed refusal, and
its limit is now stated in the file itself.

## What this cycle did not do

- **`retryable` is still derived, not declared.** 170-odd raise sites each
  stating their own retryability would be 170 places to get it wrong, and the
  code is a good default for all but a handful. The override exists for the
  handful.
- **No new error code.** An `in_flight` code was considered and rejected: the
  state CORE holds is what prevents the request, which is what `conflict`
  means, and a code per situation is how an error vocabulary stops being one.
- **`details.retry_after_ms` stays**, for the reasons above.
- **Nothing was done about the 148-vs-147 skipped-test discrepancy** between
  the local suite and CI. Still unexplained, still recorded.

## Where this is enforced

| file | what it holds |
| --- | --- |
| `src/platform/errors.ts` | `retryAfterSeconds`, the two ways to be retryable, the construction-time refusal |
| `src/platform/http/rate-limit.ts` | `retryAfterSeconds(ms)`, the limiter stating its time on the error, budget headers only |
| `src/platform/http/retry.ts` | `IN_FLIGHT_RETRY_AFTER_SECONDS`, stated on the refusal itself |
| `src/platform/http/router.ts` | every `CoreError` render path merges `error.headers` |
| `tests/refusal-retryability.test.ts` | the gate: the sweep, the four refusals, the field |
| `contracts/openapi/core-v1.yaml` | `KeyReused` now says the flag and the header agree |
