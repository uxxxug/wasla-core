/**
 * Milestone 8, second half: refusing a caller that asks too often.
 *
 * The properties that matter are not "a counter exists":
 *
 * 1. **The refusal is a refusal.** 429, a `retry-after` the caller can obey, a
 *    distinct error code, and retryable — not a 500 that looks like CORE broke,
 *    and not a domain error that looks like the request was wrong.
 * 2. **A refused request costs nothing and changes nothing.** No fulfillment, no
 *    ledger entry, no outbox row, no inbound event, no audit entry, no
 *    notification. A limiter that refuses *after* the work has happened has
 *    protected nobody.
 * 3. **Concurrency cannot walk through the limit.** This is the B-22 shape: read
 *    the counter, decide, then write. Two callers reading 99 of 100 and both
 *    being allowed. Asserted on real Postgres with a real pool, because that is
 *    the only place the interleaving exists.
 * 4. **The subject is the caller, not the machine.** Two credentials from one
 *    address are two budgets; the address is only the fallback when there is no
 *    credential at all.
 * 5. **The workers are untouched.** Background work is nobody's request.
 *
 * Postgres is not optional for the concurrency test: an in-memory store is
 * atomic because the runtime is single-threaded, which proves nothing about the
 * database. Both backends are asserted for everything else, so a permissive
 * memory double cannot certify a bug (B-12).
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createCoreApp, type CoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { makeEvent } from "../src/platform/eventing/envelope.js";
import {
  memoryPersistence,
  postgresPersistence,
  type Persistence,
} from "../src/platform/persistence/backends.js";
import {
  DEFAULT_RATE_LIMIT_POLICY,
  rateClassFor,
  subjectFor,
  UNLIMITED_ROUTES,
  type RateLimitPolicy,
} from "../src/platform/http/rate-limit.js";

const url = process.env.DATABASE_URL;

const TABLES = `rate_limit_counter, notification, notification_recipient, membership,
  session, principal, identity_link, identity, fulfillment, ledger_entry,
  ledger_transaction, payment_authorization, wallet, usage_record,
  subscription_period, subscription, plan_grant, plan, event_delivery,
  event_subscription, inbound_event, organization, outbox, inbox,
  idempotency_key, audit_entry`;

/** Small limits so a test can reach them without issuing hundreds of requests. */
const TIGHT: RateLimitPolicy = {
  windowMs: 60_000,
  limits: { ingress_events: 3, write: 3, read: 2, unmatched: 2 },
};

interface Backend {
  name: string;
  open(clock: FixedClock): Promise<{ store: Persistence; close(): Promise<void> }>;
  truncate(): Promise<void>;
}

const backends: Backend[] = [
  {
    name: "in-memory",
    async open(clock) {
      return { store: memoryPersistence(clock), async close() {} };
    },
    async truncate() {},
  },
];

if (url) {
  backends.push({
    name: "postgres",
    async open(clock) {
      const { Pool } = await import("pg");
      // max > 1 deliberately: a single connection would serialise the
      // concurrency test into the very sequence it is meant to break.
      const pool = new Pool({ connectionString: url, max: 12 });
      return {
        store: postgresPersistence(pool as never, clock),
        async close() {
          await pool.end();
        },
      };
    },
    async truncate() {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: url, max: 1 });
      try {
        await pool.query(`truncate ${TABLES} restart identity cascade`);
      } finally {
        await pool.end();
      }
    },
  });
}

describe("rate limit policy", () => {
  it("classifies routes by what they cost, and exempts liveness and metrics", () => {
    expect(rateClassFor("POST", "/v1/events")).toBe("ingress_events");
    expect(rateClassFor("GET", "/v1/fulfillments/:fulfillment_id")).toBe("read");
    expect(rateClassFor("POST", "/v1/organizations")).toBe("write");
    // An unknown path is attacker-controlled and gets the tightest budget, but is
    // still counted — probing must not be free.
    expect(rateClassFor("GET", null)).toBe("unmatched");
    for (const template of UNLIMITED_ROUTES) {
      expect(rateClassFor("GET", template)).toBe(null);
    }
  });

  it("keys on the credential, and falls back to the address only without one", () => {
    const token = `tok-${randomUUID()}`;
    const a = subjectFor({ authorization: `Bearer ${token}` });
    const b = subjectFor({ authorization: `bearer ${token}`, "x-forwarded-for": "203.0.113.9" });
    // Same credential, different address: one subject. The address does not
    // participate when a credential is present.
    expect(a).toEqual(b);
    expect(a.kind).toBe("credential");
    // The token never appears in the key.
    expect(a.hash).not.toContain(token);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);

    const other = subjectFor({ authorization: `Bearer tok-${randomUUID()}` });
    expect(other.hash).not.toBe(a.hash);

    const network = subjectFor({ "x-forwarded-for": "203.0.113.9, 70.41.3.18" });
    expect(network.kind).toBe("network");
    // The first hop is the client; the rest is proxy chain.
    expect(network.hash).toBe(subjectFor({ "x-real-ip": "203.0.113.9" }).hash);
    // Nothing to attribute at all is still a subject, not an exemption.
    expect(subjectFor({}).kind).toBe("network");
  });

  it("ships defaults that are finite and tightest where the path is unknown", () => {
    for (const limit of Object.values(DEFAULT_RATE_LIMIT_POLICY.limits)) {
      expect(limit).toBeGreaterThan(0);
      expect(Number.isFinite(limit)).toBe(true);
    }
    expect(DEFAULT_RATE_LIMIT_POLICY.limits.unmatched).toBeLessThan(
      DEFAULT_RATE_LIMIT_POLICY.limits.read,
    );
    expect(DEFAULT_RATE_LIMIT_POLICY.limits.ingress_events).toBeGreaterThan(
      DEFAULT_RATE_LIMIT_POLICY.limits.write,
    );
  });
});

