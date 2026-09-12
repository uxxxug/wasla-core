/**
 * B-22: a claim has to be a write.
 *
 * Every background worker in CORE — the outbox relay, the inbound dispatcher,
 * the outbound delivery worker and now the notification dispatcher — polls for
 * due rows and does something external with them. Before this test existed,
 * three of those four claimed by *reading*:
 *
 *     select … where status = 'pending' and next_attempt_at <= now
 *     order by … limit … for update skip locked
 *
 * which looks like a queue claim and is not one. Sent as a single statement it
 * runs in its own implicit transaction, so the row locks are released the moment
 * it returns. Two workers polling at the same time therefore both receive the
 * same rows and both do the work: two signed POSTs to a partner's webhook, two
 * runs of the same inbound event, and — once notifications existed — the same
 * message to the same person twice.
 *
 * The in-memory doubles were worse: they filtered a `Map` and returned rows
 * without marking anything, so they could not fail this test either.
 *
 * `for update skip locked` was not wrong, it was incomplete. The fix keeps it
 * and adds the write the pattern requires: the claim moves `next_attempt_at` out
 * by a lease, inside the same statement, so a second worker's identical query
 * matches nothing. These tests issue both claims before awaiting either, because
 * sequential calls cannot tell a real claim from a read that happens to be fast.
 *
 * Postgres cases are skipped without DATABASE_URL, and are the ones that matter:
 * the memory doubles have no locks to get wrong.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FixedClock } from "../src/platform/clock.js";
import { makeEvent } from "../src/platform/eventing/envelope.js";
import type { EventEnvelope } from "../src/platform/eventing/envelope.js";
import { NO_SCOPE } from "../src/platform/persistence/transaction.js";
import {
  memoryPersistence,
  postgresPersistence,
  type Persistence,
} from "../src/platform/persistence/backends.js";

const url = process.env.DATABASE_URL;

/**
 * The reclaim budget these B-24 cases pass in. High enough that none of them
 * reaches it: they are about recovering an abandoned claim, and the limit itself
 * is exercised in `tests/reclaim-budget.test.ts` (B-25).
 */
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
      // More than one connection, deliberately: a single-connection pool would
      // serialise the two claims and hide the race this file is about.
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

function event(index: number): EventEnvelope {
  return makeEvent({
    event_type: "core.fulfillment.dispatched",
    version: 1,
    producer: "wasla-core",
    occurred_at: new Date("2026-01-01T00:00:00.000Z"),
    correlation_id: `corr-claim-${index}`,
    entity_type: "fulfillment",
    entity_id: randomUUID(),
    payload: { fulfillment_id: randomUUID(), order_reference: `order-${index}` },
  });
}

const ROWS = 5;

