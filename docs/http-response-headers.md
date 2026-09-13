# Declared response headers — milestone 28

The record of the cycle that closed the last undeclared HTTP surface in CORE: the
headers CORE puts on its own answers.

## Why this cycle existed

Four surfaces were already declared and gated when this cycle started: the query
string (milestone 24), the request body (25), the request headers (26), and the
status, content type and body of the answer (27). Milestone 27's own record ends
with what it does not claim, and the first item there is response **headers**. It
was accurate: nothing in the repository stated which headers CORE sets, nothing
compared them with the published contract, and nothing could have noticed a
response that carried none.

## Measured on `main` at `ea793f3`, before anything was changed

Driving all 52 operations through the real router and reading the answers:

| Header | Set on | Documented on |
| --- | --- | --- |
| `x-correlation-id` | 52 of 52 responses | **0 of 52 operations** |
| `x-ratelimit-limit` / `-remaining` / `-reset` | every *limited* response, successes included | only the shared `RateLimited` 429 |
| `retry-after` | the 429 only | the 429 (correct) |
| `content-type` | `/metrics`, the one non-JSON answer in CORE | by its `content` block, which is where OpenAPI puts it |

`0 of 52` was the number that decided the cycle: the value a caller needs in order
to ask CORE afterwards what a request did — the value written to every audit,
outbox, ledger, inbound-event, notification and subscription row the request
touched — was sent on every single response and published nowhere.

Two defects came out of the same measurement, both on the paths a caller reaches
when something has *already* gone wrong:

1. **An unmatched route answered `404` with no headers at all.** The `if
   (!matched)` branch in `src/platform/http/router.ts` returned a body and no
   `headers` key. The body carried `correlation_id`; the header a caller reads it
   from was absent — on the one answer it gets when it can reach no route in CORE
   at all, which is exactly the answer it most needs to quote in a bug report.
2. **An unparseable JSON body answered `400` above the router**, from the Node
   adapter, as `{code, message}`: no `correlation_id`, no `details`, no
   `retryable`, and no header either. It was the only refusal in CORE that was not
   the `Error` shape milestone 27 made every documented refusal use — invisible to
   that milestone's gate precisely because the answer never reached the router it
   drives.

## What was built

### One declaration, one place headers are decided

`src/platform/http/response-headers.ts` declares each header CORE sends with four
things: its lower-case name, **when** it is sent (`always`, `limited`, `retry`,
`route`), **why** a caller is given it, and the anchored **shape** of the value.
`sealHeaders(...parts)` is now the only expression in CORE that produces a
response's headers. It refuses a name that is not declared and a value that does
not match its declared shape, and later parts win — which is why the router passes
CORE's correlation id *after* the route's own headers, so a route cannot overwrite
CORE's record of the request with a value of its own.

The direction of that refusal is deliberate and it is the opposite of the request
side. `headers.ts` records that an undeclared *request* header must be ignored,
because every proxy, browser and load balancer adds its own and refusing them
would refuse ordinary traffic. An undeclared *response* header is CORE's own doing
and nobody else's, so there is nothing to be tolerant of: it fails closed, and it
fails in a test rather than in production.

### The two defects, fixed at the cause

The `404` branch and the adapter's unparseable-body branch both go through
`sealHeaders` now, and the second answers `invalid("body must be valid JSON")`
rendered by `CoreError.toBody`, so it is the same canonical `Error` as every other
refusal, with the same correlation id in the body and in the header.

### The contract says where each header is really sent

`contracts/openapi/core-v1.yaml` gained one `components/headers` section —
`CorrelationId`, `RateLimitLimit`, `RateLimitRemaining`, `RateLimitReset`,
`RetryAfter` — referenced by every response object and by both shared refusal
responses. `RateLimited`'s four inline header definitions were replaced by
references to the same five, so there is exactly one description of each header in
the document.

Two corrections came with it, both of which are the contract catching up with what
CORE actually does:

- The three `x-ratelimit-*` headers are documented on **every limited response,
  successes included**. Documenting them only on the 429 said a caller could learn
  its budget only by exceeding it, which is false and is the least useful moment to
  learn it.
- They are deliberately **not** documented on `/health`, `/ready` and `/metrics`.
  `UNLIMITED_ROUTES` exempts those three, so they carry no budget, and documenting
  a header CORE never sends is the same defect as sending one it never documented,
  in the other direction. The gate derives that set from the limiter rather than
  listing it, so an exemption added later moves both halves at once.

