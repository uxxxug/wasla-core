import { configDefaults, defineConfig } from "vitest/config";
// @ts-expect-error - plain ESM, deliberately not TypeScript: this module is the
// one definition of the test partition and is read by `scripts/`, which runs
// under bare node with no build step.
import { clusterFiles, requestedPass, suiteFiles } from "./scripts/test-partition.mjs";

/**
 * The suite had no configuration file until this cycle, which is why the two
 * defects it now closes could exist: nothing central decided how database-backed
 * files relate to each other.
 *
 * `setupFiles` runs `tests/support/worker-database.ts` in every worker before any
 * test module is imported, which is the only point where `DATABASE_URL` can be
 * redirected to a worker-private database without editing the twenty-odd files
 * that read it at module scope.
 *
 * `hookTimeout` is raised for the same reason it was being hit: the migration
 * lifecycle suite creates and drops a real database, and those are cluster-wide
 * operations whose cost depends on what else is running on the server. Measured
 * on this machine: about 0.3s idle, and **51s** while the rest of the suite was
 * working the same server. The 60s default was therefore a coin toss. The number
 * is raised *and* the cause is removed — `npm test` runs the lifecycle files in
 * their own pass, so nothing competes with them — because a timeout that is
 * merely generous would still be masking contention instead of ending it.
 */
/**
 * Which files run is decided here, from `scripts/test-partition.mjs`, and not in
 * a `package.json` command line. It used to be decided in two command lines
 * that disagreed: `test:suite` excluded a glob while `test:cluster` named a
 * single file, so a lifecycle file added later would have run in neither pass
 * with `npm test` still reporting green. Measured, then closed — see milestone
 * 35 in `ROADMAP.md` and `docs/test-partition.md`.
 *
 * The consequence worth naming: a bare `vitest run` now performs exactly CI's
 * suite pass, so a local count and the count in a CI log are the same number
 * about the same files. `scripts/check-test-partition.mjs` fails the build if
 * any test file belongs to neither pass or to both.
 */
const pass: "suite" | "cluster" = requestedPass();

export default defineConfig({
  test: {
    include: pass === "cluster" ? clusterFiles() : suiteFiles(),
    exclude: [...configDefaults.exclude],
    setupFiles: ["tests/support/worker-database.ts"],
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
