#!/usr/bin/env node
/**
 * Fails the build if a test file is run by neither pass, or by both, or if the
 * passes stop deriving their file sets from `scripts/test-partition.mjs`.
 *
 * This gate exists because of a measurement, not a hunch. On `main` at
 * `5567e49`, `test:suite` excluded the glob `tests/migration-*-lifecycle.test.ts`
 * while `test:cluster` ran the named file `tests/migration-0011-lifecycle.test.ts`.
 * An empty `tests/migration-9999-lifecycle.test.ts` was added and both passes
 * were run: it appeared in neither, and `npm test` still reported green. A test
 * file that nothing runs is worse than a missing test, because the suite counts
 * it as covered.
 *
 * What it refuses, and why each check is here rather than trusted:
 *
 *   1. Every `tests/*.test.ts` is in exactly one pass. This is the guarantee.
 *   2. The two passes together are exactly the set of files on disk — no pass
 *      names a file that does not exist, which is how `test:cluster` would have
 *      started passing vacuously if 0011 were ever renamed.
 *   3. Neither `package.json` test script names a test file, a glob, or an
 *      `--exclude`. Restating the partition on a command line is the original
 *      defect; a gate that only checked the file sets would not notice it
 *      coming back.
 *   4. `npm test` runs both passes, so the totals a reader adds up are the
 *      totals the build produced.
 *   5. **What vitest actually resolves for each pass is exactly what this module
 *      declares.** Checks 1 to 4 read declarations; this one asks the runner.
 *      Every earlier form of the defect was a declaration that was true about
 *      itself and false about what ran, so a gate reading only declarations
 *      would have passed on the very commit that produced the defect. Found by
 *      falsification F12: emptying the configuration's use of the partition was
 *      caught by nothing until this check existed.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CLUSTER_FILE_PATTERN,
  PASS_ENVIRONMENT_VARIABLE,
  allTestFiles,
  clusterFiles,
  suiteFiles,
} from "./test-partition.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const fail = (message) => failures.push(message);

/**
 * Enumerated here, by this file, and not taken from the partition module.
 *
 * This independence was not designed in; falsification F11 found its absence.
 * Making `allTestFiles` silently drop a file — one extra clause in its filter —
 * left that file in no pass, and *every* check below still passed, because the
 * gate's idea of what exists and the runner's `include` list both descended from
 * the same dropped source. A gate that asks the thing it is auditing what to
 * audit is not a gate. So: the directory is read twice, by two files, and the
 * two answers must agree.
 */
const onDiskIndependently = readdirSync(join(root, "tests"))
  .filter((entry) => entry.endsWith(".test.ts"))
  .sort()
  .map((entry) => `tests/${entry}`);

const all = allTestFiles(root);

{
  const missing = onDiskIndependently.filter((path) => !all.includes(path));
  const invented = all.filter((path) => !onDiskIndependently.includes(path));
  if (missing.length > 0 || invented.length > 0) {
    fail(
      `scripts/test-partition.mjs does not see the same files as this directory ` +
        `listing does` +
        (missing.length > 0
          ? `; on disk but invisible to the partition, so in no pass and run by ` +
            `nothing: ${missing.join(", ")}`
          : "") +
        (invented.length > 0 ? `; claimed by the partition but absent: ${invented.join(", ")}` : ""),
    );
  }
}
const suite = suiteFiles(root);
const cluster = clusterFiles(root);

if (all.length === 0) {
  fail("tests/ contains no *.test.ts files at all, which cannot be right");
}

// 1 and 2: exactly one pass per file, and no pass inventing files.
for (const path of all) {
  const passes = [
    suite.includes(path) ? "suite" : null,
    cluster.includes(path) ? "cluster" : null,
  ].filter(Boolean);
  if (passes.length === 0) {
    fail(
      `${path} is run by no pass. It would never execute, and \`npm test\` would ` +
        `report green without it. Either it matches ${CLUSTER_FILE_PATTERN} and ` +
        `belongs to the cluster pass, or it does not and belongs to the suite pass.`,
    );
  }
  if (passes.length > 1) {
    fail(`${path} is run by both passes (${passes.join(" and ")}); its results would be counted twice`);
  }
}

