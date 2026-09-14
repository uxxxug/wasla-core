/**
 * Two identical keyed requests at the same instant produce one thing — B-43.
 *
 * What was measured on `retry-claim` at `8d31133` — that is, on milestone 32's
 * finished retry mechanism, before a line of this milestone was written — by
 * firing five byte-identical `POST /v1/organizations` under one
 * `Idempotency-Key` with `Promise.all` and counting the `organization` rows:
 *
 *  - reference backend: **5 organizations from 5 requests**, 0 replays, 5
 *    distinct ids. Every single time. `record` awaited its own `find`, so all
 *    five twins saw an empty table and all five were told they had created
 *    something.
 *  - PostgreSQL, five rounds: **1, 5, 5, 4, 4** organizations created (4, 0, 0,
 *    1, 1 replays). 19 duplicate tenants across five attempts to create five.
 *
 * The second line is the finding, and it is not the one the reservation
 * expected: whether a keyed retry duplicated was decided by event-loop
 * interleaving, not by the backend or by the schema. The same five requests
 * produced one organization once and five organizations twice, against the same
 * code and the same database. A defect that passes four times in five is worse
 * than one that fails every time, which is why this file asserts a count rather
 * than a probability, and asserts it on both backends.
 *
 * What changed. The key is claimed *before* the handler runs, in one statement
 * that cannot be interleaved — `insert … on conflict … do update … where the
 * existing row is expired or abandoned … returning claim_token` on Postgres,
 * and a synchronous read-then-write with no `await` between on the reference
 * backend, which on one thread is the same guarantee. The winner runs the
 * handler and completes the claim; the losers are answered without running it.
 *
 * What this file asserts, in this order:
 *
 *  1. The measurement above, re-run against the fix: five concurrent twins
 *     create exactly one organization, on both backends. This is the gate.
 *  2. A twin refused while the winner is working gets `409`, `retry-after: 1`
 *     and `details.claimed_at` — the refusal is a statement about state, and it
 *     carries what a caller needs to tell "my own retry raced me" apart from
 *     "somebody else has my key".
 *  3. A key reused for a *different* request is still refused as a reuse, in
 *     flight or completed: the fingerprint is checked before the state.
 *  4. A refused or thrown handler releases the claim, so the corrected request
 *     goes through immediately rather than after the horizon — and a request
 *     refused *before* its handler ran never took a claim to release, because
 *     the body is parsed first.
 *  5. The claim token fences: a `complete` or a `release` from a claim that has
 *     been taken over does nothing.
 *  6. A claim abandoned for longer than `CLAIM_HORIZON_MS` is taken over by the
 *     next request for the same key, with no sweeper.
 *  7. The horizon is not load-bearing for the normal path: the slowest of the
 *     five concurrent handlers finishes inside a tenth of it.
 *
 * `docs/retry-claim.md` records the falsifications — each assertion here was
 * checked by breaking the implementation and watching this file fail.
 */
import { afterAll, describe, expect, it } from "vitest";
import { AUTHENTICATED } from "../src/platform/http/authentication.js";
import { opaqueBody, parseBody } from "../src/platform/http/body.js";
import {
  CLAIM_HORIZON_MS,
  fingerprintRequest,
  keyed,
  type RetryRecordRow,
} from "../src/platform/http/retry.js";
import { ORGANIZATION, retryHarnesses, type Ground } from "./support/retry-harness.js";

const url = process.env["DATABASE_URL"];
const harnesses = retryHarnesses(url);

/** How many twins every concurrency case fires. */
const TWINS = 5;

const LOOKUP = { key: "claim-port", method: "POST", scope: "/v1/organizations" };

/**
 * The fingerprint the router would compute for a request the cases below send
 * by claiming through the port instead.
 *
 * Derived from the route's own registered body spec and the router's own
 * hashing helper, rather than written out as a literal or re-derived from a
 * spec written here. A hard-coded digest would keep matching itself after a
 * change to the canonicaliser, and a locally written body spec would make these
 * cases' claims subtly different from a real request's — which is the one thing
 * they must not be, since what they measure is a real request meeting them.
 */
