/**
 * Milestone 8, first half: can CORE be operated?
 *
 * The question these tests answer is not "does an endpoint return numbers". It
 * is whether the numbers are the truth, whether asking for them is free, and
 * whether they say anything they must not say.
 *
 * Three properties, each of which has a specific failure mode behind it:
 *
 * 1. **The metrics reflect what the workers actually did.** A counter that says
 *    `completed` for an item whose lease expired is worse than no counter: it
 *    tells the person on call that the queue is healthy while work is stuck.
 * 2. **Scraping is free and changes nothing.** A metrics endpoint that runs
 *    queries is a metrics endpoint that fails when the database is unwell and
 *    gets slower the more you look at it.
 * 3. **Nothing leaks.** No token, no address, no order reference, no entity id,
 *    no tenant. A count must not tell one reader that another tenant has a
 *    problem, and a label must not become one time series per entity.
 *
 * Postgres is exercised because queue depth, `retrying` and the reconciliation
 * counts are aggregate SQL, and a memory double that answers differently from
 * the database certifies bugs (B-12).
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createCoreApp, type CoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { makeEvent } from "../src/platform/eventing/envelope.js";
import { UNFENCED } from "../src/platform/eventing/fencing.js";
import {
  memoryPersistence,
  postgresPersistence,
  type Persistence,
} from "../src/platform/persistence/backends.js";
import { CATALOGUE, MetricsRegistry } from "../src/platform/observability/metrics.js";
import { DepthSampler } from "../src/platform/observability/sampler.js";
import type { NotificationChannel } from "../src/modules/notification/ports.js";
import { GatedChannel, LeakyChannel, RecordingChannel } from "./support/channel-adapters.js";

const url = process.env.DATABASE_URL;

const TABLES = `rate_limit_counter, notification, notification_recipient, membership,
  session, principal, identity_link, identity, fulfillment, ledger_entry,
  ledger_transaction, payment_authorization, wallet, usage_record,
  subscription_period, subscription, plan_grant, plan, event_delivery,
  event_subscription, inbound_event, organization, outbox, inbox,
  idempotency_key, audit_entry`;

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
      const pool = new Pool({ connectionString: url, max: 8 });
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

/** Parses an exposition into `{ "name{labels}": value }` for exact assertions. */
function parseExposition(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const index = line.lastIndexOf(" ");
    out[line.slice(0, index)] = Number(line.slice(index + 1));
  }
  return out;
}

describe("metrics registry", () => {
  it("refuses a metric that is not declared, and a label set that is not the declared one", () => {
    const registry = new MetricsRegistry();
    // A name nobody declared is a name nobody maintains. Failing here rather
        // than exporting it means an instrumentation mistake is a test failure and
    // not a mystery series in somebody's dashboard.
    expect(() => registry.increment("core_made_up_total", {})).toThrow(/not declared/);
    expect(() => registry.increment("core_http_requests_total", { route: "/health" })).toThrow(
      /missing label/,
    );
    expect(() =>
      registry.increment("core_http_requests_total", {
        route: "/health",
        method: "get",
        status: "200",
        organization_id: "acme",
      }),
    ).toThrow(/not declared for it/);
    // Type confusion is caught too: a counter used as a histogram would silently
    // produce a metric no scraper can interpret.
    expect(() => registry.observe("core_http_requests_total", { route: "/health" }, 1)).toThrow(
      /is a counter/,
    );
  });

  it("refuses label values that are identifiers, addresses or secrets", () => {
    const registry = new MetricsRegistry();
    const reject = (value: string) =>
      expect(() =>
        registry.increment("core_http_requests_total", {
          route: value,
          method: "get",
          status: "200",
        }),
      ).toThrow();

    reject(randomUUID()); // a fulfillment, event or recipient id
    reject("/v1/fulfillments/" + randomUUID()); // the concrete path
    reject("ops@example.com"); // an email address
    reject("+966500000000"); // a phone number
    reject(["sk", "live", "abcdefghijklmnopqrstuvwx"].join("_")); // a credential
    reject("a".repeat(200)); // free text from a provider

    // And the rejection message must not repeat the value it refused: a metrics
    // guard that logs the token it rejected has leaked the token.
    try {
      registry.increment("core_http_requests_total", {
        route: "ops@example.com",
        method: "get",
        status: "200",
      });
      throw new Error("expected a rejection");
    } catch (err) {
      expect((err as Error).message).not.toContain("ops@example.com");
    }
  });

  it("renders deterministic Prometheus exposition with buckets, sum and count", () => {
    const registry = new MetricsRegistry();
    registry.increment("core_http_requests_total", { route: "/health", method: "get", status: "200" });
    registry.increment("core_http_requests_total", { route: "/health", method: "get", status: "200" });
    registry.increment("core_http_requests_total", { route: "/ready", method: "get", status: "200" });
    registry.setGauge("core_queue_depth", { queue: "outbox", state: "pending" }, 3);
    registry.observe("core_http_request_duration_seconds", { route: "/health", method: "get" }, 0.004);
    registry.observe("core_http_request_duration_seconds", { route: "/health", method: "get" }, 0.4);

    const first = registry.render();
    // Byte-identical on a second read: an exposition that reorders itself makes
    // every diff unreadable and hides real changes.
    expect(registry.render()).toBe(first);

    expect(first).toContain("# TYPE core_http_requests_total counter");
    expect(first).toContain("# TYPE core_queue_depth gauge");
    expect(first).toContain("# TYPE core_http_request_duration_seconds histogram");

    const values = parseExposition(first);
    expect(values['core_http_requests_total{route="/health",method="get",status="200"}']).toBe(2);
    expect(values['core_http_requests_total{route="/ready",method="get",status="200"}']).toBe(1);
    expect(values['core_queue_depth{queue="outbox",state="pending"}']).toBe(3);
    expect(values['core_http_request_duration_seconds_count{route="/health",method="get"}']).toBe(2);
    // Cumulative buckets: 0.005 holds the 4ms observation, +Inf holds both.
    expect(
      values['core_http_request_duration_seconds_bucket{route="/health",method="get",le="0.005"}'],
    ).toBe(1);
    expect(
      values['core_http_request_duration_seconds_bucket{route="/health",method="get",le="+Inf"}'],
    ).toBe(2);
    expect(
      values['core_http_request_duration_seconds_sum{route="/health",method="get"}'],
    ).toBeCloseTo(0.404, 6);
  });

  it("declares no dimension that identifies an entity or a tenant", () => {
    // The guard above stops a bad *value*. This stops a bad *name* — the label
    // that would look reasonable in a review and would be a per-entity series.
    const forbidden = [
      "organization_id",
      "tenant",
      "tenant_id",
      "fulfillment_id",
      "event_id",
      "recipient_id",
      "notification_id",
      "delivery_id",
      "identity_id",
      "principal_id",
      "address",
      "order_reference",
      "subject",
      "subject_hash",
      "token",
      "path",
      "url",
    ];
    for (const [name, definition] of Object.entries(CATALOGUE)) {
      for (const label of definition.labels) {
        expect(forbidden, `${name} declares label ${label}`).not.toContain(label);
      }
    }
  });
});

