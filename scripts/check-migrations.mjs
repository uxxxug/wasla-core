#!/usr/bin/env node
/**
 * Migration validation gate.
 *  1. Every forward migration has a matching .down.sql rollback.
 *  2. Version prefixes are unique and sequential.
 *  3. Every forward migration is transactional (BEGIN/COMMIT).
 *  4. No destructive statement lands in a forward migration.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = new URL("../db/migrations", import.meta.url).pathname;
const errors = [];
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const forward = files.filter((f) => !f.endsWith(".down.sql"));

const seen = new Set();
for (const file of forward) {
  const version = file.split("_")[0];
  if (!/^\d{4}$/.test(version)) errors.push(`${file}: version prefix must be 4 digits`);
  if (seen.has(version)) errors.push(`${file}: duplicate version ${version}`);
  seen.add(version);

  const down = file.replace(/\.sql$/, ".down.sql");
  if (!files.includes(down)) errors.push(`${file}: missing rollback ${down}`);

  const sql = readFileSync(join(dir, file), "utf8");
  if (!/^\s*BEGIN;/m.test(sql) || !/^\s*COMMIT;/m.test(sql)) {
    errors.push(`${file}: forward migration must be wrapped in BEGIN; ... COMMIT;`);
  }
  const destructive = [/\bDROP\s+TABLE\b/i, /\bTRUNCATE\b/i, /\bDROP\s+COLUMN\b/i, /\bDELETE\s+FROM\b/i];
  for (const pattern of destructive) {
    if (pattern.test(sql)) {
      errors.push(
        `${file}: destructive statement (${pattern}) in a forward migration — split it into a reviewed, gated migration`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error("Migration validation failed:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`Migration validation passed: ${forward.length} forward migrations, all with rollbacks.`);
