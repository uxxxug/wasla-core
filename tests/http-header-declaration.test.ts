/**
 * CORE reads only the headers it declares, and accepts them only in the shape it
 * declares — milestone 26.
 *
 * The third and last request surface, after the query string (24) and the body
 * (25), and the only one where CORE keeps what the caller sent as **its own
 * record of what happened**. Measured on `main` at `a043ab7`, through
 * `createServer(router.nodeListener())` and a raw socket:
 *
 *   x-correlation-id: <8000 characters>  → 200, echoed and recorded in full
 *   x-correlation-id: "   "              → 200, "   " became the identity of record
 *   x-correlation-id: "a\tb"             → 200, accepted
 *   x-correlation-id sent twice          → 200, recorded as "a, b"
 *
 * `correlation_id` is a `text` column on audit, outbox, ledger, inbound-event,
 * notification and subscription rows, so the first of those let any caller write
 * kilobytes of chosen text into CORE's audit trail with every ordinary request;
 * the second made the field two unrelated requests are traced by meaningless; the
 * last recorded an id belonging to neither half of a repeated header. `bearer()`
 * had the same flaw pointed the other way: a repeated `authorization` was
 * narrowed to `[0]`, so CORE chose which of two credentials to authenticate.
 *
 * This file is the gate. What it asserts, and what it deliberately does not:
 *
 *  1. **The declaration is well formed** — lower-case names, a bound, a reason.
 *  2. **A malformed declared header is refused, 400, before any work** — length,
 *     shape, and repetition, each by its own case.
 *  3. **A refusal never echoes the value that caused it.**
 *  4. **A valid correlation id is still honoured**, and an absent one is still
 *     generated, so the refusals are the only behaviour change.
 *  5. **Nothing in `src` reads a header any other way**: no `headers[...]`
 *     indexing outside `headers.ts`, and every header name read anywhere is
 *     declared.
 *  6. **Reading an undeclared header throws**, so the rule cannot be bypassed by
 *     a reader that simply asks for a name nobody declared.
 *  7. **An undeclared header is *not* refused.** HTTP requires unknown headers to
 *     be ignored and every proxy adds its own; a router refusing them would
 *     refuse ordinary traffic. This is the one place where this family's rule is
 *     deliberately weaker than for the query string and the body, and the gate
 *     asserts the weaker rule on purpose rather than leaving it unstated.
 *  8. **The contract documents what a caller must send**: `x-correlation-id` as a
 *     header parameter and the bearer credential as a security requirement.
 *
 * No database: nothing here depends on a store, so it runs in both CI jobs.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCoreApp } from "../src/app.js";
import { memoryPersistence } from "../src/platform/persistence/backends.js";
import { FixedClock } from "../src/platform/clock.js";
import { DECLARED_HEADERS, parseHeaders } from "../src/platform/http/headers.js";
import { subjectFor } from "../src/platform/http/rate-limit.js";
import { readCode, sourceFiles } from "./support/source.js";

const clock = new FixedClock(new Date("2026-06-01T00:00:00.000Z"));
const core = createCoreApp({ clock, persistence: memoryPersistence(clock), rateLimit: false });

/** A shape every generated correlation id has to satisfy. */
const GENERATED = /^[0-9a-f-]{36}$/;

const health = (headers: Record<string, string | string[] | undefined>) =>
  core.router.handle({ method: "GET", url: "/health", headers });

