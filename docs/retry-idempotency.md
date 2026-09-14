# Retry safety is a property of the route

Milestone 32. Every route now declares what a second, identical call to it does,
and for the five routes that had no answer of their own the router supplies one
against the caller's `Idempotency-Key`.

This is the same shape as the two milestones before it — milestone 30 made
authentication a property of the registration, milestone 31 made entitlement one
— applied to the question a caller asks after a timeout: *may I send that
again?* Until now CORE answered it differently on every route and said so
nowhere.

## What was true before, measured rather than recalled

Taken on `main` at `bd92b69`, before a line was edited, by re-issuing each of
the 29 write routes' **own recorded request** a second time, byte-identical,
against the state the response gate's scenario left, and counting the rows of
all 25 business tables the reference registry holds around each call.

| Request, sent twice | Answer the second time | Rows created |
| --- | --- | --- |
| `POST /v1/organizations` | **201** | `organization` 2 → 3 |
| `POST /v1/geography/cities` | **201** | `city` 1 → 2 |
| `POST /v1/geography/service-areas` | **201** | `service_area` 1 → 2 |
| `POST /v1/subscriptions` | **201** | `subscription` 1 → 2, `subscription_period` 1 → 2, `payment_authorization` 5 → 6, `ledger_transaction` 6 → 7, `outbox` 26 → 30 |
| `POST /v1/sessions` | **201** | `session` 3 → 4 — correct |
| `POST /v1/geography/countries` | **201** | **none** — the row was overwritten |
| `POST /v1/memberships`, `POST /v1/plans`, `POST /v1/plans/{plan_id}/activate` | **409** | none |
| every other write route | 200/201/204 | none |

The subscription is the expensive one: a duplicate is a second recurring charge
against the same wallet. The organization, the city and the service area are
duplicates nothing can distinguish afterwards — none of the three has a natural
key, so no later read can tell which row was the retry.

`POST /v1/geography/countries` is the one place this measurement **contradicts
the reservation**, which expected a second country row. There is none: the
country's primary key is the code the caller sends and the repository upserts
it, so the repeat silently overwrote the existing row. That is a quieter form of
the same defect — whichever call arrives second decides the country's name and
default currency — and it is why the route is declared `keyed` anyway rather
than `natural`.

The routes that already collapsed a repeat did so by four mechanisms that
nothing named as a policy: a natural-key upsert (`/v1/identities`,
`/v1/wallets`, `…/usage` answer `200` rather than `201` the second time), a
caller-supplied reference (`/v1/payment-authorizations` on `business_reference`,
`/v1/events` on `event_id`), a uniqueness constraint
(`/v1/event-subscriptions`), and a state transition that is a no-op once it has
happened (`…/capture`, `…/void`, `…/cancel`, `…/retire`, `…/activate`,
`…/deactivate`, `…/collect`). `POST /v1/geography/regions` deduplicated on
`(country_code, code)` while `POST /v1/geography/cities` beside it, in the same
module, did not.

No route read an `Idempotency-Key` header. Sending one changed nothing, because
milestone 14's header declaration means an undeclared header is never read at
all. The `idempotency_key` table from migration 0001 — `key`, `scope`,
`response_body`, `created_at`, `expires_at` — had never held a row, and had no
column for the request or for the status.

## What it is now

### The declaration

`src/platform/http/retry.ts` defines three mechanisms, because there are three
honest answers and no fourth:

- **`natural(reason)`** — the route already collapses a repeat, and the reason
  names *how*: the natural key, the business reference, or the transition that
  is a no-op the second time.
- **`keyed(reason)`** — the route has no natural key to collapse on, so the
  caller supplies one and the router collapses the repeat on its behalf.
- **`newEachTime(reason)`** — a repeat legitimately creates a new thing.
  `POST /v1/sessions` is the case: two calls mean two sessions.

Every factory refuses an empty reason. `SAFE` is `natural` for reads. The
default for `add(...)` is **`KEYED_BY_DEFAULT`**, so a forgotten declaration
fails closed: the cost of that default being wrong is that a caller has to send
a header it did not expect to, while the cost of the opposite default being
wrong is a second organization and a second recurring charge.

`POST /v1/access/check` is declared `natural`, not `keyed`: it writes nothing at
all — it reads a principal's permissions and answers — so there is nothing for a
repeat to duplicate, and requiring a key to *ask a question* would be the
mechanism spreading beyond what it protects.

### The enforcement

In `Router.handle`, for `mechanism === "keyed"` only, **after** authentication,
selection and body parsing, and **before** the handler:

1. the key is read through `RequestHeaders` (declared in
   `platform/http/headers.ts`, like every other header CORE reads); missing →
   **400 `invalid_request`**, naming the header and why;
2. the fingerprint is SHA-256 over the method, the route **template** and the
   canonical JSON of the *parsed* body;
