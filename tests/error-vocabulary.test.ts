/**
 * The published error vocabulary is exactly the vocabulary CORE can speak, and
 * the failure every route can have is documented — milestone 37.
 *
 * Milestone 36 closed one direction of the answer surface and stated plainly
 * which statuses its matrix does **not** reach: `409` and `500`. This is the
 * `500` half, and a second defect in the same family found while measuring it.
 *
 * Measured on `main` at `f67908b`, before anything was changed:
 *
 *  1. Every request the response-gate scenario makes successfully was replayed
 *     against a CORE assembled with a persistence backend whose every method
 *     throws. **50 of 52 operations answered `500`**, `code` `internal`. The two
 *     that did not are `GET /health` and `GET /metrics`, which touch no
 *     persistence. **The contract documented `500` on no operation at all** —
 *     across the whole file the documented statuses were `200`, `201`, `202`,
 *     `204`, `400`, `401`, `403`, `404`, `409`, `429` and nothing else. A caller
 *     generating a client had no branch for the one answer it gets when CORE's
 *     dependency is down.
 *  2. The published `Error.code` enum listed nine codes. **`precondition_failed`
 *     and `unavailable` were constructed nowhere** — not in `src/`, not in
 *     `tests/`, not by any helper in `src/platform/errors.ts`. They lived in the
 *     `ErrorCode` union, the `STATUS` table and, for `unavailable`, the
 *     `RETRYABLE` set: three tables and a YAML enum agreeing about two words CORE
 *     could not say, and asking a caller to branch on them.
 *
 * What was decided, and what it cost:
 *
 *  - **`500` is documented on the 49 operations that can produce it, not on all
 *    52.** Truthful over uniform, because the measurement says they differ and
 *    the difference is meaningful: `/health` and `/metrics` answer without
 *    touching a dependency, which is the property that makes them worth having.
 *  - **`precondition_failed` is deleted.** Nothing produced it and nothing
 *    needed it.
 *  - **`unavailable` was given a producer instead, because the measurement found
 *    a defect behind it.** `/ready` let its dependency's failure escape, and the
 *    router's fail-closed default rendered it `500` `internal` — CORE reporting a
 *    defect in CORE when what happened is that CORE cannot serve yet. An
 *    orchestrator reading `500` from a readiness probe has grounds to stop
 *    rolling out; reading `503` it waits. `/ready` now answers `503`
 *    `unavailable`, documented as `NotReady`.
 *  - **`ErrorCode` is no longer hand-maintained.** One `STATUS` table is the
 *    source; the union is `keyof typeof STATUS`, and `ERROR_CODES` is its keys.
 *
 * What this file asserts:
 *
 *  1. The published enum is exactly `ERROR_CODES` — no code published that CORE
 *     does not have, none missing that it does.
 *  2. **Every code in `ERROR_CODES` is produced by a real answer** from CORE's
 *     own router in this file. This is the assertion that makes a dead word
 *     impossible: adding one to the table fails until something produces it.
 *  3. Every produced code carries the status its table says, and that status is
 *     documented on the operation that produced it.
 *  4. Under a dependency that throws, **every operation that answers `500` or
 *     `503` documents it, and the operations that answer neither document
 *     neither** — measured by replay, not asserted from a list.
 *
 * No database: the memory backend, so this runs in both CI jobs.
 */
import { describe, expect, it } from "vitest";
import { createCoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { memoryPersistence } from "../src/platform/persistence/backends.js";
import { ERROR_CODES, statusForCode, type ErrorCode } from "../src/platform/errors.js";
import { loadContract } from "./support/openapi.js";
import { contractPath, runScenario, type Scenario } from "./support/http-scenario.js";

const contract = loadContract();
const scenario: Scenario = await runScenario();

const documented = new Map<string, ReadonlySet<string>>(
  contract.operations.map((operation) => [
    `${operation.method.toUpperCase()} ${operation.path}`,
    new Set(operation.responses.keys()),
  ]),
);

const ABSENT = "00000000-0000-4000-8000-000000000000";
const concrete = (template: string): string =>
  template
    .split("/")
    .map((segment) => (segment.startsWith(":") ? ABSENT : segment))
    .join("/");

/**
 * A CORE whose persistence answers every call by throwing. Not a stub of one
 * method: the point is that any dependency failure, anywhere, is the caller's
 * problem in exactly one way, and a hand-picked method would only prove the one
 * path somebody thought of.
 */
const brokenDependency = (): ReturnType<typeof memoryPersistence> => {
  const clock = new FixedClock(new Date("2026-06-01T00:00:00.000Z"));
  const base = memoryPersistence(clock) as unknown as Record<string, unknown>;
  return new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      // `kind` is a string the readiness body reports; everything else on this
      // object is a repository whose every method fails.
      if (property === "kind") return value;
      if (typeof value === "object" && value !== null) {
        return new Proxy(value as Record<string, unknown>, {
          get(inner, method, innerReceiver) {
            const target2 = Reflect.get(inner, method, innerReceiver);
            if (typeof target2 === "function") {
              return () => {
                throw new Error("dependency is down");
              };
            }
            return target2;
          },
        });
      }
      return value;
    },
  }) as unknown as ReturnType<typeof memoryPersistence>;
};

interface Produced {
  readonly label: string;
  readonly code: string;
  readonly status: number;
  readonly how: string;
}

const produced: Produced[] = [];
const record = (label: string, status: number, body: unknown, how: string): void => {
  const code = (body as { code?: unknown } | undefined)?.code;
  if (typeof code === "string") produced.push({ label, code, status, how });
};

