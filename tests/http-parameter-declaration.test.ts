/**
 * Every route refuses the parameters it does not read — milestone 24.
 *
 * Milestone 23 closed the *values* a route accepts for the parameters it reads:
 * no repeats, no empty strings, no `0x10` as a limit. It measured, and
 * deliberately left open, the other half. A parameter no handler read was
 * ignored in silence, so:
 *
 *  - `GET /v1/notification-recipients?limit=abc` answered 200 with every row.
 *    That route has no `limit`. A caller who believed they had bounded the
 *    response received the whole table and a success status.
 *  - `?organisation_id=…` (British spelling, or any typo) was ignored, and the
 *    unscoped answer — every tenant's rows — came back as though the caller had
 *    asked for it.
 *
 * Both are the same defect as the ones milestone 23 fixed: CORE answered a
 * question the caller did not ask and reported success. The fix is structural
 * rather than per route. `router.get` takes the accepted parameters as its second
 * argument, the router parses them before the handler runs, and `RequestContext`
 * carries **no `URLSearchParams` at all** — only the parsed `Selection`. So a
 * handler cannot read an undeclared parameter, and an undeclared parameter cannot
 * reach a handler.
 *
 * This file is the gate on that structure, and it is driven off the router's own
 * registrations rather than a list maintained here, because a list maintained
 * here is a list that goes stale the first time somebody adds a route.
 *
 *  1. **Every registered route refuses an unknown parameter**, 400 with the
 *     offending name in the message — all methods, not only GET, because 29 of
 *     the 52 registrations are writes that read no query string and had no reason
 *     to accept one either.
 *  2. **Every declared parameter is live**: sending it twice is refused by the
 *     router, which is only true if the declaration is what the parse reads.
 *  3. **No route file reads a parameter any other way**: a source scan for the
 *     raw readers and for `URLSearchParams` outside the one module that owns
 *     them. Milestone 25 moved the scanning helpers to `tests/support/source.ts`
 *     and made them comment-blind and call-scoped, because `body.ts` explaining
 *     this rule in prose is not a second reader and a declared body field is not
 *     a query parameter. What the gate asserts is unchanged; where it looks is
 *     more precise.
 *  4. **The declarations are well formed**: unique snake_case names, non-empty
 *     vocabularies, `min <= default <= max`.
 *  5. **A handler cannot read an undeclared name** — probed directly on
 *     `Selection`, because that is the property the whole design rests on.
 *
 * No database is needed: none of this depends on a store, so it runs in both CI
 * jobs rather than only the one with Postgres.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createCoreApp } from "../src/app.js";
import { memoryPersistence } from "../src/platform/persistence/backends.js";
import { FixedClock } from "../src/platform/clock.js";
import { Selection, type ParamSpec } from "../src/platform/http/query.js";
import { calls, readCode, sourceFiles } from "./support/source.js";
import { anonymousCredential } from "./support/credential.js";

const clock = new FixedClock(new Date("2026-06-01T00:00:00.000Z"));
const core = createCoreApp({ clock, persistence: memoryPersistence(clock), rateLimit: false });
const registrations = core.router.registrations();

/**
 * A parameter name nothing can plausibly declare. Percent-encoded nowhere: if a
 * route ever accepts this, the gate below is measuring the wrong thing and says
 * so by failing.
 */
const UNKNOWN = "__unexpected_parameter";

/** A concrete path for a template, so the router matches before it parses. */
function concrete(template: string): string {
  return template
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "00000000-0000-4000-8000-000000000001" : segment))
    .join("/");
}

/** One value the spec must accept, for probing a *different* parameter. */
function validValue(spec: ParamSpec): string {
  switch (spec.kind) {
    case "enum":
      return spec.values[0]!;
    case "limit":
      return String(spec.min);
    case "decimal":
      return "1";
    default:
      return "00000000-0000-4000-8000-000000000001";
  }
}

/**
 * Every `in: query` parameter the published contract declares, by route template.
 *
 * Parsed with a small line reader rather than a YAML library because the
 * repository has no YAML dependency and `scripts/check-contracts.mjs` reads the
 * same file the same way. The reader is deliberately strict about structure — it
 * tracks the current path, the current method and one list item at a time — and
 * the test asserts it found a plausible number of paths and parameters, so a
 * reader that quietly stopped matching fails instead of agreeing with everything.
 */
