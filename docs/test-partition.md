# The suite's division into passes

Milestone 35. This document exists because of a number in the previous twelve
cycle records that nobody could explain, and a defect found while explaining it
that was considerably worse than the number.

## What was measured, before anything was edited

On `main` at `5567e49`.

### The number: 147 against 148

Every cycle record since milestone 22 restated the same discrepancy — CI's
no-database job reporting **147** skipped tests where the local run reported
**148** — and carried the same hypothesis: "one test's skip condition is
environment-dependent". It was repeated, honestly flagged as unexplained, and
never measured.

It is not environment-dependent, and there is no disagreeing test. Per-file
skipped counts taken from CI's own log and from a local run are **identical in
all eighteen files that skip anything**: 43, 33, 33, 7, 6, 4, 4, then 2 in each
of seven files, then 1 in each of four. That sums to 148 both times.

The difference was in how the two numbers were produced:

| Produced by | File set | Reported |
|---|---|---|
| CI: `npm test` → `test:suite` | all files **except** `tests/migration-*-lifecycle.test.ts` | 789 passed / **147** skipped (936) |
| CI: `npm test` → `test:cluster` | `tests/migration-0011-lifecycle.test.ts` alone | **1** skipped (1) |
| Every local measurement in `ROADMAP.md`: bare `vitest run` | all files at once | 789 passed / **148** skipped (937) |

147 + 1 = 148. Confirmed by running both halves locally and getting exactly CI's
two lines. The record had been comparing a one-run total against a two-run split
for twelve cycles.

So the defect was in the measurement, not the suite. That is worth stating
plainly, because a document whose purpose is to be believed had a number in it
that meant something other than what it said, and the wrong explanation sat
beside it long enough to look settled.

### The defect found while explaining it, which is worse

`test:suite` excluded a **glob** (`tests/migration-*-lifecycle.test.ts`) while
`test:cluster` ran a **named file** (`tests/migration-0011-lifecycle.test.ts`).
Two statements of one partition, in two different languages, in two
`package.json` strings — agreeing only because exactly one lifecycle file
happened to exist.

Measured rather than reasoned about: an empty
`tests/migration-9999-lifecycle.test.ts` was added and both passes were run. It
appeared in **neither**, and `npm test` reported everything green. A test file
that nothing runs is worse than a missing test, because the suite counts it as
covered. The probe was deleted, not committed.

## What it is now

One definition, in `scripts/test-partition.mjs`: a file belongs to the cluster
pass if and only if its name matches `/^migration-\d+-lifecycle\.test\.ts$/`.
Everything else is the suite pass.

- `vitest.config.ts` builds its `include` from that predicate, choosing the pass
  from `WASLA_TEST_PASS` (absent means `suite`, an unrecognised value throws
  rather than defaulting past a typo).
- `package.json`'s two scripts set that variable and nothing else. Neither names
  a file, a glob or an `--exclude`.
- A bare `vitest run` therefore performs **exactly** CI's suite pass. A count
  taken locally and a count read out of a CI log are now the same number about
  the same files, which is the whole point.

### Why lifecycle files are a separate pass at all

They create and drop real databases, which are cluster-wide operations.
Measured previously (recorded in `vitest.config.ts`): about 0.3s idle against
**51s** while the rest of the suite worked the same server. Their isolation is a
correctness requirement, not a preference — which is why it is now enforced
rather than left to a command line.

### Two gates, doing different jobs

`scripts/check-test-partition.mjs` (build gate, both CI jobs) checks the
repository as it stands: every `tests/*.test.ts` in exactly one pass, no pass
naming a file that does not exist, a non-empty cluster pass, neither script
restating the partition, `npm test` running both — and then **asks vitest, for
each pass, which files it will actually run**, and requires that to equal what
the module declares.

That last check is the one that matters most, and it is the reason the gate
shells out instead of reading text. Every earlier form of this defect was a
declaration that was true about itself and false about what ran.

`tests/test-partition.test.ts` (unit gate, 10 tests) checks the **rule**,
including on arrangements that do not exist in the repository and are exactly
the ones that broke: a second lifecycle file, a renamed one, near misses like
`migration-0011-lifecycle-helpers.test.ts` that must *not* be swept into a pass
that runs one file at a time.

It deliberately asserts no counts. Writing "61 files in the suite pass" into a
test makes every new test file a failing build, and the count is already stated
where a reader looks for it, produced by the passes themselves.

## Falsification

Twelve mutations, each restoring one form of the defect or a near neighbour. The
runner is not committed; the spec and verdicts are here.

| # | Mutation | Caught by | Verdict |
|---|---|---|---|
| F1 | Cluster pass identifies its file by name (old semantics) **and** a second lifecycle file exists | unit gate (1) | caught |
| F2 | The pattern matches nothing, so lifecycle files join the suite pass | unit gate (3), build gate | caught |
| F3 | The pattern loses its anchors, sweeping near misses into the one-at-a-time pass | unit gate (2) | caught |
| F4 | The suite pass stops excluding cluster files, so they run in both and count twice | unit gate (1), build gate | caught |
| F5 | An unknown pass name silently becomes `suite` instead of throwing | unit gate (1) | caught |
| F6 | `test:cluster` names its file on the command line again | build gate | caught |
| F7 | The old `--exclude` returns to `test:suite`'s command line | build gate | caught |
| F8 | `test:cluster` stops setting the pass variable, silently running the suite pass | build gate | caught |
| F9 | `npm test` stops running the cluster pass | build gate | caught |
| F10 | The pattern is changed to match nothing on disk, so the cluster pass is green by emptiness | unit gate (3), build gate | caught |
| F11 | `allTestFiles` silently drops a file, so it belongs to no pass | build gate | **survived, then closed** |
| F12 | `vitest.config.ts` ignores the partition and runs everything in one pass | unit gate, build gate | caught |

### What falsification actually found

**F11 survived, and it exposed a real hole rather than a gap in wording.** One
extra clause in `allTestFiles`'s filter made a file invisible, put it in no
pass, and **every check still passed** — because the gate's idea of what existed
and the runner's `include` list both descended from the same dropped source. A
gate that asks the thing it is auditing what to audit is not a gate. Closed by
having `check-test-partition.mjs` read `tests/` itself, independently, and
require the two answers to agree. F11 is caught after that; the independence was
not designed in, it was found.

**F1 no longer fails the way it originally did, and the difference is worth
recording.** Under the old arrangement the second lifecycle file ran in
*neither* pass. Under the new one, restoring the old naming semantics leaves it
*misplaced* — swept into the suite pass, running beside the rest and contending
for the same server — rather than hidden, because the configuration now derives
its file set from the same predicate the gate reads. A misplaced heavy test is a
flake; a hidden one is a lie. The unit gate catches the misplacement.

**F12 is caught by a crash, not a clean diff.** Making the configuration ignore
the partition left `vitest list` unable to load the config at all, so the build
gate reports "could not ask vitest which files the suite pass runs" rather than
a file-set difference. Caught, and loudly, but by a different mechanism than the
one the check was written for. Recorded because the next person to read that
error should know it can mean a broken config rather than a broken partition.

## What this does not do

- It does not verify that a test file's *contents* are meaningful, only that
  something runs it.
- It does not reconcile the two jobs' totals into one number. They are reported
  separately by two commands and added by a reader; the gate ensures the file
  sets behind them are complete and disjoint, not that anybody adds correctly.
- The `.d.mts` beside `test-partition.mjs` is a second statement about one
  thing, which is the duplication this milestone is about. It is accepted
  because `scripts/` runs under bare node with no build step, and it is checked
  by a case in the unit gate rather than trusted.
