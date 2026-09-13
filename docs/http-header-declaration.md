# CORE reads only the headers it declares — milestone 26

The third and last request surface. Milestone 24 closed the query string,
milestone 25 closed the body, and both records named the headers as what was
left. Headers are also the surface where the consequence is largest, because a
header is the only part of a request that CORE keeps **as its own record of what
happened**.

## What was measured, before anything was changed

Against `main` at `a043ab7`, through a real server —
`createServer(core.router.nodeListener())` — and, where a client would refuse to
send the value, through a raw socket rather than through `fetch`:

| Request | Answer on `main` |
| --- | --- |
| `x-correlation-id:` 8000 characters | `200`, echoed in full in the response header |
| `x-correlation-id: "   "` | `200`, `"   "` became the correlation id of record |
| `x-correlation-id: a\tb` | `200`, accepted |
| `x-correlation-id: a` sent twice | `200`, recorded as `"a, b"` |
| `authorization` sent twice | accepted; `bearer()` authenticated `[0]` |

The router's whole rule was:

```ts
const correlationHeader = headers["x-correlation-id"];
const correlationId =
  typeof correlationHeader === "string" && correlationHeader ? correlationHeader : newId();
```

Any non-empty string, taken verbatim. What that string then reaches:

- the response header, echoed to the caller;
- the structured request log and the retained `logs` array;
- the `correlation_id` **`text`** column of every audit, outbox, ledger,
  inbound-event, notification and subscription row the request creates;
- and, through the audit trail, the field a human or a reconciliation read traces
  one request across six tables by.

So the defect is not cosmetic in three separate ways. A caller could write
kilobytes of chosen text into CORE's permanent audit trail with every ordinary
request, at no cost and with no gate. Two unrelated requests could both be
recorded as `"   "`, which makes the tracing field useless exactly when it is
needed. And a repeated header produced one id, `"a, b"`, belonging to neither
half, so a later lookup by either value finds nothing while the row looks
perfectly well formed.

`bearer()` had the matching flaw pointed the other way:

```ts
const header = ctx.headers["authorization"];
const raw = Array.isArray(header) ? header[0] : header;
```

Two credentials meant CORE chose one and said nothing — the same silent
substitution milestones 24 and 25 closed for parameters and properties. Worse,
the rate limiter derived its subject from the same headers **independently**, so
the credential the limiter charged and the credential `bearer()` authenticated
were not guaranteed to be the same value.

### What was measured and is *not* a defect

Recorded because it bounds what this cycle claims:

- Node's own HTTP parser refuses a NUL byte, a DEL byte and an obs-fold
  continuation line with `400` before CORE sees the request, so response
  splitting through `x-correlation-id` was **not** reachable. The refusals below
  are not what stops it.
- A NUL byte would nonetheless have been a **backend divergence** if it could
  arrive: the reference backend stores it, and PostgreSQL refuses `0x00` in
  `text` outright — measured directly:
  `invalid byte sequence for encoding "UTF8": 0x00`. That is now unreachable
  twice over.
- Neither `Authorization` nor `x-correlation-id` appeared **anywhere** in
  `contracts/openapi/core-v1.yaml`. The one header every route but the probes
  requires was undocumented, which the contract cross-check in this cycle found
  the same way milestone 25's found four undocumented request bodies.

## What changed

`src/platform/http/headers.ts` is the only place in `src` that reads a request
header. `DECLARED_HEADERS` names the five CORE depends on, and each carries a
**use**, a **length bound** and a **recorded reason**:

| Header | Use | Bound | Why |
| --- | --- | --- | --- |
| `x-correlation-id` | `recorded` | 128 | echoed, logged and persisted as CORE's record of the request |
| `authorization` | `credential` | 4096 | read by `bearer()`, hashed by the limiter |
| `x-forwarded-for` | `forwarded` | 512 | proxy chain, first entry attributed |
| `x-real-ip` | `forwarded` | 128 | reported client address |
| `x-client-ip` | `forwarded` | 128 | reported client address |

The three uses are three strictnesses, and each is chosen for what CORE *does*
with the value rather than for tidiness:

- **`recorded`** is checked against an identifier shape — letters, digits and
  `. _ : -` — because everything downstream treats it as an identifier. That one
  rule refuses `"   "`, `a\tb`, and the `"a, b"` a repeated header becomes.
- **`credential`** must be one `scheme token`. Deliberately *not* a check that
  the scheme is `Bearer` or that the token is well formed: an unknown scheme and
  an invalid token are both `401`, answered by the identity module against real
  state, and moving that answer to the edge would turn an authentication result
  into a syntax result. What this refuses is only what cannot be a single
  credential.
- **`forwarded`** stays a list, because a proxy chain is one by definition, and
  the first entry is read through `firstForwarded`, which is the one declared
  read where taking part of a value is correct rather than a narrowing.

`RequestHeaders` throws on an undeclared read, for the reason `Selection` and
`Body` throw: returning `undefined` would rebuild the defect one level down, as a
reader that silently sees "not sent" on every request.

The router checks the headers **first** — before the route is matched and before
the limiter runs. Two reasons, both structural:

1. The limiter derives its subject from `authorization` and the forwarding
   headers, so it cannot run before those are known to be single and bounded.
   This is what makes the limiter's credential and `bearer()`'s credential the
   same value by construction.