function contractQueryParameters(): Map<string, Set<string>> {
  const lines = readFileSync("contracts/openapi/core-v1.yaml", "utf8").split("\n");
  const byTemplate = new Map<string, Set<string>>();
  let path = "";
  let method = "";
  let inParameters = false;
  let item: { name?: string; location?: string } | null = null;
  const flush = () => {
    if (item && item.location === "query" && item.name && method === "get") {
      byTemplate.get(path)!.add(item.name);
    }
    item = null;
  };
  for (const line of lines) {
    const pathLine = /^ {2}(\/\S*):\s*$/.exec(line);
    if (pathLine) {
      flush();
      inParameters = false;
      path = pathLine[1]!.replace(/\{([^}]+)\}/g, ":$1");
      method = "";
      continue;
    }
    const methodLine = /^ {4}([a-z]+):\s*$/.exec(line);
    if (methodLine) {
      flush();
      inParameters = false;
      method = methodLine[1]!;
      if (method === "get" && !byTemplate.has(path)) byTemplate.set(path, new Set());
      continue;
    }
    if (/^ {6}parameters:\s*$/.test(line)) {
      flush();
      inParameters = true;
      continue;
    }
    if (!inParameters) continue;
    const isItem = /^\s*- /.test(line);
    if (isItem) {
      flush();
      item = {};
    } else if (!/^\s{8,}/.test(line)) {
      flush();
      inParameters = false;
      continue;
    }
    if (!item) continue;
    const name = /name:\s*(\S+)/.exec(line);
    const location = /\bin:\s*(\S+)/.exec(line);
    if (name) item.name = name[1]!;
    if (location) item.location = location[1]!;
  }
  flush();
  return byTemplate;
}

/**
 * A credential that is valid and entitled to nothing.
 *
 * Every probe below is sent with it. Until milestone 30 these probes were sent
 * anonymously and the parse answered first; the router now authenticates a
 * route that declared `AUTHENTICATED` before it parses the query string, so an
 * anonymous probe would measure the 401 and never reach the refusal this file
 * exists to assert. Authenticated-but-unauthorized keeps what this file had:
 * the 400 is still shown to precede the 403 this caller would otherwise get.
 */
let token = "";
beforeAll(async () => {
  token = await anonymousCredential(core);
});

async function call(
  method: string,
  path: string,
  credential: string | null = token,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await core.router.handle({
    method,
    url: path,
    headers: credential === null ? {} : { authorization: `Bearer ${credential}` },
    body: method === "GET" ? undefined : {},
  });
  return { status: response.status, body: (response.body ?? {}) as Record<string, unknown> };
}