function fingerprintFor(app: Ground, method: string, template: string, body: unknown): string {
  const route = app.core.router
    .registrations()
    .find((entry) => entry.method === method && entry.template === template);
  if (route === undefined) throw new Error(`no route ${method} ${template}`);
  return fingerprintRequest(method, template, parseBody(body, route.body));
}

/** The fingerprint of `ORGANIZATION` sent to the organizations route. */
function organizationFingerprint(app: Ground): string {
  return fingerprintFor(app, "POST", "/v1/organizations", ORGANIZATION);
}

/** Fires the same request `TWINS` times with nothing awaited between them. */
async function twins(app: Ground, key: string) {
  return Promise.all(
    Array.from({ length: TWINS }, () => app.post("/v1/organizations", ORGANIZATION, key)),
  );
}

describe.each(harnesses)("concurrent keyed requests on $name", (harness) => {
  afterAll(async () => {
    await harness.close();
  });

  it("creates one organization from five simultaneous identical requests", async () => {
    const app = await harness.make();
    const before = await app.count("organization");
    const answers = await twins(app, "claim-race");

    // The gate. Before this milestone this number was 5 on the reference
    // backend every time and 1, 5, 5, 4, 4 on Postgres across five rounds.
    expect(
      (await app.count("organization")) - before,
      "concurrent identical keyed requests created more than one organization: B-43 is open again",
    ).toBe(1);

    // And exactly one of the five was told it created something. The row count
    // alone would pass if the router created one organization and reported five
    // fresh successes, which is the same lie from the caller's side: a caller
    // that reconciles its own records against CORE's would book five tenants.
    //
    // "Created" means a 201 *without* the replay header. Measured rather than
    // assumed: on Postgres the winner finished before three of its twins got as
    // far as claiming, so those three were answered with the winner's recorded
    // 201 and the replay header — 4 of the 5 answered 201 in the first run of
    // this gate. That is the mechanism working, and an assertion that counted
    // statuses would have called it a failure.
    const created = answers.filter(
      (answer) => answer.status === 201 && answer.headers?.["idempotent-replay"] === undefined,
    );
    expect(created, "more than one twin was told it created an organization").toHaveLength(1);

    // Every other twin was answered, and answered in one of exactly two legal
    // ways: the winner's recorded answer (it had finished) or a refusal saying
    // it is being worked on (it had not). A twin left hanging would show up here
    // as an undefined status, and a twin answered any other way as itself.
    const others = answers.filter((answer) => answer !== created[0]);
    expect(others).toHaveLength(TWINS - 1);
    for (const answer of others) {
      if (answer.status === 201) {
        expect(answer.headers?.["idempotent-replay"]).toBe("true");
        expect(answer.body).toEqual(created[0]!.body);
        continue;
      }
      expect(answer.status, `a twin answered ${answer.status}`).toBe(409);
      expect(answer.headers?.["retry-after"]).toBe("1");
    }

    // The one organization is the one the winner named, and asking again after
    // the work is done replays it rather than refusing.
    const replay = await app.post("/v1/organizations", ORGANIZATION, "claim-race");
    expect(replay.status).toBe(201);
    expect(replay.headers?.["idempotent-replay"]).toBe("true");
    expect(replay.body).toEqual(created[0]!.body);
    expect(await app.count("organization")).toBe(before + 1);
  });

  it("finishes the five handlers well inside the claim horizon", async () => {
    const app = await harness.make();
    const started = Date.now();
    await twins(app, "claim-timing");
    const elapsed = Date.now() - started;
    // The horizon is a backstop for a process that died, not a budget the
    // normal path spends. If a keyed write ever approaches it, a live claim
    // starts being mistaken for an abandoned one and two twins can both work —
    // so the distance between the two is asserted rather than assumed. A tenth
    // is the margin the doc comment in `retry.ts` promises.
    expect(
      elapsed,
      `five concurrent keyed requests took ${elapsed}ms against a ${CLAIM_HORIZON_MS}ms horizon`,
    ).toBeLessThan(CLAIM_HORIZON_MS / 10);
  });

  it("tells a refused twin when to come back, and when the winner started", async () => {
    const app = await harness.make();
    // Claimed through the port so the refusal is observed with the winner still
    // holding the claim: over HTTP the winner finishes first often enough that
    // the twin would be answered with a replay instead, which is a different
    // (also correct) answer and would make this case measure nothing.
    // Relative to what the ground already built: `ground` creates the tenant
    // this administrator administers, so an absolute count would be measuring
    // the harness rather than the case.
    const before = await app.count("organization");
    const held = await app.store.retry.claim({ ...LOOKUP, request_fingerprint: organizationFingerprint(app) });
    expect(held.outcome).toBe("claimed");

    const refused = await app.post("/v1/organizations", ORGANIZATION, LOOKUP.key);
    expect(refused.status).toBe(409);
    expect(refused.headers?.["retry-after"]).toBe("1");
    const body = refused.body as {
      code: string;
      details: Record<string, unknown>;
    };
    expect(body.code).toBe("conflict");
    // The claim time, as a timestamp and not as prose: a caller reading this in
    // a log can tell its own retry from somebody else's key without asking CORE
    // a second question.
    expect(typeof body.details["claimed_at"]).toBe("string");
    expect(Number.isNaN(Date.parse(body.details["claimed_at"] as string))).toBe(false);
    // Refused means refused: nothing was created for the twin.
    expect(await app.count("organization")).toBe(before);
  });

  it("refuses a different request under a live claim as a reuse, not as in flight", async () => {
    const app = await harness.make();
    const held = await app.store.retry.claim({ ...LOOKUP, request_fingerprint: organizationFingerprint(app) });
    expect(held.outcome).toBe("claimed");

    // A different body under the same key. The fingerprint is read before the
    // state, so the caller hears the reason that is actually its problem: it is
    // not going to be given this key's answer however long it waits.
    const refused = await app.post(
      "/v1/organizations",
      { ...ORGANIZATION, name: "Different Org" },
      LOOKUP.key,
    );
    expect(refused.status).toBe(409);
    expect(refused.headers?.["retry-after"]).toBeUndefined();
    expect((refused.body as { message: string }).message).toContain("already used with a different");
  });

  it("gives the key back when the handler refuses, so a corrected request goes through", async () => {
    const app = await harness.make();
    // A route whose handler *returns* a refusal, registered for this case
    // alone. The obvious way to write this case was a real route sent a body it
    // would reject — and that was measured, and it tested nothing: the router
    // parses the body before it claims, so a malformed request is refused with
    // no claim ever taken. Breaking the post-handler release left that version
    // of this case passing (falsification F5 in `docs/retry-claim.md`). A
    // handler that answers 409 is the only way to reach the branch, because
    // every production handler either succeeds or throws.
    let attempts = 0;
    app.core.router.post(
      "/v1/test/refusing",
      opaqueBody("the body is fingerprinted whole, like any keyed write"),
      AUTHENTICATED,
      keyed("the claim release on a refusing handler is what this route exists to measure"),
      async () => {
        attempts += 1;
        // Refuses the first call and accepts the second, which is what a caller
        // correcting its request looks like from inside a handler.
        return attempts === 1
          ? { status: 409, body: { refused: true } }
          : { status: 201, body: { accepted: true } };
      },
    );

    const refused = await app.post("/v1/test/refusing", { attempt: 1 }, "claim-release");
    expect(refused.status).toBe(409);
    // The claim is gone rather than parked: a row left behind would refuse the
    // corrected request as in-flight for a minute, and then as a reuse for a
    // day once its body changed.
    expect(
      await app.store.retry.find({ key: "claim-release", method: "POST", scope: "/v1/test/refusing" }),
      "a refused handler left its claim standing, so the corrected request cannot use the key",
    ).toBeNull();

    // Immediately, not after the horizon, and the handler really ran again:
    // `attempts` is 2, which a request refused as in-flight could not produce.
    const accepted = await app.post("/v1/test/refusing", { attempt: 1 }, "claim-release");
    expect(accepted.status).toBe(201);
    expect(attempts).toBe(2);
    // And the answer that *was* recorded is the accepted one, so the next retry
    // replays a success rather than the refusal.
    const replay = await app.post("/v1/test/refusing", { attempt: 1 }, "claim-release");
    expect(replay.status).toBe(201);
    expect(replay.headers?.["idempotent-replay"]).toBe("true");
  });

  it("takes no claim at all for a request it refuses before the handler", async () => {
    const app = await harness.make();
    const before = await app.count("organization");
    // A request missing a required field. Measured rather than assumed: the
    // body is parsed before the key is claimed, so this never reaches the
    // release path above — it leaves no row to release. Asserted because the
    // ordering is what makes that true, and a future change that claimed first
    // would leave a claim behind on every malformed request.
    const rejected = await app.post("/v1/organizations", { name: "Corrected Org" }, "claim-unparsed");
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    expect(rejected.status).toBeLessThan(500);
    expect(await app.count("organization")).toBe(before);
    expect(
      await app.store.retry.find({ key: "claim-unparsed", method: "POST", scope: "/v1/organizations" }),
      "a request refused before its handler ran still took a claim",
    ).toBeNull();

    // And the corrected request goes through under the same key.
    const corrected = await app.post(
      "/v1/organizations",
      { name: "Corrected Org", country_code: "SA" },
      "claim-unparsed",
    );
    expect(corrected.status).toBe(201);
    expect(await app.count("organization")).toBe(before + 1);
  });

  it("gives the key back when the handler throws", async () => {
    const app = await harness.make();
    // A route registered for this case alone, because no production handler can
    // be made to throw on demand without breaking something else — and the
    // release on the throw path is a different branch of the router from the
    // release on a refusal.
    app.core.router.post(
      "/v1/test/throwing",
      opaqueBody("the body is fingerprinted whole, like any keyed write"),
      AUTHENTICATED,
      keyed("the claim release on a thrown handler is what this route exists to measure"),
      async () => {
        throw new Error("the handler threw");
      },
    );

    const first = await app.post("/v1/test/throwing", { attempt: 1 }, "claim-throw");
    expect(first.status).toBe(500);
    expect(
      await app.store.retry.find({ key: "claim-throw", method: "POST", scope: "/v1/test/throwing" }),
      "a thrown handler left its claim standing, so the caller cannot retry for a minute",
    ).toBeNull();

    // Immediately, not after the horizon: the same request is accepted again
    // and reaches the handler, which throws again. That it throws is the point —
    // it proves the request ran rather than being refused as in flight.
    const second = await app.post("/v1/test/throwing", { attempt: 1 }, "claim-throw");
    expect(second.status).toBe(500);
  });

  it("fences a completion and a release on the claim token", async () => {
    const app = await harness.make();
    const first = await app.store.retry.claim({ ...LOOKUP, request_fingerprint: organizationFingerprint(app) });
    expect(first.outcome).toBe("claimed");
    const stale = first.outcome === "claimed" ? first.claim_token : "";

    // The horizon passes and the next request takes the claim over. The first
    // owner is still running somewhere, holding a token that no longer matches.
    app.clock.advance(CLAIM_HORIZON_MS + 1000);
    const second = await app.store.retry.claim({ ...LOOKUP, request_fingerprint: organizationFingerprint(app) });
    expect(second.outcome, "an abandoned claim was not taken over").toBe("claimed");
    const live = second.outcome === "claimed" ? second.claim_token : "";
    expect(live).not.toBe(stale);

    // Neither of the stale owner's two ways of settling can touch the row. If
    // either did, the new owner's work would be recorded under the old one's
    // answer, or the key would be released while the new owner is still using
    // it — both of which put two organizations behind one key.
    expect(
      await app.store.retry.complete({ ...LOOKUP, claim_token: stale, response_status: 201, response_body: { stale: true } }),
      "a stale claim recorded an answer over the live one",
    ).toBe(false);
    expect(
      await app.store.retry.release({ ...LOOKUP, claim_token: stale }),
      "a stale claim released the live owner's key",
    ).toBe(false);

    const row = (await app.store.retry.find(LOOKUP)) as RetryRecordRow;
    expect(row.state).toBe("claimed");
    expect(row.claim_token).toBe(live);
    expect(row.response_status).toBeNull();

    // The live owner still settles, and once it has, the stale owner's token is
    // no better off: a second completion is refused too.
    expect(
      await app.store.retry.complete({ ...LOOKUP, claim_token: live, response_status: 201, response_body: { live: true } }),
    ).toBe(true);
    expect(
      await app.store.retry.complete({ ...LOOKUP, claim_token: live, response_status: 201, response_body: { again: true } }),
      "a completed claim was completed a second time",
    ).toBe(false);
    const completed = (await app.store.retry.find(LOOKUP)) as RetryRecordRow;
    expect(completed.state).toBe("completed");
    expect(completed.response_body).toEqual({ live: true });
  });

  it("takes over an abandoned claim without a sweeper, and not one second early", async () => {
    const app = await harness.make();
    const held = await app.store.retry.claim({ ...LOOKUP, request_fingerprint: organizationFingerprint(app) });
    expect(held.outcome).toBe("claimed");

    // One millisecond short of the horizon the claim is still somebody's. A
    // takeover here would mean a slow handler being run twice, which is the
    // defect this milestone closed rather than a recovery.
    app.clock.advance(CLAIM_HORIZON_MS - 1);
    const early = await app.store.retry.claim({ ...LOOKUP, request_fingerprint: organizationFingerprint(app) });
    expect(early.outcome, "a live claim was taken over before the horizon").toBe("in_flight");

    // Past it, the next request for the key takes it: nothing else runs, no
    // background job exists, and the recovery costs exactly one statement.
    app.clock.advance(2);
    const taken = await app.store.retry.claim({ ...LOOKUP, request_fingerprint: organizationFingerprint(app) });
    expect(taken.outcome, "an abandoned claim was never recoverable").toBe("claimed");
    // One row, not two: the takeover reuses the primary key rather than racing
    // to insert beside it.
    expect(await app.count("idempotency_key")).toBe(1);
  });

  it("replays a completed claim rather than refusing it as in flight", async () => {
    const app = await harness.make();
    const before = await app.count("organization");
    const first = await app.post("/v1/organizations", ORGANIZATION, "claim-replay");
    expect(first.status).toBe(201);
    // Sequential, so the claim is completed before the second call: the state
    // is what decides between a replay and a refusal, and a `completed` row
    // answered as in-flight would make every ordinary retry a 409.
    const second = await app.post("/v1/organizations", ORGANIZATION, "claim-replay");
    expect(second.status).toBe(201);
    expect(second.headers?.["idempotent-replay"]).toBe("true");
    expect(second.headers?.["retry-after"]).toBeUndefined();
    expect(await app.count("organization")).toBe(before + 1);
  });
});

