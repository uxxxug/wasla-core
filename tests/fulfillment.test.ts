import { testId } from "./support/ids.js";
import { describe, expect, it } from "vitest";
import { coreWithTenants } from "./support/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { makeEvent } from "../src/platform/eventing/envelope.js";

describe("fulfillment coordination", () => {
  it("turns a MARKET order event into one opaque fulfillment request", async () => {
    const core = await coreWithTenants(new FixedClock(), [testId("org-1")]);
    const event = makeEvent({
      event_type: "market.order.created",
      version: 1,
      producer: "wasla-market",
      occurred_at: core.clock.now(),
      correlation_id: "corr-order-1",
      entity_type: "commercial_order",
      entity_id: "order-1",
      payload: { order_id: "order-1", organization_id: testId("org-1"), requested_service: "delivery" },
    });
    await core.bus.publish(event);
    await core.bus.publish(event);

    const created = (await core.outbox.all()).filter((record) => record.event.event_type === "core.fulfillment.created");
    expect(created).toHaveLength(1);
    expect(created[0]!.event.causation_id).toBe(event.event_id);
    expect(created[0]!.event.payload).not.toHaveProperty("items");
  });

  it("closes fulfillment from a MOVE completion and informs MARKET", async () => {
    const core = await coreWithTenants(new FixedClock(), [testId("org-1")]);
    const order = makeEvent({
      event_type: "market.order.created",
      version: 1,
      producer: "wasla-market",
      occurred_at: core.clock.now(),
      correlation_id: "corr-flow",
      entity_type: "commercial_order",
      entity_id: "order-2",
      payload: { order_id: "order-2", organization_id: testId("org-1"), requested_service: "delivery" },
    });
    await core.bus.publish(order);
    const created = (await core.outbox.all()).find((record) => record.event.event_type === "core.fulfillment.created");
    const fulfillmentId = created?.event.entity_id;
    expect(fulfillmentId).toBeDefined();
    if (!fulfillmentId) return;

    const completion = makeEvent({
      event_type: "move.job.completed",
      version: 1,
      producer: "wasla-move",
      occurred_at: core.clock.now(),
      correlation_id: "corr-flow",
      causation_id: created?.event.event_id,
      entity_type: "operational_job",
      entity_id: "job-9",
      payload: {
        fulfillment_id: fulfillmentId,
        job_id: "job-9",
        outcome: "completed",
        completed_at: core.clock.now().toISOString(),
      },
    });
    await core.bus.publish(completion);
    await core.bus.publish(completion);

    expect(await core.fulfillment.require(fulfillmentId)).toMatchObject({
      status: "completed",
      move_job_reference: "job-9",
    });
    expect(
      (await core.outbox.all()).filter((record) => record.event.event_type === "core.fulfillment.completed"),
    ).toHaveLength(1);
  });
});