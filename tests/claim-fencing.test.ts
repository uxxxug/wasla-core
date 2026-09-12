/**
 * B-26: a claim has to stay exclusive for as long as it is held, not only at the
 * instant it is taken.
 *
 * B-22 made `claimDue` a write, so two workers polling together cannot both get the
 * same row. B-24 made an abandoned claim visible and recoverable. Together they left
 * one window open: a worker that stalls past its lease is reclaimed, the row is
 * claimed and finished by somebody else, and then the first worker wakes up and
 * acknowledges. Its statement names the row by id, so it applies — and the row ends
 * up describing the attempt that was abandoned rather than the one that happened. A
 * failure gets recorded as a success, or a live delivery's response code is
 * overwritten by a stale one.
 *
 * The fix is a token stamped on the row at claim time, cleared when the claim ends,
 * and carried back by every acknowledgement. These tests hold three things in place:
 * the stale acknowledgement is refused on all three queues, the refusal is reported
 * as `fenced` — an outcome the metrics catalogue has had since Milestone 8 and that
 * three of the four workers could not produce until now — and a fenced relay does
 * not leave its fan-out committed.
 *
 * They also pin the one deliberate hole: replay passes `UNFENCED`, because an
 * operator advancing a `dead` row holds no claim and must not be fenced out of it.
 *
 * Postgres cases are skipped without DATABASE_URL, and they are the ones that
 * matter: the fence is a predicate inside a single UPDATE, and only a real database
 * can get that wrong.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FixedClock } from "../src/platform/clock.js";
import { makeEvent } from "../src/platform/eventing/envelope.js";
import type { EventEnvelope } from "../src/platform/eventing/envelope.js";
import { DeliveryFanOut } from "../src/platform/eventing/delivery.js";
import { UNFENCED } from "../src/platform/eventing/fencing.js";
import { InboundDispatcher } from "../src/platform/eventing/dispatcher.js";
import { OutboxPublisher } from "../src/platform/eventing/publisher.js";
import { MetricsRegistry } from "../src/platform/observability/metrics.js";
import { workerMetrics } from "../src/platform/observability/worker-metrics.js";
import { NO_SCOPE } from "../src/platform/persistence/transaction.js";
import {
  memoryPersistence,
  postgresPersistence,
  type Persistence,
} from "../src/platform/persistence/backends.js";

const url = process.env.DATABASE_URL;

/**
 * Re-declared as literals rather than imported, so that changing a default in
 * `src/` fails these tests instead of silently moving them.
 */
const LEASE_MS = 30_000;
const MAX_RECLAIMS = 3;

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
      const pool = new Pool({ connectionString: url, max: 4 });
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
        await pool.query(
          `truncate notification, notification_recipient, event_delivery, event_subscription,
           inbound_event, outbox, inbox restart identity cascade`,
        );
      } finally {
        await pool.end();
      }
    },
  });
}

function event(tag: string): EventEnvelope {
  return makeEvent({
    event_type: "core.fulfillment.dispatched",
    version: 1,
    producer: "wasla-core",
    occurred_at: new Date("2026-01-01T00:00:00.000Z"),
    correlation_id: `corr-fence-${tag}`,
    entity_type: "fulfillment",
    entity_id: randomUUID(),
    payload: { fulfillment_id: randomUUID(), order_reference: `order-${tag}` },
  });
}

async function subscribe(store: Persistence, clock: FixedClock): Promise<string> {
  const subscriptionId = randomUUID();
  await store.delivery.insertSubscription({
    subscription_id: subscriptionId,
    subscriber: "wasla-market",
    event_type: "core.fulfillment.dispatched",
    endpoint_url: "https://market.test/hooks/core",
    signing_secret: "shhh",
    active: true,
    created_at: clock.now().toISOString(),
  });
  return subscriptionId;
}

