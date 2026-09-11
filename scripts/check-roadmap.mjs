#!/usr/bin/env node
/**
 * Roadmap freshness gate.
 *
 * Rule (mandatory across all three WASLA repositories): a push that changes
 * implementation must update ROADMAP.md in the same cycle. This script compares
 * the pushed range and fails when code moved but the roadmap did not.
 *
 * Usage: node scripts/check-roadmap.mjs [baseRef] [headRef]
 * In CI the refs come from the push event; locally it defaults to HEAD~1..HEAD.
 */
import { execSync } from "node:child_process";

const base = process.argv[2] || process.env.BASE_SHA || "HEAD~1";
const head = process.argv[3] || process.env.HEAD_SHA || "HEAD";

function changedFiles(from, to) {
  try {
    return execSync(`git diff --name-only ${from} ${to}`, { encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

const files = changedFiles(base, head);
if (files === null) {
  console.log("Roadmap check skipped: cannot resolve the commit range (first commit or shallow clone).");
  process.exit(0);
}

const IMPLEMENTATION = /^(src\/|db\/|contracts\/|scripts\/|package\.json$|\.github\/workflows\/)/;
const implementationChanged = files.some((f) => IMPLEMENTATION.test(f));
const roadmapChanged = files.includes("ROADMAP.md");

if (implementationChanged && !roadmapChanged) {
  console.error("ROADMAP.md was not updated alongside implementation changes:");
  for (const f of files.filter((f) => IMPLEMENTATION.test(f))) console.error(`  - ${f}`);
  console.error("\nUpdate ROADMAP.md in the same commit cycle. This is a hard rule.");
  process.exit(1);
}

console.log(
  implementationChanged
    ? "Roadmap check passed: implementation and ROADMAP.md changed together."
    : "Roadmap check passed: no implementation changes in this range.",
);
