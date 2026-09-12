/**
 * Milestone 4: a committed CORE state change reaching a person, on both backends.
 *
 * The property under test is not "a dispatcher exists". It is the whole path,
 * end to end, with the failures that path will actually meet:
 *
 *   state change → transactional outbox → fan-out inside the publish
 *   transaction → lease claim → channel attempt → accepted / retry / permanent
 *   failure → observable final state
 *
 * and the four things that are easy to claim and hard to hold: no notification
 * without committed state, no lost notification after committed state, no
 * duplicate from a redelivery or a race, and the same answers from the in-memory
 * backend as from Postgres.
 *
 * Postgres tests are skipped without DATABASE_URL. Everything asserted here is
 * asserted identically against both backends, because a memory double that is
 * more permissive than the database certifies bugs (B-12).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCoreApp, type CoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { makeEvent } from "../src/platform/eventing/envelope.js";
import type { EventEnvelope } from "../src/platform/eventing/envelope.js";
import {
  memoryPersistence,
  postgresPersistence,
  type Persistence,
} from "../src/platform/persistence/backends.js";
import {
  RECEIVABLE_CHANNELS,
  renderMessage,
  notifiableTemplate,
} from "../src/modules/notification/domain.js";
import { CHANNEL_TYPES } from "../src/modules/identity-access/domain.js";
import {
  NotificationDispatcher,
  NotificationFanOut,
  sanitiseChannelError,
} from "../src/modules/notification/service.js";
import {
  AlwaysRetryableChannel,
  CrashAfterSendChannel,
  FlakyChannel,
  GatedChannel,
  IdempotentChannel,
  LeakyChannel,
  RecordingChannel,
  RejectingChannel,
  ThrowingChannel,
} from "./support/channel-adapters.js";
import type { NotificationChannel } from "../src/modules/notification/ports.js";

const url = process.env.DATABASE_URL;

/** Built from parts so the governance secret scan stays strict. */
const FAKE_KEY = ["sk", "live", "1234567890"].join("_");

const TABLES = `notification, notification_recipient, membership, session, principal,
  identity_link, identity, fulfillment, ledger_entry, ledger_transaction,
  payment_authorization, wallet, usage_record, subscription_period, subscription,
  plan_grant, plan, event_delivery, event_subscription, inbound_event,
  organization, outbox, inbox, idempotency_key, audit_entry`;

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
      const pool = new Pool({ connectionString: url, max: 12 });
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
        await pool.query(`truncate ${TABLES} restart identity cascade`);
      } finally {
        await pool.end();
      }
    },
  });
}

/** One app, one clock, one set of channel adapters, on the given backend. */
async function harness(backend: Backend, channels: readonly NotificationChannel[]) {
  await backend.truncate();
  const clock = new FixedClock();
  const { store, close } = await backend.open(clock);
  const core = createCoreApp({ clock, persistence: store, channels });
  const organization = await core.organization.create({
    name: "Notify Co",
    country_code: "SA",
    correlation_id: "corr-notify-setup",
  });
  return { core, clock, store, close, organizationId: organization.organization_id };
}

/**
 * A recipient CORE can actually reach: an identity registered through its
 * Telegram channel link, which `registerIdentity` marks verified.
 */
async function telegramRecipient(
  core: CoreApp,
  eventType: string,
  externalId = `tg-${randomUUID()}`,
) {
  const { identity } = await core.identity.registerIdentity({
    channel_type: "telegram",
    external_id: externalId,
    correlation_id: "corr-recipient",
  });
  const recipient = await core.notificationRecipients.register({
    organization_id: null,
    event_type: eventType,
    identity_id: identity.identity_id,
    channel: "telegram",
    correlation_id: "corr-recipient",
  });
  return { identity, recipient, address: externalId };
}

function marketOrder(core: CoreApp, organizationId: string, orderId: string): EventEnvelope {
  return makeEvent({
    event_type: "market.order.created",
    version: 1,
    producer: "wasla-market",
    occurred_at: core.clock.now(),
    correlation_id: `corr-${orderId}`,
    entity_type: "commercial_order",
    entity_id: orderId,
    payload: { order_id: orderId, organization_id: organizationId, requested_service: "delivery" },
  });
}

function jobAccepted(core: CoreApp, fulfillmentId: string, jobId: string): EventEnvelope {
  return makeEvent({
    event_type: "move.job.accepted",
    version: 1,
    producer: "wasla-move",
    occurred_at: core.clock.now(),
    correlation_id: "corr-dispatch",
    entity_type: "operational_job",
    entity_id: jobId,
    payload: { fulfillment_id: fulfillmentId, job_id: jobId, accepted_at: core.clock.now().toISOString() },
  });
}

