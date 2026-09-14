# Two identical requests at the same instant — milestone 33, blocker B-43

Milestone 32 made a retried write safe. It did not make a *concurrent* write
safe, and the difference is one `await`.

This is the record of closing B-43: what was measured before any edit, what the
mechanism now is, which of several legitimate designs was chosen and why, what
was tried in order to make the new gate fail, and what this cycle deliberately
did not do.

## What was measured first

Measured on branch `retry-claim` at `8d31133` — main plus the reservation commit,
with none of this milestone's code written — by firing five byte-identical
`POST /v1/organizations` requests under a single `Idempotency-Key` with
`Promise.all` and counting `organization` rows before and after.

| backend | round | organizations created | replays reported | distinct ids |
| --- | --- | --- | --- | --- |
| reference (in-memory) | 1 | **5** | 0 | 5 |
| PostgreSQL 18.4 | 1 | **1** | 4 | 1 |
| PostgreSQL 18.4 | 2 | **5** | 0 | 5 |
| PostgreSQL 18.4 | 3 | **5** | 0 | 5 |
| PostgreSQL 18.4 | 4 | **4** | 1 | 4 |
| PostgreSQL 18.4 | 5 | **4** | 1 | 4 |

Nineteen duplicate tenants across five attempts to create five.

Two things in that table matter more than the totals.

**The reservation was wrong, and the measurement is what says so.** The
reservation for milestone 33 recorded an expectation of "five organizations in
four of five rounds" on Postgres. The actual distribution was 1, 5, 5, 4, 4 —
the same code and the same database producing one organization once and five
twice. The reservation text is left exactly as written in `ROADMAP.md`;
corrections in this repository are additive, and a reservation quietly edited to
match its outcome is a reservation that can never be wrong.

**The defect was not in the backend.** Both backends duplicated. What decided
whether a given round duplicated was event-loop interleaving: how far the first
twin got before the second was scheduled. `find` returning nothing and `record`
being called later are two separate points in time, and every twin that arrives
between them is told it is the first.

The measurement code was temporary and was deleted rather than committed — its
assertions are now in `tests/retry-claim.test.ts`, where they run on every push
instead of once.

## What it is now

The key is claimed **before** the handler runs, in one statement that cannot be
interleaved.

On PostgreSQL (`src/platform/http/pg-retry.ts`):

```sql
insert into idempotency_key (…, state, claim_token, claimed_at, …)
values (…, 'claimed', gen_random_uuid(), $5, …)
on conflict (method, scope, key) do update
   set state = 'claimed', claim_token = excluded.claim_token, …
 where idempotency_key.expires_at <= $5
    or (idempotency_key.state = 'claimed' and idempotency_key.claimed_at <= $7)
returning claim_token
```

The primary key arbitrates inside the database, so exactly one caller gets a
token back however many arrive together. `do update … where` rather than
`do nothing` because the same statement also performs the two legitimate
takeovers — an expired record, and a claim abandoned before the cutoff — so
recovery costs no extra round trip and needs no background job.

On the reference backend (`src/platform/http/retry.ts`), `claim` reads and writes
with **no `await` between the two**, which on one thread is the same guarantee.
That is load-bearing rather than tidy, and it is why the private `live()` helper
is synchronous: milestone 32's `record` awaited its own `find`, and that single
suspension point is the whole of the reference backend's half of B-43.

The port is `find` / `claim` / `complete` / `release`. `record` is gone — a
method that wrote an answer without having reserved the right to produce it is
the shape of the defect, so it was removed rather than left beside the new path.

Four outcomes, and three of them mean "do not run the handler":

| outcome | the router | the caller sees |
| --- | --- | --- |
| `claimed` | runs the handler, then completes or releases | its own answer |
| `completed` | replays the recorded answer | `201` + `idempotent-replay: true` |
| `in_flight` | refuses | `409` + `retry-after: 1` + `details.claimed_at` |
| `reused` | refuses | `409`, no `retry-after` |

