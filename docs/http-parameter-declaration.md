# Read routes refuse only what they read

Milestone 24. Branch `http-parameter-whitelist`. The tenth cycle in the parity
family and the first that is not a parity cycle: nothing here compares two
backends. It closes a gap the previous cycle **measured and declined to
half-build**, and the whole of it is one structural change plus the gate that
holds it.

## The defect

Milestone 23 closed the *values* a route accepts for the parameters it reads. A
repeated parameter is refused, an empty string is refused, `0x10` is not a
limit. It said, in its own record, that it had not closed the *set* of
parameters, and left two measurements behind:

- `GET /v1/notification-recipients?limit=abc` answered **200 with every row**.
  That route has no `limit`. A caller who believed they had bounded the response
  received the whole table, with a success status and nothing to indicate that
  the bound had not been applied.
- `?organisation_id=…` — the British spelling, or any typo — was ignored, and
  the unscoped answer came back as though it had been asked for. On a route
  where `organization_id` is optional, that is one tenant's question answered
  with every tenant's rows.

Both are the defect milestone 23 spent a cycle on, from the other end: **CORE
answered a question the caller did not ask, and reported success.** A refusal
that arrives as a 400 costs the caller one fixed typo. A silent substitution
costs them a wrong answer they have no way to detect.

## Why the fix is structural

The obvious repair — each handler checks for parameters it does not want — is
the shape that produced the defect. It is 23 lists in 23 handlers, each of which
must be edited whenever a parameter is added, and none of which is checked by
anything. The lists drift, and a drifted list fails open: the parameter is
accepted and ignored, exactly as before.

So the declaration moved into the registration, and the enforcement into the
router:

```ts
router.get(
  "/v1/notifications",
  [
    { name: "organization_id", kind: "text" },
    { name: "status", kind: "enum", values: NOTIFICATION_STATUSES },
    { name: "limit", kind: "limit", default: 50, min: 1, max: MAX_PAGE },
  ],
  async (ctx) => { … },
);
```

Three properties follow from where the code sits, not from anybody remembering:

1. **`accepts` is required on `get`.** It is a positional parameter, so a route
   that declares nothing must say so with `[]`. `add(method, path, handler,
   accepts = [])` defaults to accepting nothing — the fail-closed direction, so
   a route registered through the low-level path accepts no query string until
   it declares one.
2. **`RequestContext` carries no `URLSearchParams`.** `ctx.query` is gone;
   `ctx.selection` is the parsed result. A handler *cannot* read an undeclared
   parameter, because there is nothing left to read it from. This is the change
   that makes the gate below possible: there is no second way in to check for.
3. **The parse happens in the router**, after the rate-limit check and before
   the handler, and its refusals go through the same `CoreError` path as every
   other refusal — same `invalid_request` code, same correlation id, same
   envelope.

`Selection` is deliberately strict in the other direction too: reading a name
the route did not declare **throws** rather than returning `undefined`. A
`undefined` would have re-created the original defect one level down — a handler
reading `limit` from a route that never declared one would see "not sent" on
every request for ever.

### What a refusal reveals, and when

Unknown-parameter refusal happens **before authentication**. That is deliberate
and worth stating plainly, because it means an unauthenticated caller can learn
which parameters a route accepts: the message lists them. That set is published
in `contracts/openapi/core-v1.yaml`, which is the document MOVE and MARKET are
built from, so the refusal discloses nothing a reader of the contract does not
already have. The ordering buys something real in exchange: a request CORE
cannot understand never reaches a store, and authentication is a store read.

A refusal body carries `code`, `message`, `details`, `retryable` and
`correlation_id` — the parameter names and the trace id, and nothing drawn from
data. Asserted, not assumed: `tests/http-parameter-declaration.test.ts` pins the
exact key set.

## The gate

`tests/http-parameter-declaration.test.ts`, **10 tests**, no database — none of
it depends on a store, so it runs in both CI jobs rather than only the one with
Postgres. Every loop is driven off `core.router.registrations()`, never off a
list maintained in the test, because a list maintained in the test is a list
that goes stale the first time somebody adds a route.

