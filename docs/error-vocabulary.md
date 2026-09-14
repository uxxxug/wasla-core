# The published error vocabulary, and the failure every route can have

Milestone 37.

## What was wrong

Milestone 36 closed one direction of the answer surface and stated plainly which
statuses its matrix does **not** reach: `409` and `500`. This is the `500` half —
and a second defect in the same family, found while measuring it.

## What was measured, before anything was changed

On `main` at `f67908b`.

**1. A failure almost every route can have, documented nowhere.** Every request
the response-gate scenario makes successfully was replayed against a CORE
assembled with a persistence backend whose every method throws.

| Answer under a failing dependency | Operations |
| --- | --- |
| `500` `internal` | **50** |
| `200` (`GET /health`, `GET /metrics` — they touch no persistence) | 2 |

The contract documented `500` on **no operation at all**. Across the whole file
the documented statuses were `200`, `201`, `202`, `204`, `400`, `401`, `403`,
`404`, `409`, `429` and nothing else. A caller generating a client had no branch
for the one answer it gets when CORE's dependency is down.

**2. Published vocabulary CORE could not speak.** The `Error.code` enum listed
nine codes. Two of them were constructed nowhere — not in `src/`, not in
`tests/`, not by any helper in `src/platform/errors.ts`, which exported
constructors for five codes only.

| Code | Status it would map to | Producers found |
| --- | --- | --- |
| `precondition_failed` | `412` | **0** |
| `unavailable` | `503` | **0** |

They lived in the `ErrorCode` union, the `STATUS` table and, for `unavailable`,
the `RETRYABLE` set: three tables and a YAML enum agreeing about two words CORE
could not say, and asking a caller to branch on them. Neither `412` nor `503` was
documented on any operation either, so the enum promised codes that could not
arrive under any status the contract admitted.

## What was decided

**`500` is documented on the 49 operations that can produce it, not on all 52.**
Truthful over uniform. This was not a preference: milestone 27's gate requires
every documented status to be *produced*, so documenting `500` on `/health` would
have made two gates contradict each other. `/health` and `/metrics` answer
without touching a dependency, which is the property that makes them worth
having, and the contract now says so by omission — checked by replay, not by a
list.

**`precondition_failed` was deleted.** Nothing produced it and nothing needed it.

**`unavailable` was given a producer, because the measurement found a defect
behind it.** `/ready` let its dependency's failure escape the handler, and the
router's fail-closed default rendered it `500` `internal`: CORE reporting a defect
in CORE when what had happened is that CORE cannot serve yet. An orchestrator
reading `500` from a readiness probe has grounds to stop a rollout; reading `503`
it waits. `/ready` now answers `503` `unavailable` with `retryable: true` and no
`retry-after` — CORE does not know when its dependency recovers, and milestone 34
established that a refusal states a time only when it knows one. Documented as a
new `NotReady` response, which carries the correlation header and none of the
budget headers because `/ready` is on `UNLIMITED_ROUTES`.

**`ErrorCode` stopped being hand-maintained.** One `STATUS` table is now the
source: the union is `keyof typeof STATUS`, `ERROR_CODES` is its keys, and
`statusForCode` reads it. A code cannot exist without a status, and the published
enum is compared against the keys on every run.

## What is enforced now

`tests/error-vocabulary.test.ts`, in both CI jobs, no database:

1. The published enum is exactly `ERROR_CODES`.
2. **Every code in `ERROR_CODES` is produced by a real answer** in this file —
   the refusal matrix for `400`/`401`/`403`/`404`, a reused key with a different
   body for `409`, a real budget exceeded for `429`, and a throwing dependency for
   `500` and `503`. Adding a word to the table fails until something says it.
3. Every produced code carries the status its own table gives it.
4. Every produced status is documented on the operation that produced it.
5. **Under a dependency that throws, every operation that answers `500` or `503`
   documents it, and an operation that answers neither documents neither** —
   measured by replay, so an operation that starts or stops touching persistence
   changes this set without anybody editing a list.
6. `/health` and `/metrics` still answer `200`, and `/ready` answers `503`, under
   a backend where every call throws.

## Falsification

Ten mutations, each applied to a clean tree, the gate run, the tree restored.

| # | Mutation | Result |
| --- | --- | --- |
| F1 | `precondition_failed` put back in the published enum | caught |
| F2 | a code CORE has dropped from the published enum | caught |
| F3 | a code added to the vocabulary table with nothing producing it | caught |
| F4 | `/ready` goes back to letting its dependency failure escape as `500` | caught |
| F5 | one operation stops documenting the `500` it produces | caught |
| F6 | `/ready` stops documenting its `503` | caught |
| F7 | `/health` documents a failure it cannot have | caught |
| F8 | a code mapped to a status it does not answer with | caught |
| F9 | `unavailable` removed from `RETRYABLE`, so the `503` reports `retryable: false` | **survived this gate** — caught by milestone 34's `tests/refusal-retryability.test.ts` |
| F10 | a rate-limited answer stops carrying its own code | caught |

**9 of 10 caught by this file; 10 of 10 caught by the suite.** F9 is recorded as
survived rather than moved: `retryable` is milestone 34's claim and it holds it
correctly, so duplicating the assertion here would add a second place to change
when the rule changes. The measurement was run to confirm that, not assumed —
removing `unavailable` from `RETRYABLE` fails
`refusal-retryability.test.ts > renders the flag and the header from one field`,
and nothing else in 63 files.

Runner `/tmp/falsify37.py`, specification `/tmp/mut37.json`, outside the
repository as in previous cycles because they mutate the tree they run against.

## Measured after

`npm run verify` green: 812 passed, 147 skipped across 61 files without a
database, plus the skipped cluster pass. Test partition: 64 files, 63 in the suite
pass and 1 in the cluster pass.
