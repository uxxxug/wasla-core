#!/usr/bin/env node
/**
 * Contract validation gate.
 *  1. Every event JSON Schema parses and declares $id, title and description.
 *  2. Every event schema has at least one example.
 *  3. The OpenAPI document parses and every path declares a summary.
 *  4. Every event type emitted by src/ has a published schema — a contract
 *     cannot drift behind the implementation.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const errors = [];

const eventsDir = join(root, "contracts/events");
const schemaFiles = readdirSync(eventsDir).filter((f) => f.endsWith(".schema.json"));
const declaredEventTypes = new Set();

for (const file of schemaFiles) {
  const full = join(eventsDir, file);
  let schema;
  try {
    schema = JSON.parse(readFileSync(full, "utf8"));
  } catch (err) {
    errors.push(`${file}: invalid JSON — ${err.message}`);
    continue;
  }
  for (const key of ["$id", "title", "description", "type"]) {
    if (!schema[key]) errors.push(`${file}: missing "${key}"`);
  }
  if (file !== "envelope.schema.json") {
    if (!Array.isArray(schema.examples) || schema.examples.length === 0) {
      errors.push(`${file}: at least one example payload is required`);
    }
    declaredEventTypes.add(file.replace(/\.v\d+\.schema\.json$/, ""));
  }
}

// OpenAPI: parsed structurally without a YAML dependency.
const openapi = readFileSync(join(root, "contracts/openapi/core-v1.yaml"), "utf8");
if (!/^openapi:\s*3\.1\.\d/m.test(openapi)) errors.push("core-v1.yaml: openapi 3.1.x header missing");
if (!/^\s{2}version:\s*\d+\.\d+\.\d+/m.test(openapi)) errors.push("core-v1.yaml: info.version missing");
const pathLines = openapi.split("\n");
const pathsIndex = pathLines.findIndex((l) => l === "paths:");
if (pathsIndex === -1) errors.push("core-v1.yaml: no paths section");
else {
  let currentPath = null;
  let hasSummary = false;
  for (let i = pathsIndex + 1; i < pathLines.length; i++) {
    const line = pathLines[i];
    if (/^\S/.test(line)) break; // left the paths block
    const pathMatch = /^ {2}(\/[^\s:]*):\s*$/.exec(line);
    if (pathMatch) {
      if (currentPath && !hasSummary) errors.push(`core-v1.yaml: ${currentPath} has no summary`);
      currentPath = pathMatch[1];
      hasSummary = false;
    } else if (/^\s+summary:/.test(line)) {
      hasSummary = true;
    }
  }
  if (currentPath && !hasSummary) errors.push(`core-v1.yaml: ${currentPath} has no summary`);
}

// Implementation → contract coverage.
function walk(dir) {
  let out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    out = out.concat(statSync(full).isDirectory() ? walk(full) : [full]);
  }
  return out;
}
const emitted = new Set();
for (const file of walk(join(root, "src")).filter((f) => f.endsWith(".ts"))) {
  const content = readFileSync(file, "utf8");
  for (const match of content.matchAll(/event_type:\s*"((?:core|move|market)\.[a-z_.]+)"/g)) {
    emitted.add(match[1]);
  }
}
for (const eventType of emitted) {
  if (!declaredEventTypes.has(eventType)) {
    errors.push(`src emits "${eventType}" but contracts/events has no schema for it`);
  }
}

if (errors.length > 0) {
  console.error("Contract validation failed:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `Contract validation passed: ${schemaFiles.length} event schemas, ${emitted.size} emitted event types covered.`,
);
