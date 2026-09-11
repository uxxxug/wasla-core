#!/usr/bin/env node
/**
 * Applies and rolls back the SQL migrations in db/migrations against a real
 * PostgreSQL instance.
 *
 * The migrations record themselves in schema_migrations, so this runner only
 * decides what to send and in what order; it never invents version bookkeeping
 * of its own. Each file is sent inside a transaction, so a migration that
 * fails halfway leaves nothing behind.
 *
 *   DATABASE_URL=postgres://user:pass@host:port/db node scripts/db-migrate.mjs status
 *   ... up              apply every pending forward migration in order
 *   ... down            roll back the newest applied migration only
 *   ... down --all      roll back everything, newest first
 *
 * `pg` is a devDependency: the application itself still has no runtime
 * dependencies. This runner is tooling, not part of the served code.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function forwardMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql") && !name.endsWith(".down.sql"))
    .sort()
    .map((name) => ({
      name,
      version: name.replace(/\.sql$/, ""),
      up: join(MIGRATIONS_DIR, name),
      down: join(MIGRATIONS_DIR, name.replace(/\.sql$/, ".down.sql")),
    }));
}

async function connect() {
  const url = process.env["DATABASE_URL"];
  if (!url) fail("DATABASE_URL is required. It is read from the environment and never committed.");
  let pg;
  try {
    pg = await import("pg");
  } catch {
    fail("the pg driver is not installed. Run `npm install` first.");
  }
  const client = new pg.default.Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Versions already recorded, or an empty list when the ledger table does not exist yet. */
async function applied(client) {
  const present = await client.query(
    "select 1 from information_schema.tables where table_schema = current_schema() and table_name = 'schema_migrations'",
  );
  if (present.rowCount === 0) return [];
  const rows = await client.query("select version from schema_migrations order by version");
  return rows.rows.map((row) => row.version);
}

async function runFile(client, path, label) {
  const sql = readFileSync(path, "utf8");
  await client.query("begin");
  try {
    await client.query(sql);
    await client.query("commit");
    console.log(`applied  ${label}`);
  } catch (error) {
    await client.query("rollback");
    fail(`${label} failed and was rolled back: ${error.message}`);
  }
}

async function main() {
  const [command, ...flags] = process.argv.slice(2);
  const client = await connect();
  try {
    const migrations = forwardMigrations();
    const done = await applied(client);

    if (!command || command === "status") {
      for (const migration of migrations) {
        const state = done.includes(migration.version) ? "applied" : "pending";
        const rollback = existsSync(migration.down) ? "" : "  (no rollback!)";
        console.log(`${state.padEnd(8)} ${migration.version}${rollback}`);
      }
      const orphans = done.filter((version) => !migrations.some((m) => m.version === version));
      for (const version of orphans) console.log(`unknown  ${version}  (recorded but no file)`);
      return;
    }

    if (command === "up") {
      const pending = migrations.filter((migration) => !done.includes(migration.version));
      if (pending.length === 0) {
        console.log("nothing pending");
        return;
      }
      for (const migration of pending) await runFile(client, migration.up, migration.version);
      return;
    }

    if (command === "down") {
      const appliedInOrder = migrations.filter((migration) => done.includes(migration.version));
      const targets = flags.includes("--all") ? appliedInOrder.slice().reverse() : appliedInOrder.slice(-1);
      if (targets.length === 0) {
        console.log("nothing to roll back");
        return;
      }
      for (const migration of targets) {
        if (!existsSync(migration.down)) fail(`${migration.version} has no rollback file`);
        await runFile(client, migration.down, `${migration.version} (down)`);
      }
      return;
    }

    fail(`unknown command "${command}". Use status, up, or down [--all].`);
  } finally {
    await client.end();
  }
}

await main();