const onDisk = new Set(all);
for (const [name, files] of [
  ["suite", suite],
  ["cluster", cluster],
]) {
  for (const path of files) {
    if (!onDisk.has(path)) {
      fail(`the ${name} pass names ${path}, which does not exist on disk`);
    }
  }
}

if (cluster.length === 0) {
  fail(
    `no file matches ${CLUSTER_FILE_PATTERN}, so the cluster pass would run nothing ` +
      `and report success. If the lifecycle tests were renamed, the pattern in ` +
      `scripts/test-partition.mjs has to move with them.`,
  );
}

// 3 and 4: the passes must not restate the partition on a command line.
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const scripts = manifest.scripts ?? {};

for (const name of ["test:suite", "test:cluster"]) {
  const command = scripts[name];
  if (typeof command !== "string") {
    fail(`package.json has no ${name} script`);
    continue;
  }
  if (!command.includes(PASS_ENVIRONMENT_VARIABLE)) {
    fail(
      `${name} does not set ${PASS_ENVIRONMENT_VARIABLE}, so vitest.config.ts cannot ` +
        `know which pass it is and would silently run the suite pass`,
    );
  }
  if (/--exclude|\.test\.ts|tests\//.test(command)) {
    fail(
      `${name} names test files or an --exclude on its command line: ` +
        `${JSON.stringify(command)}. That is the defect milestone 35 closed — the ` +
        `partition was stated twice, in two languages, and the two statements ` +
        `agreed only by accident. It belongs in scripts/test-partition.mjs alone.`,
    );
  }
}

const test = scripts.test;
if (typeof test !== "string" || !test.includes("test:suite") || !test.includes("test:cluster")) {
  fail(
    `package.json's test script must run both passes so that the totals a reader ` +
      `adds up are the totals the build produced; it is ${JSON.stringify(test)}`,
  );
}

// 5: ask vitest what it will actually run, rather than trusting the above.
const resolved = (pass) => {
  const output = execFileSync("npx", ["vitest", "list", "--filesOnly"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, [PASS_ENVIRONMENT_VARIABLE]: pass },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".test.ts"))
    .map((line) => (line.startsWith(root) ? line.slice(root.length + 1) : line))
    .sort();
};

for (const [name, declared] of [
  ["suite", suite],
  ["cluster", cluster],
]) {
  let actual;
  try {
    actual = resolved(name);
  } catch (error) {
    fail(`could not ask vitest which files the ${name} pass runs: ${error.message}`);
    continue;
  }
  const missing = declared.filter((path) => !actual.includes(path));
  const extra = actual.filter((path) => !declared.includes(path));
  if (missing.length > 0 || extra.length > 0) {
    fail(
      `the ${name} pass does not run what scripts/test-partition.mjs declares: ` +
        `vitest resolves ${actual.length} files against ${declared.length} declared` +
        (missing.length > 0 ? `; declared but not run: ${missing.join(", ")}` : "") +
        (extra.length > 0 ? `; run but not declared: ${extra.join(", ")}` : "") +
        `. Declaring the partition is not the same as performing it, and that ` +
        `difference is the whole defect.`,
    );
  }
}

if (failures.length > 0) {
  console.error("test partition check failed:\n");
  for (const message of failures) console.error(`  - ${message}`);
  console.error(
    `\n${all.length} test files: ${suite.length} in the suite pass, ${cluster.length} in the cluster pass.`,
  );
  process.exit(1);
}

console.log(
  `test partition ok: ${all.length} test files, ${suite.length} in the suite pass and ` +
    `${cluster.length} in the cluster pass, each in exactly one.`,
);
