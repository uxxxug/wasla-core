/**
 * The suite's own division into passes, tested by the suite.
 *
 * Milestone 35. Two defects were measured on `main` at `5567e49` before any of
 * this existed:
 *
 *   1. `test:suite` excluded the glob `tests/migration-*-lifecycle.test.ts`
 *      while `test:cluster` ran the named file `migration-0011-lifecycle.test.ts`.
 *      An empty `tests/migration-9999-lifecycle.test.ts` was added and both
 *      passes run: it appeared in **neither**, and `npm test` reported green.
 *   2. Because the exclusion lived in a `package.json` string rather than in the
 *      configuration, a bare `vitest run` covered a different file set than CI,
 *      and the resulting one-test difference in the skipped count was recorded
 *      as unexplained for twelve cycles. It was 147 + 1 = 148 throughout.
 *
 * `scripts/check-test-partition.mjs` is the build gate. This file is the unit
 * gate on the predicate underneath it, and the difference matters: the script
 * checks the repository as it stands today, which is one arrangement of files.
 * These cases check the *rule*, including on arrangements that do not exist yet
 * and are precisely the ones that broke before — a second lifecycle file, a
 * renamed one, a near-miss name.
 *
 * What is deliberately not asserted here: a count. Writing "60 files in the
 * suite pass" into a test makes every new test file a failing build, and the
 * count is already stated where a reader looks for it — `README.md` and the
 * cycle records — and produced by the passes themselves.
 */

import { describe, expect, it } from "vitest";

import {
  CLUSTER_FILE_PATTERN,
  PASSES,
  PASS_ENVIRONMENT_VARIABLE,
  TESTS_DIRECTORY,
  allTestFiles,
  clusterFiles,
  isClusterFile,
  requestedPass,
  suiteFiles,
} from "../scripts/test-partition.mjs";

describe("the test partition", () => {
  it("puts every test file in exactly one pass", () => {
    const all = allTestFiles();
    const suite = suiteFiles();
    const cluster = clusterFiles();

    expect(all.length).toBeGreaterThan(0);
    expect([...suite, ...cluster].sort()).toEqual(all);
    expect(suite.filter((path: string) => cluster.includes(path))).toEqual([]);
  });

  it("names only files that exist, so a pass cannot pass vacuously", () => {
    const all = new Set(allTestFiles());
    for (const path of [...suiteFiles(), ...clusterFiles()]) {
      expect(all.has(path)).toBe(true);
    }
  });

  it("has something in the cluster pass, so that pass is not green by emptiness", () => {
    expect(clusterFiles().length).toBeGreaterThan(0);
  });

  it("claims every lifecycle file, not one named one — the defect that hid a whole file", () => {
    // The arrangement that broke: a second lifecycle file. Under the old
    // arrangement this ran in neither pass. The rule must place it.
    for (const name of [
      "migration-0011-lifecycle.test.ts",
      "migration-0012-lifecycle.test.ts",
      "migration-9999-lifecycle.test.ts",
      "migration-1-lifecycle.test.ts",
    ]) {
      expect(isClusterFile(`tests/${name}`)).toBe(true);
    }
  });

  it("does not sweep near misses into a pass that runs one file at a time", () => {
    for (const name of [
      "migration-0011-lifecycle-helpers.test.ts",
      "migration-lifecycle.test.ts",
      "migration-00xx-lifecycle.test.ts",
      "lifecycle.test.ts",
      "migration-0011-lifecycle.test.ts.bak.test.ts",
      "not-migration-0011-lifecycle.test.ts",
    ]) {
      expect(isClusterFile(`tests/${name}`)).toBe(false);
    }
  });

  it("decides by the file name and not by the directory it sits under", () => {
    expect(isClusterFile("migration-0011-lifecycle.test.ts")).toBe(true);
    expect(isClusterFile("a/b/c/migration-0011-lifecycle.test.ts")).toBe(true);
    expect(isClusterFile("migration-0011-lifecycle/whatever.test.ts")).toBe(false);
  });

  it("anchors the pattern at both ends", () => {
    expect(CLUSTER_FILE_PATTERN.source.startsWith("^")).toBe(true);
    expect(CLUSTER_FILE_PATTERN.source.endsWith("$")).toBe(true);
  });

  it("keeps the declared types honest about the module", () => {
    // scripts/test-partition.mjs is plain ESM with a hand-written .d.mts beside
    // it, which is a second statement about one thing and therefore the kind of
    // duplication this milestone is about. It is accepted only because it is
    // checked: if a name is dropped or renamed in the module, this fails rather
    // than quietly widening to `any`.
    for (const exported of [allTestFiles, isClusterFile, clusterFiles, suiteFiles, requestedPass]) {
      expect(typeof exported).toBe("function");
    }
    expect(CLUSTER_FILE_PATTERN).toBeInstanceOf(RegExp);
    expect(typeof PASS_ENVIRONMENT_VARIABLE).toBe("string");
    expect(TESTS_DIRECTORY).toBe("tests");
  });

  it("runs the suite pass when nothing asks for a pass, because that is the common case", () => {
    expect(requestedPass({})).toBe("suite");
    expect(requestedPass({ [PASS_ENVIRONMENT_VARIABLE]: "" })).toBe("suite");
    expect(requestedPass({ [PASS_ENVIRONMENT_VARIABLE]: "suite" })).toBe("suite");
    expect(requestedPass({ [PASS_ENVIRONMENT_VARIABLE]: "cluster" })).toBe("cluster");
  });

  it("refuses a pass name it does not know instead of defaulting past it", () => {
    // Defaulting past a typo is how a pass stops running the files it was meant
    // to run while still reporting success.
    for (const value of ["Cluster", "clusters", "suite ", "all", "0"]) {
      expect(() => requestedPass({ [PASS_ENVIRONMENT_VARIABLE]: value })).toThrow(
        /must be one of/,
      );
    }
    expect(PASSES).toEqual(["suite", "cluster"]);
  });
});