describe("declared request headers", () => {
  it("declares each header once, in lower case, with a bound and a reason", () => {
    expect(DECLARED_HEADERS.length).toBeGreaterThan(0);
    const names = DECLARED_HEADERS.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
    for (const spec of DECLARED_HEADERS) {
      // Node lower-cases incoming header names, so a mixed-case declaration
      // would be a header that is declared and can never be found.
      expect(spec.name).toBe(spec.name.toLowerCase());
      expect(spec.maxLength).toBeGreaterThan(0);
      // Node's own limit is roughly 16 KB for all headers together; a declared
      // bound above that would be a bound in name only.
      expect(spec.maxLength).toBeLessThanOrEqual(8192);
      expect(spec.why.trim().length).toBeGreaterThan(20);
    }
    // The correlation id is the one CORE stores, echoes and logs, so its bound is
    // the one that matters most and is asserted by value rather than by shape.
    const correlation = DECLARED_HEADERS.find((spec) => spec.name === "x-correlation-id");
    expect(correlation).toBeDefined();
    expect(correlation!.use).toBe("recorded");
    expect(correlation!.maxLength).toBeLessThanOrEqual(256);
  });

  it("refuses a correlation id longer than the declared bound", async () => {
    const bound = DECLARED_HEADERS.find((spec) => spec.name === "x-correlation-id")!.maxLength;
    const result = await health({ "x-correlation-id": "x".repeat(bound + 1) });
    expect(result.status).toBe(400);
    expect((result.body as { code: string }).code).toBe("invalid_request");
    expect((result.body as { message: string }).message).toContain("x-correlation-id");
    expect((result.body as { message: string }).message).toContain(String(bound));
    // Exactly at the bound is accepted: the refusal is a limit, not a margin.
    const allowed = await health({ "x-correlation-id": "x".repeat(bound) });
    expect(allowed.status).toBe(200);
  });

  it("refuses a correlation id that is not an identifier", async () => {
    for (const value of ["   ", "a\tb", "a b", "a, b", "abc\r\nSet-Cookie: x=1", "«"]) {
      const result = await health({ "x-correlation-id": value });
      expect(result.status).toBe(400);
      expect((result.body as { message: string }).message).toContain("x-correlation-id");
    }
  });

  it("refuses a declared header sent more than once", async () => {
    for (const name of ["x-correlation-id", "authorization"]) {
      const result = await health({ [name]: ["one", "two"] });
      expect(result.status).toBe(400);
      expect((result.body as { message: string }).message).toContain("more than once");
    }
  });

  it("refuses an authorization header that cannot be one credential", async () => {
    for (const value of ["Bearer a, Bearer b", "Bearer a b", "no-scheme", "B".repeat(5000)]) {
      const result = await health({ authorization: value });
      expect(result.status).toBe(400);
      expect((result.body as { message: string }).message).toContain("authorization");
    }
  });

  it("never echoes the header value that caused the refusal", async () => {
    const secret = "correlation-value-that-must-not-come-back".repeat(10);
    const result = await health({ "x-correlation-id": secret });
    expect(result.status).toBe(400);
    const echoed = (result.headers ?? {})["x-correlation-id"] ?? "";
    expect(echoed).not.toContain("correlation-value");
    expect(echoed).toMatch(GENERATED);
    expect(JSON.stringify(result.body)).not.toContain("correlation-value");
    // The refusal is recorded, and the record carries the generated id too.
    const logged = core.router.logs[core.router.logs.length - 1]!;
    expect(logged.status).toBe(400);
    expect(logged.correlation_id).toMatch(GENERATED);
    expect(logged.error_code).toBe("invalid_request");
  });

  it("refuses before the route is matched, so no handler runs", async () => {
    // A path that does not exist would be 404, and a rejected header must win:
    // the header is checked before the route is looked up, so a malformed header
    // on an unknown path is still 400 and has cost one regular expression.
    const result = await core.router.handle({
      method: "POST",
      url: "/v1/no-such-route",
      body: { anything: true },
      headers: { "x-correlation-id": "  " },
    });
    expect(result.status).toBe(400);
  });

  it("honours a valid correlation id and generates an absent one", async () => {
    const given = await health({ "x-correlation-id": "corr-abc.1:2_3" });
    expect(given.status).toBe(200);
    expect((given.headers ?? {})["x-correlation-id"]).toBe("corr-abc.1:2_3");

    const absent = await health({});
    expect(absent.status).toBe(200);
    expect((absent.headers ?? {})["x-correlation-id"]).toMatch(GENERATED);

    // An empty header is an absent header rather than a refusal: sending
    // `x-correlation-id:` with nothing after it asks for nothing.
    const empty = await health({ "x-correlation-id": "" });
    expect(empty.status).toBe(200);
    expect((empty.headers ?? {})["x-correlation-id"]).toMatch(GENERATED);
  });

  it("ignores an undeclared header, and says so on purpose", async () => {
    const result = await health({
      "user-agent": "curl/8.5.0",
      "x-amzn-trace-id": "Root=1-abc",
      cookie: "session=whatever",
      "content-type": "application/json",
    });
    expect(result.status).toBe(200);
    // And a declared reader still cannot see them.
    const parsed = parseHeaders({ "user-agent": "curl/8.5.0" });
    expect(parsed.present()).toEqual([]);
  });

  it("throws when anything asks for a header nobody declared", () => {
    const parsed = parseHeaders({ "x-correlation-id": "abc" });
    expect(() => parsed.value("x-not-declared")).toThrow(/not declared/);
    // A forwarded read of a non-chain header is a programming error too: the
    // first entry of a credential is not a meaningful value.
    expect(() => parsed.firstForwarded("authorization")).toThrow(/not a forwarded chain/);
  });

  it("attributes a rate-limit subject only from checked headers", () => {
    const chain = parseHeaders({ "x-forwarded-for": "203.0.113.9, 70.41.3.18" });
    // A chain is the one declared header where taking one entry is correct.
    expect(subjectFor(chain)).toEqual(subjectFor(parseHeaders({ "x-real-ip": "203.0.113.9" })));
    expect(subjectFor(parseHeaders({})).kind).toBe("network");
    // A chain that is not addresses is refused rather than hashed as text.
    expect(() => parseHeaders({ "x-forwarded-for": "not an address" })).toThrow();
  });

  it("has no other reader of request headers in src", () => {
    // Two scans, because the first one alone was not enough. Written first as
    // `headers\s*["name"]`, it passed a deliberate falsification that put the old
    // reader back behind a cast — `(ctx.headers as unknown as Record<string,
    // string>)["authorization"]` — where the word `headers` is no longer adjacent
    // to the bracket. That is recorded as F7b in
    // `docs/http-header-declaration.md`, and the second scan is what replaced it:
    // **a declared header name may appear in `src` only as the argument of a
    // declared read**, however the expression in front of it is written.
    const declared = DECLARED_HEADERS.map((spec) => spec.name);
    const offenders: string[] = [];
    for (const path of sourceFiles("src")) {
      if (path.endsWith("platform/http/headers.ts")) continue;
      const source = readCode(path);
      for (const match of source.matchAll(/headers\s*\[\s*["'`]([^"'`]+)["'`]\s*\]/g)) {
        // CORE *writes* `retry-after` and `x-correlation-id` on responses, which
        // is its own output rather than a read of the request.
        if (match[1] === "retry-after" || match[1] === "x-correlation-id") continue;
        offenders.push(`${path}: headers["${match[1]}"]`);
      }
      for (const name of declared) {
        const quoted = new RegExp(`["'\`]${name.replace(/[-.]/g, "\\$&")}["'\`]`, "g");
        for (const match of source.matchAll(quoted)) {
          const at = match.index!;
          const before = source.slice(Math.max(0, at - 24), at);
          const after = source.slice(at + match[0].length, at + match[0].length + 1);
          if (/\.(value|firstForwarded)\(\s*$/.test(before)) continue;
          // An object key: how the router sets the response header of the same
          // name, which is CORE's own record and not the caller's.
          if (after === ":") continue;
          // The *value* of a `name:` field: milestone 28 declares the response
          // headers CORE sets in `platform/http/response-headers.ts`, and one of
          // them is `x-correlation-id`, the same name this module reads on the way
          // in. Exempted narrowly, by the two tokens in front of it, rather than
          // by skipping that file — a file-wide exemption would also hide a real
          // request read placed inside it, which is the thing this scan exists to
          // find.
          if (/\bname:\s*$/.test(before)) continue;
          offenders.push(`${path}: ${name} outside a declared reader`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("reads no header name that is not declared", () => {
    const declared = new Set(DECLARED_HEADERS.map((spec) => spec.name));
    const read: string[] = [];
    for (const path of sourceFiles("src")) {
      const source = readCode(path);
      for (const match of source.matchAll(
        /\.(?:value|firstForwarded)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
      )) {
        read.push(match[1]!);
      }
    }
    // Something must be read, or this assertion would pass on an empty scan.
    expect(read.length).toBeGreaterThan(0);
    expect([...new Set(read)].filter((name) => !declared.has(name))).toEqual([]);
  });

  it("documents in the contract what a caller has to send", () => {
    const contract = readFileSync("contracts/openapi/core-v1.yaml", "utf8");
    // The credential every route but the probes requires.
    expect(contract).toContain("bearerAuth");
    // The header CORE records, echoes and traces by, with its accepted shape and
    // its bound, so a caller learns the rule from the contract and not from a
    // 400. Named here so removing it from the contract fails.
    expect(contract).toContain("CorrelationId");
    expect(contract).toContain("x-correlation-id");
    const bound = DECLARED_HEADERS.find((spec) => spec.name === "x-correlation-id")!.maxLength;
    expect(contract).toContain(`maxLength: ${bound}`);
  });

  it("references the header on every documented operation, not only in components", () => {
    // A component parameter nothing references is a declaration that documents
    // nothing — the same lie this family closes from the other end. So every
    // operation under `paths` carries the reference, and the count is compared
    // against the operations found rather than asserted as a number written here.
    const lines = readFileSync("contracts/openapi/core-v1.yaml", "utf8").split("\n");
    let inPaths = false;
    let operations = 0;
    let references = 0;
    for (const line of lines) {
      if (/^paths:\s*$/.test(line)) {
        inPaths = true;
        continue;
      }
      if (/^[a-z]/.test(line)) inPaths = false;
      if (!inPaths) continue;
      if (/^ {4}(get|post|put|patch|delete):\s*$/.test(line)) operations += 1;
      if (line.includes('$ref: "#/components/parameters/CorrelationId"')) references += 1;
    }
    // The premise: a parser that matched nothing would otherwise agree with
    // everything.
    expect(operations).toBeGreaterThan(40);
    expect(references).toBe(operations);
  });
});
