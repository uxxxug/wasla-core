import { describe, expect, it, vi } from "vitest";
import { FixedClock } from "../src/platform/clock.js";
import { LocalEventBus } from "../src/platform/eventing/bus.js";
import { isValidEnvelope, makeEvent } from "../src/platform/eventing/envelope.js";
import { InMemoryInbox } from "../src/platform/eventing/inbox.js";
import { InMemoryOutbox } from "../src/platform/eventing/outbox.js";
import { OutboxPublisher } from "../src/platform/eventing/publisher.js";
import { withTransaction } from "../src/platform/eventing/unit-of-work.js";

function event(type = "core.test.happened", entityId = "e-1") {
  return makeEvent({
    event_type: type,
    version: 1,
    producer: "wasla-core",
    occurred_at: new Date("2026-01-01T00:00:00.000Z"),
    correlation_id: "corr-1",
    entity_type: "test",
    entity_id: entityId,
    payload: { ok: true },
  });
}

describe("event envelope", () => {
  it("carries every canonical field", () => {
    const e = event();
    expect(isValidEnvelope(e)).toBe(true);
    for (const key of [
      "event_id",
      "event_type",
      "version",
      "producer",
      "occurred_at",
      "correlation_id",
      "causation_id",
      "entity_type",
      "entity_id",
      "payload",
    ]) {
      expect(e).toHaveProperty(key);
    }
  });

  it("rejects a malformed envelope at the boundary", async () => {
    const bus = new LocalEventBus(new InMemoryInbox());
    // deliberately missing fields
    await expect(bus.publish({ event_type: "x" } as never)).rejects.toThrow(/invalid event envelope/);
  });
});

describe("unit of work", () => {
  it("does not append to the outbox when the transaction throws", async () => {
    const outbox = new InMemoryOutbox(new FixedClock());
    let applied = false;
    await expect(
      withTransaction(outbox, (uow) => {
        uow.stage(() => {
          applied = true;
        });
        uow.emit(event());
        throw new Error("domain rule violated");
      }),
    ).rejects.toThrow("domain rule violated");
    expect(applied).toBe(false);
    expect(outbox.all()).toHaveLength(0);
  });

  it("commits state and event together", async () => {
    const outbox = new InMemoryOutbox(new FixedClock());
    let applied = false;
    await withTransaction(outbox, (uow) => {
      uow.stage(() => {
        applied = true;
      });
      uow.emit(event());
    });
    expect(applied).toBe(true);
    expect(outbox.byStatus("pending")).toHaveLength(1);
  });
});

describe("outbox publisher", () => {
  it("publishes pending events and marks them published", async () => {
    const clock = new FixedClock();
    const outbox = new InMemoryOutbox(clock);
    const bus = new LocalEventBus(new InMemoryInbox());
    const received: string[] = [];
    bus.subscribe("test-consumer", "core.test.happened", (e) => {
      received.push(e.event_id);
    });
    outbox.append(event());

    const result = await new OutboxPublisher(outbox, bus, clock).drainOnce();
    expect(result.published).toBe(1);
    expect(received).toHaveLength(1);
    expect(outbox.byStatus("published")).toHaveLength(1);

    // A second drain must not re-publish.
    const second = await new OutboxPublisher(outbox, bus, clock).drainOnce();
    expect(second.published).toBe(0);
    expect(received).toHaveLength(1);
  });

  it("retries with backoff and dead-letters after max attempts", async () => {
    const clock = new FixedClock();
    const outbox = new InMemoryOutbox(clock);
    const bus = { publish: vi.fn().mockRejectedValue(new Error("bus down")), subscribe: vi.fn() };
    const publisher = new OutboxPublisher(outbox, bus as never, clock, 3, 1000);
    outbox.append(event());

    let last = await publisher.drainOnce();
    expect(last.failed).toBe(1);
    expect(outbox.byStatus("pending")).toHaveLength(1);

    clock.advance(1000);
    last = await publisher.drainOnce();
    expect(last.failed).toBe(1);

    clock.advance(2000);
    last = await publisher.drainOnce();
    expect(last.dead).toBe(1);
    expect(outbox.byStatus("dead")).toHaveLength(1);
  });

  it("does not retry before the backoff window elapses", async () => {
    const clock = new FixedClock();
    const outbox = new InMemoryOutbox(clock);
    const publish = vi.fn().mockRejectedValue(new Error("bus down"));
    const publisher = new OutboxPublisher(outbox, { publish } as never, clock, 5, 1000);
    outbox.append(event());
    await publisher.drainOnce();
    await publisher.drainOnce(); // still inside the backoff window
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe("consumer inbox / idempotency", () => {
  it("handles a duplicated event exactly once", async () => {
    const inbox = new InMemoryInbox();
    const bus = new LocalEventBus(inbox);
    let handled = 0;
    bus.subscribe("consumer-a", "core.test.happened", () => {
      handled += 1;
    });
    const e = event();
    await bus.publish(e);
    await bus.publish(e);
    await bus.publish(e);
    expect(handled).toBe(1);
  });

  it("delivers the same event to independent consumers", async () => {
    const bus = new LocalEventBus(new InMemoryInbox());
    const seen: string[] = [];
    bus.subscribe("consumer-a", "core.test.happened", () => void seen.push("a"));
    bus.subscribe("consumer-b", "core.test.happened", () => void seen.push("b"));
    await bus.publish(event());
    expect(seen.sort()).toEqual(["a", "b"]);
  });

  it("tolerates out-of-order delivery without losing events", async () => {
    const bus = new LocalEventBus(new InMemoryInbox());
    const order: string[] = [];
    bus.subscribe("consumer-a", "core.test.happened", (e) => void order.push(e.entity_id));
    const e1 = event("core.test.happened", "e-1");
    const e2 = event("core.test.happened", "e-2");
    await bus.publish(e2);
    await bus.publish(e1);
    expect(order).toEqual(["e-2", "e-1"]);
  });

  it("retries a failing handler and dead-letters it after max attempts", async () => {
    const bus = new LocalEventBus(new InMemoryInbox(), 3);
    const handler = vi.fn().mockRejectedValue(new Error("handler exploded"));
    bus.subscribe("flaky", "core.test.happened", handler);
    await bus.publish(event());
    expect(handler).toHaveBeenCalledTimes(3);
    expect(bus.deadLetters).toHaveLength(1);
    expect(bus.deadLetters[0]!.consumer).toBe("flaky");
  });

  it("succeeds on a retry after a transient failure", async () => {
    const bus = new LocalEventBus(new InMemoryInbox(), 3);
    let calls = 0;
    bus.subscribe("recovering", "core.test.happened", () => {
      calls += 1;
      if (calls < 2) throw new Error("transient");
    });
    await bus.publish(event());
    expect(calls).toBe(2);
    expect(bus.deadLetters).toHaveLength(0);
  });
});