Settlement is fenced on a `claim_token uuid`. A `complete` or a `release` whose
token is no longer the row's own does nothing and says so by returning `false` —
which is what stops a process that was presumed dead, and then woke up, from
recording its answer over the new owner's or deleting the new owner's key.

`CLAIM_HORIZON_MS` is sixty seconds. A claim held longer is not slow work, it is
a process that died holding it, and the next request for that key takes it over.
Without a horizon an abandoned claim would block its key until `expires_at` —
twenty-four hours — and the caller's only remedy would be to invent a new key,
which is the same as having no idempotency at all.

## The decision: a refusal, not a bounded wait

The losing twin could have been made to wait for the winner and then be given
its answer. That is a real design, it is what several payment APIs do, and it
was rejected. Against the five criteria this repository ranks legitimate paths
by:

1. **Truthfulness of measurement.** A wait makes the answer timing-dependent:
   the same two requests return a replay or a timeout depending on how long the
   handler took. A gate over that measures the machine it runs on. A refusal is
   the same answer every time, which is why `tests/retry-claim.test.ts` can
   assert a count rather than a probability.
2. **Fewest duplicated sources of truth.** A wait needs a second timeout beside
   the claim horizon, and two bounds on the same thing disagree eventually.
3. **Strongest automatic enforcement.** "Refuse when a claim is live" is one
   branch a test can reach. "Wait, then poll, then give up" is three, and the
   give-up branch is the one that would answer `409` anyway — so the wait is
   the refusal plus a delay.
4. **Least reliance on manual intervention.** A wait holds a connection per
   twin. A client that retries aggressively under one key turns that into a
   pool exhaustion, which is an operator's problem; a refusal costs one
   statement.
5. **Clearest reviewability.** `409` with `retry-after: 1` and `claimed_at` is a
   complete statement about CORE's state. A caller that reads it knows its
   request is being handled and knows when to ask again.

`409` rather than `429`: the caller did not ask too often, it asked at the same
moment as itself, and `rate_limited` would send it into a backoff loop reading a
budget that is not the thing in its way.

There is one thing this refusal reports wrongly, and it is recorded rather than
hidden: the error body's `retryable` is `false`, because `CoreError` derives the
flag from the code alone and every `conflict` is unretryable. That is right for
a reuse and wrong here — an in-flight refusal does come good by itself, which is
why it carries `retry-after`. Fixing it means letting a refusal override the flag
its code implies, which is a change to the shared error type used by every module,
and making it while measuring this one would be changing the thing under
measurement. It is B-44, and the contract tells callers to read `retry-after`
rather than `retryable` on this response.

## The schema

Migration `0021_idempotency_key_claims.sql` adds four columns and one constraint:

| column | why |
| --- | --- |
| `state` | `claimed` or `completed`, nothing else |
| `claim_token uuid` | fences settlement |
| `claimed_at` | what the horizon is measured from |
| `completed_at` | when the answer was recorded |

`response_status` became nullable, and that is the only loosening in this
schema's history. It is not one: the row now exists *before* the answer does,
because it is what decides which twin may produce one, and
`idempotency_key_state_record_ck` ties the nullability to exactly one state —

```sql
check ( (state = 'claimed'   and response_status is null and response_body is null and completed_at is null)
     or (state = 'completed' and response_status is not null and completed_at is not null)
     or state not in ('claimed', 'completed') )
```

The third clause is not slack. Without it a state outside the vocabulary would
violate both this constraint and `idempotency_key_state_ck`, and Postgres would
be free to name either; the reference backend names one. `tests/check-parity.test.ts`
measures exactly that agreement, and would have been right to fail.

