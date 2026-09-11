import { describe, expect, it } from "vitest";
import { createCoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { makeEvent } from "../src/platform/eventing/envelope.js";
import type { CoreApp } from "../src/app.js";
import type { EventEnvelope } from "../src/platform/eventing/envelope.js";

function order(core: CoreApp, orderId: string): EventEnvelope {
  return makeEvent({
    event_type: "market.order.created",
    version: 1,
    producer: "wasla-market",
    occurred_at: core.clock.now(),
    correlation_id: `corr-${orderId}`,
    entity_type: "commercial_order",
    entity_id: orderId,
    payload: { order_id: orderId, organization_id: "org-1", requested_service: "delivery" },
  });
}

function acceptance(core: CoreApp, fulfillmentId: string, jobId: string): EventEnvelope {
  return makeEvent({
    event_type: "move.job.accepted",
    version: 1,
    producer: "wasla-move",
    occurred_at: core.clock.now(),
    correlation_id: "corr-dispatch",
    entity_type: "operational_job",
    entity_id: jobId,
    payload: {
      fulfillment_id: fulfillmentId,
      job_id: jobId,
      accepted_at: core.clock.now().toISOString(),
    },
  });
}

function dispatched(core: CoreApp) {
  return core.outbox.all().filter((r) => r.event.event_type === "core.fulfillment.dispatched");
}

describe("fulfillment dispatch is an observable lifecycle transition", () => {
  it("publishes core.fulfillment.dispatched exactly once when MOVE accepts", async () => {
    const core = createCoreApp({ clock: new FixedClock() });
    const created = await core.fulfillment.consumeMarketOrder(order(core, "order-d1"));

    const accepted = acceptance(core, created.fulfillment_id, "job-1");
    await core.fulfillment.consumeJobAccepted(accepted);
    await core.fulfillment.consumeJobAccepted(accepted);

    const events = dispatched(core);
    expect(events).toHaveLength(1);
    expect(events[0]!.event.causation_id).toBe(accepted.event_id);
    expect(events[0]!.event.payload).toEqual({
      fulfillment_id: created.fulfillment_id,
      order_reference: "order-d1",
      job_reference: "job-1",
      dispatched_at: core.clock.now().toISOString(),
    });
    expect(core.fulfillment.require(created.fulfillment_id).status).toBe("dispatched");
  });

  it("keeps the MOVE job reference opaque in the dispatch event payload", async () => {
    const core = createCoreApp({ clock: new FixedClock() });
    const created = await core.fulfillment.consumeMarketOrder(order(core, "order-d2"));
    await core.fulfillment.consumeJobAccepted(acceptance(core, created.fulfillment_id, "job-2"));

    const payload = dispatched(core)[0]!.event.payload as Record<string, unknown>;
    for (const leaked of ["driver_id", "vehicle_id", "route", "items", "price"]) {
      expect(payload).not.toHaveProperty(leaked);
    }
  });

  it("refuses a second, different job for an already dispatched fulfillment", async () => {
    const core = createCoreApp({ clock: new FixedClock() });
    const created = await core.fulfillment.consumeMarketOrder(order(core, "order-d3"));
    await core.fulfillment.consumeJobAccepted(acceptance(core, created.fulfillment_id, "job-3"));

    await expect(
      core.fulfillment.consumeJobAccepted(acceptance(core, created.fulfillment_id, "job-4")),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(dispatched(core)).toHaveLength(1);
  });

  it("tolerates an acceptance that races a cancellation without dispatching", async () => {
    const core = createCoreApp({ clock: new FixedClock() });
    const created = await core.fulfillment.consumeMarketOrder(order(core, "order-d4"));
    await core.fulfillment.cancel({
      fulfillment_id: created.fulfillment_id,
      reason: "customer withdrew",
      correlation_id: "corr-cancel",
    });

    const late = acceptance(core, created.fulfillment_id, "job-5");
    const result = await core.fulfillment.consumeJobAccepted(late);
    // Idempotent on redelivery of the same late acceptance.
    await core.fulfillment.consumeJobAccepted(late);

    expect(result.status).toBe("cancelled");
    expect(result.move_job_reference).toBe("job-5");
    expect(dispatched(core)).toHaveLength(0);
  });

  it("still refuses an acceptance for a fulfillment that already completed", async () => {
    const core = createCoreApp({ clock: new FixedClock() });
    const created = await core.fulfillment.consumeMarketOrder(order(core, "order-d5"));
    await core.fulfillment.consumeJobAccepted(acceptance(core, created.fulfillment_id, "job-6"));
    await core.fulfillment.consumeMoveCompletion(
      makeEvent({
        event_type: "move.job.completed",
        version: 1,
        producer: "wasla-move",
        occurred_at: core.clock.now(),
        correlation_id: "corr-dispatch",
        entity_type: "operational_job",
        entity_id: "job-6",
        payload: {
          fulfillment_id: created.fulfillment_id,
          job_id: "job-6",
          outcome: "completed",
          completed_at: core.clock.now().toISOString(),
        },
      }),
    );

    await expect(
      core.fulfillment.consumeJobAccepted(acceptance(core, created.fulfillment_id, "job-7")),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
