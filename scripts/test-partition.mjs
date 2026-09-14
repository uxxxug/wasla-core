/**
 * The one definition of how the suite is divided into passes.
 *
 * Before this file the division was stated twice, in two different languages,
 * in two `package.json` strings: `test:suite` excluded the *glob*
 * `tests/migration-*-lifecycle.test.ts` and `test:cluster` ran the *named file*
 * `tests/migration-0011-lifecycle.test.ts`. Those two statements agreed only
 * because exactly one lifecycle file existed. Measured on `main` at `5567e49`:
 * adding an empty `tests/migration-9999-lifecycle.test.ts` produced a file that
 * ran in neither pass, while `npm test` reported everything green.
 *
 * A second consequence was quieter. The exclusion lived in a script string, so
 * a bare `vitest run` — the command every local measurement in `ROADMAP.md`
 * actually used — covered a different file set than CI, and the resulting
 * one-test difference in the skipped count was recorded as unexplained for
 * twelve cycles. It was 147 + 1 = 148 the whole time.
 *
 * So: the partition is a predicate, declared once, and both passes and a gate
 * read it. `scripts/check-test-partition.mjs` fails the build if any test file
 * falls into neither pass or into both, or if the scripts stop deriving their
 * file sets from here.
 *
 * Why lifecycle files are a separate pass at all: they create and drop real
 * databases, which are cluster-wide operations. Run beside the rest of the
 * suite they took 51s against 0.3s idle (see `vitest.config.ts`). Their
 * isolation is a correctness requirement, not a preference — which is why it is
 * enforced rather than left to a command line.
 */

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const TESTS_DIRECTORY = "tests";

/**
 * A file belongs to the cluster pass if and only if it matches this. It is a
 * pattern rather than a list so that a lifecycle file added tomorrow is placed
 * by the same rule as the one added a year ago, and it is anchored at both ends
 * so that `tests/migration-0011-lifecycle-helpers.test.ts` is *not* silently
 * swept into a pass that runs one file at a time.
 */
export const CLUSTER_FILE_PATTERN = /^migration-\d+-lifecycle\.test\.ts$/;

const repositoryRoot = () => join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every test file the suite has, in sorted order, as repository-relative paths. */
export const allTestFiles = (root = repositoryRoot()) =>
  readdirSync(join(root, TESTS_DIRECTORY))
    .filter((entry) => entry.endsWith(".test.ts"))
    .sort()
    .map((entry) => `${TESTS_DIRECTORY}/${entry}`);

export const isClusterFile = (path) =>
  CLUSTER_FILE_PATTERN.test(path.slice(path.lastIndexOf("/") + 1));

/** The pass that runs one database-creating file at a time. */
export const clusterFiles = (root = repositoryRoot()) =>
  allTestFiles(root).filter(isClusterFile);

/** Everything else — the pass a bare `vitest run` performs. */
export const suiteFiles = (root = repositoryRoot()) =>
  allTestFiles(root).filter((path) => !isClusterFile(path));

/**
 * Which pass runs now. `vitest.config.ts` reads this; nothing else should need
 * to. A value other than the two names is a mistake worth failing on rather
 * than defaulting past, because defaulting past it is how a file stops being
 * run without anybody noticing.
 */
export const PASS_ENVIRONMENT_VARIABLE = "WASLA_TEST_PASS";
export const PASSES = ["suite", "cluster"];

export const requestedPass = (environment = process.env) => {
  const value = environment[PASS_ENVIRONMENT_VARIABLE];
  if (value === undefined || value === "") return "suite";
  if (!PASSES.includes(value)) {
    throw new Error(
      `${PASS_ENVIRONMENT_VARIABLE} must be one of ${PASSES.join(", ")}, not ${JSON.stringify(value)}`,
    );
  }
  return value;
};