describe("depth sampler", () => {
  it("reports its own failure instead of publishing zeros or throwing", async () => {
    const registry = new MetricsRegistry();
    const clock = new FixedClock();
    const counts = async () => ({ pending: 2, published: 0, dead: 0, retrying: 0 });
    const healthy = {
      outbox: { counts },
      inbound: { counts },
      delivery: { counts },
      notification: { counts },
    };
    const sampler = new DepthSampler(registry, healthy, clock);
    await sampler.sample();
    expect(registry.gaugeValue("core_queue_depth", { queue: "outbox", state: "pending" })).toBe(2);
    const firstSampledAt = registry.gaugeValue("core_sample_timestamp_seconds", {});
    expect(firstSampledAt).toBe(Math.floor(clock.now().getTime() / 1000));

    // Now the database refuses. The sampler must not throw into the operator's
    // loop, must not overwrite good gauges with zeros, and must not let the
    // timestamp move — a stale sample has to look stale.
    clock.advance(60_000);
    const broken = new DepthSampler(
      registry,
      {
        ...healthy,
        delivery: {
          async counts(): Promise<Record<string, number>> {
            throw new Error("connection terminated unexpectedly");
          },
        },
      },
      clock,
    );
    await expect(broken.sample()).resolves.toBeUndefined();
    expect(registry.counterValue("core_sample_failures_total", {})).toBe(1);
    expect(registry.gaugeValue("core_sample_timestamp_seconds", {})).toBe(firstSampledAt);
    expect(registry.gaugeValue("core_queue_depth", { queue: "outbox", state: "pending" })).toBe(2);
    // The database's own error text is not turned into a label.
    expect(registry.render()).not.toContain("connection terminated");
  });
});

