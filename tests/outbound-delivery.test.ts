import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createCoreApp, type CoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { memoryPersistence, postgresPersistence } from "../src/platform/persistence/backends.js";
import type { Persistence } from "../src/platform/persistence/backends.js";
import { makeEvent } from "../src/platform/eventing/envelope.js";
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  isRetryable,
  signBody,
  verifyBody,
  type EventTransport,
  type TransportRequest,
  type TransportResponse,
} from "../src/platform/eventing/delivery.js";

/**
 * Migration 0007 gave MARKET and MOVE a way into CORE. Until this milestone
 * there was no way out: a fulfillment could be created and dispatched and
 * nothing outside CORE's process would ever learn of it. The coordination loop
 * had an entrance and no exit.
 *
 * These tests are about what "delivered" is allowed to mean, and about the
 * failures that are worth repeating versus the ones that are not.
 */

const url = process.env.DATABASE_URL;
const SECRET = "a".repeat(40);

interface Backend {
  name: string;
  /**
   * The clock is the test's, not the backend's. It used to be a fresh
   * `FixedClock` per store, so the store and the app that polled it kept
   * separate notions of `now`: advancing the test clock moved the worker forward
   * and left the store behind. Nothing read the clock inside the store until
   * B-24 made `counts()` cut claimed rows at a point in time, at which point a
   * store on its own clock reports rows as being worked on for ever.
   */
  open(clock: FixedClock): Promise<{ store: Persistence; close(): Promise<void> }>;
}

const backends: Backend[] = [
  {
    name: "in-memory",
    async open(clock) {
      return { store: memoryPersistence(clock), async close() {} };
    },
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
  });
}

async function truncate(): Promise<void> {
  if (!url) return;
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url, max: 1 });
  await pool.query(
    `truncate event_delivery, event_subscription, membership, session, principal,
     identity_link, identity, organization, outbox, inbox, inbound_event,
     fulfillment, ledger_entry, ledger_transaction, payment_authorization,
     wallet, service_area, city, region, country, audit_entry
     restart identity cascade`,
  );
  await pool.end();
}

/**
 * Answers per endpoint rather than per call, because the order in which
 * simultaneously-due deliveries are attempted is deliberately unspecified —
 * see `docs/outbound-delivery.md`. A test keyed on call order would be
 * asserting an ordering CORE does not promise, and it would pass on one
 * backend and fail on the other. It did.
 */
class EndpointTransport implements EventTransport {
  readonly sent: TransportRequest[] = [];
  constructor(private readonly byUrl: Record<string, TransportResponse>) {}
  async send(request: TransportRequest): Promise<TransportResponse> {
    this.sent.push(request);
    return this.byUrl[request.url] ?? { status: 200 };
  }
}

/** Records every request and answers with a queue of scripted responses. */
class ScriptedTransport implements EventTransport {
  readonly sent: TransportRequest[] = [];
  constructor(private readonly script: TransportResponse[]) {}
  async send(request: TransportRequest): Promise<TransportResponse> {
    this.sent.push(request);
    return this.script.shift() ?? { status: 200 };
  }
}

describe("failure classification", () => {
  it("separates a receiver that is unwell from one that refused", () => {
    // The distinction is the point: repeating a rejected payload cannot change
    // the answer, so retrying only delays someone noticing.
    for (const status of [500, 502, 503, 429, 408, null]) {
      expect(isRetryable(status), `${status} should be retried`).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryable(status), `${status} should not be retried`).toBe(false);
    }
  });

  it("signs the exact bytes sent, so a receiver cannot verify its own parse", () => {
    const body = JSON.stringify({ a: 1, b: 2 });
    expect(verifyBody(SECRET, body, signBody(SECRET, body))).toBe(true);
    // Same fields, different bytes: a receiver that re-serialised before
    // verifying would accept this, which is why the signature is over the body.
    expect(verifyBody(SECRET, JSON.stringify({ b: 2, a: 1 }), signBody(SECRET, body))).toBe(false);
    expect(verifyBody("b".repeat(40), body, signBody(SECRET, body))).toBe(false);
  });
});

