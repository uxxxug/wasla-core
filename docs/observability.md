# Operating CORE: metrics and ingress rate limiting

Milestone 8. This document is the contract for what CORE tells an operator about
itself, and for what it refuses to tell anyone.

The question the milestone actually asks is not "is there a `/metrics`
endpoint". It is: **can somebody on call answer, from inside the system, how much
work arrived, how much was refused, how much is waiting, how much is retrying,
how many leases expired, what failed for good, how big the notification backlog
is, and how many financial decisions are queued — without learning anything they
must not learn and without a second source of truth appearing next to the
database.**

## What was added, and what deliberately was not

There is **no middleware layer** in CORE. `Router.handle()` is the single funnel
every HTTP request passes through, so both the instrumentation and the limiter
live there. Adding a middleware abstraction to host them would have been an
architecture change bought with nothing: one call site does not need a pipeline.

There is **no metrics abstraction** either. One registry class, one declared
catalogue, one renderer. No adapter interface, no pluggable exporter, no tracing
layer — nothing in CORE consumes those today, and an unused abstraction is a
maintenance cost that looks like foresight.

## Exposition format

**Prometheus text exposition, version 0.0.4**, served from a single
`GET /metrics` as `text/plain; version=0.0.4; charset=utf-8`.

Chosen because it is the format for which a consumer already exists in every
plausible deployment, it is machine-parseable without a schema, it carries type
and help metadata inline, and it needs no client library. The alternative —
inventing a JSON shape — would have required writing the consumer as well.

The exposition is:

- **deterministic**: metrics render in catalogue order, label sets in insertion
  order within a metric, so two scrapes of unchanged state are byte-identical.
  A diff between scrapes is signal, not noise.
- **free**: rendering walks in-memory maps. No query, no lock, no transaction,
  no allocation proportional to traffic.
- **read-only**: the scrape changes no state. Asserted in
  `tests/observability.test.ts` by snapshotting the outbox, inbound events,
  notifications, audit trail and reconciliation queues around repeated scrapes.

Note the one thing a scrape *does* do: it counts itself, like any other request.
`core_http_requests_total{route="/metrics"}` therefore grows by one between two
consecutive scrapes. That is the honest answer — the scrape is a request — and
the test asserts exactly that difference and nothing else.

### Who may scrape it

`/metrics` is **unauthenticated and system-level**. This is safe only because the
exposition contains no tenant, no identifier and no secret (see *Privacy*), and
it is correct only if the endpoint is not reachable from the public internet.
Where CORE's HTTP surface is exposed is **B-5**, still undecided. Until B-5 is
decided, the deployment must keep `/metrics` on an internal network or behind the
same boundary as `/health` and `/ready`. Recorded, not assumed away.

## The metric catalogue

Declared in `src/platform/observability/metrics.ts`. The registry **refuses** any
metric name that is not in the catalogue, and any label set that is not exactly
the declared one — a missing label, an extra label and a typo are all test
failures rather than a mystery series in somebody's dashboard.

### Ingress

| Metric | Type | Labels | Answers |
| --- | --- | --- | --- |
| `core_http_requests_total` | counter | `route`, `method`, `status` | how much arrived, and what the outcome distribution is |
| `core_http_request_duration_seconds` | histogram | `route`, `method` | how long the edge takes, per route |
| `core_http_rate_limited_total` | counter | `rate_class`, `subject_kind` | how much was refused for asking too often |

`route` is the **route template** (`/v1/fulfillments/:fulfillment_id`), never the
concrete path. An unmatched path becomes the literal `unmatched`: an unknown path
is attacker-controlled text, and using it as a label would let a caller create
unbounded series at will. `status` is the exact numeric status, because "how many
401s" and "how many 500s" are different questions and a success/failure boolean
cannot answer either.

### Workers

| Metric | Type | Labels | Answers |
| --- | --- | --- | --- |
| `core_worker_claims_total` | counter | `worker` | how many items were leased |
| `core_worker_outcomes_total` | counter | `worker`, `outcome` | what happened to them |
| `core_worker_item_duration_seconds` | histogram | `worker` | how long one item takes |

`worker` ∈ `outbox_relay`, `inbound_dispatcher`, `event_delivery`,
`notification`. `outcome` ∈ `completed`, `retried`, `failed_permanent`, `fenced`,
`reclaimed`.

