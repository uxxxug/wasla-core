/**
 * The roadmap's own status claims are checked against the repository — milestone 38.
 *
 * Cycles 33, 36 and 37 each merged with a completed row still reporting itself as
 * "Reserved and measured, not yet implemented", and each needed a follow-up pull
 * request after the merge to correct it. The reason is structural rather than
 * careless: the convention is that a reservation is never rewritten and its
 * outcome is appended, and the marker a reader trusts sits at the *front* of the
 * cell the outcome is appended to the *end* of. Three occurrences is a defect in
 * this repository's governance, and `scripts/check-roadmap.mjs` could not have
 * caught any of them — it checks only that `ROADMAP.md` appears in a commit range
 * that touched implementation, and has never read a word of the file.
 *
 * Measured on `main` at `907e3ee`, before any edit:
 *
 *  - 37 rows, every one opening its status cell with a bolded claim, drawn from a
 *    vocabulary nobody had declared: `Complete` (16), `Complete, and
 *    self-enforcing from here` (8), and one each of `Complete.` (with a full stop,
 *    written by the correction meant to normalise it), `CORE side complete`,
 *    `Complete inside CORE`, `Complete inside CORE, with a fake adapter rather
 *    than a live provider`, `Complete, except policy decisions that are not
 *    CORE's to make`, `Blocked — external dependency`, `Blocked — B-2, B-3`,
 *    `Blocked — B-5, B-6`, `Not implemented, and until this cycle not tracked here
 *    at all`, and two sentence-length claims reporting two sub-statuses at once.
 *  - **One marker was false, and had been for eight cycles.** Row 29 read
 *    "Reserved, measured, in progress on branch `http-auth-order`" while the same
 *    cell went on to report the cycle's outcome, cited
 *    `tests/anonymous-privilege-escalation.test.ts` and
 *    `docs/anonymous-privilege-escalation.md` — both in the tree — and recorded
 *    the counts it measured. The branch was gone. Nobody found this by reading;
 *    it was found by comparing every marker against the artifacts its own cell
 *    cites, which is the comparison this file now performs on every run.
 *
 * **The obvious rule is wrong, and measuring showed it before it was written.**
 * "Every path a row cites must exist in the tree" fails on row 35, which cites
 * `tests/migration-9999-lifecycle.test.ts` — a probe deliberately created to prove
 * that `test:suite`'s glob exclusion and `test:cluster`'s named file left a gap
 * where a test file ran in neither pass, then deleted without being committed.
 * That citation is true and describes an experiment. A path-existence gate would
 * have demanded the evidence be deleted, which cycle 30's rule forbids. So the
 * rule is not about paths existing; it is about which *kind* of artifact a row in
 * a given state is allowed to have.
 *
 * **What was decided.** The marker stays where it is and is *classified* rather
 * than replaced. Normalising 37 cells to a token would have rewritten 37
 * reservations to satisfy a gate — the exact move this repository forbids — and
 * would have deleted the nuance rows 2, 8 and 10 carry deliberately (two
 * sub-statuses at once, because the milestone genuinely has two). So the closed
 * vocabulary lives here, in code, as a total classifier: every row must fall into
 * exactly one state, and a marker that matches nothing fails the build. That is
 * the part that makes the vocabulary real, because until now it was whatever
 * anybody typed.
 *
 * Completion is then held to evidence, in the one direction that catches the
 * defect: this repository writes `docs/<topic>.md` as the *account of a completed
 * cycle*, so a row still claiming to be reserved must not have one. Row 29 had
 * one. And from milestone 26 onward every row cites at least one committed
 * artifact, so a completed row that cites nothing fails — with the exemption list
 * for the earlier rows asserted exactly, so it cannot quietly grow.
 */
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const roadmap = readFileSync(new URL("../ROADMAP.md", import.meta.url), "utf8");