| Gate | What it asserts |
| --- | --- |
| Premise | `registrations()` returns ≥ 52 routes, ≥ 23 of them `GET`, and at least one route with parameters *and* one without — so no loop below can pass vacuously |
| Unknown parameter | Every registered route, **all methods**, answers `?__unexpected_parameter=1` with 400 `invalid_request` naming the parameter |
| Refusal shape | The refusal precedes authentication and its body carries exactly the five envelope keys |
| No-parameter routes | The ≥ 29 routes that declared nothing refuse *any* query string, with a message saying the route accepts none |
| Liveness | Every declared parameter, sent twice, is refused by name — with every *other* declared parameter of that route given one valid value, so a route with two required parameters cannot refuse the missing one first and prove nothing about this one |
| Declared vs read | Per file: every declared name appears as a `selection` read, and every `selection` read is declared |
| Well-formedness | Unique snake_case names, non-empty and duplicate-free enum vocabularies, `0 < min <= default <= max` |
| One way in | Source scan: no `URLSearchParams`, `searchParams`, or raw reader call anywhere outside `src/platform/http/query.ts` and `router.ts` |
| Contract parity | The declared set equals the `in: query` set in `contracts/openapi/core-v1.yaml`, per route |
| `Selection` | Reading an undeclared name throws; reading a declared one returns it |

The **declared-vs-read** check exists because the liveness probe cannot see the
other direction. The router parses a declared parameter whether or not any
handler asks for it, so a declaration can be pure decoration — a name the route
advertises, validates, and then ignores, which is the same lie about the answer
from the far end. Its granularity is a **file**, and that is the stated limit of
the check: `reputation/http.ts` reads `organization_id` inside a `subjectOf(ctx)`
helper shared by two routes, and a per-handler scan would have to follow that
call to be correct. Two routes in one file that declare different parameters and
read each other's would pass this cross-check. The router still refuses per
route; only the cross-check is file-wide.

## What the contract cross-check found

Comparing the declarations with the published contract was added to remove a
second source of truth, and it immediately paid for itself:
**`country_code` on `GET /v1/geography/service-areas/resolve` has been
implemented since the geography module shipped and appeared in no contract.** No
consumer reading `core-v1.yaml` could know a country filter existed. It is
documented in the same commit as the gate, with the parameter description
recording that milestone 24 is what found it.

Every other route agreed exactly, and every registered `GET` is present in the
contract.

The contract is parsed with a small line reader rather than a YAML library
because the repository has no YAML dependency and `scripts/check-contracts.mjs`
reads the same file the same way. A reader that silently stopped matching would
make the comparison agree with everything, so the test asserts it found a
plausible number of paths and parameters first — and that assertion was
falsified deliberately (F9 below).

## Falsification log

Nine deliberate defects, each introduced alone, the gate run, then reverted.

| # | Defect introduced | Caught |
| --- | --- | --- |
| F1 | Router stops refusing unknown parameters | Yes — 3 tests |
| F2 | A route declares `unused`, which no handler reads | **No, at first** — see below |
| F3 | A route builds a `URLSearchParams` directly | Yes |
| F4 | `Selection` returns `undefined` for an undeclared name | Yes |
| F5 | An enum spec declared with an empty vocabulary | Yes — 2 tests |
| F6 | A limit whose `default` (5000) is outside its `max` | Yes |
| F7 | A handler reads a name its file declares nowhere | Yes |
| F8 | The contract loses the documented `country_code` | Yes |
| F9 | The contract parser's path regex made to match nothing | Yes — the premise test |

**F2 is the one that matters.** The first version of this gate proved every
declared parameter was *parsed*, which a decorative declaration satisfies
perfectly, and it passed. The declared-vs-read cross-check was written in
response, and F2 and F7 were then both caught. This is the second cycle running
in which a falsification passed until the gate itself was strengthened; the
pattern is that a gate written from the implementation tends to assert what the
implementation happens to do.

## Measured

| Run | Before | After |
| --- | --- | --- |
| No database | 648 passed / 148 skipped | **658 passed / 148 skipped** |
| With PostgreSQL | 1211 passed | **1221 passed** |

`npm run typecheck`, `check-governance.mjs`, `check-contracts.mjs`,
`check-migrations.mjs` all clean. The CI verdict for both jobs is recorded in
`ROADMAP.md` beside the cycle record.

## What this cycle does not claim

- **No parity claim.** Nothing here compares the two backends; the change is
  above the persistence layer entirely.
- **Body and header parity are untouched.** This closes the query string. A
  request body still accepts unknown properties wherever the module schema
  permits it, and that is a separate, larger question about upgrade tolerance —
  strict body rejection is a breaking change for any client that sends an extra
  field, which is the opposite of the query case, where nothing legitimate was
  ever sending an undeclared parameter.
- **The declared-vs-read cross-check is file-scoped**, as stated above.
- **`accepts` describes existence, not authorisation.** A parameter being
  declared says a caller may send it, not that this caller may see what it
  selects; scope enforcement is unchanged and lives where it did.
- **The type shapes are minimal by intent.** `kind: "text"` carries no format —
  a `text` parameter that must be a UUID is still validated in the handler that
  knows it. Pushing formats into the declaration was considered and left,
  because a declaration that grows a validation language becomes a second schema
  system next to the contract.