/** Every `.ts` file under a directory, recursively. */
describe("every route refuses the parameters it does not read", () => {
  it("registers routes at all, and reports what each accepts", () => {
    // The premise. A registrations list that came back empty would make every
    // loop below pass without asserting anything.
    expect(registrations.length).toBeGreaterThanOrEqual(52);
    const gets = registrations.filter((route) => route.method === "GET");
    expect(gets.length).toBeGreaterThanOrEqual(23);
    // At least one route with parameters and at least one without, so both
    // branches of the parse are exercised by the loops.
    expect(gets.some((route) => route.accepts.length > 0)).toBe(true);
    expect(gets.some((route) => route.accepts.length === 0)).toBe(true);
  });

  it("refuses an unknown query parameter on every registered route", async () => {
    for (const route of registrations) {
      const path = `${concrete(route.template)}?${UNKNOWN}=1`;
      const { status, body } = await call(route.method, path);
      expect(status, `${route.method} ${route.template}`).toBe(400);
      expect(body["code"], `${route.method} ${route.template}`).toBe("invalid_request");
      // The caller is told what CORE could not understand. A 400 that does not
      // name the parameter leaves them guessing between the typo and the value.
      expect(String(body["message"]), `${route.method} ${route.template}`).toContain(UNKNOWN);
    }
  });

  it("refuses an unknown parameter to a caller who has a credential, 401 to one who has none", async () => {
    // The reverse of what milestone 24 asserted here, deliberately. Its
    // reasoning was that "the refusal is about the route's own contract — which
    // parameters exist is published — so answering it before the credential is
    // checked discloses nothing a reader of the contract lacks", and that "a
    // request CORE cannot understand must not reach a store, and authentication
    // is a store read".
    //
    // The first half is kept: an authenticated caller still hears about its
    // typo, below. The second half is what milestone 30 measured the cost of —
    // ordering the parse first meant 28 registrations described their input to
    // a caller holding no credential, and two fulfillment reads distinguished a
    // real identifier from an invented one for that same caller. The store
    // argument survives the reversal: a request with no bearer header is
    // refused before any session is read, so the anonymous answer still costs
    // zero reads, and a junk credential costs one indexed read that the rate
    // limiter — checked earlier still — already bounds.
    const anonymous = await call("GET", `/v1/notifications?${UNKNOWN}=1`, null);
    expect(anonymous.status).toBe(401);
    expect(JSON.stringify(anonymous.body)).not.toContain(UNKNOWN);

    const { status, body } = await call("GET", `/v1/notifications?${UNKNOWN}=1`);
    expect(status).toBe(400);
    expect(body["code"]).toBe("invalid_request");
    // No row, no count, no tenant: a refusal carries the parameter names and the
    // correlation id and nothing drawn from data.
    expect(Object.keys(body).sort()).toEqual([
      "code",
      "correlation_id",
      "details",
      "message",
      "retryable",
    ]);
  });

  it("refuses a query string entirely on every route that declared no parameters", async () => {
    const none = registrations.filter((route) => route.accepts.length === 0);
    // Includes every write route: 29 of them read no query string, and before
    // this milestone all 29 accepted any query string a caller sent.
    expect(none.length).toBeGreaterThanOrEqual(29);
    for (const route of none) {
      const { status, body } = await call(route.method, `${concrete(route.template)}?limit=10`);
      expect(status, `${route.method} ${route.template}`).toBe(400);
      expect(String(body["message"]), `${route.method} ${route.template}`).toContain(
        "this route accepts none",
      );
    }
  });

  it("parses every declared parameter, so no declaration is decoration", async () => {
    let probed = 0;
    for (const route of registrations) {
      for (const spec of route.accepts as readonly ParamSpec[]) {
        // Sent twice, with every *other* declared parameter given one valid
        // value: a route with two required parameters would otherwise refuse the
        // missing one first and the probe would prove nothing about this one.
        const others = (route.accepts as readonly ParamSpec[])
          .filter((other) => other.name !== spec.name)
          .map((other) => `${other.name}=${encodeURIComponent(validValue(other))}`);
        const query = [`${spec.name}=1`, `${spec.name}=2`, ...others].join("&");
        const path = `${concrete(route.template)}?${query}`;
        const { status, body } = await call(route.method, path);
        expect(status, `${route.method} ${route.template} ${spec.name}`).toBe(400);
        expect(String(body["message"]), `${route.method} ${route.template} ${spec.name}`).toContain(
          spec.name,
        );
        probed += 1;
      }
    }
    expect(probed).toBeGreaterThanOrEqual(9);
  });

  it("declares nothing a handler does not read, and reads nothing undeclared", () => {
    // The other direction, and the one the repeat probe above cannot see: the
    // router parses a declared parameter whether or not any handler asks for it,
    // so a declaration can be pure decoration — a name the route advertises,
    // validates, and then ignores, which is the same lie about the answer from
    // the other end. Measured in the source, per file: every name declared by a
    // route registered in a file must appear as a `selection` read in that file,
    // and every `selection` read must be declared by a route in it.
    //
    // File granularity rather than per handler is deliberate and is the stated
    // limit of this check: `reputation/http.ts` reads `organization_id` in a
    // `subjectOf(ctx)` helper shared by two routes, and a per-handler scan would
    // have to follow that call to be right. Two routes in one file that declare
    // different parameters and read each other's would pass — which is why the
    // registration is still where the declaration lives, so the router refuses
    // by route and only this cross-check is file-wide.
    const declaredByFile = new Map<string, Set<string>>();
    const readByFile = new Map<string, Set<string>>();
    for (const file of sourceFiles("src")) {
      const source = readCode(file);
      if (!source.includes("router.get(")) continue;
      const declared = new Set<string>();
      // Only the specs written inside a `router.get(...)` call: milestone 25
      // declares body fields in the same `{ name, kind }` shape, and a file-wide
      // regex counted those as query parameters no handler reads. Attributing a
      // literal to its call is what the check meant from the start.
      for (const call of calls(source, "router.get(")) {
        for (const match of call.matchAll(/\{\s*name:\s*"([a-z0-9_]+)"\s*,\s*kind:/g)) {
          declared.add(match[1]!);
        }
      }
      const read = new Set<string>();
      for (const match of source.matchAll(
        /selection\.(?:text|requiredText|number)\(\s*"([a-z0-9_]+)"\s*\)/g,
      )) {
        read.add(match[1]!);
      }
      const relative = file.replace(/\\/g, "/");
      declaredByFile.set(relative, declared);
      readByFile.set(relative, read);
    }
    // The premise: the scan found the files, and found declarations in them.
    expect(declaredByFile.size).toBeGreaterThanOrEqual(10);
    expect([...declaredByFile.values()].reduce((total, set) => total + set.size, 0)).toBeGreaterThanOrEqual(9);

    const unread: string[] = [];
    const undeclared: string[] = [];
    for (const [file, declared] of declaredByFile) {
      const read = readByFile.get(file) ?? new Set<string>();
      for (const name of declared) if (!read.has(name)) unread.push(`${file}: ${name}`);
      for (const name of read) if (!declared.has(name)) undeclared.push(`${file}: ${name}`);
    }
    expect(unread).toEqual([]);
    expect(undeclared).toEqual([]);
  });

  it("declares well-formed specs", () => {
    for (const route of registrations) {
      const names = route.accepts.map((spec) => spec.name);
      expect(new Set(names).size, `${route.template} duplicate names`).toBe(names.length);
      for (const spec of route.accepts as readonly ParamSpec[]) {
        expect(spec.name, `${route.template} ${spec.name}`).toMatch(/^[a-z][a-z0-9_]*$/);
        if (spec.kind === "enum") {
          // An empty vocabulary would refuse every value the parameter can take,
          // which is a route nobody can call rather than a strict one.
          expect(spec.values.length, `${route.template} ${spec.name}`).toBeGreaterThan(0);
          expect(new Set(spec.values).size).toBe(spec.values.length);
        }
        if (spec.kind === "limit") {
          expect(spec.min, `${route.template} ${spec.name}`).toBeGreaterThan(0);
          expect(spec.max).toBeGreaterThanOrEqual(spec.min);
          expect(spec.default).toBeGreaterThanOrEqual(spec.min);
          expect(spec.default).toBeLessThanOrEqual(spec.max);
        }
      }
    }
  });

  it("keeps the declaration the only way a route reads the query string", () => {
    // The structural claim, checked in the source rather than trusted. `query.ts`
    // owns the readers; `router.ts` owns the one `URLSearchParams` in the request
    // path. Anywhere else, either would be a second way in — and a second way in
    // is a second set of rules to keep in step, which is how the loose parsing
    // milestone 23 found survived nine cycles.
    const owners = new Set(["src/platform/http/query.ts", "src/platform/http/router.ts"]);
    const readers = [
      "optionalParam(",
      "requiredParam(",
      "enumParam(",
      "limitParam(",
      "decimalParam(",
      "URLSearchParams",
      "searchParams",
    ];
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      const relative = file.replace(/\\/g, "/");
      if (owners.has(relative)) continue;
      const source = readCode(file);
      for (const reader of readers) {
        if (source.includes(reader)) offenders.push(`${relative}: ${reader}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("agrees with the published contract about what every read route accepts", () => {
    // The declaration is now the only thing that decides which parameters a route
    // accepts — but `contracts/openapi/core-v1.yaml` is what MOVE and MARKET
    // read, so a route and its contract disagreeing is a second source of truth
    // with an external audience. Comparing them is what turned that from an
    // opinion into a check, and it immediately found one: `country_code` on
    // `GET /v1/geography/service-areas/resolve` has been implemented since the
    // geography module shipped and appeared in no contract, so no consumer could
    // know a country filter existed. Documented in the same commit as this gate.
    const contract = contractQueryParameters();
    // The premise: the parse found paths and parameters. A regex that silently
    // matched nothing would make the comparison below vacuous.
    expect(contract.size).toBeGreaterThanOrEqual(20);
    expect([...contract.values()].reduce((total, names) => total + names.size, 0)).toBeGreaterThanOrEqual(
      9,
    );

    const differences: string[] = [];
    const undocumented: string[] = [];
    for (const route of registrations) {
      if (route.method !== "GET") continue;
      const documented = contract.get(route.template);
      if (documented === undefined) {
        undocumented.push(route.template);
        continue;
      }
      const declared = [...route.accepts.map((spec) => spec.name)].sort();
      const published = [...documented].sort();
      if (JSON.stringify(declared) !== JSON.stringify(published)) {
        differences.push(`${route.template}: router ${declared.join(",")} / contract ${published.join(",")}`);
      }
    }
    expect(differences).toEqual([]);
    expect(undocumented).toEqual([]);
  });

  it("refuses to let a handler read a name its route did not declare", () => {
    // The property everything above rests on. If reading an undeclared name
    // returned `undefined`, a handler could read `limit` from a route that never
    // declared one and would see "not sent" on every request forever — the
    // silent substitution this milestone exists to end, reintroduced one level
    // down.
    const selection = new Selection(new Map([["organization_id", "tenant"]]));
    expect(selection.text("organization_id")).toBe("tenant");
    expect(() => selection.text("limit")).toThrow(/did not declare/);
    expect(() => selection.number("limit")).toThrow(/did not declare/);
    expect(selection.names()).toEqual(["organization_id"]);
  });
});