describe.each(backends)("ingress rate limiting on $name", (backend) => {
  let core: CoreApp;
  let store: Persistence;
  let clock: FixedClock;
  let close: () => Promise<void>;
  let organizationId: string;

  beforeEach(async () => {
    await backend.truncate();
    clock = new FixedClock();
    const opened = await backend.open(clock);
    store = opened.store;
    close = opened.close;
    core = createCoreApp({ clock, persistence: store, rateLimitPolicy: TIGHT });
    const org = await core.organization.create({
      name: "Limited Co",
      country_code: "SA",
      correlation_id: randomUUID(),
    });
    organizationId = org.organization_id;
    return async () => {
      await close();
    };
  });

  async function serviceToken(serviceName = "wasla-market"): Promise<string> {
    const registered = await core.identity.registerIdentity({
      channel_type: "partner_api",
      external_id: `${serviceName}-${randomUUID()}`,
      display_name: serviceName,
      service_name: serviceName,
      correlation_id: randomUUID(),
    });
    await core.identity.grantMembership({
      principal_id: registered.principal.principal_id,
      organization_id: organizationId,
      roles: ["service"],
      correlation_id: randomUUID(),
    });
    const issued = await core.identity.issueSession({
      principal_id: registered.principal.principal_id,
      channel_type: "partner_api",
      correlation_id: randomUUID(),
    });
    return issued.token;
  }

  function orderEvent(reference: string) {
    return makeEvent({
      event_type: "market.order.created",
      version: 1,
      producer: "wasla-market",
      occurred_at: clock.now(),
      correlation_id: randomUUID(),
      entity_type: "order",
      entity_id: reference,
      payload: {
        organization_id: organizationId,
        order_id: reference,
        requested_service: "delivery",
      },
    });
  }

  const post = (token: string, reference = `mkt-${randomUUID()}`) =>
    core.router.handle({
      method: "POST",
      url: "/v1/events",
      body: orderEvent(reference),
      headers: { authorization: `Bearer ${token}` },
    });

  it("allows up to the limit, refuses past it with 429 and usable retry timing", async () => {
    const token = await serviceToken();

    for (let i = 1; i <= TIGHT.limits.ingress_events; i++) {
      const res = await post(token);
      expect(res.status, `request ${i} of the budget`).toBe(202);
      expect(res.headers?.["x-ratelimit-limit"]).toBe(String(TIGHT.limits.ingress_events));
      expect(res.headers?.["x-ratelimit-remaining"]).toBe(
        String(TIGHT.limits.ingress_events - i),
      );
      // No `retry-after` while the caller is inside its budget: advertising one
      // would tell a well-behaved client to slow down for no reason.
      expect(res.headers?.["retry-after"]).toBeUndefined();
    }

    const refused = await post(token);
    expect(refused.status).toBe(429);
    // Not 500, not 400, not a domain code: the caller must be able to tell
    // "wait" from "broken" from "wrong".
    expect(refused.body).toMatchObject({ code: "rate_limited", retryable: true });
    expect(String((refused.body as { message: string }).message)).not.toMatch(/[0-9a-f]{40}/);
    const retryAfter = Number(refused.headers?.["retry-after"]);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter * 1000).toBeLessThanOrEqual(TIGHT.windowMs);
    expect(refused.headers?.["x-ratelimit-remaining"]).toBe("0");

    // The refusal is counted, by class and subject kind only.
    expect(
      core.metrics.counterValue("core_http_rate_limited_total", {
        rate_class: "ingress_events",
        subject_kind: "credential",
      }),
    ).toBe(1);
    expect(
      core.metrics.counterValue("core_http_requests_total", {
        route: "/v1/events",
        method: "post",
        status: "429",
      }),
    ).toBe(1);
  });

  it("lets the caller back in when the window it was told to wait for has passed", async () => {
    const token = await serviceToken();
    for (let i = 0; i < TIGHT.limits.ingress_events; i++) await post(token);
    const refused = await post(token);
    expect(refused.status).toBe(429);

    // Obeying `retry-after` must actually work, otherwise the header is a lie.
    clock.advance(Number(refused.headers?.["retry-after"]) * 1000);
    expect((await post(token)).status).toBe(202);
  });

  it("changes no state at all when it refuses", async () => {
    const token = await serviceToken();
    for (let i = 0; i < TIGHT.limits.ingress_events; i++) await post(token);

    const snapshot = async () => ({
      inbound: (await store.inbound.all()).length,
      outbox: (await store.outbox.all()).length,
      inbox: await store.inbox.size(),
      audit: (await store.audit.entries()).length,
      notifications: JSON.stringify(await store.notification.counts()),
      deliveries: JSON.stringify(await store.delivery.counts()),
      fulfillments: (await store.fulfillment.all()).length,
      transactions: (await store.money.transactions()).length,
      authorizations: (await store.money.allAuthorizations()).length,
    });

    const before = await snapshot();
    const reference = `mkt-refused-${randomUUID()}`;
    const refused = await post(token, reference);
    expect(refused.status).toBe(429);
    expect(await snapshot()).toEqual(before);
    // Specifically: the event was not durably accepted under another name, so a
    // later replay is a first delivery and not a duplicate.
    expect(await core.fulfillment.findByOrderReference(reference)).toBeUndefined();

    // And the refusal did not consume the idempotency of the request: the same
    // event, sent inside a fresh window, is accepted normally.
    clock.advance(TIGHT.windowMs);
    expect((await post(token, reference)).status).toBe(202);
    expect((await store.inbound.all()).length).toBe(before.inbound + 1);
  });

  it("gives each credential its own budget", async () => {
    const market = await serviceToken("wasla-market");
    const move = await serviceToken("wasla-move");
    for (let i = 0; i < TIGHT.limits.ingress_events; i++) await post(market);
    expect((await post(market)).status).toBe(429);

    // A second caller must not be punished for the first one's traffic — and
    // both are behind the same reported address here, which is exactly the case
    // an address-keyed limiter would get wrong.
    const other = await core.router.handle({
      method: "POST",
      url: "/v1/events",
      body: orderEvent(`mkt-${randomUUID()}`),
      headers: { authorization: `Bearer ${move}`, "x-forwarded-for": "203.0.113.9" },
    });
    // MOVE may not assert a market event, but it was *reached*: 403 from the
    // handler, not 429 from the limiter.
    expect(other.status).toBe(403);
  });

  it("keeps route classes apart", async () => {
    const token = await serviceToken();
    // Exhaust `read` against a route that exists.
    for (let i = 0; i < TIGHT.limits.read; i++) {
      await core.router.handle({
        method: "GET",
        url: "/v1/event-deliveries/undelivered",
        headers: { authorization: `Bearer ${token}` },
      });
    }
    const refusedRead = await core.router.handle({
      method: "GET",
      url: "/v1/event-deliveries/undelivered",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(refusedRead.status).toBe(429);
    expect(refusedRead.headers?.["x-ratelimit-limit"]).toBe(String(TIGHT.limits.read));

    // Ingress is a different budget: a reporting client exhausting its reads must
    // not stop MARKET from delivering events.
    expect((await post(token)).status).toBe(202);
  });

  it("never refuses liveness or the metrics scrape", async () => {
    const token = await serviceToken();
    for (const path of UNLIMITED_ROUTES) {
      for (let i = 0; i < 12; i++) {
        const res = await core.router.handle({
          method: "GET",
          url: path,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.status, `${path} on attempt ${i}`).not.toBe(429);
        // Nothing to advertise: these routes have no budget at all.
        expect(res.headers?.["x-ratelimit-limit"]).toBeUndefined();
      }
    }
  });

  it("does not throttle the background workers", async () => {
    const token = await serviceToken();
    // Fill the ingress budget with accepted events, then exhaust it.
    for (let i = 0; i < TIGHT.limits.ingress_events; i++) await post(token);
    expect((await post(token)).status).toBe(429);

    // The workers are invoked directly and never pass through the router, so a
    // caller flooding the edge cannot stop CORE from finishing work it has
    // already accepted responsibility for.
    expect(await core.dispatcher.drainOnce()).toMatchObject({
      processed: TIGHT.limits.ingress_events,
    });
    expect((await core.publisher.drainOnce()).published).toBeGreaterThan(0);
    await core.deliveries.drainOnce();
    await core.notificationDispatcher.drainOnce();
    // The worker counters moved while the edge was refusing.
    expect(
      core.metrics.counterValue("core_worker_outcomes_total", {
        worker: "inbound_dispatcher",
        outcome: "completed",
      }),
    ).toBe(TIGHT.limits.ingress_events);
  });

  it("attributes an unauthenticated flood to the network, not to a credential", async () => {
    for (let i = 0; i < TIGHT.limits.read; i++) {
      await core.router.handle({
        method: "GET",
        url: "/v1/event-deliveries/undelivered",
        headers: { "x-forwarded-for": "198.51.100.7" },
      });
    }
    const refused = await core.router.handle({
      method: "GET",
      url: "/v1/event-deliveries/undelivered",
      headers: { "x-forwarded-for": "198.51.100.7" },
    });
    // 429 before 401: an unauthenticated flood must be cheap to refuse, and
    // rejecting it earlier than authentication is the point.
    expect(refused.status).toBe(429);
    expect(
      core.metrics.counterValue("core_http_rate_limited_total", {
        rate_class: "read",
        subject_kind: "network",
      }),
    ).toBe(1);
    // The address is not in the exposition, hashed or otherwise.
    const exposition = core.metrics.render();
    expect(exposition).not.toContain("198.51.100.7");
    expect(exposition).not.toMatch(/[0-9a-f]{64}/);
  });

  it("counts a probe of paths that do not exist", async () => {
    for (let i = 0; i < TIGHT.limits.unmatched; i++) {
      const res = await core.router.handle({ method: "GET", url: `/v1/does-not-exist-${i}` });
      expect(res.status).toBe(404);
    }
    const refused = await core.router.handle({ method: "GET", url: "/v1/does-not-exist-final" });
    expect(refused.status).toBe(429);
    // Every probe shares one series and one budget: the path is never a label.
    expect(core.metrics.render()).not.toContain("does-not-exist");
  });
});

describe.runIf(url)("rate limiting under real concurrency", () => {
  it("admits exactly the limit when every request arrives at once", async () => {
    // The B-22 shape, on the database that has to survive it. Read-decide-write
    // would let more than `limit` through here; a single atomic upsert cannot.
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url, max: 16 });
    try {
      await pool.query(`truncate ${TABLES} restart identity cascade`);
      const clock = new FixedClock();
      const store = postgresPersistence(pool as never, clock);
      const limit = 5;
      const core = createCoreApp({
        clock,
        persistence: store,
        rateLimitPolicy: { windowMs: 60_000, limits: { ...TIGHT.limits, read: limit } },
      });

      // Issued before anything is awaited, so they genuinely interleave.
      const attempts = 40;
      const inFlight = Array.from({ length: attempts }, () =>
        core.router.handle({
          method: "GET",
          url: "/v1/event-deliveries/undelivered",
          headers: { authorization: "Bearer flood-credential" },
        }),
      );
      const results = await Promise.all(inFlight);

      const refused = results.filter((r) => r.status === 429).length;
      const admitted = attempts - refused;
      // Exactly, not approximately.
      expect(admitted).toBe(limit);
      expect(refused).toBe(attempts - limit);
      // The counter agrees with the responses.
      const { rows } = await pool.query<{ hits: string }>(
        `select hits from rate_limit_counter where rate_class = 'read'`,
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.hits)).toBe(attempts);
      expect(
        core.metrics.counterValue("core_http_rate_limited_total", {
          rate_class: "read",
          subject_kind: "credential",
        }),
      ).toBe(refused);
    } finally {
      await pool.end();
    }
  });

  it("counts each window separately and prunes the ones that have passed", async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url, max: 4 });
    try {
      await pool.query(`truncate ${TABLES} restart identity cascade`);
      const clock = new FixedClock();
      const store = postgresPersistence(pool as never, clock);
      const core = createCoreApp({ clock, persistence: store, rateLimitPolicy: TIGHT });

      for (let i = 0; i < TIGHT.limits.unmatched + 2; i++) {
        await core.router.handle({ method: "GET", url: "/v1/nope" });
      }
      clock.advance(TIGHT.windowMs);
      expect((await core.router.handle({ method: "GET", url: "/v1/nope" })).status).toBe(404);

      const windows = await pool.query(`select window_start, hits from rate_limit_counter`);
      expect(windows.rows).toHaveLength(2);

      // Old windows are removable without touching the live one: the table does
      // not grow for ever, and pruning is an operator loop, not a request cost.
      const removed = await store.rateLimit.prune(new Date(clock.now().getTime()));
      expect(removed).toBe(1);
      const left = await pool.query(`select count(*)::int as n from rate_limit_counter`);
      expect(left.rows[0]!.n).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