`retried` and `failed_permanent` are separate counters because they are separate
operational facts: a retry is the system working, a permanent failure is work
that will never happen unless a person acts. `fenced` is an acknowledgement
refused because the claim token was stale — the B-22 protection firing — and it
must never be counted as a completion, or the counters would claim one message
was delivered twice. `reclaimed` is a lease that expired and was taken back.

Item duration is measured with `process.hrtime.bigint()`, not with the injectable
domain clock: a test that freezes time must still be able to advance leases
without producing fictional latencies.

### Queue depth and the financial queues

| Metric | Type | Labels | Answers |
| --- | --- | --- | --- |
| `core_queue_depth` | gauge | `queue`, `state` | how much work is waiting |
| `core_reconciliation_depth` | gauge | `queue` | how many financial situations need a human |
| `core_sample_timestamp_seconds` | gauge | — | when the gauges above were last true |
| `core_sample_failures_total` | counter | — | how often sampling itself failed |

`queue` ∈ `outbox`, `inbound` (accepted inbound events), `event_delivery`,
`notification`.
`state` is that queue's own status vocabulary plus `retrying`.

**`retrying` is derived, not stored.** No table has a `retrying` status; a
retrying row is a pending row with at least one attempt spent
(`status = 'pending' and attempts > 0`). It is computed inside the same aggregate
query on both backends, and asserted identically for both, so the gauge cannot
describe a state the system does not have.

`core_reconciliation_depth{queue}` covers `inconsistent`,
`pending_financial_decision` and `stale_holds` — the three existing
reconciliation queues, as **counts only**. It reports the size of a queue a human
has to work through. It does not report which tenant is in it.

### Why gauges need a timestamp, and why the scrape does not refresh them

The depth gauges come from aggregate queries, so they are refreshed by
`DepthSampler.sample()`, which the process that runs CORE calls on its own
cadence — **not** by the scrape. If the scrape refreshed them, every scrape would
be four-plus aggregate queries, monitoring frequency would become database load,
and the endpoint would fail exactly when the database is unwell, which is exactly
when it is needed.

The cost of that choice is staleness, so it is made visible rather than hidden:
`core_sample_timestamp_seconds` says when the gauges were last true, and
`core_sample_failures_total` counts sampling errors. A gauge with no fresh
timestamp is a gauge nobody should trust, and an operator can alert on the
timestamp itself. Sampling failures never propagate: a failed sample leaves the
previous values and the old timestamp in place rather than publishing zeros,
because a zero and "I could not look" are different facts.

Every declared state is always present, at zero when empty. "No dead rows" and
"the sampler is gone" must not look the same.

## Privacy: system-level only, deliberately

**Decision: every metric is system-level. No metric carries a tenant dimension.
There is no tenant-scoped metric, and the two are not mixed.**

The alternative — tenant-scoped metrics behind authorization — was rejected for
this milestone. Metrics are pull-based and coarse; making them per-tenant means
the exposition itself becomes tenant data, which then needs authorization at
scrape time, per-tenant filtering, and a rule for what an operator's own scrape
returns. A count is enough to leak: `core_http_requests_total{organization_id=…}`
tells any reader that a particular tenant exists, roughly how large it is, and
when it is having trouble. Per-tenant operational answers already exist, already
authorized, through the reconciliation and delivery endpoints.

Enforced, not merely intended:

- The catalogue is asserted to declare **no** dimension named for a tenant or an
  entity (`organization_id`, `fulfillment_id`, `event_id`, `recipient_id`,
  `subject_hash`, `path`, `address`, …). High cardinality and identifiability are
  the same problem here, and the assertion catches both.
- Every label **value** is checked against
  `/^[a-z0-9_.:\/-]{1,96}$/` and additionally rejected if it is uuid-shaped or a
  long opaque token-like run of characters. An email address, a phone number, an
  api key and a random id all fail. The rejection message never echoes the value
  it refused — a guard that logs the token it rejected has leaked the token.
- A full lifecycle test drives an event through ingress, dispatch, publication
  and a notification whose channel adapter fails with an error containing both
  the recipient's address and an api key, then asserts the exposition contains no
  token, no organization id, no order reference, no identity id, no address, no
  provider error text — and no uuid anywhere at all.

## Ingress rate limiting

### Where it lives

At the HTTP edge, in `Router.handle()`, **after route matching and before any
handler runs**. Not in domain services: a limit inside a service would be a
business rule with a status code attached, would fire for background work done on
nobody's behalf, and would have to be repeated in every service.

