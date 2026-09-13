/**
 * Every route documents the response it returns, and the documented shape is
 * enforced against the response CORE actually produces — milestone 27.
 *
 * The three request surfaces are declared and gated (query 24, body 25, headers
 * 26). This is the answer surface, and it was the weakest thing in the repo.
 * Measured on `main` at `f71aba2`, by parsing the published contract and driving
 * all 52 operations over the router:
 *
 *  - **34 of 52 operations documented no response schema at all.** A status code
 *    and a sentence of prose, nothing a client could validate against.
 *  - **Nothing had ever parsed the contract as YAML.** `check-contracts.mjs`
 *    scans it with regular expressions, so a structurally broken document passed:
 *    two response descriptions contained unquoted commas inside flow maps, which
 *    a real parser reads as `{description: "Invalid envelope", "or no consumer
 *    for this event type": null}` — a truncated sentence and a junk key.
 *  - **Nothing had ever compared a response body to the contract.** Three
 *    divergences had shipped and no test could see any of them:
 *      1. `POST /v1/organizations` and `GET /v1/organizations/{id}` answered
 *         `{}`. Both handlers passed an unawaited promise as the body and
 *         `JSON.stringify` renders a promise as `{}`, so the caller that had just
 *         created a tenant could not learn its id. Every test passed because
 *         every test read the status.
 *      2. `GET /v1/sessions/current` returned six permissions the published
 *         `Permission` enum did not list, so a client validating CORE's own
 *         answer would have rejected it.
 *      3. `GET /v1/event-deliveries/undelivered` returned `claim_token` — the
 *         fencing credential a worker presents to acknowledge a delivery — to
 *         anybody holding `organization.read`.
 *
 * What this file asserts:
 *
 *  1. **The contract parses**, and no response object carries a key that is not
 *     `description`, `content`, `headers` or `$ref` — the junk-key check, which
 *     is the only reason the malformed lines above were findable.
 *  2. **Every operation documents the status it actually answers with**, and
 *     documents a schema in the content type it actually sends. A bodyless 204
 *     documents no content, and says so here rather than by omission.
 *  3. **Every operation's real body satisfies its documented schema, strictly**:
 *     a property CORE returns that the contract does not document is a failure,
 *     not an addition, and `null` requires `nullable: true`.
 *  4. **Coverage**: the set of operations driven equals the set the contract
 *     publishes. A route added later cannot go unmeasured, and a route deleted
 *     cannot keep a stale schema.
 *  5. **The refusal shape is the documented one**, checked against a real 400.
 *  6. **No response body anywhere contains a claim token**, so the redaction
 *     cannot be undone by a route added later.
 *  7. **A route that hands back a promise as its body is refused by the router**,
 *     which is the defect in 3.1 made structurally impossible rather than fixed
 *     one file at a time.
 *
 * What it does not claim: that the schemas describe every value a property can
 * take. They describe the values CORE produced in this scenario, plus the enums
 * its own domain types declare. A state no scenario reaches is documented from
 * the source, not measured, and `financial_disposition: inconsistent` is one such
 * value.
 *
 * No database: the scenario runs on the memory backend, so this gate runs in both
 * CI jobs.
 */