/**
 * The states a row may be in. Declared here rather than in the document, because
 * the document is prose and prose is what let twelve variants of three states
 * accumulate unnoticed. Order matters: the first pattern that matches wins, and
 * `reserved` is tested before `complete` so that a cell saying "reserved... not
 * yet implemented" cannot be read as complete because the word appears later.
 */
const STATES = [
  {
    state: "reserved",
    // "Reserved", "in progress", "not yet implemented", "not started".
    pattern: /\b(reserved|in progress|not yet implemented|not started)\b/i,
  },
  { state: "blocked", pattern: /^blocked\b/i },
  { state: "not implemented", pattern: /^not implemented\b/i },
  // The fall-through is not "anything else": it must say so.
  { state: "complete", pattern: /\bcomplete\b/i },
] as const;

type State = (typeof STATES)[number]["state"];

interface Row {
  readonly milestone: number;
  readonly marker: string;
  readonly state: State | undefined;
  readonly cell: string;
  readonly citations: readonly string[];
}

const rows: Row[] = [];
for (const line of roadmap.split("\n")) {
  if (!/^\| \d+ \|/.test(line)) continue;
  const cells = line.split(" | ");
  const milestone = Number(cells[0]!.replace(/^\|\s*/, "").trim());
  const cell = cells[2] ?? "";
  const marker = /^\s*\*\*(.+?)\*\*/.exec(cell)?.[1] ?? "";
  rows.push({
    milestone,
    marker,
    state: STATES.find((candidate) => candidate.pattern.test(marker))?.state,
    cell,
    // Every path the whole row names in backticks, which is how this document
    // cites an artifact.
    citations: [
      ...new Set(
        [...line.matchAll(/`((?:tests|docs|src|db|scripts|contracts)\/[A-Za-z0-9_./-]+)`/g)].map(
          (match) => match[1]!,
        ),
      ),
    ],
  });
}

/**
 * Completed rows that own no written cycle account. Measured, not chosen: from
 * milestone 27 onward every completed row owns exactly one, which is the
 * convention "one `docs/<topic>.md` per cycle" showing up as a fact about the
 * tree rather than as a sentence in a document. The eight rows below predate it.
 * Asserted exactly, so it cannot grow.
 */
const OWNS_NO_ACCOUNT = [1, 3, 12, 19, 20, 21, 25, 26];

/**
 * The only two completed rows that cite no artifact at all. The list was drafted
 * from a first measurement that read six rows (1, 3, 5, 7, 9, 25) and the gate
 * corrected it: 5, 7 and 9 are `blocked` rather than complete, and row 25 does
 * cite one — a `contracts/` path, which the first pass had not counted. The wrong
 * list is recorded rather than quietly replaced, because it is the second time in
 * two cycles that a hand-drafted list disagreed with what the code measured.
 *
 * Asserted exactly rather than used as a filter, so a new row cannot join it by
 * citing nothing: the set may shrink and may not grow.
 */
const CITES_NOTHING = [1, 3];

/**
 * A written cycle account belongs to the lowest-numbered row that cites it: the
 * row that produced it. A later reservation may quote an earlier cycle's document
 * as evidence without being credited with having written it, and cannot shield an
 * earlier row's stale claim either.
 */
const accountOwner = new Map<string, number>();
for (const row of [...rows].sort((a, b) => a.milestone - b.milestone)) {
  for (const path of row.citations) {
    if (!path.startsWith("docs/")) continue;
    if (!existsSync(new URL(`../${path}`, import.meta.url))) continue;
    if (!accountOwner.has(path)) accountOwner.set(path, row.milestone);
  }
}
const accountsOwnedBy = (milestone: number): string[] =>
  [...accountOwner.entries()].filter(([, owner]) => owner === milestone).map(([path]) => path);

