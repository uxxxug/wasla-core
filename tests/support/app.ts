/**
 * A core app whose tenants exist.
 *
 * Before the foreign-key parity cycle, a test could publish a market order for
 * `org-1` without ever creating `org-1`: the reference backend accepted the
 * fulfillment row, so the scenario passed in memory while the same sequence
 * against Postgres was refused by `fulfillment_organization_id_fkey`. That is
 * the B-12 failure in its plainest form — a green run certifying a write
 * production rejects — and the fix belongs in the fixture, not in the rule.
 *
 * The bundle is built here rather than inside `createCoreApp` so the test can
 * reach the stores to seed a parent row. `createCoreApp` still owns the wiring;
 * this only decides which persistence it is handed.
 */
import { createCoreApp, type CoreApp } from "../../src/app.js";
import type { Clock } from "../../src/platform/clock.js";
import { memoryPersistence, type Persistence } from "../../src/platform/persistence/backends.js";
import { seedTenant } from "./rows.js";

export async function coreWithTenants<C extends Clock>(
  clock: C,
  organizationIds: readonly string[],
): Promise<CoreApp & { store: Persistence; clock: C }> {
  const store = memoryPersistence(clock);
  const core = createCoreApp({ clock, persistence: store });
  for (const organizationId of organizationIds) {
    await seedTenant(store, organizationId);
  }
  return { ...core, store, clock };
}