/**
 * Takes a fulfillment to `dispatched`, which emits `core.fulfillment.dispatched`
 * — a real committed state change, not a hand-written outbox row. Then relays,
 * which is where the fan-out happens.
 */
async function dispatchAndRelay(core: CoreApp, organizationId: string, orderId: string) {
  const created = await core.fulfillment.consumeMarketOrder(marketOrder(core, organizationId, orderId));
  await core.fulfillment.consumeJobAccepted(jobAccepted(core, created.fulfillment_id, `job-${orderId}`));
  await core.publisher.drainOnce();
  const events = (await core.outbox.all()).filter(
    (r) => r.event.event_type === "core.fulfillment.dispatched",
  );
  return { fulfillment: created, event: events[events.length - 1]!.event };
}

/**
 * The same state change, with the relay suppressed: used where a test needs to
 * run the fan-out itself rather than have the publisher do it.
 */
async function dispatchAndRelayWithout(core: CoreApp, organizationId: string, orderId: string) {
  const created = await core.fulfillment.consumeMarketOrder(marketOrder(core, organizationId, orderId));
  await core.fulfillment.consumeJobAccepted(jobAccepted(core, created.fulfillment_id, `job-${orderId}`));
  return { fulfillment: created };
}

describe.each(backends)("notifications on $name", (backend) => {
  it("turns one committed event into exactly one notification per recipient", async () => {
    const channel = new RecordingChannel();
    const { core, close, organizationId } = await harness(backend, [channel]);
    try {
      const { address } = await telegramRecipient(core, "core.fulfillment.dispatched");
      const { event } = await dispatchAndRelay(core, organizationId, `order-${randomUUID()}`);

      const queued = await core.notifications.forEvent(event.event_id);
      expect(queued).toHaveLength(1);
      expect(queued[0]!.status).toBe("pending");
      expect(queued[0]!.channel).toBe("telegram");
      expect(queued[0]!.address).toBe(address);
      // Rendered from named fields, not from a dump of the row.
      expect(queued[0]!.body).toContain(" has been assigned and is now in progress.");
      expect(queued[0]!.body).not.toContain("fulfillment_id");

      const result = await core.notificationDispatcher.drainOnce();
      expect(result).toMatchObject({ accepted: 1, delivered: 0, retrying: 0, failed: 0, fenced: 0 });
      expect(channel.sent).toHaveLength(1);
      expect(channel.sent[0]!.message.idempotency_key).toBe(`${event.event_id}:${queued[0]!.recipient_id}`);
      expect(channel.sent[0]!.message.attempt).toBe(1);

      const after = (await core.notifications.forEvent(event.event_id))[0]!;
      expect(after.status).toBe("accepted");
      expect(after.accepted_at).not.toBeNull();
      // `accepted` is not `delivered`: no provider said it arrived (D-8).
      expect(after.delivered_at).toBeNull();

      // Draining again sends nothing: the row is no longer claimable.
      expect(await core.notificationDispatcher.drainOnce()).toMatchObject({ accepted: 0, retrying: 0 });
      expect(channel.sent).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("does not notify twice when the same outbox event is relayed again", async () => {
    const channel = new RecordingChannel();
    const { core, close, organizationId } = await harness(backend, [channel]);
    try {
      await telegramRecipient(core, "core.fulfillment.dispatched");
      const { event } = await dispatchAndRelay(core, organizationId, `order-${randomUUID()}`);

      // A relay that runs the fan-out again for an already-published event: the
      // duplicate-delivery case, which happens whenever a relay crashes between
      // sending and marking published.
      await core.notificationFanOut.queueFor(event);
      await core.notificationFanOut.queueFor(event);

      expect(await core.notifications.forEvent(event.event_id)).toHaveLength(1);
      await core.notificationDispatcher.drainOnce();
      expect(channel.sent).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("produces no notification for state that was never committed", async () => {
    const channel = new RecordingChannel();
    const { core, close, organizationId } = await harness(backend, [channel]);
    try {
      await telegramRecipient(core, "core.fulfillment.dispatched");
      const created = await core.fulfillment.consumeMarketOrder(
        marketOrder(core, organizationId, `order-${randomUUID()}`),
      );
      // A dispatch that is refused: no state change, so no outbox row and
      // therefore nothing for the fan-out to see. The orphan-notification case.
      await core.fulfillment.consumeJobAccepted(jobAccepted(core, created.fulfillment_id, "job-a"));
      await expect(
        core.fulfillment.consumeJobAccepted(jobAccepted(core, created.fulfillment_id, "job-b")),
      ).rejects.toMatchObject({ code: "conflict" });
      await core.publisher.drainOnce();

      // Exactly one notification: the dispatch that committed. None for the
      // refused one.
      const all = await core.notifications.list({});
      expect(all).toHaveLength(1);
      expect(all[0]!.body).toContain("in progress");
    } finally {
      await close();
    }
  });

  it("retries a retryable failure on the schedule and then succeeds", async () => {
    const channel = new FlakyChannel("telegram", 2);
    const { core, clock, close, organizationId } = await harness(backend, [channel]);
    try {
      await telegramRecipient(core, "core.fulfillment.dispatched");
      const { event } = await dispatchAndRelay(core, organizationId, `order-${randomUUID()}`);

      expect(await core.notificationDispatcher.drainOnce()).toMatchObject({ retrying: 1 });
      const first = (await core.notifications.forEvent(event.event_id))[0]!;
      expect(first.status).toBe("pending");
      expect(first.attempts).toBe(1);
      expect(first.retrying).toBe(true);
      expect(first.last_error).toBe("provider_unavailable");

      // Still inside the backoff: nothing is claimed, and the adapter is not
      // called again. Without this the "retry" would be a hot loop.
      expect(await core.notificationDispatcher.drainOnce()).toMatchObject({ retrying: 0, accepted: 0 });
      expect(channel.attempts).toBe(1);

      clock.advance(1_000);
      expect(await core.notificationDispatcher.drainOnce()).toMatchObject({ retrying: 1 });
      clock.advance(2_000);
      expect(await core.notificationDispatcher.drainOnce()).toMatchObject({ accepted: 1 });

      expect(channel.attempts).toBe(3);
      // The attempt number the adapter saw counted up, and never repeated.
      expect(channel.seenAttemptNumbers).toEqual([1, 2, 3]);
      const done = (await core.notifications.forEvent(event.event_id))[0]!;
      expect(done.status).toBe("accepted");
      expect(done.attempts).toBe(3);
      expect(done.provider_message_id).toBe("flaky-3");
    } finally {
      await close();
    }
  });

  it("honours a provider's retry_after over its own backoff", async () => {
    const channel = new FlakyChannel("telegram", 1, 5_000);
    const { core, clock, close, organizationId } = await harness(backend, [channel]);
    try {
      await telegramRecipient(core, "core.fulfillment.dispatched");
      await dispatchAndRelay(core, organizationId, `order-${randomUUID()}`);
      await core.notificationDispatcher.drainOnce();

      // The computed backoff would have been 1s. The provider asked for 5s.
      clock.advance(1_000);
      expect(await core.notificationDispatcher.drainOnce()).toMatchObject({ accepted: 0 });
      clock.advance(4_000);
      expect(await core.notificationDispatcher.drainOnce()).toMatchObject({ accepted: 1 });
    } finally {
      await close();
    }
  });

  it("never retries a permanent failure", async () => {
    const channel = new RejectingChannel();
    const { core, clock, close, organizationId } = await harness(backend, [channel]);
    try {
      await telegramRecipient(core, "core.fulfillment.dispatched");
      const { event } = await dispatchAndRelay(core, organizationId, `order-${randomUUID()}`);

      expect(await core.notificationDispatcher.drainOnce()).toMatchObject({ failed: 1, retrying: 0 });
      const row = (await core.notifications.forEvent(event.event_id))[0]!;
      expect(row.status).toBe("failed");
      expect(row.failed_at).not.toBeNull();
      expect(row.last_error).toBe("permanent: unknown_recipient");
      // Kept, so an operator can find the refusal in the provider's console.
      expect(row.provider_message_id).toBe("rejected-1");

      for (let i = 0; i < 5; i++) {
        clock.advance(60_000);
        await core.notificationDispatcher.drainOnce();
      }
      expect(channel.attempts).toBe(1);
    } finally {
      await close();
    }
  });

  it("stops retrying after the attempt budget and leaves the reason visible", async () => {
    const channel = new AlwaysRetryableChannel();
    const { core, clock, close, organizationId } = await harness(backend, [channel]);
    try {
      await telegramRecipient(core, "core.fulfillment.dispatched");
      const { event } = await dispatchAndRelay(core, organizationId, `order-${randomUUID()}`);

      for (let i = 0; i < 12; i++) {
        await core.notificationDispatcher.drainOnce();
        clock.advance(120_000);
      }
      // maxAttempts is 6, and no amount of extra draining exceeds it.
      expect(channel.attempts).toBe(6);
      const row = (await core.notifications.forEvent(event.event_id))[0]!;
      expect(row.status).toBe("failed");
      expect(row.attempts).toBe(6);
      expect(row.last_error).toContain("attempts_exhausted after 6");
      expect(row.retrying).toBe(false);
    } finally {
      await close();
    }
  });

  it("treats an adapter that throws as retryable, without stopping the drain", async () => {
    const throwing = new ThrowingChannel("telegram");
    const working = new RecordingChannel("email");
    const { core, close, organizationId } = await harness(backend, [throwing, working]);
    try {
      const { identity } = await core.identity.registerIdentity({
        channel_type: "email",
        external_id: `ops-${randomUUID()}@example.test`,
        correlation_id: "corr-recipient",
      });
      await core.notificationRecipients.register({
        organization_id: null,
        event_type: "core.fulfillment.dispatched",
        identity_id: identity.identity_id,
        channel: "email",
        correlation_id: "corr-recipient",
      });
      await telegramRecipient(core, "core.fulfillment.dispatched");
      const { event } = await dispatchAndRelay(core, organizationId, `order-${randomUUID()}`);

      const result = await core.notificationDispatcher.drainOnce();
      expect(result).toMatchObject({ accepted: 1, retrying: 1 });
      // The email recipient was still messaged, despite the telegram adapter
      // throwing in the same drain.
      expect(working.sent).toHaveLength(1);

      const rows = await core.notifications.forEvent(event.event_id);
      const thrown = rows.find((r) => r.channel === "telegram")!;
      expect(thrown.status).toBe("pending");
      expect(thrown.last_error).toContain("channel_threw: socket hang up");
    } finally {
      await close();
    }
  });

  it("recovers a notification whose worker died between sending and acknowledging", async () => {
    const channel = new RecordingChannel();
    const { core, clock, store, close, organizationId } = await harness(backend, [channel]);
    try {
      await telegramRecipient(core, "core.fulfillment.dispatched");
      const { event } = await dispatchAndRelay(core, organizationId, `order-${randomUUID()}`);

      // Worker A claims the row, hands the message to the provider, and dies.
      // Nothing is acknowledged: the row stays leased with nobody coming back
      // for it. Modelled by claiming through the store rather than by throwing
      // inside an adapter, because a throw is caught and recorded — a killed
      // process is not, and it is the uncaught case that risks losing a message.
      const [claimed] = await store.notification.claimDue(clock.now(), 10, 30_000);
      await channel.send({
        notification_id: claimed!.notification_id,
        channel: claimed!.channel,
        address: claimed!.address!,
        template: claimed!.template,
        subject: claimed!.subject,
        body: claimed!.body,
        data: claimed!.data,
        idempotency_key: claimed!.idempotency_key,
        attempt: claimed!.attempts,
      });
      expect(channel.sent).toHaveLength(1);

      // Inside the lease, no other worker may take it: an in-flight attempt is
      // not evidence of failure, and taking it here would be the duplicate the
      // lease exists to prevent.
      clock.advance(5_000);
      expect(await core.notificationDispatcher.drainOnce()).toMatchObject({ reclaimed: 0, accepted: 0 });
      expect(channel.sent).toHaveLength(1);
      expect((await core.notifications.forEvent(event.event_id))[0]!.status).toBe("processing");

      // Past the lease it comes back and is sent again: at-least-once, stated
      // rather than implied. The alternative — recording before sending — loses
      // the message instead of repeating it.
      clock.advance(30_000);
      await core.notificationDispatcher.drainOnce();
      clock.advance(30_000);
      await core.notificationDispatcher.drainOnce();

      expect(channel.sent.length).toBeGreaterThanOrEqual(2);
      // Same idempotency key on the repeat: what lets a cooperating provider
      // collapse it back to one message for the recipient.
      expect(channel.sent[1]!.message.idempotency_key).toBe(channel.sent[0]!.message.idempotency_key);
      const settled = (await core.notifications.forEvent(event.event_id))[0]!;
      expect(settled.status).toBe("accepted");
      expect(settled.attempts).toBeGreaterThanOrEqual(2);
    } finally {
      await close();
    }
  });

  it("repeats rather than loses a message when the adapter fails after the provider took it", async () => {
    const channel = new CrashAfterSendChannel("telegram", 1);
    const { core, clock, close, organizationId } = await harness(backend, [channel]);
    try {
      await telegramRecipient(core, "core.fulfillment.dispatched");
      const { event } = await dispatchAndRelay(core, organizationId, `order-${randomUUID()}`);

      // The provider has the message; the adapter then fails. CORE cannot know
      // it was sent, so it retries — a repeat, not a loss.
      expect(await core.notificationDispatcher.drainOnce()).toMatchObject({ retrying: 1 });
      expect(channel.delivered).toHaveLength(1);

      clock.advance(1_000);
      expect(await core.notificationDispatcher.drainOnce()).toMatchObject({ accepted: 1 });
      expect(channel.delivered).toHaveLength(2);
      expect(channel.delivered[0]!.idempotency_key).toBe(channel.delivered[1]!.idempotency_key);
      expect((await core.notifications.forEvent(event.event_id))[0]!.status).toBe("accepted");
    } finally {
      await close();
    }
  });

  it("collapses a forced repeat when the provider honours the idempotency key", async () => {
    const channel = new IdempotentChannel();
    const { core, clock, store, close, organizationId } = await harness(backend, [channel]);
    try {
      await telegramRecipient(core, "core.fulfillment.dispatched");
      await dispatchAndRelay(core, organizationId, `order-${randomUUID()}`);

      const first = await store.notification.list({});
      const id = first[0]!.notification_id;
      // Force the repeat CORE would be forced into by a crash: claim, then put
      // the row back without acknowledging, then drain again.
      await store.notification.claimDue(clock.now(), 10, 30_000);
      clock.advance(31_000);
      await core.notificationDispatcher.drainOnce();
      clock.advance(31_000);
      await core.notificationDispatcher.drainOnce();

      expect(channel.requests.length).toBeGreaterThanOrEqual(1);
      // Whatever CORE was forced to repeat, the recipient was messaged once.
      expect(channel.distinctSends).toBe(1);
      expect((await core.notifications.get(id)).status).toBe("accepted");
    } finally {
      await close();
    }
  });

  it("does not let two concurrent dispatchers send the same notification", async () => {
    const gated = new GatedChannel();
    const { core, clock, store, close, organizationId } = await harness(backend, [gated]);
    try {
      await telegramRecipient(core, "core.fulfillment.dispatched");
      for (let i = 0; i < 5; i++) {
        await dispatchAndRelay(core, organizationId, `order-${randomUUID()}`);
      }
      expect(await core.notifications.list({ status: "pending" })).toHaveLength(5);

      // Two workers over the same store, both draining before either resolves.
      const workerA = new NotificationDispatcher(store.notification, [gated], clock);
      const workerB = new NotificationDispatcher(store.notification, [gated], clock);
      const drains = Promise.all([workerA.drainOnce(), workerB.drainOnce()]);
      // Both are now inside their sends; releasing lets them finish.
      setTimeout(() => gated.open(), 10);
      const [a, b] = await drains;

      expect(a.accepted + b.accepted).toBe(5);
      // Five notifications, five sends. Not ten.
      expect(gated.started).toHaveLength(5);
      const keys = new Set(gated.started.map((m) => m.idempotency_key));
      expect(keys.size).toBe(5);
      expect(await core.notifications.list({ status: "accepted" })).toHaveLength(5);
    } finally {
      await close();
    }
  });

  it("drops a stalled worker's acknowledgement instead of overwriting the newer attempt", async () => {
    const channel = new RecordingChannel();
    const { core, clock, store, close, organizationId } = await harness(backend, [channel]);
    try {
      await telegramRecipient(core, "core.fulfillment.dispatched");
      const { event } = await dispatchAndRelay(core, organizationId, `order-${randomUUID()}`);

      // Worker A claims and then stalls, holding a token.
      const [claimed] = await store.notification.claimDue(clock.now(), 10, 30_000);
      const staleToken = claimed!.claim_token;

      // The lease expires and worker B takes over and finishes the work.
      clock.advance(31_000);
      expect(await core.notificationDispatcher.drainOnce()).toMatchObject({ reclaimed: 1 });
      await core.notificationDispatcher.drainOnce();
      expect((await core.notifications.forEvent(event.event_id))[0]!.status).toBe("accepted");

      // Worker A wakes up and reports success. It must not be recorded: the row
      // it was working on is not the row that exists now.
      const accepted = await store.notification.markDelivered(
        claimed!.notification_id,
        staleToken,
        "ghost-1",
        clock.now(),
      );
      expect(accepted).toBe(false);
      const final = (await core.notifications.forEvent(event.event_id))[0]!;
      expect(final.status).toBe("accepted");
      expect(final.provider_message_id).not.toBe("ghost-1");
      expect(final.delivered_at).toBeNull();
    } finally {
      await close();
    }
  });

  it("resumes across a restart, because the queue is in the database", async () => {
    const first = new AlwaysRetryableChannel();
    const { core, clock, store, close, organizationId } = await harness(backend, [first]);
    try {
      await telegramRecipient(core, "core.fulfillment.dispatched");
      const { event } = await dispatchAndRelay(core, organizationId, `order-${randomUUID()}`);
      await core.notificationDispatcher.drainOnce();
      expect((await core.notifications.forEvent(event.event_id))[0]!.attempts).toBe(1);

      // A new process over the same store, with a working adapter this time.
      const second = new RecordingChannel();
      const restarted = new NotificationDispatcher(store.notification, [second], clock);
      clock.advance(60_000);
      expect(await restarted.drainOnce()).toMatchObject({ accepted: 1 });
      expect(second.sent).toHaveLength(1);
      expect((await core.notifications.forEvent(event.event_id))[0]!.attempts).toBe(2);
    } finally {
      await close();
    }
  });

  it("queues a failed notification, not a lost one, when the recipient became unreachable", async () => {
    const channel = new RecordingChannel();
    const { core, clock, store, close, organizationId } = await harness(backend, [channel]);
    try {
      const { recipient } = await telegramRecipient(core, "core.fulfillment.dispatched");
      // The address is gone by the time the event is relayed: the person
      // revoked the channel, or the link was replaced and not re-verified. The
      // directory is stubbed rather than the link deleted, because what is
      // under test is what the fan-out does with "no address", and the real
      // store is still the one writing the row.
      const unreachable = new NotificationFanOut(
        store.notification,
        { async verifiedAddress() { return null; } },
        clock,
        () => randomUUID(),
      );
      const { fulfillment } = await dispatchAndRelayWithout(core, organizationId, `order-${randomUUID()}`);
      const event = (await core.outbox.all()).find(
        (r) =>
          r.event.event_type === "core.fulfillment.dispatched" &&
          (r.event.payload as { fulfillment_id?: string }).fulfillment_id === fulfillment.fulfillment_id,
      )!.event;
      await unreachable.queueFor(event);

      const row = (await core.notifications.forEvent(event.event_id))[0]!;
      expect(row.recipient_id).toBe(recipient.recipient_id);
      expect(row.status).toBe("failed");
      expect(row.address).toBeNull();
      expect(row.last_error).toContain("no verified telegram link");
      // Never handed to a channel: there is nowhere to send it.
      await core.notificationDispatcher.drainOnce();
      expect(channel.sent).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("retries rather than fails when no adapter is configured for the channel", async () => {
    const { core, clock, close, organizationId } = await harness(backend, []);
    try {
      await telegramRecipient(core, "core.fulfillment.dispatched");
      const { event } = await dispatchAndRelay(core, organizationId, `order-${randomUUID()}`);

      expect(await core.notificationDispatcher.drainOnce()).toMatchObject({ retrying: 1 });
      expect((await core.notifications.forEvent(event.event_id))[0]!.last_error).toBe(
        "channel_adapter_not_configured",
      );
      // And it does not retry for ever: a missing adapter still ends.
      for (let i = 0; i < 10; i++) {
        clock.advance(120_000);
        await core.notificationDispatcher.drainOnce();
      }
      expect((await core.notifications.forEvent(event.event_id))[0]!.status).toBe("failed");
    } finally {
      await close();
    }
  });

  it("never phrases an undecided financial outcome as a refund", async () => {
    const channel = new RecordingChannel();
    const { core, close, organizationId } = await harness(backend, [channel]);
    try {
      await telegramRecipient(core, "core.fulfillment.completed");
      // A failure closed with money still held and nobody having decided: the
      // exact state B-20 / D-6 describes.
      const created = await core.fulfillment.consumeMarketOrder(
        marketOrder(core, organizationId, `order-${randomUUID()}`),
      );
      await core.fulfillment.consumeJobAccepted(jobAccepted(core, created.fulfillment_id, "job-fin"));
      await core.fulfillment.consumeMoveCompletion(
        makeEvent({
          event_type: "move.job.completed",
          version: 1,
          producer: "wasla-move",
          occurred_at: core.clock.now(),
          correlation_id: "corr-fin",
          entity_type: "operational_job",
          entity_id: "job-fin",
          payload: {
            fulfillment_id: created.fulfillment_id,
            job_id: "job-fin",
            outcome: "failed",
            reason: "move_job_failed",
            completed_at: core.clock.now().toISOString(),
          },
        }),
      );
      await core.publisher.drainOnce();

      const rows = await core.notifications.list({});
      expect(rows).toHaveLength(1);
      const body = rows[0]!.body.toLowerCase();
      // Not the word "refund" — the message says "no refund … has been decided
      // yet", which is the honest sentence. What must never appear is a promise.
      for (const forbidden of [
        "has been refunded",
        "will be refunded",
        "was refunded",
        "you will receive a refund",
        "settled",
        "reimburs",
        "credited back",
      ]) {
        expect(body).not.toContain(forbidden);
      }
      if (rows[0]!.data["financial_decision_required"] === true) {
        expect(rows[0]!.body).toContain("held pending review");
        expect(rows[0]!.body).toContain("no refund or charge has been decided yet");
      }
    } finally {
      await close();
    }
  });

  it("keeps provider credentials and addresses out of the recorded error", async () => {
    const channel = new LeakyChannel();
    const { core, close, organizationId } = await harness(backend, [channel]);
    try {
      const { address } = await telegramRecipient(core, "core.fulfillment.dispatched");
      const { event } = await dispatchAndRelay(core, organizationId, `order-${randomUUID()}`);
      await core.notificationDispatcher.drainOnce();

      const row = (await core.notifications.forEvent(event.event_id))[0]!;
      expect(row.last_error).not.toContain(["sk", "live", "9f8e7d6c5b4a"].join("_"));
      expect(row.last_error).not.toContain(address);
      expect(row.last_error).toContain("api_key=[redacted]");
      expect(row.last_error).toContain("[address]");
    } finally {
      await close();
    }
  });

  it("reports pending, retrying, accepted and failed counts to an operator", async () => {
    const rejecting = new RejectingChannel("telegram");
    const working = new RecordingChannel("email");
    const { core, close, organizationId } = await harness(backend, [rejecting, working]);
    try {
      const { identity } = await core.identity.registerIdentity({
        channel_type: "email",
        external_id: `ops-${randomUUID()}@example.test`,
        correlation_id: "corr-recipient",
      });
      await core.notificationRecipients.register({
        organization_id: null,
        event_type: "core.fulfillment.dispatched",
        identity_id: identity.identity_id,
        channel: "email",
        correlation_id: "corr-recipient",
      });
      await telegramRecipient(core, "core.fulfillment.dispatched");
      await dispatchAndRelay(core, organizationId, `order-${randomUUID()}`);

      expect(await core.notifications.counts()).toMatchObject({ pending: 2 });
      await core.notificationDispatcher.drainOnce();
      const counts = await core.notifications.counts();
      expect(counts).toMatchObject({ accepted: 1, failed: 1, pending: 0 });
    } finally {
      await close();
    }
  });

  it("exposes recipients and notifications over the API, and refuses an impossible tenant scope", async () => {
    const channel = new RecordingChannel();
    const { core, close, organizationId } = await harness(backend, [channel]);
    try {
      const { identity } = await core.identity.registerIdentity({
        channel_type: "telegram",
        external_id: `tg-${randomUUID()}`,
        correlation_id: "corr-api",
      });
      const admin = await core.identity.registerIdentity({
        channel_type: "web",
        external_id: `admin-${randomUUID()}`,
        correlation_id: "corr-api",
      });
      await core.identity.grantMembership({
        principal_id: admin.principal.principal_id,
        organization_id: organizationId,
        roles: ["platform_admin"],
        correlation_id: "corr-api",
      });
      const session = await core.identity.issueSession({
        principal_id: admin.principal.principal_id,
        channel_type: "web",
        correlation_id: "corr-api",
      });
      const auth = { authorization: `Bearer ${session.token}` };

      const created = await core.router.handle({
        method: "POST",
        url: "/v1/notification-recipients",
        headers: auth,
        body: {
          organization_id: null,
          event_type: "core.fulfillment.dispatched",
          identity_id: identity.identity_id,
          channel: "telegram",
          correlation_id: "corr-api",
        },
      });
      expect(created.status).toBe(201);

      // A tenant scope on an event that does not name its tenant is refused
      // rather than stored as a recipient that matches nothing (B-23).
      const impossible = await core.router.handle({
        method: "POST",
        url: "/v1/notification-recipients",
        headers: auth,
        body: {
          organization_id: organizationId,
          event_type: "core.fulfillment.dispatched",
          identity_id: identity.identity_id,
          channel: "telegram",
          correlation_id: "corr-api",
        },
      });
      expect(impossible.status).toBe(400);

      await dispatchAndRelay(core, organizationId, `order-${randomUUID()}`);
      await core.notificationDispatcher.drainOnce();

      const listed = await core.router.handle({
        method: "GET",
        url: "/v1/notifications",
        headers: auth,
      });
      expect(listed.status).toBe(200);
      const body = listed.body as { count: number; summary: Record<string, number>; items: unknown[] };
      expect(body.count).toBe(1);
      expect(body.summary).toMatchObject({ accepted: 1 });
      // No claim token on the wire: an internal fencing detail.
      expect(body.items[0]).not.toHaveProperty("claim_token");

      const recipients = await core.router.handle({
        method: "GET",
        url: "/v1/notification-recipients",
        headers: auth,
      });
      expect(recipients.status).toBe(200);
      expect((recipients.body as { count: number }).count).toBe(1);
    } finally {
      await close();
    }
  });

  it("stops notifying a deactivated recipient without touching what was queued", async () => {
    const channel = new RecordingChannel();
    const { core, close, organizationId } = await harness(backend, [channel]);
    try {
      const { recipient } = await telegramRecipient(core, "core.fulfillment.dispatched");
      await dispatchAndRelay(core, organizationId, `order-${randomUUID()}`);
      await core.notificationRecipients.setActive(recipient.recipient_id, false, "corr-off");
      await dispatchAndRelay(core, organizationId, `order-${randomUUID()}`);

      // One notification: the one queued while the recipient was active.
      expect(await core.notifications.list({})).toHaveLength(1);
      await core.notificationDispatcher.drainOnce();
      expect(channel.sent).toHaveLength(1);
    } finally {
      await close();
    }
  });
});

describe("notification rendering and channel vocabulary", () => {
  it("only notifies about events a person asked to hear about", () => {
    for (const noisy of [
      "core.money.credited",
      "core.payment.authorized",
      "core.payment.captured",
      "core.payment.refunded",
      "core.payment.voided",
      "core.identity.verified",
      "core.fulfillment.created",
      "core.subscription.created",
      "core.subscription.renewed",
      "move.job.accepted",
    ]) {
      expect(notifiableTemplate(noisy, {})).toBeNull();
    }
    expect(notifiableTemplate("core.fulfillment.completed", { outcome: "failed" })).toBe(
      "fulfillment_failed",
    );
    expect(notifiableTemplate("core.fulfillment.completed", { outcome: "completed" })).toBe(
      "fulfillment_completed",
    );
  });

  it("says nothing about money unless CORE knows what happened to it", () => {
    const held = renderMessage("core.fulfillment.completed", {
      outcome: "failed",
      order_reference: "order-1",
      settlement_state: "held",
      financial_decision_required: true,
    })!;
    expect(held.body).toContain("held pending review");
    expect(held.body).toContain("no refund or charge has been decided yet");
    expect(held.body).not.toMatch(/(has been|will be|was) refunded/i);

    const released = renderMessage("core.fulfillment.cancelled", {
      order_reference: "order-2",
      settlement_state: "released",
      financial_decision_required: false,
    })!;
    expect(released.body).toContain("No payment was taken.");

    const captured = renderMessage("core.fulfillment.completed", {
      order_reference: "order-3",
      settlement_state: "captured",
      financial_decision_required: false,
    })!;
    expect(captured.body).toContain("The authorised payment was charged.");

    // Partial capture with no decision, and an unknown state: silence, not a guess.
    for (const state of ["partially_captured", "something_new", undefined]) {
      const quiet = renderMessage("core.fulfillment.completed", {
        order_reference: "order-4",
        settlement_state: state,
        financial_decision_required: false,
      })!;
      expect(quiet.body).toBe("Request order-4 has been completed.");
    }
  });

  it("keeps the receivable channel list honest against identity's channel types", () => {
    // The two lists are separate on purpose (a `web` session has no address),
    // but every channel this module claims it can reach must still be a channel
    // an identity can be linked on. A divergence here is a channel nobody can
    // ever be registered for.
    for (const channel of RECEIVABLE_CHANNELS) {
      expect(CHANNEL_TYPES as readonly string[]).toContain(channel);
    }
    expect(RECEIVABLE_CHANNELS).not.toContain("web" as never);
  });

  it("redacts credentials and addresses from a provider error", () => {
    const text = sanitiseChannelError(
      `POST failed for +966500000000 with Authorization: Bearer abc.def and api_key=${FAKE_KEY}`,
      "+966500000000",
    );
    expect(text).not.toContain("+966500000000");
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain("abc.def");
    expect(sanitiseChannelError("x".repeat(900), null)).toHaveLength(501);
  });
});
