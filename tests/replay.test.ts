/**
 * Milestone 6, part two: historical replay, on both backends.
 *
 * The claims worth testing are the dangerous ones. A replay tool that works on
 * the happy path and is wrong about money, tenancy, ordering or resumption is
 * not a tool, it is a way to corrupt a production database from a terminal. So
 * what is asserted here is mostly what replay *cannot* do:
 *
 *   - a dry-run cannot write, proved on Postgres by a connection that refuses
 *     writes rather than by inspecting the code path
 *   - a second replay of the same scope cannot cause a second effect
 *   - a replayed financial event cannot capture, release or settle twice
 *   - an old event cannot move a fulfillment backwards
 *   - an event with no tenant scope cannot be attributed to a tenant
 *   - two replays cannot run at once
 *   - a failure cannot be silent, and cannot make the rest unresumable
 *
 * Postgres tests are skipped without DATABASE_URL. The financial, dry-run,
 * concurrency and resumption assertions all run against the real database, since
 * those are precisely the ones an in-memory double could certify wrongly (B-12).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCoreApp, type CoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { makeEvent } from "../src/platform/eventing/envelope.js";
import type { EventEnvelope } from "../src/platform/eventing/envelope.js";
import { PgInboundEventStore } from "../src/platform/eventing/pg-ingress.js";
import { ReadOnlyQueryable } from "../src/platform/persistence/postgres.js";
import { PgAuditLog } from "../src/platform/audit/pg-audit.js";
import {
  memoryPersistence,
  postgresPersistence,
  type Persistence,
} from "../src/platform/persistence/backends.js";
import { ReplayService, type ReplayActor, type ReplayScope } from "../src/platform/replay/service.js";
import { permissionsForRoles } from "../src/modules/identity-access/domain.js";

const url = process.env.DATABASE_URL;

const TABLES = `rate_limit_counter, notification, notification_recipient, membership, session,
  principal, identity_link, identity, fulfillment, ledger_entry, ledger_transaction,
  payment_authorization, wallet, usage_record, subscription_period, subscription,
  plan_grant, plan, event_delivery, event_subscription, inbound_event,
  organization, outbox, inbox, idempotency_key, audit_entry`;

const OPERATOR: ReplayActor = { actor_type: "principal", actor_id: null };

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
        await pool.query(`truncate ${TABLES} restart identity cascade`);
      } finally {
        await pool.end();
      }
    },
  });
}

async function harness(backend: Backend) {
  await backend.truncate();
  const clock = new FixedClock(new Date("2026-05-01T00:00:00.000Z"));
  const { store, close } = await backend.open(clock);
  const core = createCoreApp({ clock, persistence: store });
  const organization = await core.organization.create({
    name: "Replay Co",
    country_code: "SA",
    correlation_id: "corr-replay-setup",
  });
  return { core, clock, store, close, organizationId: organization.organization_id };
}

/**
 * Records an event into the durable inbound history without dispatching it —
 * exactly the state a replay finds: accepted, stored, never handled.
 *
 * `received_at` comes from the test clock, so the total order replay uses is
 * under the test's control rather than the wall clock's.
 */
async function record(store: Persistence, event: EventEnvelope): Promise<EventEnvelope> {
  await store.inbound.accept(event);
  return event;
}

function marketOrder(
  clock: FixedClock,
  organizationId: string,
  orderId: string,
  holdId: string | null = null,
): EventEnvelope {
  return makeEvent({
    event_type: "market.order.created",
    version: 1,
    producer: "wasla-market",
    occurred_at: clock.now(),
    correlation_id: `corr-${orderId}`,
    entity_type: "commercial_order",
    entity_id: orderId,
    payload: {
      order_id: orderId,
      organization_id: organizationId,
      requested_service: "delivery",
      payment_authorization_id: holdId,
    },
  });
}

function jobAccepted(clock: FixedClock, fulfillmentId: string, jobId: string): EventEnvelope {
  return makeEvent({
    event_type: "move.job.accepted",
    version: 1,
    producer: "wasla-move",
    occurred_at: clock.now(),
    correlation_id: "corr-accept",
    entity_type: "operational_job",
    entity_id: jobId,
    payload: { fulfillment_id: fulfillmentId, job_id: jobId, accepted_at: clock.now().toISOString() },
  });
}

function jobCompleted(
  clock: FixedClock,
  fulfillmentId: string,
  jobId: string,
  outcome: "completed" | "failed" = "completed",
): EventEnvelope {
  return makeEvent({
    event_type: "move.job.completed",
    version: 1,
    producer: "wasla-move",
    occurred_at: clock.now(),
    correlation_id: "corr-complete",
    entity_type: "operational_job",
    entity_id: jobId,
    payload: {
      fulfillment_id: fulfillmentId,
      job_id: jobId,
      outcome,
      completed_at: clock.now().toISOString(),
    },
  });
}