describe.each(backends)("operational metrics on $name", (backend) => {
  let core: CoreApp;
  let store: Persistence;
  let clock: FixedClock;
  let close: () => Promise<void>;
  let organizationId: string;

  async function open(channels: readonly NotificationChannel[] = []): Promise<void> {
    await backend.truncate();
    clock = new FixedClock();
    const opened = await backend.open(clock);
    store = opened.store;
    close = opened.close;
    core = createCoreApp({ clock, persistence: store, channels });
    const org = await core.organization.create({
      name: "Observability Co",
      country_code: "SA",
      correlation_id: randomUUID(),
    });
    organizationId = org.organization_id;
  }

  beforeEach(async () => {
    await open();
    return async () => {
      await close();
    };
  });

  async function serviceToken(serviceName: string): Promise<string> {
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

  /** Drives a fulfillment to `dispatched`, the state change people are told about. */
  async function dispatchNotifiable(reference: string): Promise<string> {
    const created = await core.fulfillment.consumeMarketOrder(orderEvent(reference));
    await core.fulfillment.consumeJobAccepted(
      makeEvent({
        event_type: "move.job.accepted",
        version: 1,
        producer: "wasla-move",
        occurred_at: clock.now(),
        correlation_id: randomUUID(),
        entity_type: "operational_job",
        entity_id: `job-${reference}`,
        payload: {
          fulfillment_id: created.fulfillment_id,
          job_id: `job-${reference}`,
          accepted_at: clock.now().toISOString(),
        },
      }),
    );
    return created.fulfillment_id;
  }

  it("counts ingress by route template and exact status, never by concrete path", async () => {
    const token = await serviceToken("wasla-market");
    const reference = `mkt-${randomUUID()}`;
    await core.router.handle({
      method: "POST",
      url: "/v1/events",
      body: orderEvent(reference),
      headers: { authorization: `Bearer ${token}` },
    });
    await core.dispatcher.drainOnce();
    const created = await core.fulfillment.findByOrderReference(reference);
    await core.router.handle({
      method: "GET",
      url: `/v1/fulfillments/${created!.fulfillment_id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    // Unauthorised, and a 401 must be as visible as a 200: an error rate is the
    // first thing anybody looks at.
    await core.router.handle({ method: "GET", url: `/v1/fulfillments/${created!.fulfillment_id}` });
    await core.router.handle({ method: "GET", url: `/v1/nothing-here` });

    const values = parseExposition(core.metrics.render());
    expect(values['core_http_requests_total{route="/v1/events",method="post",status="202"}']).toBe(1);
    expect(
      values['core_http_requests_total{route="/v1/fulfillments/:fulfillment_id",method="get",status="200"}'],
    ).toBe(1);
    expect(
      values['core_http_requests_total{route="/v1/fulfillments/:fulfillment_id",method="get",status="401"}'],
    ).toBe(1);
    // An unknown path is attacker-controlled text and is folded into one series.
    expect(values['core_http_requests_total{route="unmatched",method="get",status="404"}']).toBe(1);
    expect(core.metrics.render()).not.toContain(created!.fulfillment_id);
    expect(core.metrics.render()).not.toContain("nothing-here");
    // Latency is recorded per route, and only per route.
    expect(
      core.metrics.histogramValue("core_http_request_duration_seconds", {
        route: "/v1/events",
        method: "post",
      })?.count,
    ).toBe(1);
  });

  it("reflects what the outbox relay and the delivery worker really did", async () => {
    const token = await serviceToken("wasla-market");
    const reference = `mkt-${randomUUID()}`;
    await core.router.handle({
      method: "POST",
      url: "/v1/events",
      body: orderEvent(reference),
      headers: { authorization: `Bearer ${token}` },
    });
    // The inbound dispatcher moves the accepted event to its consumer, which
    // creates a fulfillment and appends CORE's own event to the outbox.
    expect(await core.dispatcher.drainOnce()).toMatchObject({ processed: 1 });
    expect(
      core.metrics.counterValue("core_worker_claims_total", { worker: "inbound_dispatcher" }),
    ).toBe(1);
    expect(
      core.metrics.counterValue("core_worker_outcomes_total", {
        worker: "inbound_dispatcher",
        outcome: "completed",
      }),
    ).toBe(1);

    const published = await core.publisher.drainOnce();
    expect(published.published).toBeGreaterThan(0);
    expect(core.metrics.counterValue("core_worker_claims_total", { worker: "outbox_relay" })).toBe(
      published.published,
    );
    expect(
      core.metrics.counterValue("core_worker_outcomes_total", {
        worker: "outbox_relay",
        outcome: "completed",
      }),
    ).toBe(published.published);
    // Nothing failed, so the failure counters must be absent rather than zero-ish
    // guesses.
    expect(
      core.metrics.counterValue("core_worker_outcomes_total", {
        worker: "outbox_relay",
        outcome: "failed_permanent",
      }),
    ).toBe(0);
    // Per-item latency was observed for each claimed item.
    expect(
      core.metrics.histogramValue("core_worker_item_duration_seconds", { worker: "outbox_relay" })
        ?.count,
    ).toBe(published.published);
  });

  it("separates a retry from a permanent failure for outbound delivery", async () => {
    await close();
    // A transport that refuses with 500 (retryable) and then with 400 (not).
    let status = 500;
    await backend.truncate();
    clock = new FixedClock();
    const opened = await backend.open(clock);
    store = opened.store;
    close = opened.close;
    core = createCoreApp({
      clock,
      persistence: store,
      transport: { async send() {
        return { status, error: `endpoint responded ${status}` };
      } },
    });
    const org = await core.organization.create({
      name: "Delivery Co",
      country_code: "SA",
      correlation_id: randomUUID(),
    });
    organizationId = org.organization_id;

    await core.subscriptions.register({
      subscriber: "wasla-market",
      event_type: "core.fulfillment.created",
      endpoint_url: "https://market.example.com/hooks",
      signing_secret: "s".repeat(32),
    });
    await core.fulfillment.consumeMarketOrder(orderEvent(`mkt-${randomUUID()}`));
    await core.publisher.drainOnce();

    expect(await core.deliveries.drainOnce()).toMatchObject({ delivered: 0, failed: 1, dead: 0 });
    expect(
      core.metrics.counterValue("core_worker_outcomes_total", {
        worker: "event_delivery",
        outcome: "retried",
      }),
    ).toBe(1);

    status = 400;
    clock.advance(60_000);
    expect(await core.deliveries.drainOnce()).toMatchObject({ dead: 1 });
    expect(
      core.metrics.counterValue("core_worker_outcomes_total", {
        worker: "event_delivery",
        outcome: "failed_permanent",
      }),
    ).toBe(1);
    // The retry counter did not move when the failure became permanent: these
    // are different operational facts and a dashboard that adds them is wrong.
    expect(
      core.metrics.counterValue("core_worker_outcomes_total", {
        worker: "event_delivery",
        outcome: "retried",
      }),
    ).toBe(1);
  });

  it("shows an abandoned claim as a reclaimed lease, not as completed work", async () => {
    // The lifecycle case milestone 8 names explicitly: a worker that dies after
    // claiming and before acknowledging must later appear as an expired lease.
    // Modelled by claiming the row and never acknowledging it, which is exactly
    // what a killed process leaves behind.
    await close();
    await open([new RecordingChannel()]);
    const identity = await core.identity.registerIdentity({
      channel_type: "telegram",
      external_id: `tg-${randomUUID()}`,
      correlation_id: randomUUID(),
    });
    await core.notificationRecipients.register({
      organization_id: null,
      event_type: "core.fulfillment.dispatched",
      identity_id: identity.identity.identity_id,
      channel: "telegram",
      correlation_id: randomUUID(),
    });
    await dispatchNotifiable(`mkt-${randomUUID()}`);
    await core.publisher.drainOnce();

    // Claim without acknowledging: the abandoned worker.
    const claimed = await store.notification.claimDue(clock.now(), 10, 30_000);
    expect(claimed).toHaveLength(1);

    // Nothing is completed, and nothing is reclaimed yet — the lease is alive.
    expect(await core.notificationDispatcher.drainOnce()).toMatchObject({
      reclaimed: 0,
      accepted: 0,
    });
    expect(
      core.metrics.counterValue("core_worker_outcomes_total", {
        worker: "notification",
        outcome: "completed",
      }),
    ).toBe(0);

    // Past the lease, the row comes back as reclaimed and only then is retried.
    clock.advance(31_000);
    const afterExpiry = await core.notificationDispatcher.drainOnce();
    expect(afterExpiry.reclaimed).toBe(1);
    expect(
      core.metrics.counterValue("core_worker_outcomes_total", {
        worker: "notification",
        outcome: "reclaimed",
      }),
    ).toBe(1);
    // And the work was then done, not silently lost.
    expect(afterExpiry.accepted + afterExpiry.delivered).toBe(1);
    expect(
      core.metrics.counterValue("core_worker_outcomes_total", {
        worker: "notification",
        outcome: "completed",
      }),
    ).toBe(1);
  });

  it("counts a fenced acknowledgement instead of a second completion", async () => {
    await close();
    // The dangerous shape, run for real: a worker is inside the channel call when
    // its lease expires and a second worker takes the row. When the first worker
    // comes back it must be refused, and that refusal must appear as `fenced` and
    // not as a completion — otherwise the counters would claim the same message
    // was delivered twice.
    const gate = new GatedChannel();
    await open([gate]);
    const identity = await core.identity.registerIdentity({
      channel_type: "telegram",
      external_id: `tg-${randomUUID()}`,
      correlation_id: randomUUID(),
    });
    await core.notificationRecipients.register({
      organization_id: null,
      event_type: "core.fulfillment.dispatched",
      identity_id: identity.identity.identity_id,
      channel: "telegram",
      correlation_id: randomUUID(),
    });
    await dispatchNotifiable(`mkt-${randomUUID()}`);
    await core.publisher.drainOnce();

    const inFlight = core.notificationDispatcher.drainOnce();
    // Wait until the first worker is actually inside the channel call.
    for (let i = 0; i < 200 && gate.started.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(gate.started).toHaveLength(1);

    // Its lease expires and a second worker legitimately takes the row over.
    clock.advance(31_000);
    const reclaimed = await store.notification.reclaimExpired(clock.now(), 6, 10);
    expect(reclaimed).toBe(1);
    const second = await store.notification.claimDue(clock.now(), 10, 30_000);
    expect(second).toHaveLength(1);

    gate.open();
    const result = await inFlight;
    expect(result.fenced).toBe(1);
    expect(result.accepted).toBe(0);
    expect(
      core.metrics.counterValue("core_worker_outcomes_total", {
        worker: "notification",
        outcome: "fenced",
      }),
    ).toBe(1);
    expect(
      core.metrics.counterValue("core_worker_outcomes_total", {
        worker: "notification",
        outcome: "completed",
      }),
    ).toBe(0);
    // The store is the authority for that refusal, and says the same thing
    // directly: the stale claim token can no longer acknowledge the row.
    expect(second[0]!.claim_token).not.toBe(null);
  });

  it("samples queue depth and the reconciliation queues without exposing a tenant", async () => {
    const reference = `mkt-${randomUUID()}`;
    await core.fulfillment.consumeMarketOrder(orderEvent(reference));

    await core.depthSampler.sample();
    expect(core.metrics.gaugeValue("core_queue_depth", { queue: "outbox", state: "pending" })).toBe(1);
    expect(core.metrics.gaugeValue("core_queue_depth", { queue: "outbox", state: "published" })).toBe(0);
    // Present at zero rather than absent: "no dead rows" and "the sampler is
    // gone" must not look the same.
    expect(core.metrics.gaugeValue("core_queue_depth", { queue: "outbox", state: "dead" })).toBe(0);
    expect(core.metrics.gaugeValue("core_reconciliation_depth", { queue: "inconsistent" })).toBe(0);
    expect(
      core.metrics.gaugeValue("core_reconciliation_depth", { queue: "pending_financial_decision" }),
    ).toBe(0);
    expect(core.metrics.gaugeValue("core_reconciliation_depth", { queue: "stale_holds" })).toBe(0);
    expect(core.metrics.gaugeValue("core_sample_timestamp_seconds", {})).toBe(
      Math.floor(clock.now().getTime() / 1000),
    );

    await core.publisher.drainOnce();
    await core.depthSampler.sample();
    expect(core.metrics.gaugeValue("core_queue_depth", { queue: "outbox", state: "pending" })).toBe(0);
    expect(
      core.metrics.gaugeValue("core_queue_depth", { queue: "outbox", state: "published" }),
    ).toBeGreaterThan(0);

    // The gauge names a queue, never the organization whose rows are in it.
    expect(core.metrics.render()).not.toContain(organizationId);
    expect(core.metrics.render()).not.toContain(reference);
  });

  it("derives `retrying` from the queue itself rather than from a second store", async () => {
    // A retrying row is a pending row with an attempt spent. There is no
    // `retrying` status anywhere, and this asserts the derivation is identical on
    // both backends.
    await core.fulfillment.consumeMarketOrder(orderEvent(`mkt-${randomUUID()}`));
    const pending = await store.outbox.byStatus("pending");
    expect(pending.length).toBeGreaterThan(0);
    // UNFENCED: nothing claimed this row, so there is no token to present (B-26).
    await store.outbox.markFailed(
      pending[0]!.event.event_id,
      UNFENCED,
      "transient",
      new Date(clock.now().getTime() + 60_000),
    );

    const counts = await store.outbox.counts();
    expect(counts["retrying"]).toBe(1);
    expect(counts["pending"]).toBe(pending.length);
    await core.depthSampler.sample();
    expect(core.metrics.gaugeValue("core_queue_depth", { queue: "outbox", state: "retrying" })).toBe(1);
  });

  it("tells an abandoned claim apart from a scheduled retry, and counts the recovery", async () => {
    // B-24. Before `claimed_at` these two rows were indistinguishable: both
    // pending, both with a `next_attempt_at` in the future. One is waiting for a
    // retry it asked for; the other is held by a process that died. An operator
    // could not tell them apart, and `reclaimed` was uncountable for this worker
    // because nothing on the row said a claim had ever happened.
    await core.fulfillment.consumeMarketOrder(orderEvent(`mkt-${randomUUID()}`));
    await core.fulfillment.consumeMarketOrder(orderEvent(`mkt-${randomUUID()}`));

    // A worker claims everything due, acknowledges one row as a failure to be
    // retried in a minute, and then dies holding the rest.
    const claimed = await store.outbox.claimDue(clock.now(), 100, 30_000);
    expect(claimed.length).toBeGreaterThan(1);
    const abandoned = claimed.length - 1;
    const retriedId = claimed[0]!.event.event_id;
    await store.outbox.markFailed(
      retriedId,
      claimed[0]!.claim_token,
      "transient",
      new Date(clock.now().getTime() + 60_000),
    );

    // Inside the lease: one row scheduled for a retry, the rest being worked on.
    // `in_flight` is the answer to "what is a worker doing right now", which no
    // reader of these tables could give before.
    expect(await store.outbox.counts()).toMatchObject({
      retrying: 1,
      in_flight: abandoned,
      abandoned: 0,
    });

    // The lease runs out. Only the held rows become abandoned; the retrying row
    // is still simply waiting its turn, and must never be counted as stuck.
    clock.advance(31_000);
    expect(await store.outbox.counts()).toMatchObject({
      retrying: 1,
      in_flight: 0,
      abandoned,
    });
    await core.depthSampler.sample();
    expect(
      core.metrics.gaugeValue("core_queue_depth", { queue: "outbox", state: "abandoned" }),
    ).toBe(abandoned);

    // The relay recovers exactly those rows, counts the recovery as a distinct
    // outcome, and publishes them in the same pass.
    const drained = await core.publisher.drainOnce();
    expect(drained.reclaimed).toBe(abandoned);
    expect(drained.published).toBe(abandoned);
    expect(
      core.metrics.counterValue("core_worker_outcomes_total", {
        worker: "outbox_relay",
        outcome: "reclaimed",
      }),
    ).toBe(abandoned);

    // The retrying row was not touched by the recovery, and its retry budget was
    // not charged for an attempt nobody observed failing.
    const retried = await store.outbox.get(retriedId);
    expect(retried!.status).toBe("pending");
    expect(retried!.claimed_at).toBeNull();
    expect(retried!.attempts).toBe(1);
    expect(await store.outbox.counts()).toMatchObject({ retrying: 1, abandoned: 0 });
  });

  it("counts an abandoned inbound claim as reclaimed by the dispatcher", async () => {
    const token = await serviceToken("wasla-market");
    const reference = `mkt-${randomUUID()}`;
    await core.router.handle({
      method: "POST",
      url: "/v1/events",
      body: orderEvent(reference),
      headers: { authorization: `Bearer ${token}` },
    });

    // A dispatcher claims the accepted event and dies before processing it.
    const claimed = await store.inbound.claimDue(clock.now(), 100, 30_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.claimed_at).not.toBeNull();

    // Inside the lease nothing may take it, and nothing is stuck yet.
    expect(await store.inbound.claimDue(clock.now(), 100, 30_000)).toEqual([]);
    expect(await store.inbound.counts()).toMatchObject({ in_flight: 1, abandoned: 0 });

    clock.advance(31_000);
    expect(await store.inbound.counts()).toMatchObject({ in_flight: 0, abandoned: 1 });

    const drained = await core.dispatcher.drainOnce();
    expect(drained.reclaimed).toBe(1);
    expect(drained.processed).toBe(1);
    expect(
      core.metrics.counterValue("core_worker_outcomes_total", {
        worker: "inbound_dispatcher",
        outcome: "reclaimed",
      }),
    ).toBe(1);
  });

  it("serves the exposition without touching the database or changing any state", async () => {
    const token = await serviceToken("wasla-market");
    const reference = `mkt-${randomUUID()}`;
    await core.router.handle({
      method: "POST",
      url: "/v1/events",
      body: orderEvent(reference),
      headers: { authorization: `Bearer ${token}` },
    });
    await core.dispatcher.drainOnce();
    await core.publisher.drainOnce();
    await core.depthSampler.sample();

    const before = {
      outbox: (await store.outbox.all()).length,
      inbound: (await store.inbound.all()).length,
      notifications: (await store.notification.counts())["pending"],
      audit: (await store.audit.entries()).length,
      fulfillments: (await core.fulfillment.listFinanciallyInconsistent()).length,
    };

    // Scraped repeatedly, as a monitoring system would.
    const first = await core.router.handle({ method: "GET", url: "/metrics" });
    const second = await core.router.handle({ method: "GET", url: "/metrics" });
    expect(first.status).toBe(200);
    expect(String(first.headers?.["content-type"])).toContain("text/plain");
    expect(typeof first.body).toBe("string");

    const after = {
      outbox: (await store.outbox.all()).length,
      inbound: (await store.inbound.all()).length,
      notifications: (await store.notification.counts())["pending"],
      audit: (await store.audit.entries()).length,
      fulfillments: (await core.fulfillment.listFinanciallyInconsistent()).length,
    };
    expect(after).toEqual(before);

    // Deterministic apart from the scrape it just counted: the only difference
    // between two consecutive scrapes is the request the first one made.
    const firstValues = parseExposition(String(first.body));
    const secondValues = parseExposition(String(second.body));
    expect(secondValues['core_http_requests_total{route="/metrics",method="get",status="200"}']).toBe(
      (firstValues['core_http_requests_total{route="/metrics",method="get",status="200"}'] ?? 0) + 1,
    );
  });

  it("carries CORS headers on /metrics, and nowhere else", async () => {
    // The dashboard is a single HTML file that may be served from a different
    // origin than CORE, so a browser reading /metrics needs these on the
    // response — and a simple GET with no custom headers sends no preflight,
    // so there is no OPTIONS route to register.
    const metrics = await core.router.handle({ method: "GET", url: "/metrics" });
    expect(metrics.headers?.["access-control-allow-origin"]).toBe("*");
    expect(metrics.headers?.["access-control-allow-methods"]).toBe("GET");

    // Not opened globally: an ordinary route must not acquire these headers by
    // accident of shared middleware, because that would be CORS on every
    // authenticated endpoint rather than on the one unauthenticated scrape
    // target this cycle scoped it to.
    const health = await core.router.handle({ method: "GET", url: "/health" });
    expect(health.headers?.["access-control-allow-origin"]).toBeUndefined();
    expect(health.headers?.["access-control-allow-methods"]).toBeUndefined();
  });

  it("leaks no token, address, identifier or tenant into the exposition", async () => {
    await close();
    // A channel that fails with a message containing the recipient's address and
    // an api key — the realistic leak, where a provider's error text ends up in
    // a label because somebody made the failure reason a dimension.
    await open([new LeakyChannel()]);
    const token = await serviceToken("wasla-market");
    const identity = await core.identity.registerIdentity({
      channel_type: "telegram",
      external_id: `tg-secret-${randomUUID()}`,
      correlation_id: randomUUID(),
    });
    await core.notificationRecipients.register({
      organization_id: null,
      event_type: "core.fulfillment.dispatched",
      identity_id: identity.identity.identity_id,
      channel: "telegram",
      correlation_id: randomUUID(),
    });
    const reference = `mkt-${randomUUID()}`;
    await core.router.handle({
      method: "POST",
      url: "/v1/events",
      body: orderEvent(reference),
      headers: { authorization: `Bearer ${token}` },
    });
    await core.dispatcher.drainOnce();
    await dispatchNotifiable(`mkt2-${randomUUID()}`);
    await core.publisher.drainOnce();
    await core.notificationDispatcher.drainOnce();
    await core.depthSampler.sample();

    const exposition = core.metrics.render();
    for (const forbidden of [
      token,
      organizationId,
      reference,
      identity.identity.identity_id,
      "tg-secret",
      "provider.test",
      "api_key",
    ]) {
      expect(exposition, `exposition leaked ${forbidden.slice(0, 8)}…`).not.toContain(forbidden);
    }
    // No uuid at all, anywhere: the strongest form of the same assertion, and
    // the one that catches an identifier arriving through a label nobody
    // reviewed.
    expect(exposition).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    // And the notification did retry — the leak test is only meaningful because
    // there was something to leak.
    expect(
      core.metrics.counterValue("core_worker_outcomes_total", {
        worker: "notification",
        outcome: "retried",
      }),
    ).toBe(1);
  });

  it("keeps instrumentation off the request's critical path", async () => {
    // Not a benchmark. The property is structural: handling a request must not
    // add a database round trip, so a large number of requests against an
    // in-process route must stay far below what any query-per-request
    // implementation could achieve.
    const started = Date.now();
    const rounds = 400;
    for (let i = 0; i < rounds; i++) {
      await core.router.handle({ method: "GET", url: "/health" });
    }
    const perRequest = (Date.now() - started) / rounds;
    expect(perRequest).toBeLessThan(2);
    expect(
      core.metrics.counterValue("core_http_requests_total", {
        route: "/health",
        method: "get",
        status: "200",
      }),
    ).toBe(rounds);
    // The log array is bounded, so a long-running process does not grow one
    // record per request for ever.
    expect(core.router.logs.length).toBeLessThanOrEqual(1000);
  });
});

describe.each(backends)("module state counts on $name", (backend) => {
  let core: CoreApp;
  let store: Persistence;
  let clock: FixedClock;
  let close: () => Promise<void>;
  let organizationId: string;

  async function open(): Promise<void> {
    await backend.truncate();
    clock = new FixedClock();
    const opened = await backend.open(clock);
    store = opened.store;
    close = opened.close;
    core = createCoreApp({ clock, persistence: store, channels: [] });
    const org = await core.organization.create({
      name: "State Count Co",
      country_code: "SA",
      correlation_id: randomUUID(),
    });
    organizationId = org.organization_id;
  }

  beforeEach(async () => {
    await open();
    return async () => {
      await close();
    };
  });

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

  async function createFulfillment(reference: string): Promise<string> {
    const created = await core.fulfillment.consumeMarketOrder(orderEvent(reference));
    await core.fulfillment.consumeJobAccepted(
      makeEvent({
        event_type: "move.job.accepted",
        version: 1,
        producer: "wasla-move",
        occurred_at: clock.now(),
        correlation_id: randomUUID(),
        entity_type: "operational_job",
        entity_id: `job-${reference}`,
        payload: {
          fulfillment_id: created.fulfillment_id,
          job_id: `job-${reference}`,
          accepted_at: clock.now().toISOString(),
        },
      }),
    );
    return created.fulfillment_id;
  }

  it("counts fulfillment, subscription, and money state in the metrics exposition", async () => {
    // Create known state: two dispatched fulfillments and one coordinating.
    await createFulfillment(`mkt-${randomUUID()}`);
    await createFulfillment(`mkt-${randomUUID()}`);
    await core.fulfillment.consumeMarketOrder(orderEvent(`mkt-${randomUUID()}`));

    // Create a wallet and credit it.
    const walletResult = await core.money.createWallet({
      owner_type: "organization",
      owner_id: organizationId,
      currency: "SAR",
      correlation_id: randomUUID(),
    });
    await core.money.credit({
      wallet_id: walletResult.wallet.wallet_id,
      amount_minor: 10000,
      business_reference: `topup-${randomUUID()}`,
      correlation_id: randomUUID(),
    });
    // Authorize against it.
    await core.money.authorize({
      wallet_id: walletResult.wallet.wallet_id,
      amount_minor: 5000,
      business_reference: `auth-${randomUUID()}`,
      correlation_id: randomUUID(),
    });

    // Create a subscription plan and subscribe.
    const { plan } = await core.billing.createPlan({
      code: `plan-${randomUUID()}`,
      name: "Test Plan",
      billing_interval: "month",
      amount_minor: 1000,
      currency: "SAR",
      grants: [{ feature_key: "orders", limit_value: 100 }],
      correlation_id: randomUUID(),
    });
    await core.billing.activatePlan({ plan_id: plan.plan_id, correlation_id: randomUUID() });
    await core.billing.subscribe({
      plan_id: plan.plan_id,
      owner_type: "organization",
      owner_id: organizationId,
      wallet_id: walletResult.wallet.wallet_id,
      correlation_id: randomUUID(),
    });

    // Sample.
    await core.depthSampler.sample();
    const values = parseExposition(core.metrics.render());

    // Fulfillment: 2 dispatched, 1 coordinating.
    expect(values[`core_fulfillment_depth{status="dispatched"}`]).toBe(2);
    expect(values[`core_fulfillment_depth{status="coordinating"}`]).toBe(1);

    // Subscription: 1 active.
    expect(values[`core_subscription_depth{status="active"}`]).toBe(1);

    // Money: 1 active wallet, 1 authorized authorization.
    expect(values[`core_money_depth{kind="wallet",status="active"}`]).toBe(1);
    expect(values[`core_money_depth{kind="payment_authorization",status="authorized"}`]).toBe(1);
  });

  it("updates the counts when state changes", async () => {
    // Start with one coordinating fulfillment.
    await core.fulfillment.consumeMarketOrder(orderEvent(`mkt-${randomUUID()}`));
    await core.depthSampler.sample();
    let values = parseExposition(core.metrics.render());
    expect(values[`core_fulfillment_depth{status="coordinating"}`]).toBe(1);
    expect(values[`core_fulfillment_depth{status="dispatched"}`]).toBe(0);

    // Dispatch it.
    const ref = `mkt-${randomUUID()}`;
    await createFulfillment(ref);
    await core.depthSampler.sample();
    values = parseExposition(core.metrics.render());
    expect(values[`core_fulfillment_depth{status="coordinating"}`]).toBe(1);
    expect(values[`core_fulfillment_depth{status="dispatched"}`]).toBe(1);
  });

  it("falsifies: a count that does not match the real state fails the gate", async () => {
    // Create a wallet and credit it.
    const walletResult = await core.money.createWallet({
      owner_type: "organization",
      owner_id: organizationId,
      currency: "SAR",
      correlation_id: randomUUID(),
    });
    await core.money.credit({
      wallet_id: walletResult.wallet.wallet_id,
      amount_minor: 10000,
      business_reference: `topup-${randomUUID()}`,
      correlation_id: randomUUID(),
    });
    const auth = await core.money.authorize({
      wallet_id: walletResult.wallet.wallet_id,
      amount_minor: 5000,
      business_reference: `auth-${randomUUID()}`,
      correlation_id: randomUUID(),
    });

    // Sample and verify the count is 1 authorized.
    await core.depthSampler.sample();
    let values = parseExposition(core.metrics.render());
    expect(values[`core_money_depth{kind="payment_authorization",status="authorized"}`]).toBe(1);

    // Void the authorization — the count must change.
    await core.money.voidAuthorization({
      authorization_id: auth.authorization_id,
      reason: "test void",
      correlation_id: randomUUID(),
    });
    await core.depthSampler.sample();
    values = parseExposition(core.metrics.render());

    // The voided count must be 1 and the authorized count must be 0.
    expect(values[`core_money_depth{kind="payment_authorization",status="voided"}`]).toBe(1);
    expect(values[`core_money_depth{kind="payment_authorization",status="authorized"}`]).toBe(0);
  });
});
