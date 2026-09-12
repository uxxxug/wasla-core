import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createCoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { memoryPersistence, postgresPersistence } from "../src/platform/persistence/backends.js";
import type { Persistence } from "../src/platform/persistence/backends.js";
import { makeEvent } from "../src/platform/eventing/envelope.js";

/**
 * The existing suites prove single-threaded correctness. These prove the two
 * things a single-threaded suite cannot see: what happens when two callers
 * race for the same row, and what survives losing the process.
 *
 * The inbox claim tests elsewhere call `claim` twice in sequence, which only
 * shows the second call reads the first one's row. Issuing both at once is a
 * different question, and on Postgres it is the one that matters, because the
 * answer depends on whether the insert is a real conditional write or a
 * read-then-write with a window in it.
 */

const url = process.env.DATABASE_URL;

interface Backend {
  name: string;
  open(): Promise<{ store: Persistence; close(): Promise<void> }>;
}

const backends: Backend[] = [
  {
    name: "in-memory",
    async open() {
      return { store: memoryPersistence(new FixedClock()), async close() {} };
    },
  },
];

if (url) {
  backends.push({
    name: "postgres",
    async open() {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: url, max: 8 });
      return {
        store: postgresPersistence(pool as never, new FixedClock()),
        async close() {
          await pool.end();
        },
      };
    },
  });
}

async function truncate(): Promise<void> {
  if (!url) return;
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url, max: 1 });
  await pool.query(
    `truncate membership, session, principal, identity_link, identity,
     organization, outbox, inbox, fulfillment, ledger_entry,
     ledger_transaction, payment_authorization, wallet, service_area,
     city, region, country, audit_entry restart identity cascade`,
  );
  await pool.end();
}

