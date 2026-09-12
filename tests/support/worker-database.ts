/**
 * Gives every test worker its own database.
 *
 * Why this file exists, measured rather than assumed. Every database-backed test
 * file in this suite resets state the same way: `truncate <every table> restart
 * identity cascade` in `beforeEach`. That is correct within one file and a
 * defect across several, because Vitest runs test *files* in parallel worker
 * processes and they all read one `DATABASE_URL`. So one file truncates
 * `organization` while another is midway through a test that depends on the row
 * it just inserted, and the second file fails on a foreign key that its own code
 * never violated.
 *
 * This is not theoretical. It was reproduced while measuring something else:
 * `financial decision boundary on 'postgres' > keeps the pending-decision queue
 * separate from the defect queue` failed with `insert or update on table
 * "fulfillment" violates foreign key constraint
 * "fulfillment_organization_id_fkey"` in a run where nothing was wrong with that
 * test — the file scheduled beside it had truncated the organization out from
 * under it. Which files land beside each other depends on worker count, machine
 * speed and file order, so the suite's verdict depended on scheduling. A green
 * that depends on scheduling is not a measurement, and every earlier cycle's
 * "verified locally against Postgres" was resting on it.
 *
 * The fix is isolation rather than coordination. A lock or a mutex around the
 * truncation would serialise the whole suite through one critical section and
 * still leave every file able to see every other file's rows. A worker-private
 * database removes the shared mutable state itself: within one worker Vitest
 * runs files one at a time, so a truncation there can never interrupt anybody,
 * and no cross-file leakage is possible in either direction.
 *
 * `DATABASE_URL` is rewritten here, before any test module is imported, so the
 * 20-odd files that read it at module scope need no change and cannot opt out.
 * Each worker's database is created once and migrated to head, then reused
 * across runs — the tables are truncated by the tests themselves, so a reused
 * database starts every file empty anyway.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Marks a prepared worker, so the cost is paid once per process, not per file. */
const PREPARED = Symbol.for("wasla.test.worker-database");

interface PreparedGlobal {
  [PREPARED]?: string;
}

/**
 * `VITEST_POOL_ID` identifies the worker process. `VITEST_WORKER_ID` is the
 * documented alias and both are read, because a fallback of "1" would silently
 * put every worker back on one database and restore exactly the interference
 * this file exists to remove — so the absence of both is worth being explicit
 * about rather than defaulting through.
 */
function workerId(): string {
  const id = process.env["VITEST_POOL_ID"] ?? process.env["VITEST_WORKER_ID"];
  if (id && /^[0-9]+$/.test(id)) return id;
  // Not a Vitest worker (or a Vitest that stopped exporting the id): fall back to
  // the process id, which is still private to this process.
  return `p${process.pid}`;
}

async function query(connectionString: string, sql: string): Promise<void> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function appliedCount(connectionString: string): Promise<number> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{ count: string }>(
      "select count(*)::text as count from schema_migrations",
    );
    return Number(result.rows[0]?.count ?? "0");
  } catch {
    // No `schema_migrations` at all — an empty database, which is the normal
    // state the first time a worker runs.
    return 0;
  } finally {
    await client.end();
  }
}

async function migrationsOnDisk(): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(new URL("../../db/migrations", import.meta.url));
  return files.filter((name) => name.endsWith(".sql") && !name.endsWith(".down.sql")).length;
}

const base = process.env["DATABASE_URL"];

if (base) {
  const parsed = new URL(base);
  const baseName = parsed.pathname.replace(/^\//, "") || "postgres";
  const workerName = `${baseName}_w${workerId()}`;
  parsed.pathname = `/${workerName}`;
  const workerUrl = parsed.toString();
  const globals = globalThis as PreparedGlobal;

  if (globals[PREPARED] !== workerUrl) {
    // `create database` is refused if the database exists, and that refusal is
    // the desired outcome on every run after the first, so it is tolerated by
    // name rather than by ignoring all errors.
    try {
      await query(base, `create database ${workerName}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists/i.test(message)) throw error;
    }

    // Migrate only when the database is behind, so a reused worker database
    // costs one query instead of a full migration run. Comparing counts rather
    // than trusting a marker: a half-applied database is behind and must be
    // finished, and `up` is idempotent per version.
    if ((await appliedCount(workerUrl)) < (await migrationsOnDisk())) {
      await run("node", ["scripts/db-migrate.mjs", "up"], {
        env: { ...process.env, DATABASE_URL: workerUrl },
        cwd: new URL("../..", import.meta.url).pathname,
      });
    }

    globals[PREPARED] = workerUrl;
  }

  // Every test file in this worker reads this, at module scope, after this hook.
  process.env["DATABASE_URL"] = workerUrl;
}
