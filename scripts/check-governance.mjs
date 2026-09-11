#!/usr/bin/env node
/**
 * Architecture governance gate. Fails the build on a boundary violation.
 * Complements tests/governance.test.ts by also covering contracts and SQL.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const violations = [];

function walk(dir) {
  let out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    out = out.concat(statSync(full).isDirectory() ? walk(full) : [full]);
  }
  return out;
}

const files = walk(root);

// 1. CORE must not own MOVE/MARKET entities in its schema or contracts.
const FOREIGN_TABLES = [
  "driver",
  "vehicle",
  "fleet",
  "ride",
  "operational_job",
  "commercial_order",
  "order_item",
  "product",
  "store",
  "merchant",
  "inventory",
];
for (const file of files.filter((f) => f.endsWith(".sql"))) {
  const sql = readFileSync(file, "utf8").toLowerCase();
  for (const table of FOREIGN_TABLES) {
    if (new RegExp(`create table (if not exists )?(public\\.)?${table}\\b`).test(sql)) {
      violations.push(`${file}: CORE must not own table "${table}" (ADR 0002 / ADR 0011)`);
    }
  }
}

// 2. No secret material committed.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk_live_[A-Za-z0-9]{8,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
];
for (const file of files) {
  if (/\.(png|jpg|jpeg|ico|lock|lockb)$/.test(file)) continue;
  if (file.endsWith("check-governance.mjs")) continue;
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) violations.push(`${file}: possible committed secret (${pattern})`);
  }
}

// 3. Every event schema must be referenced by the event catalog.
const catalogPath = join(root, "docs/event-catalog.md");
const catalog = readFileSync(catalogPath, "utf8");
for (const file of files.filter((f) => f.includes("/contracts/events/") && f.endsWith(".schema.json"))) {
  const name = file.split("/").pop();
  if (name === "envelope.schema.json") continue;
  const eventType = name.replace(/\.v\d+\.schema\.json$/, "");
  if (!catalog.includes(eventType)) {
    violations.push(`docs/event-catalog.md: missing entry for ${eventType}`);
  }
}

if (violations.length > 0) {
  console.error("Governance violations:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log("Governance checks passed.");
