# The roadmap's own status claims, checked against the repository

Milestone 38.

## What was wrong

Cycles 33, 36 and 37 each merged with a completed row still reporting itself as
"Reserved and measured, not yet implemented", and each needed a follow-up pull
request after the merge to correct it. The cause is structural, not careless: a
reservation is never rewritten and its outcome is appended, and the marker a
reader trusts sits at the **front** of the cell the outcome is appended to the
**end** of.

`scripts/check-roadmap.mjs` could not have caught any of the three. It checks only
that `ROADMAP.md` appears in a commit range that touched implementation. It has
never read a word of the file's contents.

## What was measured, before anything was changed

On `main` at `907e3ee`.

**37 rows, and a vocabulary nobody declared.** Every row opens its status cell
with a bolded claim. Counting them:

| Marker | Rows |
| --- | --- |
| `Complete` | 16 |
| `Complete, and self-enforcing from here` | 8 |
| `Complete.` (with a full stop, written by the correction meant to normalise it) | 1 |
| `CORE side complete` / `Complete inside CORE` / `Complete inside CORE, with a fake adapter…` / `Complete, except policy decisions that are not CORE's to make` | 4 |
| `Blocked — external dependency` / `Blocked — B-2, B-3` / `Blocked — B-5, B-6` | 3 |
| `Not implemented, and until this cycle not tracked here at all` | 1 |
| Sentence-length claims reporting two sub-statuses at once (rows 2, 8, 10) | 3 |
| `Reserved, measured, in progress on branch http-auth-order` | 1 |

**One marker was false, and had been for eight cycles.** Row 29 read "Reserved,
measured, in progress on branch `http-auth-order`" while the same cell went on to
report the cycle's outcome, cited `tests/anonymous-privilege-escalation.test.ts`
and `docs/anonymous-privilege-escalation.md` — both present — and recorded the
counts it measured (717/1280). The branch it named was deleted at merge. Nobody
found this by reading the document; it was found by comparing every marker against
the artifacts its own cell cites.

**The obvious rule is wrong, and measuring showed it before it was written.**
"Every path a row cites must exist in the tree" fails on row 35, which cites
`tests/migration-9999-lifecycle.test.ts` — a probe deliberately created to prove
that `test:suite`'s glob exclusion and `test:cluster`'s named file left a gap where
a test file ran in **neither** pass, then deleted without being committed. That
citation is true and describes an experiment. A path-existence gate would have
demanded the evidence be deleted, which cycle 30's rule forbids.

## What was decided

**The marker stays in the cell and is classified, not replaced.** Normalising 37
cells to a canonical token would have rewritten 37 reservations to satisfy a gate
— the move this repository forbids — and would have flattened the nuance rows 2, 8
and 10 carry deliberately, because those milestones genuinely have two
sub-statuses. So the closed vocabulary lives in `tests/roadmap-status.test.ts` as a
**total classifier**: `reserved`, `blocked`, `not implemented`, `complete`, tested
in that order so that a cell saying "reserved… not yet implemented" cannot be read
as complete because the word appears later in the sentence. A marker matching
nothing fails the build. That assertion is what makes the vocabulary real; until
now it was whatever anybody typed.

**Completion is held to evidence, by ownership of a written account.** This
repository writes one `docs/<topic>.md` per completed cycle, and the measurement
found that convention is already a fact about the tree: every completed row from
milestone 27 onward owns exactly one existing account, and the eight completed rows
before it own none. A cycle account belongs to the **lowest-numbered** row that
cites it, so a later reservation may quote an earlier cycle's document as evidence
without being credited with having written it.

Two rules follow, and between them they catch the defect from both sides:

- A row in state `reserved` may not **own** an existing account. Row 29 did.
- A row in state `complete` from milestone 27 onward must **own** one.

Both exemption lists — the eight rows owning no account, and the two completed rows
citing no artifact at all — are asserted exactly rather than used as filters, so
they may shrink and may not grow.

## Two hand-drafted lists the gate corrected

Recorded rather than quietly replaced, because it is the second cycle running in
which a list written by hand disagreed with what the code measured.

- The exemption list for "cites no artifact" was drafted as `1, 3, 5, 7, 9, 25`
  from a first pass. The gate returned `1, 3`: rows 5, 7 and 9 are `blocked`
  rather than complete, and row 25 does cite one — a `contracts/` path the first
  pass had not counted.
- The reserved-row rule took three forms, and the first two were killed by
  falsification rather than by argument. "A reserved row may not **cite** an
  existing account" flagged **the reservation of this milestone**, which quotes row
  29's citation as the evidence for its own existence — a rule that forbids a
  reservation from naming the defect it was opened to fix is the wrong rule. "May
  not be the **only claimant** of one" then let F1 through: this milestone's own
  completed row mentions row 29's document, so restoring row 29's stale marker was
  shielded by a later row merely talking about it. Only **ownership** survives
  both, and it is also the simplest of the three.

## Falsification

Ten mutations, each applied to a clean tree, the gate run, the tree restored.

| # | Mutation | Result |
| --- | --- | --- |
| F1 | row 29's stale marker put back | caught |
| F2 | a marker written in words the vocabulary does not contain | caught |
| F3 | a completed row stops citing the account that completed it | caught |
| F4 | a blocked row stops saying blocked and says nothing recognisable | caught |
| F5 | a completed row reworded so a reservation word appears in its marker | caught |
| F6 | a row loses its bolded marker entirely | caught |
| F7 | two rows claim the same milestone number | caught |
| F8 | a completed row's own account citation removed | caught |
| F9 | a whole row deleted from the table | caught |
| F10 | the exemption list widened to admit a completed row that cites nothing | caught |

**10 of 10 caught, and three of them only after something was fixed.** Recorded in
order, because what each survival was caused by is the useful part:

- **F3** deleted row 36's account reference and survived: the row still cited its
  test file, which the first "a completed row must cite something" rule accepted.
  That is what forced ownership.
- **F1** — row 29's stale marker put back — survived the "only claimant" rule,
  because this milestone's own completed row mentions row 29's document and
  shielded it. That is what forced ownership in the *other* direction too, and it
  is the reason the gate now has one rule where it nearly had two weak ones.
- **F8** survived twice for two unrelated reasons, and the second was a defect in
  the falsification runner rather than in the gate. First it was written before
  `docs/roadmap-status.md` existed, so there was no account to remove. Then it
  still survived because the runner's replace rule was
  `replace(find, replace, 1) if first or n > 1`, which silently mutated only the
  **first** of two occurrences whenever a string appeared twice — so the citation
  the gate reads was left in place and the gate correctly passed. Hand-applying the
  same mutation caught it immediately, which is how the runner bug was found. The
  rule is now explicit (`all` on the mutation, or first-only) and the same defect
  would have made any two-occurrence mutation in cycles 36 and 37 read as
  survived; none of those mutations had a repeated anchor, which was luck.

This is the third probe defect in three cycles — after cycle 37's `body: {}` probe
that measured the wrong surface and its conflict probe that failed at setup. The
pattern is consistent enough to name: **a probe that reports green is reporting
about itself until proven otherwise.**

Runner `/tmp/falsify38.py`, specification `/tmp/mut38.json`, outside the repository
as in previous cycles because they mutate the tree they run against.

## What this does not claim

The gate reads claims, not work. It cannot tell whether a row marked `complete` is
in fact finished — only that the row's claim does not contradict the tree in the
ways measured above. Rows 2, 8 and 10 still report two sub-statuses in one
sentence and are classified by the first state their marker matches, which is a
simplification the classifier makes on purpose rather than a fact about those
milestones.
