/**
 * Event envelope declaration — milestone 42.
 *
 * `contracts/events/envelope.schema.json` is a published contract: it is the
 * wrapper every event carries — `event_id`, `event_type`, `version`,
 * `producer`, `occurred_at`, `correlation_id`, `causation_id`,
 * `entity_type`, `entity_id`, `payload`. The payload inside each event is
 * validated against its own schema by the event-payload-declaration gate
 * (milestone 40), but the envelope itself is not. A producer that adds a
 * field, changes a type, or uses a producer value outside the declared enum
 * can ship without anything noticing.
 *
 * This gate drives several core event types over the in-memory backend,
 * reads every emitted event from the outbox, and validates each full envelope
 * against the published contract: every required field present, no undeclared
 * field, every present field's type matches the declaration, and `producer`
 * is one of the declared enum values.
 *
 * Falsification, each applied to a conformed payload and restored: a required
 * field removed, an undeclared field added, and a field's type changed.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createCoreApp, type CoreApp } from "../src/app.js";
import { memoryPersistence } from "../src/platform/persistence/backends.js";
import { FixedClock } from "../src/platform/clock.js";
import { makeEvent } from "../src/platform/eventing/envelope.js";
import { seedCountry } from "./support/rows.js";
import {
  payloadErrors,
  schemaFor,
} from "./support/event-schemas.js";
import { randomUUID } from "node:crypto";

const START = new Date("2026-06-01T00:00:00.000Z");
const CORR = "envelope-gate";

/** A whole CORE with a funded tenant. */
async function makeCore(): Promise<{
  core: CoreApp;
  clock: FixedClock;
  organizationId: string;
  principalId: string;
  walletId: string;
}> {
  const clock = new FixedClock(START);
  const store = memoryPersistence(clock);
  const core = createCoreApp({ clock, persistence: store, rateLimit: false });

  await seedCountry(store);

  const registered = await core.identity.registerIdentity({
    channel_type: "web",
    external_id: "env-admin",
    correlation_id: CORR,
  });
  const principalId = registered.principal.principal_id;

  const organization = await core.organization.create({
    name: "Envelope Gate Org",
    country_code: "SA",
    correlation_id: CORR,
  });
  const organizationId = organization.organization_id;

  await core.identity.grantMembership({
    principal_id: principalId,
    organization_id: organizationId,
    roles: ["platform_admin"],
    correlation_id: CORR,
  });

  const walletResult = await core.money.createWallet({
    owner_type: "organization",
    owner_id: organizationId,
    currency: "SAR",
    correlation_id: CORR,
  });
  const walletId = walletResult.wallet.wallet_id;

  // Fund the wallet so authorize works.
  await core.money.credit({
    wallet_id: walletId,
    amount_minor: 100000,
    business_reference: "fund-envelope",
    correlation_id: CORR,
  });

  return { core, clock, organizationId, principalId, walletId };
}

/** Read every event in the outbox, grouped by type. */
async function emittedEvents(core: CoreApp): Promise<Map<string, unknown[]>> {
  const all = await core.outbox.all();
  const byType = new Map<string, unknown[]>();
  for (const row of all) {
    const eventType = row.event.event_type;
    if (!byType.has(eventType)) byType.set(eventType, []);
    byType.get(eventType)!.push(row.event);
  }
  return byType;
}

