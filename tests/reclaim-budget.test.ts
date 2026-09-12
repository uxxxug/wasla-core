/**
 * B-25: an abandoned claim has to run out eventually.
 *
 * B-24 made an abandoned claim visible and recoverable, and deliberately did not
 * charge it against `attempts`: nobody watched that work fail, and charging it
 * would let five ordinary deploys dead-letter five healthy events at
 * `maxAttempts = 5`. The price of that decision was the only unbounded failure
 * mode left in these queues. A payload that kills whatever picks it up — an
 * out-of-memory on an oversized event, an infinite loop on a malformed field — was
 * claimed, killed, recovered, claimed again, for ever. Every pass rewrote
 * `last_error` and incremented `reclaimed`, so it was loud; nothing stopped it, so
 * it never reached the one state that summons a human.
 *
 * The fix is a second counter, not a second meaning for the first one: `reclaims`
 * counts abandonments, `attempts` counts observed failures, and each has its own
 * limit. These tests exist to hold both halves of that in place — the limit does
 * fire, and it fires without touching the retry budget of a row that has never
 * actually failed.
 *
 * Postgres cases are skipped without DATABASE_URL. They are the ones that matter
 * here: the decision is taken inside a single UPDATE, from a `reclaims` the same
 * statement increments, and only a real database can get that wrong.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FixedClock } from "../src/platform/clock.js";
import { makeEvent } from "../src/platform/eventing/envelope.js";
import type { EventEnvelope } from "../src/platform/eventing/envelope.js";
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
 * Three, the shipped default. Written here as a literal rather than imported from
 * the source: a test that reads the same constant as the code cannot notice the
 * constant changing, and the whole point of a budget is the number.
 */
const MAX_RECLAIMS = 3;
const LEASE_MS = 30_000;

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
    correlation_id: `corr-reclaim-${tag}`,
    entity_type: "fulfillment",
    entity_id: randomUUID(),
    payload: { fulfillment_id: randomUUID(), order_reference: `order-${tag}` },
  });
}