`content-type` is declared in `response-headers.ts`, because CORE does set it, but
it is **not** documented in any response's `headers` map: OpenAPI states a response
header named `Content-Type` is ignored, since the media type is already declared by
`content` — which milestone 27 gates.

### The gate

`tests/http-response-header-declaration.test.ts`, nine cases, every one of them
measured against real answers rather than read out of the router:

1. The declaration is well formed — unique lower-case names, anchored shapes, a
   reason each — and the set is closed.
2. `sealHeaders` refuses an undeclared name, a `retry-after` of `0`, a negative
   remaining budget and a blank correlation id; lower-cases what it sends; and lets
   the last part win.
3. All 52 operations answer with a correlation id of the declared shape, and it
   **equals the `correlation_id` in the body** wherever the body has one. The two
   are one fact and the gate refuses to let them drift.
4. No operation sets a header that is not declared.
5. For the status each operation actually returns, the contract documents exactly
   the headers CORE sets on it — with the limiter's contribution added for limited
   routes and withheld for exempt ones, and with the limiter's real behaviour
   checked rather than assumed.
6. Both shared refusal responses document the header, so every documented refusal
   in the contract carries it.
7. The three answers that used to carry nothing now carry the id: the unmatched
   `404`, the malformed-request-header `400` (a *generated* id, never the rejected
   value), and an unhandled exception's `500`.
8. The unparseable body, over a real socket, answers the canonical five-field
   `Error` with the header matching the body.
9. `retry-after` appears on the refusal and on nothing before it, the remaining
   budget counts down on the way there, and it reads `0` at the refusal.

## Falsification

Twelve mutations, each applied to a **committed** tree, gate run, tree restored
and `git status --porcelain` checked empty after each restore.

| # | Mutation | Result |
| --- | --- | --- |
| F1 | The unmatched `404` returns no headers again | caught |
| F2 | The unparseable body answers `{code, message}` again | caught |
| F3 | `sealHeaders` passes an undeclared name through | caught |
| F4 | The success path stops setting the correlation id | caught |
| F5 | The limiter stops sending `x-ratelimit-remaining` | caught |
| F6 | `/health` stops being exempt from the limiter | caught |
| F7 | One operation stops documenting its response headers | caught |
| F8 | The contract documents an `x-request-id` CORE never sends | caught |
| F9 | The `500` path invents a second correlation id | caught |
| F10 | `retry-after` is sent as `0` | caught, on the second attempt — see below |
| F11 | The remaining budget never counts down | caught |
| F12 | The correlation id's declared shape accepts anything | caught |

**F10's first attempt was invalid and is recorded rather than removed.** It
rewrote `"retry-after": …` as an object key, but `rate-limit.ts` writes
`headers["retry-after"] = …`, so the substitution matched nothing and the tree was
unchanged: the gate reported "not caught" for a mutation that had not been made.
Re-run correctly — `String(0)` in place of `String(Math.max(1, …))` — the gate
failed on the `retry-after` case, because `sealHeaders` refuses a `0` it is not
declared to send. The lesson is the same one the last three cycles recorded in a
different form: a falsification that does not change the tree proves nothing, and
"not caught" must be checked against the diff before it is believed.

## Measurements

| | Without a database | With PostgreSQL |
| --- | --- | --- |
| Before (main, `ea793f3`) | 700 passed, 148 skipped | 1263 passed |
| After | **709 passed, 148 skipped** | **1272 passed** |

The nine new cases are the whole difference. (An additive correction to earlier
records: the skipped count at `ea793f3` was 148, not 147 as one earlier cycle
summary said; nothing about the passing counts changes.)

## What this cycle does not claim

- **It says nothing about which refusal statuses are reachable.** The contract
  documents `400`, `401`, `403`, `404`, `409` and `429` across the surface; this
  gate drives each operation to its *success* status and to three specific
  refusals. Whether every documented refusal can actually be produced, and whether
  a produced refusal is documented, is a separate cycle.
- **It does not gate `content-type` against the wire.** Milestone 27 gates the
  documented media type; that the Node adapter writes exactly that string for a
  text body is asserted for `/metrics` only.
- **It makes no claim about headers CORE sends as a client.** The outbound webhook
  signature headers (`x-wasla-signature`, `x-wasla-event-id`,
  `x-wasla-delivery-attempt`) are CORE's requests to somebody else's server, not
  its responses, and they are declared and tested where they belong, in the
  delivery module.
- **It does not make the limiter's numbers a contract.** The gate asserts the
  budget counts down and reads `0` at the refusal; the window size and the class
  limits remain configuration, not published promises.