It does **not** participate in the request's transaction. The counter is one
statement of its own, taken on the pool, before any handler opens a transaction —
so a rolled-back request cannot refund budget, and a refusal cannot roll back
domain work.

**Background workers are not limited, by construction.** The outbox relay, the
inbound dispatcher, the delivery worker and the notification dispatcher are
invoked directly by the process that runs them and never pass through the router.
There is no exemption list to forget to update; there is no code path from a
worker to the limiter. A test asserts the workers keep draining while the edge is
refusing.

### The subject: what the limit counts against

| Kind | Key | When |
| --- | --- | --- |
| `credential` | sha256 of the presented bearer token | whenever an `Authorization: Bearer` header is present |
| `network` | sha256 of the first hop of `x-forwarded-for` / `x-real-ip` / `x-client-ip`, else the constant `unattributed` | only when there is no bearer token at all |

The credential is the caller's logical identity: MARKET's credential and MOVE's
credential are different subjects, and two callers behind one NAT are still two
subjects. The network address is the fallback for genuinely anonymous traffic,
never the primary key, because an address is neither stable for one caller nor
unique to one caller. Traffic with neither is limited together under one bucket
rather than being exempt.

Only the **hash** is ever stored, logged or exported. Neither the token nor the
address appears in the counter table, the metrics, the response body or the
headers — and the metrics carry only `subject_kind`, never the hash, because a
per-subject label is a per-caller time series.

**Organization is deliberately not the key.** Resolving a token to an
organization requires a session lookup — a database read *before* the limiter,
which would mean a flood of invalid tokens still costs a query per request, the
exact thing the limiter exists to prevent. Per-credential is the strictest key
obtainable without paying that cost. A malformed or expired token is still a
`credential` subject for the same reason: discovering that a token is invalid is
itself work, and letting garbage tokens fall back to the shared network bucket
would let them dilute it.

### Policy

Fixed window, aligned to the epoch so every instance agrees on boundaries.
Limits are per subject, per route class, per window; they are constructor
arguments, never read from the environment, because CORE does not read
configuration — the composition root decides.

| Class | Routes | Default limit / 60 s |
| --- | --- | --- |
| `ingress_events` | `POST /v1/events` | 600 |
| `write` | any other non-GET | 120 |
| `read` | any other GET | 300 |
| `unmatched` | no route matched | 60 |

`/health`, `/ready` and `/metrics` are **never** limited. Throttling a health
check makes a healthy deployment look unhealthy for the wrong reason, and
throttling the scraper blinds monitoring exactly when a flood is in progress.
Those routes also advertise no `x-ratelimit-*` headers: they have no budget.

Route **class**, not route, because the class is both a policy key and a metric
label: one limit per route would be a policy nobody can reason about and
unbounded label cardinality.

Fixed rather than sliding: a fixed window is one atomic statement, a sliding
window is a durable log of request timestamps per subject that grows with
traffic. The known cost is the boundary burst — a caller can spend its budget at
the end of one window and again at the start of the next, so the true worst case
is twice the limit over a window boundary. Documented, bounded, accepted.

### What a refusal looks like

HTTP **429**, error code `rate_limited`, `retryable: true`:

```
HTTP/1.1 429
retry-after: 37
x-ratelimit-limit: 600
x-ratelimit-remaining: 0
x-ratelimit-reset: 1789000000

{ "code": "rate_limited", "message": "rate limit exceeded for this credential and route class",
  "details": { "retry_after_ms": 36512, "limit": 600 }, "retryable": true, "correlation_id": … }
```

- **429, never 500 and never a domain error.** A caller must be able to
  distinguish "you asked too often, wait" from "CORE is broken" from "your
  request was wrong". `rate_limited` is a first-class code in
  `src/platform/errors.ts` mapped to 429 and marked retryable, not a repurposed
  `unavailable`.
- `retry-after` in whole seconds, rounded up, minimum 1 (RFC 9110): a
  `retry-after: 0` invites an immediate retry that would be refused again.
  Obeying it is tested to actually work.
- `x-ratelimit-limit` / `-remaining` / `-reset` on allowed responses too, so a
  well-behaved client can slow down before it is refused.
- The message carries no subject, no hash and no address. The caller already
  knows who it is; anybody else reading the response must not learn it.