describe.each(backends)("reclaim budget on $name", (backend) => {
  it("dead-letters an outbox row once it has been abandoned past the budget", async () => {
    await backend.truncate();
    const clock = new FixedClock();
    const { store, close } = await backend.open(clock);
    try {
      const envelope = event("outbox-budget");
      await store.outbox.append(envelope, NO_SCOPE);

      // Each round is one worker death: claim the row, never acknowledge it, let
      // the lease run out, recover it. Exactly the shape of a crash loop on one
      // payload — and before B-25 this loop had no end.
      for (let round = 1; round <= MAX_RECLAIMS; round++) {
        const claimed = await store.outbox.claimDue(clock.now(), 10, LEASE_MS);
        expect(claimed).toHaveLength(1);
        clock.advance(LEASE_MS + 1);
        expect(await store.outbox.reclaimExpired(clock.now(), MAX_RECLAIMS)).toEqual({
          reclaimed: 1,
          dead: 0,
        });
        const record = await store.outbox.get(envelope.event_id);
        // Recovered, and the row says how many times: the budget is readable on
        // the row rather than inferred from a counter in a dashboard.
        expect(record?.status).toBe("pending");
        expect(record?.reclaims).toBe(round);
        expect(record?.last_error).toBe(`abandoned claim ${round} reclaimed after attempt 0`);
        // The retry budget is untouched throughout. This is the half of B-24 the
        // fix must not undo: three deploys have not consumed three of the five
        // attempts this event is entitled to.
        expect(record?.attempts).toBe(0);
      }

      // One more death. The budget allowed MAX_RECLAIMS recoveries, so this
      // abandonment is not recovered — it is the end of the row.
      const claimed = await store.outbox.claimDue(clock.now(), 10, LEASE_MS);
      expect(claimed).toHaveLength(1);
      clock.advance(LEASE_MS + 1);
      expect(await store.outbox.reclaimExpired(clock.now(), MAX_RECLAIMS)).toEqual({
        reclaimed: 0,
        dead: 1,
      });

      const dead = await store.outbox.get(envelope.event_id);
      expect(dead?.status).toBe("dead");
      expect(dead?.reclaims).toBe(MAX_RECLAIMS + 1);
      // The dead-letter explains itself. A terminal row with `attempts = 0` is
      // otherwise indistinguishable from a bug, and an operator reading it needs to
      // know the payload was never judged — nothing survived long enough to judge it.
      expect(dead?.last_error).toBe(
        `reclaim limit exceeded: abandoned ${MAX_RECLAIMS + 1} times after attempt 0`,
      );
      expect(dead?.attempts).toBe(0);
      expect(await store.outbox.byStatus("dead")).toHaveLength(1);

      // And it stays stopped: no claim, and nothing left to reclaim.
      expect(await store.outbox.claimDue(clock.now(), 10, LEASE_MS)).toEqual([]);
      expect(await store.outbox.reclaimExpired(clock.now(), MAX_RECLAIMS)).toEqual({
        reclaimed: 0,
        dead: 0,
      });
    } finally {
      await close();
    }
  });

  it("spends the two budgets separately: a real failure does not use up reclaims", async () => {
    await backend.truncate();
    const clock = new FixedClock();
    const { store, close } = await backend.open(clock);
    try {
      const envelope = event("outbox-two-budgets");
      await store.outbox.append(envelope, NO_SCOPE);

      // A genuine, observed failure: the bus rejected it. `attempts` moves.
      const held = await store.outbox.claimDue(clock.now(), 10, LEASE_MS);
      await store.outbox.markFailed(
        envelope.event_id,
        held[0]!.claim_token,
        "bus down",
        clock.now(),
      );
      let record = await store.outbox.get(envelope.event_id);
      expect(record?.attempts).toBe(1);
      expect(record?.reclaims).toBe(0);

      // Now a worker dies holding it. `reclaims` moves and `attempts` does not,
      // and the recovery message carries both so the two are never confused.
      await store.outbox.claimDue(clock.now(), 10, LEASE_MS);
      clock.advance(LEASE_MS + 1);
      expect(await store.outbox.reclaimExpired(clock.now(), MAX_RECLAIMS)).toEqual({
        reclaimed: 1,
        dead: 0,
      });
      record = await store.outbox.get(envelope.event_id);
      expect(record?.attempts).toBe(1);
      expect(record?.reclaims).toBe(1);
      expect(record?.last_error).toBe("abandoned claim 1 reclaimed after attempt 1");
      expect(record?.claimed_at).toBeNull();
    } finally {
      await close();
    }
  });

  it("dead-letters an abandoned inbound event, which is what replay can act on", async () => {
    await backend.truncate();
    const clock = new FixedClock();
    const { store, close } = await backend.open(clock);
    try {
      const envelope = event("inbound-budget");
      expect(await store.inbound.accept(envelope, NO_SCOPE)).toBe(true);

      for (let round = 1; round <= MAX_RECLAIMS; round++) {
        expect(await store.inbound.claimDue(clock.now(), 10, LEASE_MS)).toHaveLength(1);
        clock.advance(LEASE_MS + 1);
        expect(await store.inbound.reclaimExpired(clock.now(), MAX_RECLAIMS)).toEqual({
          reclaimed: 1,
          dead: 0,
        });
        expect((await store.inbound.get(envelope.event_id))?.reclaims).toBe(round);
      }

      await store.inbound.claimDue(clock.now(), 10, LEASE_MS);
      clock.advance(LEASE_MS + 1);
      expect(await store.inbound.reclaimExpired(clock.now(), MAX_RECLAIMS)).toEqual({
        reclaimed: 0,
        dead: 1,
      });

      const dead = await store.inbound.get(envelope.event_id);
      expect(dead?.status).toBe("dead");
      expect(dead?.attempts).toBe(0);
      expect(dead?.claimed_at).toBeNull();
      // `dead` is one of the two statuses the replay selector takes by default, so
      // for this queue the limit hands the event to an operator rather than
      // dropping it. That is not true of the other two queues, which have no
      // revival path at all — recorded as a blocker, not fixed here.
      expect((await store.inbound.byStatus("dead")).map((r) => r.event.event_id)).toEqual([
        envelope.event_id,
      ]);
    } finally {
      await close();
    }
  });

  it("dead-letters an abandoned delivery without inventing a subscriber response", async () => {
    await backend.truncate();
    const clock = new FixedClock();
    const { store, close } = await backend.open(clock);
    try {
      const envelope = event("delivery-budget");
      await store.outbox.append(envelope, NO_SCOPE);
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

      for (let round = 1; round <= MAX_RECLAIMS; round++) {
        expect(await store.delivery.claimDue(clock.now(), 10, LEASE_MS)).toHaveLength(1);
        clock.advance(LEASE_MS + 1);
        expect(await store.delivery.reclaimExpired(clock.now(), MAX_RECLAIMS)).toEqual({
          reclaimed: 1,
          dead: 0,
        });
      }

      await store.delivery.claimDue(clock.now(), 10, LEASE_MS);
      clock.advance(LEASE_MS + 1);
      expect(await store.delivery.reclaimExpired(clock.now(), MAX_RECLAIMS)).toEqual({
        reclaimed: 0,
        dead: 1,
      });

      const dead = (await store.delivery.byStatus("dead"))[0];
      expect(dead?.delivery_id).toBe(deliveryId);
      expect(dead?.reclaims).toBe(MAX_RECLAIMS + 1);
      expect(dead?.attempts).toBe(0);
      // No response was ever received — that is what an abandoned claim means — so
      // neither of the two fields that record one may be filled in. Writing a
      // status here would put a subscriber reply that never happened into the
      // delivery history.
      expect(dead?.last_status).toBeNull();
      expect(dead?.delivered_at).toBeNull();
    } finally {
      await close();
    }
  });

  it("reports an exhausted reclaim as a permanent failure, not as a recovery", async () => {
    await backend.truncate();
    const clock = new FixedClock();
    const { store, close } = await backend.open(clock);
    try {
      const registry = new MetricsRegistry();
      // The bus rejects every publish, so the row survives each drain and can be
      // abandoned again. `maxAttempts` is set absurdly high on purpose: this test is
      // about the reclaim budget running out, and a row that dead-lettered because
      // it ran out of *attempts* would prove nothing about it.
      const publish = vi.fn().mockRejectedValue(new Error("bus down"));
      const publisher = new OutboxPublisher(
        store.outbox,
        { publish, subscribe: vi.fn() } as never,
        clock,
        100,
        1000,
        undefined,
        undefined,
        workerMetrics(registry, "outbox_relay"),
        MAX_RECLAIMS,
      );

      const envelope = event("worker-budget");
      await store.outbox.append(envelope, NO_SCOPE);
      for (let round = 0; round <= MAX_RECLAIMS; round++) {
        // Past any backoff the previous round's failure imposed, so there is
        // something to claim; then a claim nobody acknowledges, and a lease that
        // runs out. One worker death per round.
        clock.advance(60_000);
        await store.outbox.claimDue(clock.now(), 10, LEASE_MS);
        clock.advance(LEASE_MS + 1);
        const result = await publisher.drainOnce();
        const last = round === MAX_RECLAIMS;
        // The two are never both non-zero for the same row, and never the same
        // number: a crash loop that is still recovering and one that has given up
        // are different operational situations.
        expect(result.reclaimed).toBe(last ? 0 : 1);
        expect(result.reclaim_exhausted).toBe(last ? 1 : 0);
        // `dead` stays zero throughout. The bus refused every publish, but
        // `maxAttempts` is 100, so nothing dead-lettered for running out of
        // attempts: the only terminal row here is the one the reclaim budget ended,
        // and it is reported on its own field.
        expect(result.dead).toBe(0);
      }
      // The row also failed for real in the rounds it survived, and those attempts
      // are on a different counter: three abandonments recovered, three publishes
      // refused, and neither number moved the other.
      const dead = await store.outbox.get(envelope.event_id);
      expect(dead?.status).toBe("dead");
      expect(dead?.reclaims).toBe(MAX_RECLAIMS + 1);
      expect(dead?.attempts).toBe(MAX_RECLAIMS);

      const exposition = registry.render();
      // MAX_RECLAIMS recoveries, then one permanent failure. `failed_permanent`
      // rather than a new outcome label, because the vocabulary already has a word
      // for "terminal, no worker will pick this up again".
      expect(exposition).toContain(
        `core_worker_outcomes_total{worker="outbox_relay",outcome="reclaimed"} ${MAX_RECLAIMS}`,
      );
      expect(exposition).toContain(
        'core_worker_outcomes_total{worker="outbox_relay",outcome="failed_permanent"} 1',
      );
    } finally {
      await close();
    }
  });
});
