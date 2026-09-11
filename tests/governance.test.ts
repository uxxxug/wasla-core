import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src", import.meta.url).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = walk(SRC).filter((f) => f.endsWith(".ts"));

/**
 * Executable governance (ADR 0018). These are not documentation — a violation
 * fails CI.
 */
describe("architecture governance", () => {
  it("CORE contains no MOVE- or MARKET-owned domain entities", async () => {
    const forbidden = [
      /\bdriver\b/i,
      /\bdispatch\b/i,
      /\bvehicle\b/i,
      /\bfleet\b/i,
      /\bmerchant\b/i,
      /\binventory\b/i,
      /\bcatalog\b/i,
      /\bstorefront\b/i,
      /\bproof_of_delivery\b/i,
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      // Comments may reference other systems when explaining a boundary.
      const code = content
        .split("\n")
        .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
        .join("\n");
      for (const pattern of forbidden) {
        if (pattern.test(code)) offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no secrets, tokens or credentials are hardcoded", async () => {
    const patterns = [
      /sk_live_[A-Za-z0-9]/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /(password|api_key|secret)\s*[:=]\s*["'][^"'{}\s]{8,}["']/i,
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const pattern of patterns) {
        if (pattern.test(content)) offenders.push(`${file}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("modules do not reach into each other's internals", async () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (!file.includes("/modules/")) continue;
      const moduleName = file.split("/modules/")[1]!.split("/")[0]!;
      const content = readFileSync(file, "utf8");
      const imports = [...content.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      for (const imported of imports) {
        const match = /modules\/([^/]+)\/(.+)$/.exec(imported);
        if (!match) continue;
        const target = match[1]!;
        const rest = match[2]!;
        if (target === moduleName) continue;
        // Only a module's published surface may be imported.
        if (!/^(service|domain|http)\.js$/.test(rest)) {
          offenders.push(`${file} imports internal ${imported}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has no TODO or FIXME masquerading as an implementation", async () => {
    const offenders = files.filter((file) => /TODO|FIXME|XXX/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