// ── the refusals a uniform matrix reaches: 400, 401, 403, 404 ────────────────
const authorization = `Bearer ${scenario.token}`;
let key = 0;
for (const registration of scenario.core.router.registrations()) {
  const label = `${registration.method.toUpperCase()} ${contractPath(registration.template)}`;
  const url = concrete(registration.template);
  const probes = [
    { how: "no credential", headers: {} as Record<string, string> },
    {
      how: "a body naming a property no route declares",
      headers: { authorization, "idempotency-key": `vocab-${++key}` },
      body: { "not-a-field-any-route-declares": true },
    },
    { how: "no body", headers: { authorization, "idempotency-key": `vocab-${++key}` } },
  ];
  for (const probe of probes) {
    const response = await scenario.core.router.handle({
      method: registration.method,
      url,
      headers: probe.headers,
      ...("body" in probe ? { body: probe.body } : {}),
    });
    if (response.status >= 400) record(label, response.status, response.body, probe.how);
  }
}

// ── 409: a keyed route, the same key, a different body ───────────────────────
{
  // The scenario's own CORE, because the credential is its own: a fresh app
  // would refuse this token before it ever reached the key.
  const app = scenario.core;
  const headers = { authorization, "idempotency-key": "vocab-conflict" };
  const first = await app.router.handle({
    method: "POST",
    url: "/v1/geography/countries",
    headers,
    body: { country_code: "KW", name: "Kuwait", default_currency: "KWD" },
  });
  const second = await app.router.handle({
    method: "POST",
    url: "/v1/geography/countries",
    headers,
    body: { country_code: "BH", name: "Bahrain", default_currency: "BHD" },
  });
  record("POST /v1/geography/countries", second.status, second.body, "a used key with a different body");
  // The first call is only setup, but if it did not succeed the second proves
  // nothing, so it is asserted rather than assumed.
  expect(first.status, "the setup call for the conflict probe must succeed").toBeLessThan(300);
}

// ── 429: a real budget, exceeded ─────────────────────────────────────────────
{
  const clock = new FixedClock(new Date("2026-06-01T00:00:00.000Z"));
  const app = createCoreApp({ clock, persistence: memoryPersistence(clock) });
  for (let attempt = 0; attempt < 400; attempt++) {
    const response = await app.router.handle({
      method: "GET",
      url: "/v1/geography/countries",
      headers: { authorization },
    });
    if (response.status === 429) {
      record("GET /v1/geography/countries", response.status, response.body, "the read budget, exceeded");
      break;
    }
  }
}

// ── 500 and 503: every successful request replayed against a failing backend ─
const underFailure = new Map<string, number>();
{
  const clock = new FixedClock(new Date("2026-06-01T00:00:00.000Z"));
  const app = createCoreApp({ clock, persistence: brokenDependency(), rateLimit: false });
  for (const [label, answer] of scenario.answers) {
    const response = await app.router.handle({
      method: answer.request.method,
      url: answer.request.url,
      headers: answer.request.headers,
      ...(answer.request.body === undefined ? {} : { body: answer.request.body }),
    });
    underFailure.set(label, response.status);
    if (response.status >= 500) record(label, response.status, response.body, "a dependency that throws");
  }
  void clock;
}

describe("the published error vocabulary is the vocabulary CORE can speak", () => {
  it("publishes exactly the codes CORE has, and no others", () => {
    const schema = contract.resolve({ $ref: "#/components/schemas/Error" }) as {
      properties: { code: { enum: string[] } };
    };
    expect([...schema.properties.code.enum].sort()).toEqual([...ERROR_CODES].sort());
  });

  it("produces every code it publishes, in a real answer", () => {
    const seen = new Set(produced.map((entry) => entry.code));
    const never = ERROR_CODES.filter((code) => !seen.has(code));
    expect(never, "a published code no request in this file could produce").toEqual([]);
    // And nothing outside the vocabulary came back.
    const stray = [...seen].filter((code) => !(ERROR_CODES as readonly string[]).includes(code));
    expect(stray).toEqual([]);
  });

  it("answers each code with the status its own table gives it", () => {
    const wrong = produced
      .filter((entry) => entry.status !== statusForCode(entry.code as ErrorCode))
      .map((entry) => `${entry.label} answered ${entry.status} with code ${entry.code}`);
    expect([...new Set(wrong)]).toEqual([]);
  });

  it("documents every status it produced, on the operation that produced it", () => {
    const undocumented = produced
      .filter((entry) => !(documented.get(entry.label)?.has(String(entry.status)) ?? false))
      .map((entry) => `${entry.label} answered ${entry.status} (${entry.how}) and does not document it`);
    expect([...new Set(undocumented)]).toEqual([]);
  });

  it("documents a failure on exactly the operations a failing dependency can break", () => {
    // Measured by replay rather than declared: an operation that stops touching
    // persistence, or starts, changes this set without anybody editing a list.
    const wrong: string[] = [];
    for (const [label, status] of underFailure) {
      const statuses = documented.get(label) ?? new Set<string>();
      const documentsFailure = statuses.has("500") || statuses.has("503");
      if (status >= 500 && !statuses.has(String(status))) {
        wrong.push(`${label} answers ${status} under a failing dependency and does not document it`);
      }
      if (status < 500 && documentsFailure) {
        wrong.push(`${label} documents a failure it does not produce even when every dependency throws`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("keeps the two routes that answer without a dependency answering", () => {
    // The reason `500` is documented on 49 operations and not on 52. If these
    // two ever start touching persistence, the assertion above stops passing on
    // its own; this one says why it mattered.
    expect(underFailure.get("GET /health")).toBe(200);
    expect(underFailure.get("GET /metrics")).toBe(200);
    expect(underFailure.get("GET /ready")).toBe(503);
  });
});