describe("the roadmap's status claims agree with the repository", () => {
  it("reads a row for every milestone, with a marker on each", () => {
    expect(rows.length).toBeGreaterThanOrEqual(38);
    expect(rows.filter((row) => row.marker === "").map((row) => row.milestone)).toEqual([]);
    // Numbers are unique: two rows for one milestone would make every claim below
    // ambiguous, and the table is hand-maintained.
    expect(new Set(rows.map((row) => row.milestone)).size).toBe(rows.length);
  });

  it("classifies every marker into exactly one declared state", () => {
    // The vocabulary is closed by this assertion and by nothing else. A marker
    // that says something new — or says nothing recognisable — fails here rather
    // than being silently read as complete.
    const unclassified = rows
      .filter((row) => row.state === undefined)
      .map((row) => `row ${row.milestone}: ${row.marker}`);
    expect(unclassified).toEqual([]);
  });

  it("does not let a row claim to be reserved once its account has been written", () => {
    // This repository writes `docs/<topic>.md` as the account of a *completed*
    // cycle, so a row that owns one may not still say it has not run. Row 29
    // owned `docs/anonymous-privilege-escalation.md` while claiming to be
    // reserved, for eight cycles.
    //
    // Ownership, not citation. Two weaker forms were tried and both failed a
    // falsification. "A reserved row may not cite an existing account" flagged
    // the reservation of *this* milestone, which quotes row 29's citation as the
    // evidence for its own existence — a rule that forbids a reservation from
    // naming the defect it was opened to fix is the wrong rule. "May not be the
    // only claimant" then let row 29's stale marker back in, because this
    // milestone's own completed row mentions the same file and shielded it. An
    // account belongs to the lowest-numbered row that cites it, which is the one
    // that wrote it, and shielding is impossible.
    const contradictions = rows
      .filter((row) => row.state === "reserved")
      .flatMap((row) =>
        accountsOwnedBy(row.milestone).map(
          (path) =>
            `row ${row.milestone} claims "${row.marker}" and owns ${path}, a written account of a cycle that says it has not run`,
        ),
      );
    expect(contradictions).toEqual([]);
  });

  it("requires a completed row to cite the artifact that completed it", () => {
    const silent = rows
      .filter((row) => row.state === "complete" && row.citations.length === 0)
      .map((row) => row.milestone)
      .sort((a, b) => a - b);
    // Not `toEqual` against a filter: the exemption list is asserted, so adding a
    // completed row that cites nothing fails even though the older rows do too.
    expect(silent).toEqual(CITES_NOTHING);
  });

  it("requires every completed cycle from 27 onward to own its written account", () => {
    // The other direction. Ownership rather than mere citation because a
    // falsification that deleted row 36's `docs/documented-refusals.md` reference
    // survived the weaker rule: the row still cited its test file.
    const ownsNothing = rows
      .filter((row) => row.state === "complete" && accountsOwnedBy(row.milestone).length === 0)
      .map((row) => row.milestone)
      .sort((a, b) => a - b);
    expect(ownsNothing).toEqual(OWNS_NO_ACCOUNT);
  });

  it("keeps the exemption honest by naming what each exempt row is", () => {
    // A guard on the guard: if a row on the list stops being complete, or the
    // list stops matching the table, the previous assertion would quietly weaken.
    for (const milestone of [...CITES_NOTHING, ...OWNS_NO_ACCOUNT]) {
      const row = rows.find((candidate) => candidate.milestone === milestone);
      expect(row, `row ${milestone} is on the exemption list and not in the table`).toBeDefined();
    }
  });

  it("marks a blocked row as blocked rather than as something to come back to", () => {
    // `blocked` and `reserved` are the two states a reader acts on differently:
    // one is waiting on somebody outside this repository, the other is work in
    // flight here. A row may not read as both.
    const both = rows
      .filter((row) => /^blocked\b/i.test(row.marker) && row.state !== "blocked")
      .map((row) => `row ${row.milestone}: ${row.marker}`);
    expect(both).toEqual([]);
  });
});