There are two states and no third. A row meaning "nobody is working on this and
there is no answer" would make the absence of a record two things to check
instead of one, so `release` **deletes**. That is the fourth delete path in
`src/`, classified in `delete-actions.ts` and gated by
`tests/delete-parity.test.ts`: the table is neither a foreign-key parent nor a
child and carries no trigger, so there is nothing to cascade and nothing to
orphan. It is not an audit trail either — a released claim recorded no answer,
and `audit_entry` holds what CORE did.

## Falsifications

Every assertion in `tests/retry-claim.test.ts` was checked by breaking the
implementation and confirming the gate fails, then restoring from a byte-exact
snapshot (md5-verified) before the next mutation. Ten mutations, run against
both backends:

| # | mutation | gate fails | cases that caught it |
| --- | --- | --- | --- |
| F1 | reference `claim` reads through `await Promise.resolve(live(…))` — milestone 32's defect restored | yes | five-twins count; reference-store single-grant |
| F2 | Postgres `claim` conflicts always take the row (`or true`), so the insert stops arbitrating | yes | five-twins count, and 4 more |
| F3 | `complete` not fenced on the token, both backends | yes | token fencing; five-twins count; completed-replay |
| F4 | `release` not fenced on the token, both backends | yes | token fencing; release-on-throw |
| F5 | refusing handler's `release` replaced by `true` | **no, at first** | — see below |
| F6 | thrown handler's `release` replaced by `await Promise.resolve()` | yes | release-on-throw |
| F7 | in-flight refusal sends no `IN_FLIGHT_HEADERS` | yes | refused-twin headers; five-twins count |
| F8 | state read before fingerprint, both backends | yes | reuse-under-live-claim; reference-store reuse |
| F9 | `CLAIM_HORIZON_MS` set to 1 | yes | handler-timing margin |
| F10 | abandoned claims never taken over, both backends | yes | horizon takeover; token fencing |

**F5 survived the first run, and that is the useful result in this table.** The
release-on-refusal case had been written the obvious way — a real route sent a
body it would reject — and it tested nothing. The router parses the body
*before* it claims the key, so a malformed request is refused without a claim
ever being taken: there was no claim for the broken release to fail to release.
The gate was passing for a reason unrelated to what it claimed to measure.

The fix was a route registered by the test whose handler *returns* `409` on its
first call and `201` on its second, which is the only way to reach that branch —
every production handler either succeeds or throws. F5 is caught now. The
original scenario was kept as its own case, asserting what it actually
establishes: a request refused before its handler ran takes no claim at all, and
the ordering that makes that true is now gated rather than incidental.

## What this cycle did not do

- **No sweeper.** Abandoned claims are taken over by the next request for the
  same key. A worker that deleted them would be a second mechanism doing what
  one statement already does, with its own schedule to get wrong.
- **No bounded wait**, for the five reasons above.
- **`retryable` is still derived from the error code alone** — B-44, above.
- **No change to `expires_at` or `RETENTION_MS`.** Retention is a separate
  question from liveness and mixing them would put two meanings on one column.
- **Nothing was done about the 148-vs-147 skipped-test discrepancy** between the
  local suite and CI's report. It is still unexplained and still recorded.

## Where this is enforced

| file | what it holds |
| --- | --- |
| `db/migrations/0021_idempotency_key_claims.sql` | the columns, the constraint, and the measurement in its header |
| `src/platform/http/retry.ts` | the port, the reference implementation, the horizon, the refusals |
| `src/platform/http/pg-retry.ts` | the one-statement claim |
| `src/platform/http/router.ts` | claim before handler; complete on 2xx, release otherwise; release on throw |
| `src/platform/persistence/column-shapes.ts`, `row-rules.ts` | the shape and the rules, restated for the reference backend |
| `src/platform/persistence/delete-actions.ts` | why `release` may delete |
| `tests/retry-claim.test.ts` | the gate: 11 cases per backend |
| `tests/support/retry-harness.ts` | the ground both retry gates stand on, extracted so they cannot drift |
| `contracts/openapi/core-v1.yaml` | `KeyReused` now covers the in-flight case and its `retry-after` |