describe.each(backends)("claim fencing on $name", (backend) => {
  it("refuses an outbox acknowledgement from a claim that was taken away", async () => {
    await backend.truncate();
    const clock = new FixedClock();
    const { store, close } = await backend.open(clock);
    try {
      const envelope = event("outbox-stale");
      await store.outbox.append(envelope, NO_SCOPE);

      // The first worker claims the row and keeps the token it was handed.
      const first = await store.outbox.claimDue(clock.now(), 10, LEASE_MS);
      expect(first).toHaveLength(1);
      const staleToken = first[0]!.claim_token;
      expect(staleToken).not.toBeNull();

      // It then stalls past its lease and the row is recovered.
      clock.advance(LEASE_MS + 1);
      expect(await store.outbox.reclaimExpired(clock.now(), MAX_RECLAIMS)).toEqual({
        reclaimed: 1,
        dead: 0,
      });

      // A second worker picks the row up and gets a different token. Different, not
      // merely present: a reused token would make the fence decorative.
      const second = await store.outbox.claimDue(clock.now(), 10, LEASE_MS);
      expect(second).toHaveLength(1);
      expect(second[0]!.claim_token).not.toBe(staleToken);

      // Now the stalled worker wakes up and reports the success it eventually had.
      // Before B-26 this applied: the row would have been marked published on the
      // strength of an attempt nobody was waiting for any more.
      expect(await store.outbox.markPublished(envelope.event_id, staleToken)).toBe(false);

      const record = await store.outbox.get(envelope.event_id);
      expect(record?.status).toBe("pending");
      // Still held by the second worker, with its token intact: a refused
      // acknowledgement must not release somebody else's claim either.
      expect(record?.claimed_at).not.toBeNull();
      expect(record?.claim_token).toBe(second[0]!.claim_token);

      // And the current holder is unaffected by any of it.
      expect(await store.outbox.markPublished(envelope.event_id, second[0]!.claim_token)).toBe(
        true,
      );
      expect((await store.outbox.get(envelope.event_id))?.status).toBe("published");
    } finally {
      await close();
    }
  });

  it("refuses a stale inbound acknowledgement and keeps the real failure visible", async () => {
    await backend.truncate();
    const clock = new FixedClock();
    const { store, close } = await backend.open(clock);
    try {
      const envelope = event("inbound-stale");
      expect(await store.inbound.accept(envelope, NO_SCOPE)).toBe(true);

      const first = await store.inbound.claimDue(clock.now(), 10, LEASE_MS);
      const staleToken = first[0]!.claim_token;
      clock.advance(LEASE_MS + 1);
      await store.inbound.reclaimExpired(clock.now(), MAX_RECLAIMS);

      const second = await store.inbound.claimDue(clock.now(), 10, LEASE_MS);
      // The current holder observes a real failure and records it.
      expect(
        await store.inbound.markFailed(
          envelope.event_id,
          second[0]!.claim_token,
          "handler rejected the payload",
          new Date(clock.now().getTime() + 60_000),
        ),
      ).toBe(true);

      // The stalled dispatcher's late success is the worst version of this defect:
      // it would have hidden an error an operator needs to see behind a `processed`
      // row, and the event would never be dispatched again.
      expect(await store.inbound.markProcessed(envelope.event_id, staleToken)).toBe(false);

      const record = await store.inbound.get(envelope.event_id);
      expect(record?.status).toBe("pending");
      expect(record?.last_error).toBe("handler rejected the payload");
      expect(record?.attempts).toBe(1);
    } finally {
      await close();
    }
  });

  it("refuses a stale delivery acknowledgement rather than overwriting the response", async () => {
    await backend.truncate();
    const clock = new FixedClock();
    const { store, close } = await backend.open(clock);
    try {
      const envelope = event("delivery-stale");
      await store.outbox.append(envelope, NO_SCOPE);
      const subscriptionId = await subscribe(store, clock);
      const deliveryId = randomUUID();
      await store.delivery.queue({
        delivery_id: deliveryId,
        event_id: envelope.event_id,
        subscription_id: subscriptionId,
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
      });

      const first = await store.delivery.claimDue(clock.now(), 10, LEASE_MS);
      const staleToken = first[0]!.claim_token;
      clock.advance(LEASE_MS + 1);
      await store.delivery.reclaimExpired(clock.now(), MAX_RECLAIMS);

      const second = await store.delivery.claimDue(clock.now(), 10, LEASE_MS);
      expect(
        await store.delivery.markDelivered(deliveryId, second[0]!.claim_token, 200),
      ).toBe(true);

      // The stalled worker's subscriber answered 500 long after its claim was gone.
      // Applying it would put a failure on a delivery that has already succeeded —
      // and would reopen a `delivered` row for retry.
      expect(
        await store.delivery.markFailed(
          deliveryId,
          staleToken,
          "endpoint responded 500",
          500,
          new Date(clock.now().getTime() + 60_000),
        ),
      ).toBe(false);

      const record = (await store.delivery.byStatus("delivered"))[0];
      expect(record?.delivery_id).toBe(deliveryId);
      expect(record?.last_status).toBe(200);
      expect(record?.last_error).toBeNull();
      expect(record?.attempts).toBe(1);
    } finally {
      await close();
    }
  });

  it("clears the token whenever a claim ends, on all three queues", async () => {
    await backend.truncate();
    const clock = new FixedClock();
    const { store, close } = await backend.open(clock);
    try {
      // The token's whole value depends on this: if recovery left it in place, the
      // worker that was reclaimed would still hold a matching token and the fence
      // would refuse nothing.
      const envelope = event("token-lifecycle");
      await store.outbox.append(envelope, NO_SCOPE);
      await store.inbound.accept(envelope, NO_SCOPE);

      expect((await store.outbox.claimDue(clock.now(), 10, LEASE_MS))[0]!.claim_token).not.toBeNull();
      expect(
        (await store.inbound.claimDue(clock.now(), 10, LEASE_MS))[0]!.claim_token,
      ).not.toBeNull();

      clock.advance(LEASE_MS + 1);
      await store.outbox.reclaimExpired(clock.now(), MAX_RECLAIMS);
      await store.inbound.reclaimExpired(clock.now(), MAX_RECLAIMS);

      expect((await store.outbox.get(envelope.event_id))?.claim_token).toBeNull();
      expect((await store.inbound.get(envelope.event_id))?.claim_token).toBeNull();

      // And an acknowledgement releases it too, so a row at rest never carries a
      // token that some later caller could match by accident.
      const claimed = await store.outbox.claimDue(clock.now(), 10, LEASE_MS);
      expect(await store.outbox.markDead(envelope.event_id, claimed[0]!.claim_token, "gave up")).toBe(
        true,
      );
      const dead = await store.outbox.get(envelope.event_id);
      expect(dead?.status).toBe("dead");
      expect(dead?.claim_token).toBeNull();
      expect(dead?.claimed_at).toBeNull();
    } finally {
      await close();
    }
  });

  it("reports a fenced dispatcher acknowledgement as fenced, not as a success", async () => {
    await backend.truncate();
    const clock = new FixedClock();
    const { store, close } = await backend.open(clock);
    try {
      const registry = new MetricsRegistry();
      const envelope = event("dispatcher-metric");
      await store.inbound.accept(envelope, NO_SCOPE);

      // The stall happens where a stall really happens: inside the work, between
      // the claim and the acknowledgement. The bus hands the event on successfully
      // and, while it is doing so, the lease runs out and recovery takes the row.
      const publish = vi.fn(async () => {
        clock.advance(LEASE_MS + 1);
        await store.inbound.reclaimExpired(clock.now(), MAX_RECLAIMS);
      });
      const dispatcher = new InboundDispatcher(
        store.inbound,
        { publish, subscribe: vi.fn() } as never,
        clock,
        5,
        1000,
        workerMetrics(registry, "inbound_dispatcher"),
        MAX_RECLAIMS,
      );

      const result = await dispatcher.drainOnce();
      expect(publish).toHaveBeenCalledTimes(1);
      expect(result.fenced).toBe(1);
      // Not counted as processed. That is the point: the count of processed events
      // has to mean events whose outcome was actually recorded.
      expect(result.processed).toBe(0);
      expect(result.failed).toBe(0);

      // The row is back in the pending pool for whoever holds it next, with its
      // retry budget untouched — nothing failed here, a worker was merely slow.
      const record = await store.inbound.get(envelope.event_id);
      expect(record?.status).toBe("pending");
      expect(record?.attempts).toBe(0);
      expect(record?.reclaims).toBe(1);

      // `fenced` has been in the metrics catalogue since Milestone 8 and no worker
      // but `notification` could emit it. This assertion is the whole reason B-26
      // was recorded as a blocker rather than a nicety.
      expect(registry.render()).toContain(
        'core_worker_outcomes_total{worker="inbound_dispatcher",outcome="fenced"} 1',
      );
    } finally {
      await close();
    }
  });

  it("rolls back the fan-out when the relay's acknowledgement is fenced", async () => {
    await backend.truncate();
    const clock = new FixedClock();
    const { store, close } = await backend.open(clock);
    try {
      const registry = new MetricsRegistry();
      const envelope = event("relay-fanout");
      await store.outbox.append(envelope, NO_SCOPE);
      await subscribe(store, clock);

      const publish = vi.fn(async () => {
        clock.advance(LEASE_MS + 1);
        await store.outbox.reclaimExpired(clock.now(), MAX_RECLAIMS);
      });
      const publisher = new OutboxPublisher(
        store.outbox,
        { publish, subscribe: vi.fn() } as never,
        clock,
        5,
        1000,
        new DeliveryFanOut(store.delivery, clock, () => randomUUID()),
        store.boundary,
        workerMetrics(registry, "outbox_relay"),
        MAX_RECLAIMS,
      );

      const result = await publisher.drainOnce();
      expect(result.fenced).toBe(1);
      expect(result.published).toBe(0);

      // The delivery rows were queued in the same transaction as the refused
      // acknowledgement, so they must not survive it. Committing them would leave
      // webhooks queued against a row that is still pending — and the next holder
      // of the claim will queue them again, so the subscriber would be sent the
      // event twice for one publish.
      expect(await store.delivery.byStatus("pending")).toHaveLength(0);

      // A fence is not a failed publish: no attempt charged, no backoff imposed.
      // Charging one would eventually dead-letter an event whose only problem is a
      // worker slower than its lease.
      const record = await store.outbox.get(envelope.event_id);
      expect(record?.status).toBe("pending");
      expect(record?.attempts).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.dead).toBe(0);

      expect(registry.render()).toContain(
        'core_worker_outcomes_total{worker="outbox_relay",outcome="fenced"} 1',
      );
    } finally {
      await close();
    }
  });

  it("lets an unfenced caller advance a row it never claimed", async () => {
    await backend.truncate();
    const clock = new FixedClock();
    const { store, close } = await backend.open(clock);
    try {
      // Replay's case. An operator rescuing a dead-lettered event holds no claim by
      // design, so a fence that applied to every caller would have broken the one
      // recovery path this queue has. `UNFENCED` is that exemption, named so every
      // use of it is findable in one search.
      const envelope = event("replay-unfenced");
      await store.inbound.accept(envelope, NO_SCOPE);
      const claimed = await store.inbound.claimDue(clock.now(), 10, LEASE_MS);
      expect(await store.inbound.markDead(envelope.event_id, claimed[0]!.claim_token, "defect")).toBe(
        true,
      );

      expect(await store.inbound.markProcessed(envelope.event_id, UNFENCED)).toBe(true);
      expect((await store.inbound.get(envelope.event_id))?.status).toBe("processed");
    } finally {
      await close();
    }
  });
});