/** Everything a replay could possibly touch, in one comparable value. */
async function snapshot(core: CoreApp, store: Persistence) {
  const inbound = await store.inbound.all();
  return {
    inbound: inbound
      .map((r) => `${r.event.event_id}:${r.status}:${r.attempts}:${r.next_attempt_at}`)
      .sort(),
    inbox: await store.inbox.size(),
    outbox: (await store.outbox.all()).length,
    audit: (await store.audit.entries()).length,
    fulfillments: (await store.fulfillment.all())
      .map((f) => `${f.fulfillment_id}:${f.status}:${f.settlement_state}`)
      .sort(),
    notifications: (await core.notifications.list({})).length,
  };
}

/** A funded wallet with a hold, so the money path is real and not simulated. */
async function funded(core: CoreApp, organizationId: string, amount = 4_000) {
  const { wallet } = await core.money.createWallet({
    owner_type: "organization",
    owner_id: organizationId,
    currency: "SAR",
    correlation_id: "corr-money",
  });
  await core.money.credit({
    wallet_id: wallet.wallet_id,
    amount_minor: 10_000,
    business_reference: `topup:${randomUUID()}`,
    correlation_id: "corr-money",
  });
  const hold = await core.money.authorize({
    wallet_id: wallet.wallet_id,
    amount_minor: amount,
    business_reference: `hold:${randomUUID()}`,
    correlation_id: "corr-money",
  });
  return { wallet, hold };
}