import { describe, expect, it } from "vitest";
import { createCoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { memoryPersistence } from "../src/platform/persistence/backends.js";
import { loadContract, violations, type Operation } from "./support/openapi.js";
import { runScenario, contractPath, type Scenario } from "./support/http-scenario.js";

const contract = loadContract();
const scenario: Scenario = await runScenario();

/** The keys OpenAPI allows on a response object. Anything else is a parse artefact. */
const RESPONSE_KEYS = new Set(["description", "content", "headers", "$ref"]);

const answerFor = (operation: Operation) => {
  const answer = scenario.answers.get(operation.label);
  if (answer === undefined) throw new Error(`nothing drove ${operation.label}`);
  return answer;
};

describe("declared HTTP responses", () => {
  it("publishes a contract a parser can read, with no junk keys in any response", () => {
    expect(contract.operations.length).toBeGreaterThan(0);
    const junk: string[] = [];
    for (const operation of contract.operations) {
      for (const [status, response] of operation.responses) {
        for (const key of response.keys) {
          if (!RESPONSE_KEYS.has(key)) {
            junk.push(`${operation.label} ${status}: ${JSON.stringify(key)}`);
          }
        }
      }
    }
    // A junk key means a description ran past an unquoted comma inside a flow
    // map, so the published sentence is truncated too.
    expect(junk).toEqual([]);
  });

  it("documents the status every operation actually answers with", () => {
    const missing: string[] = [];
    for (const operation of contract.operations) {
      const answer = answerFor(operation);
      if (!operation.responses.has(String(answer.status))) {
        missing.push(`${operation.label} answered ${answer.status}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("documents a schema for every operation that returns a body", () => {
    const undocumented: string[] = [];
    for (const operation of contract.operations) {
      const answer = answerFor(operation);
      const documented = operation.responses.get(String(answer.status));
      if (documented === undefined) continue; // reported by the case above
      if (answer.body === null || answer.body === undefined) {
        // A bodyless answer documents no content, and must not pretend to.
        if (documented.schema !== undefined) {
          undocumented.push(`${operation.label} documents a schema but sends no body`);
        }
        continue;
      }
      if (documented.schema === undefined) {
        undocumented.push(`${operation.label} ${answer.status} documents no schema`);
      }
    }
    expect(undocumented).toEqual([]);
  });

  it("documents the content type it sends", () => {
    const wrong: string[] = [];
    for (const operation of contract.operations) {
      const answer = answerFor(operation);
      const documented = operation.responses.get(String(answer.status));
      if (documented === undefined || answer.body === null || answer.body === undefined) continue;
      const sent = typeof answer.body === "string" ? "text/plain" : "application/json";
      if (documented.contentType !== sent) {
        wrong.push(`${operation.label} sends ${sent}, documents ${documented.contentType}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("returns bodies that satisfy the documented schema, with nothing undocumented", () => {
    const problems: string[] = [];
    for (const operation of contract.operations) {
      const answer = answerFor(operation);
      const documented = operation.responses.get(String(answer.status));
      const schema = documented?.schema;
      if (schema === undefined) continue; // the cases above own that failure
      if (typeof answer.body === "string") {
        // The one text response: the schema says string, and the body is one.
        problems.push(...violations(answer.body, schema, `${operation.label} body`));
        continue;
      }
      problems.push(...violations(answer.body, schema, `${operation.label} body`));
    }
    expect(problems).toEqual([]);
  });

  it("drives exactly the operations the contract publishes", () => {
    const published = [...contract.operations.map((operation) => operation.label)].sort();
    const driven = [...scenario.answers.keys()].sort();
    expect(driven).toEqual(published);
  });

  it("answers every operation with a success status, so no schema is checked against a refusal", () => {
    const refused: string[] = [];
    for (const operation of contract.operations) {
      const answer = answerFor(operation);
      if (answer.status >= 400) refused.push(`${operation.label} → ${answer.status}`);
    }
    expect(refused).toEqual([]);
  });

  it("refuses with the documented Error shape", async () => {
    const response = await scenario.core.router.handle({
      method: "GET",
      url: "/v1/fulfillments/reconciliation/inconsistent",
      headers: { authorization: `Bearer ${scenario.token}` },
    });
    expect(response.status).toBe(400);
    const error = contract.resolve({ $ref: "#/components/schemas/Error" });
    expect(violations(response.body, error, "refusal")).toEqual([]);
  });

  it("never returns a claim token in any response body", () => {
    const leaked: string[] = [];
    for (const [label, answer] of scenario.answers) {
      if (JSON.stringify(answer.body ?? null).includes("claim_token")) leaked.push(label);
    }
    expect(leaked).toEqual([]);
  });

  it("refuses a route that returns a promise as its body", async () => {
    // The defect of `POST /v1/organizations`, reproduced deliberately: a handler
    // that forgets to await answers `{}` with a success status. The router turns
    // it into an internal error instead, so the next route to make the mistake
    // fails loudly rather than shipping an empty body past a green suite.
    // Its own app: adding a route to the scenario's router would change the set
    // of registrations the coverage case compares against the contract.
    const clock = new FixedClock(new Date("2026-06-01T00:00:00.000Z"));
    const core = createCoreApp({ clock, persistence: memoryPersistence(clock), rateLimit: false });
    core.router.get("/v1/__unawaited", [], async () => ({
      status: 200,
      body: Promise.resolve({ organization_id: "never-seen" }) as unknown,
    }));
    const response = await core.router.handle({ method: "GET", url: "/v1/__unawaited", headers: {} });
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain("never-seen");
  });

  it("maps every contract template to the route the router registered", () => {
    const registered = new Set(
      scenario.core.router
        .registrations()
        .map((route) => `${route.method} ${contractPath(route.template)}`),
    );
    const orphans = contract.operations
      .map((operation) => operation.label)
      .filter((label) => !registered.has(label));
    expect(orphans).toEqual([]);
    expect(registered.size).toBe(contract.operations.length);
  });
});
