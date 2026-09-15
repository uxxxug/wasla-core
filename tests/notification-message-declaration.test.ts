/**
 * Notification message declaration — milestone 41.
 *
 * `contracts/notifications/notification-message.v1.schema.json` is a published
 * contract: it is the shape a channel adapter receives, and the shape a real
 * provider implementation is written against. The `NotificationMessage`
 * interface in `domain.ts` is hand-coded to match it, and the dispatcher
 * constructs a message from the stored row and hands it to the adapter. Nothing
 * validates that the message a real dispatch produces actually conforms to the
 * contract. A correct answer with no enforcement is a coincidence, not a
 * guarantee.
 *
 * This gate drives a notification through the fan-out and the dispatcher,
 * captures the `NotificationMessage` the adapter receives, and asserts it
 * satisfies the published contract: every required field present, no
 * undeclared field, and every present field's type matches the declaration.
 * No database: every message is produced over the in-memory backend.
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
import type { NotificationChannel, ChannelResult } from "../src/modules/notification/ports.js";
import type { NotificationMessage } from "../src/modules/notification/domain.js";
import {
  payloadErrors,
  schemaFor,
} from "./support/event-schemas.js";
import { randomUUID } from "node:crypto";

const START = new Date("2026-06-01T00:00:00.000Z");
const CORR = "notification-message-gate";

/** A channel adapter that records every message it receives. */
class CapturingChannel implements NotificationChannel {
  readonly channel = "telegram" as const;
  readonly sent: NotificationMessage[] = [];

  async send(message: NotificationMessage): Promise<ChannelResult> {
    this.sent.push(message);
    return { outcome: "delivered", provider_message_id: "test-1" };
  }
}

/** A whole CORE with a telegram recipient for fulfillment_dispatched. */
async function makeCore(channel: CapturingChannel): Promise<{
  core: CoreApp;
  clock: FixedClock;
  organizationId: string;
}> {
  const clock = new FixedClock(START);
  const store = memoryPersistence(clock);
  const core = createCoreApp({
    clock,
    persistence: store,
    rateLimit: false,
    channels: [channel],
  });

  await seedCountry(store);

  const organization = await core.organization.create({
    name: "Notification Gate Org",
    country_code: "SA",
    correlation_id: CORR,
  });
  const organizationId = organization.organization_id;

  // Register a Telegram identity — the address is the external_id.
  const { identity } = await core.identity.registerIdentity({
    channel_type: "telegram",
    external_id: "@test-user",
    correlation_id: CORR,
  });

  // Subscribe the identity to fulfillment_dispatched notifications.
  await core.notificationRecipients.register({
    organization_id: null,
    event_type: "core.fulfillment.dispatched",
    identity_id: identity.identity_id,
    channel: "telegram",
    correlation_id: CORR,
  });

  return { core, clock, organizationId };
}

describe("notification message declaration", () => {
  let channel: CapturingChannel;

  beforeAll(async () => {
    channel = new CapturingChannel();
    const { core, clock, organizationId } = await makeCore(channel);

    // Create a fulfillment by consuming a market order directly.
    const orderId = `order-${randomUUID().slice(0, 8)}`;
    const order = makeEvent({
      event_type: "market.order.created",
      version: 1,
      producer: "wasla-market",
      occurred_at: clock.now(),
      correlation_id: CORR,
      causation_id: null,
      entity_type: "order",
      entity_id: orderId,
      payload: {
        order_id: orderId,
        organization_id: organizationId,
        requested_service: "delivery",
        payment_authorization_id: null,
      },
    });
    const created = await core.fulfillment.consumeMarketOrder(order);

    // Dispatch the fulfillment by consuming a move.job.accepted.
    const jobId = `job-${randomUUID().slice(0, 8)}`;
    const accepted = makeEvent({
      event_type: "move.job.accepted",
      version: 1,
      producer: "wasla-move",
      occurred_at: clock.now(),
      correlation_id: CORR,
      causation_id: null,
      entity_type: "operational_job",
      entity_id: jobId,
      payload: {
        fulfillment_id: created.fulfillment_id,
        job_id: jobId,
        accepted_at: clock.now().toISOString(),
      },
    });
    await core.fulfillment.consumeJobAccepted(accepted);

    // Relay the outbox — this triggers the notification fan-out.
    await core.publisher.drainOnce();

    // Run the notification dispatcher to deliver the message.
    await core.notificationDispatcher.drainOnce();
  });

  it("produces at least one notification message", () => {
    expect(channel.sent.length, "no notification message was dispatched").toBeGreaterThan(0);
  });

  it("every dispatched message conforms to the published contract", () => {
    for (const message of channel.sent) {
      const errors = payloadErrors("notification-message", message as unknown as Record<string, unknown>);
      expect(errors, errors.join("; ")).toHaveLength(0);
    }
  });

  // ── falsification ──

  describe("falsification", () => {
    const schema = schemaFor("notification-message");
    const examples = schema.examples ?? [];
    const conformingPayload = (examples[0] as Record<string, unknown>) ?? {};

    it("catches a missing required field", () => {
      const mutated = { ...conformingPayload };
      const requiredField = schema.required[0] ?? "notification_id";
      delete mutated[requiredField];
      const errors = payloadErrors("notification-message", mutated);
      expect(
        errors.some((e) => e.includes("missing required field")),
        `removing required field "${requiredField}" was not caught`,
      ).toBe(true);
    });

    it("catches an undeclared field", () => {
      const mutated = { ...conformingPayload, undeclared_field: "should not be here" };
      const errors = payloadErrors("notification-message", mutated);
      expect(
        errors.some((e) => e.includes("undeclared_field") && e.includes("does not declare")),
        "adding an undeclared field was not caught",
      ).toBe(true);
    });

    it("catches a wrong-typed field", () => {
      const props = schema.properties as Record<string, Record<string, unknown>>;
      const integerField = Object.entries(props).find(
        ([, p]) => p.type === "integer",
      );
      if (!integerField) return;
      const [field] = integerField;
      const mutated = { ...conformingPayload, [field]: "not-an-integer" };
      const errors = payloadErrors("notification-message", mutated);
      expect(
        errors.some((e) => e.includes(field) && e.includes("contract declares integer")),
        `changing "${field}" to a string was not caught`,
      ).toBe(true);
    });

    it("passes a conforming payload", () => {
      const errors = payloadErrors("notification-message", conformingPayload);
      expect(errors, errors.join("; ")).toHaveLength(0);
    });
  });
});