describe.each(backends)("concurrency on $name", (backend) => {
  it("hands one event to exactly one of two simultaneous claimants", async () => {
    await truncate();
    const { store, close } = await backend.open();
    try {
      const eventId = randomUUID();
      // Both issued before either is awaited. Sequential calls cannot
      // distinguish a conditional insert from a check followed by a write.
      const results = await Promise.all([
        store.inbox.claim("move", eventId),
        store.inbox.claim("move", eventId),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await store.inbox.size()).toBe(1);
    } finally {
      await close();
    }
  });

  it("captures a hold once when two callers capture it at the same time", async () => {
    await truncate();
    const { store, close } = await backend.open();
    try {
      const core = createCoreApp({ clock: new FixedClock(), persistence: store });
      const org = await core.organization.create({
        name: "Acme",
        country_code: "SA",
        correlation_id: "corr-1",
      });
      const { wallet } = await core.money.createWallet({
        owner_type: "organization",
        owner_id: org.organization_id,
        currency: "SAR",
        correlation_id: "corr-1",
      });
      await core.money.credit({
        wallet_id: wallet.wallet_id,
        amount_minor: 10_000,
        business_reference: `topup:${randomUUID()}`,
        correlation_id: "corr-1",
      });
      const hold = await core.money.authorize({
        wallet_id: wallet.wallet_id,
        amount_minor: 4_000,
        business_reference: `hold:${randomUUID()}`,
        correlation_id: "corr-1",
      });

      const outcomes = await Promise.allSettled([
        core.money.capture({ authorization_id: hold.authorization_id, correlation_id: "corr-1" }),
        core.money.capture({ authorization_id: hold.authorization_id, correlation_id: "corr-1" }),
      ]);

      // Either both see the same idempotent result or one is refused. What is
      // not acceptable is the money moving twice, so the balance is the
      // assertion that matters.
      expect(outcomes.some((o) => o.status === "fulfilled")).toBe(true);
      const balance = await core.money.balance(wallet.wallet_id);
      expect(balance.posted_minor).toBe(6_000);
      expect(balance.held_minor).toBe(0);
    } finally {
      await close();
    }
  });

  it("closes a fulfillment once when cancellation races the MOVE completion", async () => {
    await truncate();
    const { store, close } = await backend.open();
    try {
      const clock = new FixedClock();
      const core = createCoreApp({ clock, persistence: store });
      const org = await core.organization.create({
        name: "Acme",
        country_code: "SA",
        correlation_id: "corr-1",
      });
      const orderReference = `ORD-${randomUUID()}`;
      const created = await core.fulfillment.consumeMarketOrder(
        makeEvent({
          event_type: "market.order.created",
          version: 1,
          producer: "wasla-market",
          occurred_at: clock.now(),
          correlation_id: "corr-1",
          entity_type: "order",
          entity_id: orderReference,
          payload: {
            order_id: orderReference,
            organization_id: org.organization_id,
            requested_service: "delivery",
          },
        }),
      );

      const outcomes = await Promise.allSettled([
        core.fulfillment.cancel({
          fulfillment_id: created.fulfillment_id,
          reason: "customer_changed_mind",
          correlation_id: "corr-1",
        }),
        core.fulfillment.consumeMoveCompletion(
          makeEvent({
            event_type: "move.job.completed",
            version: 1,
            producer: "wasla-move",
            occurred_at: clock.now(),
            correlation_id: "corr-1",
            entity_type: "job",
            entity_id: "JOB-1",
            payload: {
              fulfillment_id: created.fulfillment_id,
              job_id: "JOB-1",
              outcome: "completed",
              completed_at: clock.now().toISOString(),
            },
          }),
        ),
      ]);

      // One wins. The point is that the row ends in exactly one terminal
      // state, not a blend of the two.
      expect(outcomes.filter((o) => o.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
      const final = await core.fulfillment.require(created.fulfillment_id);
      expect(["completed", "cancelled"]).toContain(final.status);
      expect(final.completed_at).not.toBeNull();
      if (final.status === "completed") {
        // The completion won: money captured against delivered work, nothing open.
        expect(await core.fulfillment.listFinanciallyInconsistent()).toHaveLength(0);
      } else {
        // The cancellation won, and the completion it beat is not discarded: MOVE
        // reported the work as done, so the row carries that report and the case is
        // routed to the decision queue (B-29). Reporting this fulfillment as
        // financially finished would be the defect, not the reading below.
        expect(final).toMatchObject({
          status: "cancelled",
          executed_after_cancellation_job_reference: "JOB-1",
        });
        expect(await core.fulfillment.listPendingFinancialDecision()).toHaveLength(1);
      }
    } finally {
      await close();
    }
  });
});

// A restart is only meaningful where the state outlives the process.
describe.runIf(url)("restart and reload on postgres", () => {
  it("reloads state from the database and refuses to redo settled work", async () => {
    await truncate();
    const { Pool } = await import("pg");
    const clock = new FixedClock();

    const first = new Pool({ connectionString: url, max: 4 });
    const coreA = createCoreApp({
      clock,
      persistence: postgresPersistence(first as never, clock),
    });
    const org = await coreA.organization.create({
      name: "Acme",
      country_code: "SA",
      correlation_id: "corr-1",
    });
    const { wallet } = await coreA.money.createWallet({
      owner_type: "organization",
      owner_id: org.organization_id,
      currency: "SAR",
      correlation_id: "corr-1",
    });
    await coreA.money.credit({
      wallet_id: wallet.wallet_id,
      amount_minor: 10_000,
      business_reference: `topup:${randomUUID()}`,
      correlation_id: "corr-1",
    });
    const hold = await coreA.money.authorize({
      wallet_id: wallet.wallet_id,
      amount_minor: 4_000,
      business_reference: `hold:${randomUUID()}`,
      correlation_id: "corr-1",
    });
    const orderReference = `ORD-${randomUUID()}`;
    const order = makeEvent({
      event_type: "market.order.created",
      version: 1,
      producer: "wasla-market",
      occurred_at: clock.now(),
      correlation_id: "corr-1",
      entity_type: "order",
      entity_id: orderReference,
      payload: {
        order_id: orderReference,
        organization_id: org.organization_id,
        requested_service: "delivery",
        payment_authorization_id: hold.authorization_id,
      },
    });
    const created = await coreA.fulfillment.consumeMarketOrder(order);
    const completion = makeEvent({
      event_type: "move.job.completed",
      version: 1,
      producer: "wasla-move",
      occurred_at: clock.now(),
      correlation_id: "corr-1",
      entity_type: "job",
      entity_id: "JOB-1",
      payload: {
        fulfillment_id: created.fulfillment_id,
        job_id: "JOB-1",
        outcome: "completed",
        completed_at: clock.now().toISOString(),
      },
    });
    await coreA.fulfillment.consumeMoveCompletion(completion);

    // The process goes away. Nothing is carried across except the database.
    await first.end();

    const second = new Pool({ connectionString: url, max: 4 });
    const coreB = createCoreApp({
      clock,
      persistence: postgresPersistence(second as never, clock),
    });
    try {
      const reloaded = await coreB.fulfillment.require(created.fulfillment_id);
      expect(reloaded).toMatchObject({ status: "completed", settlement_state: "captured" });
      expect((await coreB.money.balance(wallet.wallet_id)).posted_minor).toBe(6_000);

      // Redelivery after a restart must be as inert as redelivery before one.
      await coreB.fulfillment.consumeMarketOrder(order);
      await coreB.fulfillment.consumeMoveCompletion(completion);

      expect(await coreB.fulfillment.require(created.fulfillment_id)).toMatchObject({
        status: "completed",
        settlement_state: "captured",
      });
      const balance = await coreB.money.balance(wallet.wallet_id);
      expect(balance.posted_minor).toBe(6_000);
      expect(balance.held_minor).toBe(0);
      expect(await coreB.fulfillment.listFinanciallyInconsistent()).toHaveLength(0);
    } finally {
      await second.end();
    }
  });
});