3. a record with the same fingerprint → its status and body, unchanged, plus
   `idempotent-replay: true`;
4. a record with a different fingerprint → **409 `conflict`**, "this
   Idempotency-Key was already used with a different request";
5. otherwise the handler runs, and **only a 2xx answer is recorded**.

Nothing above that block moved. Rate limiting, authentication, selection and
body parsing keep milestone 30's ordering exactly.

The order is deliberate. After authentication, because a `401` must never be
answerable from a record and who the caller is decides whether it reaches the
route at all. After the body parse, because the fingerprint is a fingerprint of
the request CORE *understood*, and a body CORE cannot parse is not a request it
can record an answer for. Before the handler, because collapsing a repeat after
the work has been done collapses nothing.

### The record

`db/migrations/0020_idempotency_key_records.sql` gives the 0001 table the three
columns it was missing — `method`, `request_fingerprint`, `response_status` —
moves the primary key from `(key)` to **`(method, scope, key)`**, and constrains
the status to 2xx. `scope` holds the route template.

- **The key is scoped to one route.** A key is only unique within the caller's
  own naming; two systems retrying two different calls with the same generated
  string must not be answered from each other's record.
- **`response_body` stays nullable**, and SQL `NULL` means "the recorded answer
  carried no body" on both backends. A `jsonb NOT NULL` column would force a
  JSON `null`, which the reference backend cannot express — its rows are
  JavaScript objects, where the two nulls are one value — and that is the
  divergence B-12 is about.
- **`idempotency_key_response_status_ck`** is what makes "a refusal is never
  recorded" un-bypassable. The rule lives in the router; the CHECK is what stops
  a future change from quietly breaking it, on both backends
  (`ROW_RULES.idempotency_key` restates it for the reference store, and
  `tests/check-parity.test.ts` probes both).
- **Expiry is 24 hours**, and an expired record is *absent*: `find` filters on
  `expires_at` rather than handing back a stale row for the caller to judge.
  That is also what makes the table finite without a sweeper.

## After

| Request | Answer now |
| --- | --- |
| `POST /v1/organizations` with no `Idempotency-Key` | **400 `invalid_request`**, naming the header; nothing written |
| the same request twice with the same key | **201** then **201** with `idempotent-replay: true`, the same body, one row |
| the same key with a different body | **409 `conflict`**, and the first answer still replays afterwards |
| a different key with the same body | **201** and a genuinely new row |
| an invalid body, then a corrected one under the same key | **400** then **201** — a refusal is not recorded |
| a `403`, then an entitled caller with the same key | **403** then **201** |
| the same key on two different routes | two records, two answers |
| the same key 24 hours later | the handler runs again |

The five keyed operations publish the header as a shared component
(`components/parameters/IdempotencyKey`), a `409`, the
`idempotent-replay` response header on their success status, and a description
paragraph that says plainly that requiring the header **is a breaking change**.

## The difference between the backends, named

A replay restores the same JSON **document**, not the same bytes. Postgres
`jsonb` stores a parsed document and orders its keys itself, by length and then
bytewise, so a body sent as
`{"organization_id":…,"name":…}` replays as `{"name":…,…,"organization_id":…}`.
The values are identical and a JSON object is unordered by definition, so no
caller can depend on the difference — but it is a difference, it was found by
running the gate against Postgres after it passed in memory, and the gate
asserts document equality through the same canonicaliser the fingerprint uses
rather than claiming a byte equality CORE does not deliver.

## What this does not claim

**It is not concurrency-safe.** The record is written *after* the handler
answered, so two identical requests in flight at the same instant can both reach
the handler; the second is collapsed only once the first has been recorded.
Closing that needs the record claimed before the work, inside the handler's own
transaction — a different design, and a different cycle. Stating the bound is
the alternative to implying a guarantee the code does not give.

**A replay does not restore response headers**, only the status and the body.
None of the five keyed routes sets a header of its own today, so nothing is lost;
a route that started to would need this decision revisited.

**A `natural` reason is not proved by the gate.** The repeat case proves a
repeat creates no row; it cannot prove *which* mechanism collapsed it. A route
whose upsert was replaced by a silent swallow would still pass, and the reason
string is what a reviewer reads.

**A store failure is visible but not fatal.** A `find` that throws refuses the
request with `500` — nothing has been written at that point, and running the
handler with the protection silently absent would be doing exactly the work the
route declared it must not do twice. A `record` that throws still returns the
caller's answer, because the work is done and hiding an organization CORE just
created would be worse; the request is logged at `error` with
`error_code: "retry_not_recorded"`, and the next retry runs again — the
behaviour of every route before this milestone.

**Nothing sweeps the table.** Expired records stay until something deletes them;
they are dead weight rather than wrong answers, because `find` will not return
them.