describe("event envelope declaration", () => {
  let core: CoreApp;
  let clock: FixedClock;
  let organizationId: string;
  let walletId: string;
  let emitted: Map<string, unknown[]>;

  beforeAll(async () => {
    const setup = await makeCore();
    core = setup.core;
    clock = setup.clock;
    organizationId = setup.organizationId;
    walletId = setup.walletId;

    // core.money.credited already emitted by the credit() in makeCore.
    // core.identity.verified already emitted by registerIdentity.

    // ── payment authorized ──
    await core.money.authorize({
      wallet_id: walletId,
      amount_minor: 5000,
      business_reference: "auth-envelope",
      correlation_id: CORR,
    });

    // ── fulfillment created ──
    const orderId = `order-${randomUUID().slice(0, 8)}`;
    await core.bus.publish(makeEvent({
      event_type: "market.order.created",
      version: 1,
      producer: "wasla-market",
      occurred_at: clock.now(),
      correlation_id: CORR,
      causation_id: null,
      entity_type: "commercial_order",
      entity_id: orderId,
      payload: { order_id: orderId, organization_id: organizationId, requested_service: "delivery" },
    }));

    // ── fulfillment dispatched + completed ──
    const events = await emittedEvents(core);
    const fulfillment = (events.get("core.fulfillment.created") ?? [])[0] as Record<string, unknown> | undefined;
    if (fulfillment) {
      const f = fulfillment.payload as Record<string, string>;
      const jobId = `job-${randomUUID().slice(0, 8)}`;
      await core.bus.publish(makeEvent({
        event_type: "move.job.accepted",
        version: 1,
        producer: "wasla-move",
        occurred_at: clock.now(),
        correlation_id: CORR,
        causation_id: null,
        entity_type: "operational_job",
        entity_id: jobId,
        payload: { fulfillment_id: f["fulfillment_id"], job_id: jobId, accepted_at: clock.now().toISOString() },
      }));
      await core.bus.publish(makeEvent({
        event_type: "move.job.completed",
        version: 1,
        producer: "wasla-move",
        occurred_at: clock.now(),
        correlation_id: CORR,
        causation_id: null,
        entity_type: "operational_job",
        entity_id: jobId,
        payload: { fulfillment_id: f["fulfillment_id"], job_id: jobId, outcome: "completed", completed_at: clock.now().toISOString() },
      }));
    }

    // Read all emitted events from the outbox.
    emitted = await emittedEvents(core);
  });

  it("emits at least one event", () => {
    expect(emitted.size, "no events were emitted").toBeGreaterThan(0);
  });

  it("every emitted envelope conforms to the published envelope contract", () => {
    for (const [eventType, events] of emitted) {
      for (const event of events) {
        const errors = payloadErrors("envelope", event as Record<string, unknown>);
        expect(errors, `${eventType}: ${errors.join("; ")}`).toHaveLength(0);
      }
    }
  });

  it("every envelope producer is in the declared enum", () => {
    const schema = schemaFor("envelope");
    const producerProp = (schema.properties as Record<string, Record<string, unknown>>)["producer"];
    const allowed = (producerProp?.enum as string[]) ?? [];
    expect(allowed.length, "envelope schema has no producer enum").toBeGreaterThan(0);
    for (const [, events] of emitted) {
      for (const event of events) {
        const e = event as Record<string, unknown>;
        const producer = e["producer"];
        if (typeof producer === "string") {
          expect(allowed, `${producer} is not in the declared enum`).toContain(producer);
        }
      }
    }
  });

  // ── falsification ──

  describe("falsification", () => {
    const schema = schemaFor("envelope");
    // The envelope schema's example is {}, so construct a conforming payload
    // from the schema's required fields and properties.
    const conforming: Record<string, unknown> = {
      event_id: "00000000-0000-0000-0000-000000000001",
      event_type: "core.test.event",
      version: 1,
      producer: "wasla-core",
      occurred_at: "2026-01-01T00:00:00.000Z",
      correlation_id: "corr-test",
      causation_id: null,
      entity_type: "test_entity",
      entity_id: "test-1",
      payload: { test: true },
    };

    it("catches a missing required field", () => {
      const mutated = { ...conforming };
      const requiredField = schema.required[0] ?? "event_id";
      delete mutated[requiredField];
      const errors = payloadErrors("envelope", mutated);
      expect(
        errors.some((e) => e.includes("missing required field")),
        `removing required field "${requiredField}" was not caught`,
      ).toBe(true);
    });

    it("catches an undeclared field", () => {
      const mutated = { ...conforming, undeclared_field: "should not be here" };
      const errors = payloadErrors("envelope", mutated);
      expect(
        errors.some((e) => e.includes("undeclared_field") && e.includes("does not declare")),
        "adding an undeclared field was not caught",
      ).toBe(true);
    });

    it("catches a wrong-typed field", () => {
      const props = schema.properties as Record<string, Record<string, unknown>>;
      const integerField = Object.entries(props).find(([, p]) => p.type === "integer");
      if (!integerField) return;
      const [field] = integerField;
      const mutated = { ...conforming, [field]: "not-an-integer" };
      const errors = payloadErrors("envelope", mutated);
      expect(
        errors.some((e) => e.includes(field) && e.includes("contract declares integer")),
        `changing "${field}" to a string was not caught`,
      ).toBe(true);
    });

    it("passes a conforming payload", () => {
      const errors = payloadErrors("envelope", conforming);
      expect(errors, errors.join("; ")).toHaveLength(0);
    });
  });
});