describe.each(backends)("worker claims on $name", (backend) => {
  it("gives the outbox relay's rows to one claimant, not both", async () => {
    await backend.truncate();
    const clock = new FixedClock();
    const { store, close } = await backend.open(clock);
    try {
      for (let i = 0; i < ROWS; i++) await store.outbox.append(event(i), NO_SCOPE);

      const [a, b] = await Promise.all([
        store.outbox.claimDue(clock.now(), ROWS, 30_000),
        store.outbox.claimDue(clock.now(), ROWS, 30_000),
      ]);
      const ids = (rows: { event: EventEnvelope }[]) => rows.map((r) => r.event.event_id);
      const overlap = ids(a).filter((id) => ids(b).includes(id));

      expect(overlap).toEqual([]);
      expect(a.length + b.length).toBe(ROWS);
      // And a third poll inside the lease sees nothing at all.
      expect(await store.outbox.claimDue(clock.now(), ROWS, 30_000)).toEqual([]);
    } finally {
      await close();
    }
  });

  it("returns an abandoned outbox claim when its lease expires, and counts it", async () => {
    await backend.truncate();
    const clock = new FixedClock();
    const { store, close } = await backend.open(clock);
    try {
      await store.outbox.append(event(0), NO_SCOPE);
      const claimed = await store.outbox.claimDue(clock.now(), ROWS, 30_000);
      expect(claimed).toHaveLength(1);
      // The claim is on the row, which is what B-24 added: until now the only
      // evidence a worker held this row was a `next_attempt_at` in the future,
      // which a scheduled retry looks exactly like.
      expect(claimed[0]!.claimed_at).not.toBeNull();

      // The worker died. Nothing marked it published or failed.
      clock.advance(29_000);
      expect(await store.outbox.claimDue(clock.now(), ROWS, 30_000)).toEqual([]);
      expect(await store.outbox.reclaimExpired(clock.now(), MAX_RECLAIMS)).toEqual({
        reclaimed: 0,
        dead: 0,
      });

      clock.advance(2_000);
      // The lease has run out. `claimDue` still refuses it — a claimed row is
      // not up for grabs, it is *owed a recovery* — and the recovery is the
      // countable event.
      expect(await store.outbox.claimDue(clock.now(), ROWS, 30_000)).toEqual([]);
      expect(await store.outbox.reclaimExpired(clock.now(), MAX_RECLAIMS)).toEqual({
        reclaimed: 1,
        dead: 0,
      });

      // No message is lost: the row is pending, unclaimed and due again.
      const reclaimed = await store.outbox.claimDue(clock.now(), ROWS, 30_000);
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]!.status).toBe("pending");
      // And `attempts` was not charged for an attempt nobody observed failing.
      expect(reclaimed[0]!.attempts).toBe(0);
    } finally {
      await close();
    }
  });

  it("releases the claim on every acknowledgement, so a finished row never looks held", async () => {
    // B-24. `claimed_at` is only meaningful while a worker holds the row. If an
    // acknowledgement left it set, a published row would be counted as in flight
    // for ever and `abandoned` would climb on a queue where nothing is wrong —
    // the alarm this column exists to justify would be permanently on.
    await backend.truncate();
    const clock = new FixedClock();
    const { store, close } = await backend.open(clock);
    try {
      for (let i = 0; i < 3; i++) await store.outbox.append(event(i), NO_SCOPE);
      const claimed = await store.outbox.claimDue(clock.now(), ROWS, 30_000);
      expect(claimed).toHaveLength(3);

      await store.outbox.markPublished(claimed[0]!.event.event_id);
      await store.outbox.markFailed(
        claimed[1]!.event.event_id,
        "transient",
        new Date(clock.now().getTime() + 60_000),
      );
      await store.outbox.markDead(claimed[2]!.event.event_id, "gave up");

      for (const row of claimed) {
        const after = await store.outbox.get(row.event.event_id);
        expect(after!.claimed_at, `${after!.status} still carries a claim`).toBeNull();
      }
      // Nothing is in flight and nothing is stuck: one published, one waiting on
      // a retry it asked for, one dead.
      expect(await store.outbox.counts()).toMatchObject({
        in_flight: 0,
        abandoned: 0,
        retrying: 1,
        published: 1,
        dead: 1,
      });
      // And after the failed row's backoff elapses it is claimable again, which
      // is the difference between a released claim and a lease that never ended.
      clock.advance(61_000);
      expect(await store.outbox.claimDue(clock.now(), ROWS, 30_000)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("gives an inbound event to one dispatcher, not both", async () => {
    await backend.truncate();
    const clock = new FixedClock();
    const { store, close } = await backend.open(clock);
    try {
      for (let i = 0; i < ROWS; i++) {
        await store.inbound.accept(
          makeEvent({
            event_type: "move.job.accepted",
            version: 1,
            producer: "wasla-move",
            occurred_at: clock.now(),
            correlation_id: `corr-in-${i}`,
            entity_type: "operational_job",
            entity_id: randomUUID(),
            payload: { job_id: randomUUID() },
          }),
        );
      }

      const [a, b] = await Promise.all([
        store.inbound.claimDue(clock.now(), ROWS, 30_000),
        store.inbound.claimDue(clock.now(), ROWS, 30_000),
      ]);
      const ids = (rows: { event: EventEnvelope }[]) => rows.map((r) => r.event.event_id);
      expect(ids(a).filter((id) => ids(b).includes(id))).toEqual([]);
      expect(a.length + b.length).toBe(ROWS);
    } finally {
      await close();
    }
  });

  it("gives an outbound delivery to one worker, not both", async () => {
    await backend.truncate();
    const clock = new FixedClock();
    const { store, close } = await backend.open(clock);
    try {
      const subscriptionId = `sub-${randomUUID()}`;
      await store.delivery.insertSubscription({
        subscription_id: subscriptionId,
        subscriber: "wasla-market",
        event_type: "core.fulfillment.dispatched",
        endpoint_url: "https://market.test/hooks/core",
        signing_secret: "shhh",
        active: true,
        created_at: clock.now().toISOString(),
      });
      for (let i = 0; i < ROWS; i++) {
        const envelope = event(i);
        await store.outbox.append(envelope, NO_SCOPE);
        await store.delivery.queue({
          delivery_id: `del-${randomUUID()}`,
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
        });
      }

      const [a, b] = await Promise.all([
        store.delivery.claimDue(clock.now(), ROWS, 30_000),
        store.delivery.claimDue(clock.now(), ROWS, 30_000),
      ]);
      const ids = (rows: { delivery_id: string }[]) => rows.map((r) => r.delivery_id);
      // This is the one with a partner on the other end: an overlap here is a
      // duplicate signed POST to somebody else's endpoint.
      expect(ids(a).filter((id) => ids(b).includes(id))).toEqual([]);
      expect(a.length + b.length).toBe(ROWS);
    } finally {
      await close();
    }
  });

  it("gives a notification to one dispatcher, and stamps a distinct fencing token", async () => {
    await backend.truncate();
    const clock = new FixedClock();
    const { store, close } = await backend.open(clock);
    try {
      const identityId = randomUUID();
      const recipientId = `rcpt-${randomUUID()}`;
      // A real identity row: on Postgres the recipient has a foreign key to it,
      // and a test that worked around the key would be testing a schema nobody
      // runs.
      await store.identity.insertIdentity(
        {
          identity_id: identityId,
          status: "active",
          canonical_identity_id: null,
          display_name: "claim test",
          created_at: clock.now().toISOString(),
          updated_at: clock.now().toISOString(),
          source_system: "test",
          legacy_id: null,
        },
        NO_SCOPE,
      );
      await store.notification.insertRecipient({
        recipient_id: recipientId,
        organization_id: null,
        event_type: "core.fulfillment.dispatched",
        identity_id: identityId,
        channel: "telegram",
        active: true,
        created_at: clock.now().toISOString(),
      });
      for (let i = 0; i < ROWS; i++) {
        const envelope = event(i);
        await store.outbox.append(envelope, NO_SCOPE);
        await store.notification.queue({
          notification_id: randomUUID(),
          event_id: envelope.event_id,
          recipient_id: recipientId,
          organization_id: null,
          channel: "telegram",
          address: "584213197",
          template: "fulfillment_dispatched",
          subject: "Your request is on its way",
          body: `Request order-${i} has been assigned and is now in progress.`,
          data: { reference: `order-${i}` },
          idempotency_key: `${envelope.event_id}:${recipientId}`,
          status: "pending",
          attempts: 0,
          last_error: null,
          provider_message_id: null,
          claim_token: null,
          claimed_at: null,
          next_attempt_at: clock.now().toISOString(),
          created_at: clock.now().toISOString(),
          accepted_at: null,
          delivered_at: null,
          failed_at: null,
        });
      }

      const [a, b] = await Promise.all([
        store.notification.claimDue(clock.now(), ROWS, 30_000),
        store.notification.claimDue(clock.now(), ROWS, 30_000),
      ]);
      const ids = [...a, ...b].map((n) => n.notification_id);
      expect(new Set(ids).size).toBe(ROWS);
      expect(ids).toHaveLength(ROWS);

      // Every claimed row carries a token, and no token crosses batches: that
      // is what makes a late acknowledgement from a stalled worker match
      // nothing instead of overwriting the attempt that replaced it. How the
      // five rows split between the two workers is not asserted — either split
      // is correct, and pinning it would be pinning the scheduler.
      const tokensA = new Set(a.map((n) => n.claim_token));
      const tokensB = new Set(b.map((n) => n.claim_token));
      for (const token of [...tokensA, ...tokensB]) expect(token).toBeTruthy();
      for (const token of tokensA) expect(tokensB.has(token)).toBe(false);
      for (const claimed of [...a, ...b]) {
        expect(claimed.status).toBe("processing");
        expect(claimed.attempts).toBe(1);
      }
    } finally {
      await close();
    }
  });
});

/**
 * Identity insert is skipped above, so this file never asserts on identity FKs.
 * It does assert the notification store refuses to hand the same row to two
 * claimants under real concurrency, which is the property the whole notification
 * module depends on and the one the previous claim shape did not have.
 */