- Refused requests are still counted, so a caller that keeps hammering stays
  refused for the rest of the window instead of being let back in by its own
  excess.
- **A refused request changes nothing.** Tested by snapshotting fulfillments,
  ledger transactions, payment authorizations, outbox, inbox, inbound events,
  event deliveries, notifications and the audit trail around a refused request.
  It also does not consume the request's idempotency: the same event, resent in a
  fresh window, is accepted as a first delivery.

### Concurrency

The store contract is a single operation, `hit(key, window) -> post-increment
count`. It returns the count rather than a boolean so the decision belongs to the
policy, and — more importantly — so there is **no version of the code where a
`select` precedes an `update`**. That read-then-write shape is exactly the bug
found and fixed as **B-22** in the worker claim: two callers both reading 99 of
100 and both being allowed.

- Postgres: one `insert … on conflict … do update set hits = hits + 1 …
  returning hits`. The statement takes a row lock for its own duration, so
  concurrent callers at the boundary receive 100 and 101, never 100 and 100. Run
  on the pool, never inside the request's transaction scope.
- Memory: atomic because the increment contains no `await` and the runtime is
  single-threaded.

The memory limiter is correct **within one process only**. Two instances each
keep their own counters, so the effective limit becomes the policy times the
number of instances. That is why the Postgres store exists, and why the limiter
backend is bound to the persistence bundle rather than selected separately —
wiring the durable persistence next to an in-process limiter would silently
multiply every limit.

The concurrency guarantee is asserted on **real Postgres**: 40 requests issued
before anything is awaited, over a pool with `max: 16`, against a limit of 5 →
exactly 5 admitted, 35 refused, and the stored counter equal to 40. The test was
falsified against a deliberately racy read-then-write implementation of the same
store, which admitted all 40 — so the assertion is known to be capable of
failing.

### Housekeeping

Old windows are removed by `prune(before)`, an operator loop, never a request
path. The table only ever grows by one row per (subject, class, window) and old
rows are deletable without touching the live window; both are tested.

## Measured cost

`scripts/measure-ingress-overhead.mjs`, 20 000 requests per configuration
against the same no-op handler (Node 20, local Postgres 18):

| Configuration | mean | p50 | added at p50 |
| --- | --- | --- | --- |
| bare router | 10.1 µs | 7.95 µs | — |
| + metrics | 9.7 µs | 9.0 µs | ≈ +1 µs |
| + metrics + limiter (memory) | 13.7–15.7 µs | 12.8–14.3 µs | ≈ +5–6 µs |
| + metrics + limiter (Postgres) | ≈ 960 µs | ≈ 208 µs | ≈ +200 µs |

Read honestly: **the metrics are free** — one map lookup and two integer
increments per request, within run-to-run noise, and no query, lock or
transaction is added anywhere. The in-process limiter is a few microseconds. The
**shared** limiter costs one database round trip per request (≈ 0.2 ms at p50
here), which is the intrinsic price of a limit that holds across instances, and
is the reason the backend is a deliberate choice rather than a default. Nothing
in the sampler runs on a request path.

## What Milestone 8 does not do

- No tracing, no span export. Nothing consumes it, and `correlation_id` already
  threads through the audit trail and the event envelopes.
- No alert rules. Those belong to the deployment, not to CORE.
- No push, no gateway, no second store of derived state. The database remains the
  only source of truth; every gauge is a sampled view of it, timestamped so its
  age is visible.
- B-23, D-6, D-7 and D-8 are untouched. Any contract change belongs to a
  contracts cycle.

## Blocker recorded here: B-24

**Lease expiry is not countable for three of the four workers.** The outbox
relay, the inbound dispatcher and the delivery worker carry their lease on
`next_attempt_at`, which is also the scheduled-retry field. When such a row
becomes claimable again, nothing distinguishes "a worker died holding this" from
"this was scheduled to be retried now", so `core_worker_outcomes_total{outcome=
"reclaimed"}` can only be reported by the notification store, which has a
separate `reclaimExpired` and a `claim_token`.

Making it countable for the other three needs a schema change — a `processing`
status or a `claimed_at` column — which is a contract-adjacent change to the
eventing tables and belongs to its own cycle. **Recorded as B-24, not invented
here.** Until it is done, an expired lease elsewhere is visible indirectly, as a
claim count that exceeds completions plus retries plus permanent failures.