2. The correlation id becomes CORE's record the moment anything is logged, so it
   has to be a value CORE is willing to store before it is used once.

A refusal **never echoes the value that caused it**. The response header, the log
record and the metric all carry a freshly generated id, and the message says what
is accepted without quoting what was sent. Echoing an 8000-character value back
to prove it was too long would be the defect answering itself.

### Contract

`components/parameters/CorrelationId` documents the header with its shape, its
bound, the refusal, and the fact that omitting it makes CORE generate one — and
it is referenced from **all 52 operations**, not only defined. A component
parameter nothing references documents nothing, which is the same lie this family
closes from the other end; the gate compares the number of references against the
number of operations it found rather than against a number written in the test.
The `Authorization` rule is stated in the API description beside the rate-limit
rule that was already there.

## The gate

`tests/http-header-declaration.test.ts`, **15 tests**, no database, so it runs in
both CI jobs. It asserts the declaration is well formed; that each refusal
happens, by its own case; that a refusal never echoes the value; that a valid
correlation id is still honoured and an absent one still generated; that nothing
in `src` reads a header any other way; that an undeclared read throws; that the
limiter's subject comes only from checked headers; and that the contract documents
what a caller must send.

It also asserts, on purpose, that **an undeclared header is not refused**. HTTP
requires unknown headers to be ignored and every proxy, browser and load balancer
adds its own, so a router that refused them would refuse ordinary traffic. This
is the one place where this family's rule is deliberately weaker than for the
query string and the body, and the gate states the weaker rule rather than
leaving the difference unspoken: what is enforced is that CORE never *reads* an
undeclared header.

## Falsification log

Every mutation was applied to a **committed** tree, the gate was run, and the tree
was restored and confirmed clean afterwards.

| # | Mutation | Result |
| --- | --- | --- |
| F1 | length bound not enforced | **2 tests fail** |
| F2 | `recorded` accepts any non-empty string (the old rule) | **2 fail** |
| F3 | a repeated header is narrowed to `[0]` instead of refused | **1 fails** |
| F4 | the refusal echoes the rejected value as the correlation id | **2 fail** |
| F5 | headers checked only after the route matched | **1 fails** |
| F6 | an undeclared read returns `undefined` instead of throwing | **1 fails** |
| F7a | the old raw reader restored as `headers["authorization"]` | **1 fails** |
| F7b | the same read hidden behind a cast | **1 fails** — see below |
| F8 | a reader asks for an undeclared header name | **1 fails** |
| F9 | one operation stops referencing `CorrelationId` | **1 fails** |
| F10 | the component parameter is deleted | **1 fails** |

### F7b, and a gate that was not good enough

The source scan was written first as `headers\s*\["name"\]`. F7b put the old
reader back as

```ts
const raw = (ctx.headers as unknown as Record<string, string>)["authorization"];
```

and **the scan passed it**: the cast separates the word `headers` from the
bracket. The first reading of F7 in this cycle was therefore taken against a scan
that could be evaded, and it is recorded here as that rather than deleted. The
scan was replaced with the rule it was trying to approximate — *a declared header
name may appear in `src` only as the argument of `.value` or `.firstForwarded`* —
after which F7a and F7b both fail. Two commits in this branch carry that
correction in order (`fa4b0d7`, then `be6dd30`), so the branch history shows the
weak gate and its replacement rather than only the final state.

A second process note, from the same failure: `git checkout -- .` in the
falsification script reverted the *sharpened but uncommitted* test file, so the
first re-run of F7b was measured against the old scan again. The readings from
that run were discarded, the sharpened gate was committed, and every reading in
the table above was then re-taken on a committed tree. This is the second cycle in
a row where a falsification round produced a wrong reading through a dirty tree,
and it is the same lesson written down again: **commit before falsifying, and
verify the tree is clean after each restore.**

## Measurement

| Run | Before | After |
| --- | --- | --- |
| No `DATABASE_URL` | 674 passed / 147 skipped | **689 passed / 147 skipped** |
| With `DATABASE_URL` | 1236 + 1 = 1237 | **1251 + 1 = 1252** |

Locally on an embedded PostgreSQL 18.4 with `C` collation; the CI verdict against
`postgres:16` with `en_US.utf8` is recorded in `ROADMAP.md`. `tsc --noEmit` clean;
governance, contract, migration and roadmap gates pass. One existing test file
changed: `tests/rate-limit.test.ts` calls `subjectFor` directly and now builds its
input with `parseHeaders({...})`, because the function takes checked headers. What
it asserts is unchanged, and no test was loosened to accommodate the new
strictness.

## What this cycle does not claim

- **It does not make the correlation id trustworthy.** It is still a value the
  caller chooses; what changed is that it is now a *bounded identifier* the caller
  chooses. CORE's own `request_id` remains the only id CORE generates.
- **It does not authenticate anything at the edge.** A well-formed credential that
  is expired, forged or unknown is still `401`, decided against real state by the
  identity module.
- **It does not bound the total size of a request's headers.** Node's ~16 KB limit
  does that, and CORE does not restate it.
- **It says nothing about response headers.** CORE sets `x-correlation-id`,
  `retry-after` and the three `x-ratelimit-*` headers; this cycle governs only what
  is read from the request.
- **It does not cover `content-type`.** CORE parses a JSON body regardless of what
  the caller declares, which is a separate question about what a request *is*
  rather than about what CORE reads from it, and it is not addressed here.
