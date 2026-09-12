import { defineConfig } from "vitest/config";

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
export default defineConfig({
  test: {
    setupFiles: ["tests/support/worker-database.ts"],
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