describe.each(backends)("outbound delivery on $name", (backend) => {
  let store: Persistence;
  let close: () => Promise<void>;
  let clock: FixedClock;

  const app = (transport: EventTransport): CoreApp =>
    createCoreApp({ clock, persistence: store, transport });

  beforeEach(async () => {
    await truncate();
    clock = new FixedClock();
    const opened = await backend.open(clock);
    store = opened.store;
    close = opened.close;
  });

  afterEach(async () => {
    await close();
  });

  const subscribe = async (core: CoreApp, subscriber = "wasla-move") =>
    core.subscriptions.register({
      subscriber,
      event_type: "core.fulfillment.created",
      endpoint_url: `https://${subscriber}.example.com/events`,
      signing_secret: SECRET,
    });

  const emit = async () => {
    const event = makeEvent({
      event_type: "core.fulfillment.created",
      version: 1,
      producer: "wasla-core",
      occurred_at: clock.now(),
      correlation_id: randomUUID(),
      entity_type: "fulfillment",
      entity_id: randomUUID(),
      payload: { organization_id: randomUUID() },
    });
    // The port requires a scope on purpose: an event is only ever appended in
    // the transaction that made the change it describes.
    await store.boundary.run((scope) => store.outbox.append(event, scope));
    return event;
  };

  it("never returns a signing secret on any read path", async () => {
    const core = app(new ScriptedTransport([]));
    const created = await subscribe(core);
    expect("signing_secret" in created).toBe(false);
    const listed = await core.subscriptions.list();
    expect(listed.every((s) => !("signing_secret" in s))).toBe(true);
    // But the store still holds it, because HMAC needs the plaintext.
    const stored = await store.delivery.findSubscription(
      "wasla-move",
      "core.fulfillment.created",
    );
    expect(stored?.signing_secret).toBe(SECRET);
  });

  it("refuses a subscription CORE must not honour", async () => {
    const core = app(new ScriptedTransport([]));
    // Subscribing to inbound traffic would hand one external system another's
    // events by configuration alone.
    await expect(
      core.subscriptions.register({
        subscriber: "wasla-move",
        event_type: "market.order.created",
        endpoint_url: "https://move.example.com/events",
        signing_secret: SECRET,
      }),
    ).rejects.toThrow(/only core/i);
    // Plain HTTP puts the payload on the wire in clear; the signature proves
    // origin, not confidentiality.
    await expect(
      core.subscriptions.register({
        subscriber: "wasla-move",
        event_type: "core.fulfillment.created",
        endpoint_url: "http://move.example.com/events",
        signing_secret: SECRET,
      }),
    ).rejects.toThrow(/https/);
    await expect(
      core.subscriptions.register({
        subscriber: "wasla-move",
        event_type: "core.fulfillment.created",
        endpoint_url: "https://move.example.com/events",
        signing_secret: "short",
      }),
    ).rejects.toThrow(/32/);
    expect(await core.subscriptions.list()).toHaveLength(0);
  });

  it("delivers a published event to every interested subscriber", async () => {
    const core = app(new ScriptedTransport([]));
    const move = await subscribe(core, "wasla-move");
    const market = await subscribe(core, "wasla-market");
    const event = await emit();

    await core.publisher.drainOnce();
    // Queued at relay time, one row per subscriber.
    const queued = await store.delivery.forEvent(event.event_id);
    expect(queued).toHaveLength(2);
    expect(queued.every((d) => d.status === "pending")).toBe(true);

    const result = await core.deliveries.drainOnce();
    expect(result).toEqual({
      delivered: 2,
      failed: 0,
      dead: 0,
      reclaimed: 0,
      reclaim_exhausted: 0,
      fenced: 0,
      suppressed: 0,
    });

    const after = await store.delivery.forEvent(event.event_id);
    expect(after.every((d) => d.status === "delivered")).toBe(true);
    expect(after.every((d) => d.delivered_at !== null)).toBe(true);
    expect(new Set(after.map((d) => d.subscription_id))).toEqual(
      new Set([move.subscription_id, market.subscription_id]),
    );
  });

  it("sends a verifiable signature and the id the receiver dedupes on", async () => {
    const transport = new ScriptedTransport([]);
    const core = app(transport);
    await subscribe(core);
    const event = await emit();

    await core.publisher.drainOnce();
    await core.deliveries.drainOnce();

    const sent = transport.sent[0];
    expect(sent).toBeDefined();
    expect(sent?.url).toBe("https://wasla-move.example.com/events");
    expect(sent?.headers[EVENT_ID_HEADER]).toBe(event.event_id);
    // Verify against the body actually transmitted, not a reconstruction.
    expect(verifyBody(SECRET, sent?.body ?? "", sent?.headers[SIGNATURE_HEADER] ?? "")).toBe(true);
    expect(JSON.parse(sent?.body ?? "{}").event_id).toBe(event.event_id);
  });

  it("does not queue a second delivery when the relay runs again", async () => {
    const core = app(new ScriptedTransport([{ status: 503 }]));
    await subscribe(core);
    const event = await emit();

    await core.publisher.drainOnce();
    // Re-running the fan-out is what a crash between queueing and marking
    // published would cause. It has to be free.
    const again = await store.delivery.queue(
      {
        delivery_id: randomUUID(),
        event_id: event.event_id,
        subscription_id: (await core.subscriptions.list())[0]?.subscription_id ?? "",
        status: "pending",
        attempts: 0,
        reclaims: 0,
        last_error: null,
        last_status: null,
        next_attempt_at: clock.now().toISOString(),
        created_at: clock.now().toISOString(),
        delivered_at: null,
        claimed_at: null,
        claim_token: null,
      },
      undefined,
    );
    expect(again, "a duplicate delivery was queued").toBe(false);
    expect(await store.delivery.forEvent(event.event_id)).toHaveLength(1);
  });

  it("retries a receiver that is unwell and backs off between attempts", async () => {
    const transport = new ScriptedTransport([{ status: 503 }, { status: 200 }]);
    const core = app(transport);
    await subscribe(core);
    const event = await emit();
    await core.publisher.drainOnce();

    expect(await core.deliveries.drainOnce()).toEqual({
      delivered: 0,
      failed: 1,
      dead: 0,
      reclaimed: 0,
      reclaim_exhausted: 0,
      fenced: 0,
      suppressed: 0,
    });
    const failed = (await store.delivery.forEvent(event.event_id))[0];
    expect(failed?.status).toBe("pending");
    expect(failed?.attempts).toBe(1);
    expect(failed?.last_status).toBe(503);
    expect(new Date(failed?.next_attempt_at ?? 0).getTime()).toBeGreaterThan(
      clock.now().getTime(),
    );

    // Still backing off: draining now must not attempt it again.
    expect(await core.deliveries.drainOnce()).toEqual({
      delivered: 0,
      failed: 0,
      dead: 0,
      reclaimed: 0,
      reclaim_exhausted: 0,
      fenced: 0,
      suppressed: 0,
    });
    expect(transport.sent).toHaveLength(1);

    clock.advance(2000);
    expect(await core.deliveries.drainOnce()).toEqual({
      delivered: 1,
      failed: 0,
      dead: 0,
      reclaimed: 0,
      reclaim_exhausted: 0,
      fenced: 0,
      suppressed: 0,
    });
    expect((await store.delivery.forEvent(event.event_id))[0]?.status).toBe("delivered");
  });

  it("recovers a delivery whose worker died, without confusing it with a backoff", async () => {
    // B-24. A delivery worker that dies mid-request leaves a row nobody will
    // acknowledge. Until `claimed_at` existed that row was indistinguishable from
    // one backing off after a 503: both pending, both with a `next_attempt_at` in
    // the future. So a partner outage and a crash-looping worker produced the
    // same numbers, and the only honest thing an operator could say was "some
    // deliveries are late".
    const transport = new ScriptedTransport([{ status: 200 }]);
    const core = app(transport);
    await subscribe(core);
    const event = await emit();
    await core.publisher.drainOnce();

    // The worker claims the delivery and dies. Nothing was sent.
    const claimed = await store.delivery.claimDue(clock.now(), 10, 30_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.claimed_at).not.toBeNull();
    expect(transport.sent).toHaveLength(0);

    // Inside the lease the row is neither available nor stuck.
    expect(await core.deliveries.drainOnce()).toEqual({
      delivered: 0,
      failed: 0,
      dead: 0,
      reclaimed: 0,
      reclaim_exhausted: 0,
      fenced: 0,
      suppressed: 0,
    });
    expect(await store.delivery.counts()).toMatchObject({ in_flight: 1, abandoned: 0 });

    // Once the lease runs out it is stuck, countably, and the next drain
    // recovers it and sends it.
    clock.advance(31_000);
    expect(await store.delivery.counts()).toMatchObject({ in_flight: 0, abandoned: 1 });
    expect(await core.deliveries.drainOnce()).toEqual({
      delivered: 1,
      failed: 0,
      dead: 0,
      reclaimed: 1,
      reclaim_exhausted: 0,
      fenced: 0,
      suppressed: 0,
    });
    expect(transport.sent).toHaveLength(1);

    const delivered = (await store.delivery.forEvent(event.event_id))[0];
    expect(delivered?.status).toBe("delivered");
    // One attempt, not two: the abandoned claim was never charged as one, so a
    // rolling restart cannot walk a healthy delivery to its attempt limit.
    expect(delivered?.attempts).toBe(1);
    expect(delivered?.claimed_at).toBeNull();
    // And `delivered_at` is the clock, not the lease it happened to be holding
    // — the memory backend used to stamp it from `next_attempt_at`, which after
    // B-22 put it one whole lease into the future, and only on that backend (B-12).
    expect(delivered?.delivered_at).toBe(clock.now().toISOString());
  });

  it("stops immediately when the receiver rejected the payload", async () => {
    const transport = new ScriptedTransport([{ status: 422 }]);
    const core = app(transport);
    await subscribe(core);
    const event = await emit();
    await core.publisher.drainOnce();

    expect(await core.deliveries.drainOnce()).toEqual({
      delivered: 0,
      failed: 0,
      dead: 1,
      reclaimed: 0,
      reclaim_exhausted: 0,
      fenced: 0,
      suppressed: 0,
    });
    const dead = (await store.delivery.forEvent(event.event_id))[0];
    expect(dead?.status).toBe("dead");
    expect(dead?.attempts).toBe(1);
    expect(dead?.last_status).toBe(422);

    // Dead means dead: no further attempt, whatever the clock says.
    clock.advance(3_600_000);
    await core.deliveries.drainOnce();
    expect(transport.sent).toHaveLength(1);
  });

  it("records a timeout as a failure with no status rather than a success", async () => {
    const transport = new ScriptedTransport([{ status: null, error: "no response within 5000ms" }]);
    const core = app(transport);
    await subscribe(core);
    const event = await emit();
    await core.publisher.drainOnce();

    expect(await core.deliveries.drainOnce()).toEqual({
      delivered: 0,
      failed: 1,
      dead: 0,
      reclaimed: 0,
      reclaim_exhausted: 0,
      fenced: 0,
      suppressed: 0,
    });
    const pending = (await store.delivery.forEvent(event.event_id))[0];
    expect(pending?.status).toBe("pending");
    expect(pending?.last_status).toBeNull();
    expect(pending?.last_error).toMatch(/no response/);
  });

  it("gives up after a bounded number of attempts and leaves the row visible", async () => {
    const transport = new ScriptedTransport(Array.from({ length: 12 }, () => ({ status: 500 })));
    const core = app(transport);
    await subscribe(core);
    const event = await emit();
    await core.publisher.drainOnce();

    for (let i = 0; i < 12; i += 1) {
      await core.deliveries.drainOnce();
      clock.advance(600_000);
    }
    const dead = (await store.delivery.forEvent(event.event_id))[0];
    expect(dead?.status).toBe("dead");
    expect(dead?.attempts).toBe(8);
    // An operator has to be able to find it without reading the logs.
    const undelivered = await core.subscriptions.undelivered();
    expect(undelivered.map((d) => d.delivery_id)).toContain(dead?.delivery_id);
  });

  it("does not queue work for a deactivated subscriber", async () => {
    const transport = new ScriptedTransport([]);
    const core = app(transport);
    const subscription = await subscribe(core);
    await core.subscriptions.setActive(subscription.subscription_id, false);

    const event = await emit();
    await core.publisher.drainOnce();
    expect(await store.delivery.forEvent(event.event_id)).toHaveLength(0);
    expect(await core.deliveries.drainOnce()).toEqual({
      delivered: 0,
      failed: 0,
      dead: 0,
      reclaimed: 0,
      reclaim_exhausted: 0,
      fenced: 0,
      suppressed: 0,
    });
    expect(transport.sent).toHaveLength(0);
  });

  it("stops sending work already queued when a subscriber is switched off", async () => {
    // The other half of the same intent, and the one that was missing (B-28).
    // Fan-out honoured `active`; the worker did not, so every delivery already
    // pending when the subscription was switched off was still claimed, signed and
    // POSTed. An operator switching off a compromised endpoint got "stop queueing
    // new work" when they asked for "stop sending".
    const transport = new ScriptedTransport([]);
    const core = app(transport);
    const subscription = await subscribe(core);
    const event = await emit();
    // Queued while the subscription was still active, which is the only way a row
    // for an inactive subscription can exist at all.
    await core.publisher.drainOnce();
    expect(await store.delivery.forEvent(event.event_id)).toHaveLength(1);

    await core.subscriptions.setActive(subscription.subscription_id, false);

    expect(await core.deliveries.drainOnce()).toEqual({
      delivered: 0,
      failed: 0,
      dead: 0,
      reclaimed: 0,
      reclaim_exhausted: 0,
      fenced: 0,
      // Counted apart from `dead`: that is a fact about the subscriber's answers,
      // this is a fact about a decision an operator took.
      suppressed: 1,
    });
    // The assertion that matters. Nothing left the building.
    expect(transport.sent).toHaveLength(0);

    const [row] = await store.delivery.forEvent(event.event_id);
    expect(row?.status).toBe("dead");
    // No attempt was made, so none is charged, and there is no response to record.
    // Charging one would inflate a later backoff and, because a revival preserves
    // `attempts` (B-27), could hand back a row already at `maxAttempts` without
    // anything ever having been sent.
    expect(row?.attempts).toBe(0);
    expect(row?.last_status).toBeNull();
    expect(row?.last_error).toMatch(/not active/);
    // And the claim is released, so the row is not left held by a worker that has
    // finished with it.
    expect(row?.claimed_at).toBeNull();
    expect(row?.claim_token).toBeNull();

    // Repeating the drain finds nothing: the row is terminal, not skipped-and-left,
    // so it is not re-claimed on every pass for ever.
    expect((await core.deliveries.drainOnce()).suppressed).toBe(0);
  });

  it("does not charge the suppression against an attempt already spent", async () => {
    // A subscriber that failed once and is then switched off mid-backoff. The point
    // is that `attempts` is exactly where the failure left it: the suppression adds
    // nothing, so what an operator later reads on the row is the number of times a
    // request was actually made.
    const transport = new ScriptedTransport([{ status: 503 }]);
    const core = app(transport);
    const subscription = await subscribe(core);
    await emit();
    await core.publisher.drainOnce();
    expect((await core.deliveries.drainOnce()).failed).toBe(1);
    expect(transport.sent).toHaveLength(1);

    await core.subscriptions.setActive(subscription.subscription_id, false);
    // Past the backoff, so the row is genuinely due and the suppression is what
    // stopped it rather than the schedule.
    clock.advance(60_000);

    expect((await core.deliveries.drainOnce()).suppressed).toBe(1);
    expect(transport.sent).toHaveLength(1);
    const dead = await store.delivery.byStatus("dead");
    expect(dead).toHaveLength(1);
    expect(dead[0]?.attempts).toBe(1);
    // `last_error` is replaced, because the last thing that happened to this row is
    // that CORE was told to stop — that is what an operator needs to read first.
    expect(dead[0]?.last_error).toMatch(/not active/);
    // `last_status` is not, so the evidence of the real attempt survives: the row
    // still says a receiver answered 503 once.
    expect(dead[0]?.last_status).toBe(503);
  });

  it("keeps a subscriber's outage from holding up another subscriber", async () => {
    // The reason delivery is per-subscription and not per-event.
    const transport = new EndpointTransport({
      "https://wasla-move.example.com/events": { status: 503 },
      "https://wasla-market.example.com/events": { status: 200 },
    });
    const core = app(transport);
    const move = await subscribe(core, "wasla-move");
    await subscribe(core, "wasla-market");
    const event = await emit();

    await core.publisher.drainOnce();
    expect(await core.deliveries.drainOnce()).toEqual({
      delivered: 1,
      failed: 1,
      dead: 0,
      reclaimed: 0,
      reclaim_exhausted: 0,
      fenced: 0,
      suppressed: 0,
    });

    const rows = await store.delivery.forEvent(event.event_id);
    const moveRow = rows.find((d) => d.subscription_id === move.subscription_id);
    const marketRow = rows.find((d) => d.subscription_id !== move.subscription_id);
    expect(moveRow?.status).toBe("pending");
    expect(marketRow?.status).toBe("delivered");
  });

  it("marks the outbox row published only if its deliveries were queued", async () => {
    // The two commit together, so a failure to queue must not leave an event
    // marked published that nobody will ever be sent.
    const core = app(new ScriptedTransport([]));
    await subscribe(core);
    const event = await emit();
    const broken = new Error("delivery store unavailable");
    const original = store.delivery.queue.bind(store.delivery);
    store.delivery.queue = async () => {
      throw broken;
    };
    try {
      await core.publisher.drainOnce();
    } finally {
      store.delivery.queue = original;
    }

    const record = await store.outbox.get(event.event_id);
    expect(record?.status, "the event was published with no deliveries queued").not.toBe(
      "published",
    );

    // And once the store is healthy again the relay completes both halves.
    clock.advance(60_000);
    await core.publisher.drainOnce();
    expect((await store.outbox.get(event.event_id))?.status).toBe("published");
    expect(await store.delivery.forEvent(event.event_id)).toHaveLength(1);
  });

  it("will not send a delivery whose subscription has gone", async () => {
    const transport = new ScriptedTransport([]);
    const core = app(transport);
    await subscribe(core);
    const event = await emit();
    await core.publisher.drainOnce();

    const originalGet = store.delivery.getSubscription.bind(store.delivery);
    store.delivery.getSubscription = async () => undefined;
    try {
      // No secret means no signature; sending unsigned would be worse than
      // not sending at all, and waiting cannot bring the subscription back.
      expect(await core.deliveries.drainOnce()).toEqual({
        delivered: 0,
        failed: 0,
        dead: 1,
        reclaimed: 0,
        reclaim_exhausted: 0,
        fenced: 0,
        suppressed: 0,
      });
    } finally {
      store.delivery.getSubscription = originalGet;
    }
    expect(transport.sent).toHaveLength(0);
    expect((await store.delivery.forEvent(event.event_id))[0]?.last_error).toMatch(/subscription/);
  });

  it("registers the same subscription twice without rotating its secret", async () => {
    const core = app(new ScriptedTransport([]));
    const first = await subscribe(core);
    const second = await core.subscriptions.register({
      subscriber: "wasla-move",
      event_type: "core.fulfillment.created",
      endpoint_url: "https://wasla-move.example.com/events",
      signing_secret: "c".repeat(40),
    });
    expect(second.subscription_id).toBe(first.subscription_id);
    // Silently rotating would break every in-flight delivery without anyone
    // asking for it. Rotation has to be a deliberate, separate act.
    const stored = await store.delivery.findSubscription(
      "wasla-move",
      "core.fulfillment.created",
    );
    expect(stored?.signing_secret).toBe(SECRET);
    expect(await core.subscriptions.list()).toHaveLength(1);
  });
});