/**
 * The reference backend's own atomicity, stated where it can be read.
 *
 * Not a duplicate of the cases above: those go through the router, and the
 * router would collapse a duplicate on a later check even if `claim` were not
 * atomic. This one asks the store directly, which is where milestone 32's
 * `record` lost the race — it awaited its own `find`, and an `await` is a point
 * where another twin runs.
 */
describe("the reference store's claim", () => {
  it("grants exactly one of many simultaneous claims", async () => {
    const [memory] = retryHarnesses(undefined);
    const app = await memory!.make();
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.store.retry.claim({ ...LOOKUP, request_fingerprint: organizationFingerprint(app) }),
      ),
    );
    const granted = outcomes.filter((outcome) => outcome.outcome === "claimed");
    expect(granted, "the reference store granted more than one claim on one key").toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.outcome === "in_flight")).toHaveLength(19);
    expect(await app.count("idempotency_key")).toBe(1);
    await memory!.close();
  });

  it("refuses a claim for a different request without granting it", async () => {
    const [memory] = retryHarnesses(undefined);
    const app = await memory!.make();
    await app.store.retry.claim({ ...LOOKUP, request_fingerprint: organizationFingerprint(app) });
    const other = await app.store.retry.claim({ ...LOOKUP, request_fingerprint: "f".repeat(64) });
    expect(other.outcome).toBe("reused");
    // The refusal changed nothing: the original claim is still the live one, so
    // the caller that holds it can still complete its work.
    const row = (await app.store.retry.find(LOOKUP)) as RetryRecordRow;
    expect(row.request_fingerprint).toBe(organizationFingerprint(app));
    expect(row.state).toBe("claimed");
    await memory!.close();
  });
});
