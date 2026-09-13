/**
 * Reading CORE's own source, for the gates that measure structure.
 *
 * Milestone 24 scanned `src` with `String.includes` and per-file regexes to prove
 * that nothing outside `query.ts` reads a query string and that no route declares
 * a parameter it never reads. Milestone 25 broke both checks the moment it existed,
 * and neither break was a real defect:
 *
 *  - `body.ts` explains in a comment *why* `RequestContext` carries no
 *    `URLSearchParams`, and the scan counted the word in the prose as a second
 *    reader.
 *  - body field specs are written `{ name: "endpoint_url", kind: "text" }`, the
 *    same literal shape as parameter specs, so the declared-vs-read cross-check
 *    read them as query parameters that no handler reads.
 *
 * Both are the scan being imprecise rather than the rule being wrong, so the
 * helpers live here, are shared by both gates, and are precise about two things:
 * comments are not code, and a declaration belongs to the call it was written in.
 * Nothing here weakens what either gate asserts — a real second reader in real
 * code still fails, which the falsification logs in
 * `docs/http-parameter-declaration.md` and `docs/http-body-declaration.md`
 * demonstrate by putting one back.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every TypeScript file under a directory, recursively. */
export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

/**
 * The same source with comments blanked out.
 *
 * Replaced by spaces rather than deleted, so offsets and line numbers still line
 * up with the file on disk. String *contents* are deliberately kept: the
 * cross-checks below find declared and read names inside string literals, so
 * blanking them would blind the gates rather than sharpen them. The cost is
 * stated rather than hidden — a gate word that appears inside a runtime message
 * string still counts as code here.
 */
export function code(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (two === "//") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      out += " ".repeat(stop - index);
      index = stop;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(index, stop).replace(/[^\n]/g, " ");
      index = stop;
      continue;
    }
    const quote = source[index]!;
    if (quote === '"' || quote === "'" || quote === "`") {
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (source[cursor] === quote) break;
        cursor += 1;
      }
      const stop = Math.min(cursor + 1, source.length);
      // Copied through untouched: a string literal is where the names live.
      out += source.slice(index, stop);
      index = stop;
      continue;
    }
    out += source[index];
    index += 1;
  }
  return out;
}

/**
 * The text of every call to `callee` in a source file, from the opening
 * parenthesis to its match.
 *
 * Comments are stripped first, so a call quoted in a comment is not a call. Used
 * to attribute a `{ name, kind }` literal to the registration it was written in
 * instead of to the file it happens to sit in.
 */
export function calls(source: string, callee: string): string[] {
  const stripped = code(source);
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = stripped.indexOf(callee, from);
    if (start === -1) return out;
    let depth = 0;
    let cursor = start + callee.length - 1;
    for (; cursor < stripped.length; cursor += 1) {
      const character = stripped[cursor];
      if (character === "(" || character === "[" || character === "{") depth += 1;
      else if (character === ")" || character === "]" || character === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(source.slice(start, Math.min(cursor + 1, source.length)));
    from = cursor === start ? start + callee.length : cursor;
  }
}

/** Read a file and strip its comments and string contents in one step. */
export function readCode(path: string): string {
  return code(readFileSync(path, "utf8"));
}
