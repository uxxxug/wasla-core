import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createCoreApp, type CoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { memoryPersistence, postgresPersistence } from "../src/platform/persistence/backends.js";
import type { Persistence } from "../src/platform/persistence/backends.js";
import { makeEvent } from "../src/platform/eventing/envelope.js";

/**
 * Until this milestone the only way an event could reach a CORE consumer was
 * the in-process bus. MARKET and MOVE are separate services, so nothing
 * outside CORE's own process could actually start the work CORE exists to
 * coordinate: the vertical slice was real but unreachable.
 *
 * These tests are about the edge itself — who may assert what, what "accepted"
 * is allowed to mean, and whether a redelivery costs anything.
 */

const url = process.env.DATABASE_URL;

interface Backend {
  name: string;
  open(): Promise<{ store: Persistence; close(): Promise<void> }>;
}

const backends: Backend[] = [
  {
    name: "in-memory",
    async open() {
      return { store: memoryPersistence(new FixedClock()), async close() {} };
    },
  },
];

if (url) {
  backends.push({
    name: "postgres",
    async open() {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: url, max: 8 });
      return {
        store: postgresPersistence(pool as never, new FixedClock()),
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
    `truncate membership, session, principal, identity_link, identity,
     organization, outbox, inbox, inbound_event, fulfillment, ledger_entry,
     ledger_transaction, payment_authorization, wallet, service_area,
     city, region, country, audit_entry restart identity cascade`,
  );
  await pool.end();
}

/** Provisions a service credential the way an operator would. */
async function serviceToken(
  core: CoreApp,
  serviceName: string,
  organizationId: string,
): Promise<string> {
  const registered = await core.identity.registerIdentity({
    channel_type: "partner_api",
    external_id: `${serviceName}-credential`,
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

function orderEvent(organizationId: string, reference: string, authorizationId?: string) {
  return makeEvent({
    event_type: "market.order.created",
    version: 1,
    producer: "wasla-market",
    occurred_at: new Date("2026-01-01T00:00:00.000Z"),
    correlation_id: randomUUID(),
    entity_type: "order",
    entity_id: reference,
    payload: {
      organization_id: organizationId,
      order_id: reference,
      requested_service: "delivery",
      ...(authorizationId ? { payment_authorization_id: authorizationId } : {}),
    },
  });
}

describe.each(backends)("event ingress on $name", (backend) => {
  let store: Persistence;
  let close: () => Promise<void>;
  let core: CoreApp;
  let clock: FixedClock;
  let organizationId: string;

  beforeEach(async () => {
    await truncate();
    const opened = await backend.open();
    store = opened.store;
    close = opened.close;
    clock = new FixedClock();
    core = createCoreApp({ clock, persistence: store });
    const org = await core.organization.create({
      name: "Ingress Co",
      country_code: "SA",
      correlation_id: randomUUID(),
    });
    organizationId = org.organization_id;
    return async () => {
      await close();
    };
  });

  it("accepts an event over HTTP, and answers before processing it", async () => {
    const token = await serviceToken(core, "wasla-market", organizationId);
    const reference = `mkt-${randomUUID()}`;

    const res = await core.router.handle({
      method: "POST",
      url: "/v1/events",
      body: orderEvent(organizationId, reference),
      headers: { authorization: `Bearer ${token}` },
    });

    // 202, not 200. CORE has taken durable responsibility for the event and
    // nothing more; claiming 200 would describe work that has not happened.
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ accepted: true, first_delivery: true });

    // Durable before the answer, and nothing consumed yet.
    const held = await store.inbound.byStatus("pending");
    expect(held).toHaveLength(1);
    expect(await core.fulfillment.findByOrderReference(reference)).toBeUndefined();

    // Only now does the event reach a consumer.
    expect(await core.dispatcher.drainOnce()).toMatchObject({ processed: 1, dead: 0 });
    const created = await core.fulfillment.findByOrderReference(reference);
    expect(created?.status).toBe("coordinating");
    expect(await store.inbound.byStatus("processed")).toHaveLength(1);
  });

  it("refuses a caller asserting another system's events", async () => {
    const token = await serviceToken(core, "wasla-move", organizationId);
    const res = await core.router.handle({
      method: "POST",
      url: "/v1/events",
      body: orderEvent(organizationId, `mkt-${randomUUID()}`),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(await store.inbound.all()).toHaveLength(0);
  });

  it("refuses an external caller trying to assert a core.* fact", async () => {
    const token = await serviceToken(core, "wasla-market", organizationId);
    // The dangerous case. Every consumer treats `core.*` as authoritative, so
    // an outside caller able to announce a capture that never happened could
    // move the whole system's belief about money.
    const forged = makeEvent({
      event_type: "core.payment.captured",
      version: 1,
      producer: "wasla-market",
      occurred_at: new Date("2026-01-01T00:00:00.000Z"),
      correlation_id: randomUUID(),
      entity_type: "payment_authorization",
      entity_id: randomUUID(),
      payload: { amount_minor: 999_999 },
    });
    const res = await core.router.handle({
      method: "POST",
      url: "/v1/events",
      body: forged,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(await store.inbound.all()).toHaveLength(0);
  });

  it("refuses an envelope whose producer contradicts the credential", async () => {
    const token = await serviceToken(core, "wasla-market", organizationId);
    const spoofed = {
      ...orderEvent(organizationId, `mkt-${randomUUID()}`),
      producer: "wasla-move",
    };
    const res = await core.router.handle({
      method: "POST",
      url: "/v1/events",
      body: spoofed,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it("refuses a human credential, however privileged", async () => {
    // A person holding `events.submit` still has no service_name, so there is
    // no prefix they are entitled to. Authorisation alone is not enough: the
    // question is not "may you submit" but "whose events are you".
    const person = await core.identity.registerIdentity({
      channel_type: "telegram",
      external_id: `tg-${randomUUID()}`,
      correlation_id: randomUUID(),
    });
    await core.identity.grantMembership({
      principal_id: person.principal.principal_id,
      organization_id: organizationId,
      roles: ["platform_admin"],
      correlation_id: randomUUID(),
    });
    const issued = await core.identity.issueSession({
      principal_id: person.principal.principal_id,
      channel_type: "telegram",
      correlation_id: randomUUID(),
    });
    const res = await core.router.handle({
      method: "POST",
      url: "/v1/events",
      body: orderEvent(organizationId, `mkt-${randomUUID()}`),
      headers: { authorization: `Bearer ${issued.token}` },
    });
    expect(res.status).toBe(403);
  });

  it("refuses an event type no consumer will ever pick up", async () => {
    const token = await serviceToken(core, "wasla-market", organizationId);
    const orphan = {
      ...orderEvent(organizationId, `mkt-${randomUUID()}`),
      event_type: "market.order.repriced",
    };
    const res = await core.router.handle({
      method: "POST",
      url: "/v1/events",
      body: orphan,
      headers: { authorization: `Bearer ${token}` },
    });
    // Refused, not parked. Accepting it would leave a row pending forever and
    // the producer would never learn that nothing will ever happen.
    expect(res.status).toBe(400);
    expect(await store.inbound.all()).toHaveLength(0);
  });

  it("refuses an envelope that is not an envelope", async () => {
    const token = await serviceToken(core, "wasla-market", organizationId);
    const res = await core.router.handle({
      method: "POST",
      url: "/v1/events",
      body: { event_type: "market.order.created" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  it("costs nothing when a producer redelivers after a timeout", async () => {
    const token = await serviceToken(core, "wasla-market", organizationId);
    const reference = `mkt-${randomUUID()}`;
    const event = orderEvent(organizationId, reference);
    const send = () =>
      core.router.handle({
        method: "POST",
        url: "/v1/events",
        body: event,
        headers: { authorization: `Bearer ${token}` },
      });

    const first = await send();
    expect(first.body).toMatchObject({ first_delivery: true });
    // The producer timed out waiting and sent it again.
    const second = await send();
    expect(second.status).toBe(202);
    // Still accepted — a retry is not an error — but explicitly not the first,
    // so a producer can tell the difference if it cares.
    expect(second.body).toMatchObject({ accepted: true, first_delivery: false });

    expect(await store.inbound.all()).toHaveLength(1);
    await core.dispatcher.drainOnce();
    // One accepted event, one fulfillment — the redelivery bought nothing.
    expect(await core.fulfillment.findByOrderReference(reference)).toBeDefined();
    expect(await store.fulfillment.all()).toHaveLength(1);
  });

  it("tells only one of two simultaneous redeliveries that it was first", async () => {
    const token = await serviceToken(core, "wasla-market", organizationId);
    const event = orderEvent(organizationId, `mkt-${randomUUID()}`);
    const send = () =>
      core.router.handle({
        method: "POST",
        url: "/v1/events",
        body: event,
        headers: { authorization: `Bearer ${token}` },
      });

    // Both in flight before either is awaited. A check-then-insert would tell
    // both callers they were first, which is the same shape of bug the money
    // store had before B-12.
    const [a, b] = await Promise.all([send(), send()]);
    const firsts = [a, b].filter(
      (r) => (r.body as { first_delivery?: boolean }).first_delivery === true,
    );
    expect(firsts).toHaveLength(1);
    expect(await store.inbound.all()).toHaveLength(1);
  });

  it("keeps the event and retries when a consumer fails, then succeeds", async () => {
    const token = await serviceToken(core, "wasla-market", organizationId);
    const reference = `mkt-${randomUUID()}`;

    // Fails often enough to exhaust the bus's own in-process attempts, so the
    // durable layer is the one that has to keep the event alive.
    let failures = 3;
    core.bus.subscribe("test.flaky", "market.order.created", async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("consumer is down");
      }
    });

    await core.router.handle({
      method: "POST",
      url: "/v1/events",
      body: orderEvent(organizationId, reference),
      headers: { authorization: `Bearer ${token}` },
    });

    const first = await core.dispatcher.drainOnce();
    expect(first).toMatchObject({ processed: 0, failed: 1, dead: 0 });
    expect(await store.inbound.byStatus("pending")).toHaveLength(1);

    // Backoff has to elapse before the row is due again — proof the retry is
    // scheduled rather than spun on.
    expect(await core.dispatcher.drainOnce()).toMatchObject({ processed: 0, failed: 0 });

    clock.advance(2_000);
    expect(await core.dispatcher.drainOnce()).toMatchObject({ processed: 1, dead: 0 });
    expect(await core.fulfillment.findByOrderReference(reference)).toBeDefined();
  });

  it("still refuses to do the work twice when a dispatch is replayed", async () => {
    const token = await serviceToken(core, "wasla-market", organizationId);
    const reference = `mkt-${randomUUID()}`;
    const event = orderEvent(organizationId, reference);
    await core.router.handle({
      method: "POST",
      url: "/v1/events",
      body: event,
      headers: { authorization: `Bearer ${token}` },
    });
    await core.dispatcher.drainOnce();
    expect(await store.fulfillment.all()).toHaveLength(1);

    // The dispatcher is at-least-once by construction: a crash between the
    // handler succeeding and `markProcessed` dispatches the event again. What
    // makes that safe is the consumer inbox, not the dispatcher — so the
    // replay is issued straight at the bus, which is what the dispatcher would
    // have done.
    await core.bus.publish(event);
    expect(await store.fulfillment.all()).toHaveLength(1);
    expect(core.bus.deadLetters).toHaveLength(0);
  });
});