describe.each(backends)("event replay on '$name'", (backend) => {
  it("refuses a scope that does not narrow", async () => {
    const { core, close } = await harness(backend);
    try {
      // "Replay everything" is not an operation anyone can review before it
      // runs, so it is not an operation this tool offers.
      await expect(core.replay.plan({ limit: 100 })).rejects.toThrow(/must narrow/);
      await expect(
        core.replay.plan({ statuses: ["processed"], limit: 100 }),
      ).rejects.toThrow(/must narrow/);
      // A status filter alone is every event CORE ever handled.
      await expect(
        core.replay.plan({ event_types: ["market.order.created"], limit: 0 }),
      ).rejects.toThrow(/limit/);
      await expect(
        core.replay.plan({ event_types: ["market.order.created"], limit: 100_000 }),
      ).rejects.toThrow(/limit/);
    } finally {
      await close();
    }
  });

  it("a dry-run changes nothing at all", async () => {
    const { core, clock, store, close, organizationId } = await harness(backend);
    try {
      const first = await record(store, marketOrder(clock, organizationId, `ORD-${randomUUID()}`));
      clock.advance(1000);
      await record(store, marketOrder(clock, organizationId, `ORD-${randomUUID()}`));

      const before = await snapshot(core, store);
      const plan = await core.replay.plan({ event_types: ["market.order.created"], limit: 10 });
      const after = await snapshot(core, store);

      // The plan says what would happen…
      expect(plan.dry_run).toBe(true);
      expect(plan.discovered).toBe(2);
      expect(plan.counts.applied).toBe(2);
      expect(plan.outcomes[0]?.event_id).toBe(first.event_id);
      expect(plan.outcomes[0]?.consumers).toContain("core.fulfillment.market-order");
      // …and nothing whatsoever happened. Including no audit entry: a dry-run
      // that journals itself is a dry-run that writes.
      expect(after).toEqual(before);
      expect(after.fulfillments).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("replays a stored event into a real effect and marks it processed", async () => {
    const { core, clock, store, close, organizationId } = await harness(backend);
    try {
      const orderId = `ORD-${randomUUID()}`;
      const event = await record(store, marketOrder(clock, organizationId, orderId));

      const report = await core.replay.run(
        { event_ids: [event.event_id], limit: 10 },
        "pending_only",
        OPERATOR,
      );

      expect(report.counts.applied).toBe(1);
      expect(report.stopped_early).toBe(false);
      expect(report.failure).toBeUndefined();
      // The effect is the consumer's own, through the ordinary bus: the
      // fulfillment exists because `consumeMarketOrder` ran, not because replay
      // wrote anything.
      const fulfillments = await store.fulfillment.all();
      expect(fulfillments).toHaveLength(1);
      expect(fulfillments[0]?.market_order_reference).toBe(orderId);
      // And the queue now agrees, so the dispatcher will not redo the work.
      expect((await store.inbound.get(event.event_id))?.status).toBe("processed");
    } finally {
      await close();
    }
  });

  it("replays a dead event without resetting its attempt history", async () => {
    const { core, clock, store, close, organizationId } = await harness(backend);
    try {
      const event = await record(store, marketOrder(clock, organizationId, `ORD-${randomUUID()}`));
      await store.inbound.markDead(event.event_id, "consumer defect, since fixed");

      // The reason `dead` rows are in scope by default: they are the events a
      // replay exists to rescue.
      const report = await core.replay.run(
        { event_ids: [event.event_id], limit: 10 },
        "pending_only",
        OPERATOR,
      );
      expect(report.counts.applied).toBe(1);
      const record_ = await store.inbound.get(event.event_id);
      expect(record_?.status).toBe("processed");
      // The attempt history survives: it is evidence, and replay is not entitled
      // to erase it. (`last_error` is cleared, because that is what
      // `markProcessed` has always meant for the dispatcher too — replay uses the
      // same store method with the same semantics rather than a special one.)
      expect(record_?.attempts).toBe(1);
    } finally {
      await close();
    }
  });

  it("causes no second effect when the same scope is replayed twice", async () => {
    const { core, clock, store, close, organizationId } = await harness(backend);
    try {
      const event = await record(store, marketOrder(clock, organizationId, `ORD-${randomUUID()}`));
      const scope: ReplayScope = { event_ids: [event.event_id], limit: 10 };

      await core.replay.run(scope, "pending_only", OPERATOR);
      const afterFirst = await snapshot(core, store);

      // First line of defence: a handled row is not `pending` or `dead` any more,
      // so the default scope does not even find it.
      const second = await core.replay.run(scope, "pending_only", OPERATOR);
      expect(second.discovered).toBe(0);

      // Second line of defence, and the one that matters: force the row back into
      // scope by asking for processed rows too, so it really is offered to the
      // consumers again. The inbox refuses it.
      const third = await core.replay.run(
        { ...scope, statuses: ["pending", "dead", "processed"] },
        "pending_only",
        OPERATOR,
      );
      expect(third.discovered).toBe(1);
      expect(third.counts.applied).toBe(0);
      expect(third.counts.skipped_duplicate).toBe(1);
      expect(third.outcomes[0]?.reason).toMatch(/already processed/);

      const afterSecond = await snapshot(core, store);
      // Only the journal entries of the two extra runs differ.
      expect({ ...afterSecond, audit: 0 }).toEqual({ ...afterFirst, audit: 0 });
      expect(afterSecond.audit).toBe(afterFirst.audit + 4);
    } finally {
      await close();
    }
  });

  it("cannot be tricked into a second effect by a re-wrapped event", async () => {
    const { core, clock, store, close, organizationId } = await harness(backend);
    try {
      const orderId = `ORD-${randomUUID()}`;
      const original = await record(store, marketOrder(clock, organizationId, orderId));
      await core.replay.run({ event_ids: [original.event_id], limit: 10 }, "pending_only", OPERATOR);

      // The cheapest possible way to cause a double effect: the same facts under
      // a new event id, which the inbox has never seen. Replay never does this —
      // it republishes the stored envelope byte for byte — but if someone
      // submits one deliberately, the domain must still refuse.
      clock.advance(1000);
      const rewrapped = await record(store, marketOrder(clock, organizationId, orderId));
      expect(rewrapped.event_id).not.toBe(original.event_id);
      const report = await core.replay.run(
        { event_ids: [rewrapped.event_id], limit: 10 },
        "pending_only",
        OPERATOR,
      );

      // The inbox lets it through, because to the inbox it is a new event. The
      // fulfillment's own uniqueness on the order reference is what holds:
      // exactly one fulfillment, no second closure, no second hold.
      expect(report.counts.applied).toBe(1);
      expect(await store.fulfillment.all()).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("does not capture, release or settle money twice", async () => {
    const { core, clock, store, close, organizationId } = await harness(backend);
    try {
      const { wallet, hold } = await funded(core, organizationId);
      const created = await record(
        store,
        marketOrder(clock, organizationId, `ORD-${randomUUID()}`, hold.authorization_id),
      );
      await core.replay.run({ event_ids: [created.event_id], limit: 5 }, "pending_only", OPERATOR);
      const fulfillment = (await store.fulfillment.all())[0]!;
      expect(fulfillment.settlement_state).toBe("held");
      expect((await core.money.balance(wallet.wallet_id)).held_minor).toBe(4_000);

      clock.advance(1000);
      const accepted = await record(store, jobAccepted(clock, fulfillment.fulfillment_id, "job-money"));
      clock.advance(1000);
      const completed = await record(
        store,
        jobCompleted(clock, fulfillment.fulfillment_id, "job-money"),
      );

      // The whole lifecycle driven from history: reserve → dispatch → capture.
      const first = await core.replay.run(
        { event_ids: [accepted.event_id, completed.event_id], limit: 5 },
        "pending_only",
        OPERATOR,
      );
      expect(first.counts.applied).toBe(2);
      const settled = await store.fulfillment.get(fulfillment.fulfillment_id);
      expect(settled?.status).toBe("completed");
      expect(settled?.settlement_state).toBe("captured");
      const balanceAfterCapture = await core.money.balance(wallet.wallet_id);
      expect(balanceAfterCapture.held_minor).toBe(0);
      expect(balanceAfterCapture.available_minor).toBe(6_000);
      const authorizationAfterCapture = await core.money.getAuthorization(hold.authorization_id);

      // Now the dangerous part: the same financial events again, and deliberately
      // dragged back into scope so the inbox is the only thing standing between
      // a replay and a second capture.
      const second = await core.replay.run(
        {
          event_ids: [accepted.event_id, completed.event_id],
          statuses: ["pending", "dead", "processed"],
          limit: 5,
        },
        "pending_only",
        OPERATOR,
      );
      expect(second.discovered).toBe(2);
      expect(second.counts.skipped_duplicate).toBe(2);
      expect(second.counts.applied).toBe(0);

      // No second capture, no second ledger movement, no changed hold. The
      // guarantee comes from the invariants the ledger already had — there is no
      // replay-specific branch anywhere in the money path.
      expect(await core.money.balance(wallet.wallet_id)).toEqual(balanceAfterCapture);
      expect(await core.money.getAuthorization(hold.authorization_id)).toEqual(
        authorizationAfterCapture,
      );
      expect((await store.fulfillment.get(fulfillment.fulfillment_id))?.settlement_state).toBe(
        "captured",
      );
    } finally {
      await close();
    }
  });

  it("does not release money twice when a rejection is replayed", async () => {
    const { core, clock, store, close, organizationId } = await harness(backend);
    try {
      const { wallet, hold } = await funded(core, organizationId, 2_500);
      const created = await record(
        store,
        marketOrder(clock, organizationId, `ORD-${randomUUID()}`, hold.authorization_id),
      );
      await core.replay.run({ event_ids: [created.event_id], limit: 5 }, "pending_only", OPERATOR);
      const fulfillment = (await store.fulfillment.all())[0]!;

      clock.advance(1000);
      const rejected = await record(
        store,
        makeEvent({
          event_type: "move.job.rejected",
          version: 1,
          producer: "wasla-move",
          occurred_at: clock.now(),
          correlation_id: "corr-reject",
          entity_type: "operational_job",
          entity_id: "job-reject",
          payload: {
            fulfillment_id: fulfillment.fulfillment_id,
            reason: "no_capacity",
            rejected_at: clock.now().toISOString(),
          },
        }),
      );

      await core.replay.run({ event_ids: [rejected.event_id], limit: 5 }, "pending_only", OPERATOR);
      const released = await core.money.balance(wallet.wallet_id);
      expect(released.held_minor).toBe(0);
      expect(released.available_minor).toBe(10_000);

      // A second release would credit the wallet twice — the classic replay
      // defect. It does not happen.
      const again = await core.replay.run(
        { event_ids: [rejected.event_id], statuses: ["pending", "dead", "processed"], limit: 5 },
        "reapply",
        OPERATOR,
      );
      expect(again.counts.applied).toBe(1);
      expect(await core.money.balance(wallet.wallet_id)).toEqual(released);
      expect((await store.fulfillment.get(fulfillment.fulfillment_id))?.status).toBe("failed");
    } finally {
      await close();
    }
  });

  it("re-runs handlers in reapply mode without a double effect", async () => {
    const { core, clock, store, close, organizationId } = await harness(backend);
    try {
      const event = await record(store, marketOrder(clock, organizationId, `ORD-${randomUUID()}`));
      await core.replay.run({ event_ids: [event.event_id], limit: 5 }, "pending_only", OPERATOR);

      let handled = 0;
      core.bus.subscribe("test.probe", "market.order.created", () => {
        handled += 1;
      });

      // `reapply` is the named, documented way to make handlers run again — for
      // a consumer whose handler was wrong and has been fixed. It is not a way
      // around idempotency: the fulfillment consumer runs too, and the domain
      // still refuses to create a second fulfillment for one order.
      const report = await core.replay.run(
        { event_ids: [event.event_id], statuses: ["pending", "dead", "processed"], limit: 5 },
        "reapply",
        OPERATOR,
      );
      expect(report.mode).toBe("reapply");
      expect(report.counts.applied).toBe(1);
      expect(handled).toBe(1);
      expect(await store.fulfillment.all()).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("reports events it cannot read and leaves them exactly as they were", async () => {
    const { core, clock, store, close, organizationId } = await harness(backend);
    try {
      const good = await record(store, marketOrder(clock, organizationId, `ORD-${randomUUID()}`));
      clock.advance(1000);
      // Stored before payload validation existed at the edge: structurally a
      // valid envelope, with a payload no version of the contract can read.
      const unreadable = await record(
        store,
        makeEvent({
          event_type: "market.order.created",
          version: 1,
          producer: "wasla-market",
          occurred_at: clock.now(),
          correlation_id: "corr-old",
          entity_type: "commercial_order",
          entity_id: "ORD-BROKEN",
          payload: { order_id: "ORD-BROKEN", requested_service: "delivery" },
        }),
      );
      clock.advance(1000);
      const wrongVersion = await record(
        store,
        {
          ...marketOrder(clock, organizationId, `ORD-${randomUUID()}`),
          version: 9,
        },
      );

      const report = await core.replay.run(
        { event_types: ["market.order.created"], limit: 10 },
        "pending_only",
        OPERATOR,
      );

      expect(report.counts.applied).toBe(1);
      expect(report.counts.not_normalizable).toBe(2);
      const byId = new Map(report.outcomes.map((o) => [o.event_id, o]));
      expect(byId.get(unreadable.event_id)?.rejection).toBe("payload_malformed");
      expect(byId.get(unreadable.event_id)?.reason).toContain("organization_id");
      expect(byId.get(wrongVersion.event_id)?.rejection).toBe("unsupported_version");
      // An unreadable event is a fact about a gap in CORE. Rewriting its status
      // would destroy the evidence needed to close that gap, and guessing its
      // payload would be far worse: a refusal stops, a guess settles money.
      expect((await store.inbound.get(unreadable.event_id))?.status).toBe("pending");
      expect((await store.inbound.get(unreadable.event_id))?.attempts).toBe(0);
      expect((await store.inbound.get(good.event_id))?.status).toBe("processed");
    } finally {
      await close();
    }
  });

  it("refuses to attribute an event with no tenant scope to a tenant", async () => {
    const { core, clock, store, close, organizationId } = await harness(backend);
    try {
      const created = await record(
        store,
        marketOrder(clock, organizationId, `ORD-${randomUUID()}`),
      );
      await core.replay.run({ event_ids: [created.event_id], limit: 5 }, "pending_only", OPERATOR);
      const fulfillment = (await store.fulfillment.all())[0]!;
      clock.advance(1000);
      const accepted = await record(store, jobAccepted(clock, fulfillment.fulfillment_id, "job-t"));

      const report = await core.replay.run(
        { event_types: ["move.job.accepted"], organization_id: organizationId, limit: 5 },
        "pending_only",
        OPERATOR,
      );

      // The fulfillment *does* belong to this organization, and CORE could look
      // that up. It deliberately does not: the envelope is the evidence, and
      // resolving tenancy by inference is how one organization's history ends up
      // replayed under another's scope. An explicit refusal beats a plausible
      // link (B-23).
      expect(report.counts.applied).toBe(0);
      expect(report.counts.skipped_tenant_unknown).toBe(1);
      expect(report.outcomes[0]?.reason).toContain("B-23");
      expect((await store.inbound.get(accepted.event_id))?.status).toBe("pending");
    } finally {
      await close();
    }
  });

  it("keeps two organizations' events apart", async () => {
    const { core, clock, store, close, organizationId } = await harness(backend);
    try {
      const other = await core.organization.create({
        name: "Other Co",
        country_code: "SA",
        correlation_id: "corr-other",
      });
      const mine = await record(store, marketOrder(clock, organizationId, `ORD-${randomUUID()}`));
      clock.advance(1000);
      const theirs = await record(
        store,
        marketOrder(clock, other.organization_id, `ORD-${randomUUID()}`),
      );

      const report = await core.replay.run(
        { event_types: ["market.order.created"], organization_id: organizationId, limit: 10 },
        "pending_only",
        OPERATOR,
      );

      expect(report.counts.applied).toBe(1);
      expect(report.counts.skipped_tenant_mismatch).toBe(1);
      const applied = report.outcomes.filter((o) => o.outcome === "applied");
      expect(applied[0]?.event_id).toBe(mine.event_id);
      // The other tenant's event was not touched, in either direction.
      expect((await store.inbound.get(theirs.event_id))?.status).toBe("pending");
      expect(await store.fulfillment.all()).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("orders by CORE's receipt time and not by the producer's clock", async () => {
    const { core, clock, store, close, organizationId } = await harness(backend);
    try {
      // A producer with a skewed clock: the event CORE received first claims to
      // have happened last. Ordering by `occurred_at` would let that producer
      // reorder CORE's history retroactively.
      const firstReceived = await record(store, {
        ...marketOrder(clock, organizationId, `ORD-A-${randomUUID()}`),
        occurred_at: "2030-01-01T00:00:00.000Z",
      });
      clock.advance(5000);
      const secondReceived = await record(store, {
        ...marketOrder(clock, organizationId, `ORD-B-${randomUUID()}`),
        occurred_at: "2020-01-01T00:00:00.000Z",
      });

      const plan = await core.replay.plan({ event_types: ["market.order.created"], limit: 10 });
      expect(plan.outcomes.map((o) => o.event_id)).toEqual([
        firstReceived.event_id,
        secondReceived.event_id,
      ]);
    } finally {
      await close();
    }
  });

  it("does not let an old event move a fulfillment backwards", async () => {
    const { core, clock, store, close, organizationId } = await harness(backend);
    try {
      const created = await record(store, marketOrder(clock, organizationId, `ORD-${randomUUID()}`));
      await core.replay.run({ event_ids: [created.event_id], limit: 5 }, "pending_only", OPERATOR);
      const fulfillment = (await store.fulfillment.all())[0]!;

      // An acceptance that was stored long ago and never handled…
      clock.advance(1000);
      const staleAcceptance = await record(
        store,
        jobAccepted(clock, fulfillment.fulfillment_id, "job-late"),
      );
      // …while the fulfillment has since been cancelled.
      clock.advance(1000);
      await core.fulfillment.cancel({
        fulfillment_id: fulfillment.fulfillment_id,
        reason: "customer_cancelled",
        correlation_id: "corr-cancel",
      });
      const closed = await store.fulfillment.get(fulfillment.fulfillment_id);
      expect(closed?.status).toBe("cancelled");

      const report = await core.replay.run(
        { event_ids: [staleAcceptance.event_id], limit: 5 },
        "pending_only",
        OPERATOR,
      );

      // The event is applied — it is a real fact and the consumer records what it
      // can — but the lifecycle does not regress. The protection is the
      // conditional transition the consumer already used, not anything replay
      // added: replay hands the event over and the domain decides.
      expect(report.counts.applied).toBe(1);
      const after = await store.fulfillment.get(fulfillment.fulfillment_id);
      expect(after?.status).toBe("cancelled");
      expect(after?.move_job_reference).toBe("job-late");
      // And no dispatched event was published for a cancelled fulfillment.
      const dispatched = (await store.outbox.all()).filter(
        (r) => r.event.event_type === "core.fulfillment.dispatched",
      );
      expect(dispatched).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("stops at a failure, says which event and why, and stays resumable", async () => {
    const { core, clock, store, close, organizationId } = await harness(backend);
    try {
      const first = await record(store, marketOrder(clock, organizationId, `ORD-1-${randomUUID()}`));
      clock.advance(1000);
      const broken = await record(store, marketOrder(clock, organizationId, `ORD-2-${randomUUID()}`));
      clock.advance(1000);
      const last = await record(store, marketOrder(clock, organizationId, `ORD-3-${randomUUID()}`));

      // A consumer with a defect, which is the situation replay exists for.
      let failing = true;
      core.bus.subscribe("test.probe", "market.order.created", (event) => {
        if (failing && event.event_id === broken.event_id) throw new Error("consumer defect");
      });

      const report = await core.replay.run(
        { event_types: ["market.order.created"], limit: 10 },
        "pending_only",
        OPERATOR,
      );

      // Not silent, and not vague: the failing event, the reason, and where the
      // run stopped.
      expect(report.stopped_early).toBe(true);
      expect(report.counts.applied).toBe(1);
      expect(report.counts.failed).toBe(1);
      expect(report.failure?.event_id).toBe(broken.event_id);
      expect(report.failure?.reason).toContain("consumer defect");
      // The cursor points *before* the failing event, so a resume retries it
      // rather than stepping over the one event that did not work.
      expect(report.resume_after).toEqual({
        received_at: (await store.inbound.get(first.event_id))!.received_at,
        event_id: first.event_id,
      });
      // What preceded it was applied; what followed it was not started.
      expect((await store.inbound.get(first.event_id))?.status).toBe("processed");
      expect((await store.inbound.get(last.event_id))?.status).toBe("pending");
      // The failing row keeps the dispatcher's own schedule: replay does not
      // spend the live queue's retry budget or push its next attempt out.
      const failedRow = await store.inbound.get(broken.event_id);
      expect(failedRow?.status).toBe("pending");
      expect(failedRow?.attempts).toBe(0);

      // Now the defect is fixed and the operator resumes from the cursor.
      failing = false;
      const resumed = await core.replay.run(
        { event_types: ["market.order.created"], after: report.resume_after ?? undefined, limit: 10 },
        "pending_only",
        OPERATOR,
      );
      expect(resumed.counts.failed).toBe(0);
      expect(resumed.counts.applied).toBe(2);
      expect(resumed.stopped_early).toBe(false);
      // Three orders, three fulfillments — the retried event did not produce a
      // second one for the consumer that had already succeeded on it.
      expect(await store.fulfillment.all()).toHaveLength(3);
      for (const event of [first, broken, last]) {
        expect((await store.inbound.get(event.event_id))?.status).toBe("processed");
      }
    } finally {
      await close();
    }
  });

  it("can survey every failure in a scope when asked to continue", async () => {
    const { core, clock, store, close, organizationId } = await harness(backend);
    try {
      const events: EventEnvelope[] = [];
      for (let index = 0; index < 3; index += 1) {
        events.push(await record(store, marketOrder(clock, organizationId, `ORD-${randomUUID()}`)));
        clock.advance(1000);
      }
      core.bus.subscribe("test.probe", "market.order.created", () => {
        throw new Error("every consumer is broken");
      });

      const report = await core.replay.run(
        { event_types: ["market.order.created"], limit: 10 },
        "pending_only",
        OPERATOR,
        { stopOnError: false },
      );

      // Stopping is the default because later facts must not land on an earlier
      // one that never did. Surveying is the deliberate opposite, for finding
      // out how bad it is.
      expect(report.counts.failed).toBe(3);
      expect(report.stopped_early).toBe(false);
      expect(report.outcomes.every((o) => o.outcome === "failed")).toBe(true);
    } finally {
      await close();
    }
  });

  it("pages through a scope with a cursor instead of one huge run", async () => {
    const { core, clock, store, close, organizationId } = await harness(backend);
    try {
      for (let index = 0; index < 5; index += 1) {
        await record(store, marketOrder(clock, organizationId, `ORD-${randomUUID()}`));
        clock.advance(1000);
      }

      const firstPage = await core.replay.run(
        { event_types: ["market.order.created"], limit: 2 },
        "pending_only",
        OPERATOR,
      );
      expect(firstPage.counts.applied).toBe(2);
      expect(firstPage.more_available).toBe(true);

      const secondPage = await core.replay.run(
        {
          event_types: ["market.order.created"],
          after: firstPage.resume_after ?? undefined,
          limit: 2,
        },
        "pending_only",
        OPERATOR,
      );
      // Strictly after, so no event is repeated and none is skipped.
      expect(secondPage.counts.applied).toBe(2);
      const seen = [...firstPage.outcomes, ...secondPage.outcomes].map((o) => o.event_id);
      expect(new Set(seen).size).toBe(4);
      expect(await store.fulfillment.all()).toHaveLength(4);
    } finally {
      await close();
    }
  });

  it("journals who ran it, over what, and what happened", async () => {
    const { core, clock, store, close, organizationId } = await harness(backend);
    try {
      const event = await record(store, marketOrder(clock, organizationId, `ORD-${randomUUID()}`));
      const report = await core.replay.run(
        { event_ids: [event.event_id], limit: 5 },
        "pending_only",
        { actor_type: "principal", actor_id: null },
      );

      // No new table: the audit trail CORE already has carries the truth, and a
      // counters table would become a second, competing account of what the
      // domain state is.
      const entries = await store.audit.forEntity("event_replay", report.replay_id);
      expect(entries.map((e) => e.action).sort()).toEqual([
        "event_replay.finished",
        "event_replay.started",
      ]);
      const finished = entries.find((e) => e.action === "event_replay.finished")!;
      expect(finished.metadata["counts"]).toEqual(report.counts);
      expect(finished.metadata["mode"]).toBe("pending_only");
      expect(finished.metadata["discovered"]).toBe(1);
      expect((finished.metadata["scope"] as Record<string, unknown>)["event_ids"]).toEqual([
        event.event_id,
      ]);
      // Identifiers and counts only — never a payload. An event can describe a
      // real person's order and the journal is read by more people than the
      // database is.
      expect(JSON.stringify(finished.metadata)).not.toContain("requested_service");
    } finally {
      await close();
    }
  });

  it("refuses a second replay while one is running", async () => {
    const { core, clock, store, close, organizationId } = await harness(backend);
    try {
      const event = await record(store, marketOrder(clock, organizationId, `ORD-${randomUUID()}`));
      // Held directly rather than by racing two runs, so the assertion is about
      // the lock and not about which of two timers won.
      const lease = await store.replayLock.acquire();
      expect(lease).not.toBeNull();

      await expect(
        core.replay.run({ event_ids: [event.event_id], limit: 5 }, "pending_only", OPERATOR),
      ).rejects.toThrow(/already running/);
      // Refused, not queued: a replay waiting behind another would run later
      // against a state the operator never inspected.
      expect((await store.inbound.get(event.event_id))?.status).toBe("pending");

      await lease!.release();
      const report = await core.replay.run(
        { event_ids: [event.event_id], limit: 5 },
        "pending_only",
        OPERATOR,
      );
      expect(report.counts.applied).toBe(1);
    } finally {
      await close();
    }
  });

  it("releases the lock even when the run throws", async () => {
    const { core, store, close } = await harness(backend);
    try {
      // `select` is the first thing a run does; if the lock were not released in
      // a `finally`, one unexpected error would lock replay out until a restart.
      const broken = new ReplayService(
        {
          ...store.inbound,
          select: async () => {
            throw new Error("store unavailable");
          },
        },
        core.bus,
        store.inbox,
        store.audit,
        core.clock,
        store.replayLock,
      );
      await expect(
        broken.run({ event_types: ["market.order.created"], limit: 5 }, "pending_only", OPERATOR),
      ).rejects.toThrow(/store unavailable/);
      const lease = await store.replayLock.acquire();
      expect(lease).not.toBeNull();
      await lease!.release();
    } finally {
      await close();
    }
  });
});

describe.runIf(url)("replay dry-run on a read-only connection", () => {
  it("can read the history and is physically unable to write", async () => {
    const backend = backends.find((b) => b.name === "postgres")!;
    const { core, clock, store, close, organizationId } = await harness(backend);
    const { Pool } = await import("pg");
    const readOnlyPool = new Pool({ connectionString: url, max: 2 });
    try {
      const event = await record(store, marketOrder(clock, organizationId, `ORD-${randomUUID()}`));

      // The same service, the same code path, on a connection where every
      // statement runs inside `begin transaction read only`. This is what makes
      // the dry-run guarantee a proof rather than a promise: not "it does not
      // call the handler", but "the database refuses the write".
      const readOnly = new ReadOnlyQueryable(readOnlyPool as never);
      const guarded = new ReplayService(
        new PgInboundEventStore(readOnly, clock),
        core.bus,
        store.inbox,
        new PgAuditLog(readOnly as never, clock),
        clock,
        store.replayLock,
      );

      const plan = await guarded.plan({ event_ids: [event.event_id], limit: 5 });
      expect(plan.discovered).toBe(1);
      expect(plan.counts.applied).toBe(1);

      // And the falsification: the identical scope, executed for real, is
      // refused by Postgres with SQLSTATE 25006.
      const failure = await guarded
        .run({ event_ids: [event.event_id], limit: 5 }, "pending_only", OPERATOR)
        .then(() => null)
        .catch((error: Error & { code?: string }) => error);
      expect(failure).not.toBeNull();
      expect(failure?.code).toBe("25006");
      expect(failure?.message).toMatch(/read-only transaction/);

      // Nothing happened: not the effect, not the status change, not even the
      // journal entry that would have recorded the attempt.
      expect((await store.inbound.get(event.event_id))?.status).toBe("pending");
      expect(await store.fulfillment.all()).toHaveLength(0);
      expect(await store.audit.forEntity("event_replay", plan.replay_id)).toHaveLength(0);
    } finally {
      await readOnlyPool.end();
      await close();
    }
  });

  it("excludes a second process from replaying at the same time", async () => {
    const backend = backends.find((b) => b.name === "postgres")!;
    const { core, clock, store, close, organizationId } = await harness(backend);
    const { Pool } = await import("pg");
    // A genuinely separate connection pool, which is what a second CORE instance
    // has. The in-process lock would let both through; the advisory lock does
    // not, because only the database can arbitrate between two processes.
    const otherPool = new Pool({ connectionString: url, max: 2 });
    try {
      const event = await record(store, marketOrder(clock, organizationId, `ORD-${randomUUID()}`));
      const otherStore = postgresPersistence(otherPool as never, clock);
      const lease = await otherStore.replayLock.acquire();
      expect(lease).not.toBeNull();

      await expect(
        core.replay.run({ event_ids: [event.event_id], limit: 5 }, "pending_only", OPERATOR),
      ).rejects.toThrow(/already running/);

      await lease!.release();
      // And the exclusion is not permanent: once the other holder finishes, the
      // lock is available again.
      const report = await core.replay.run(
        { event_ids: [event.event_id], limit: 5 },
        "pending_only",
        OPERATOR,
      );
      expect(report.counts.applied).toBe(1);
    } finally {
      await otherPool.end();
      await close();
    }
  });
});

describe("replay authorisation", () => {
  it("is a platform-admin capability and not a service one", () => {
    // Every service credential holds `events.submit`. If replay reused it,
    // MARKET and MOVE would each be able to replay CORE's entire history.
    expect(permissionsForRoles(["platform_admin"]).has("events.replay")).toBe(true);
    for (const role of ["service", "org_admin", "org_member", "support_agent"] as const) {
      expect(permissionsForRoles([role]).has("events.replay")).toBe(false);
      expect(permissionsForRoles(["service"]).has("events.submit")).toBe(true);
    }
  });
});
