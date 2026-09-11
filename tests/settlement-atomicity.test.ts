import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { memoryPersistence, postgresPersistence } from "../src/platform/persistence/backends.js";
import type { Persistence } from "../src/platform/persistence/backends.js";
import { FixedClock } from "../src/platform/clock.js";
import { MoneyService } from "../src/modules/money/service.js";
import { FulfillmentService } from "../src/modules/fulfillment/service.js";
import { OrganizationService } from "../src/modules/organization/service.js";
import type { FulfillmentRepository } from "../src/modules/fulfillment/service.js";
import type { TransactionScope } from "../src/platform/persistence/transaction.js";
import { makeEvent } from "../src/platform/eventing/envelope.js";

/**
 * B-11.
 *
 * Money and execution state used to be settled in two separate transactions:
 * `capture` committed on its own, and the fulfillment row was updated
 * afterwards. Each SQL statement was correct. The pair was not: a failure
 * between them left funds captured against a fulfillment still recorded as
 * `dispatched` / `held`, which is a real financial inconsistency that no
 * amount of retrying can repair, because the capture is not idempotent from
 * the outside once the fulfillment never records it.
 *
 * These tests force a failure at exactly that point — after the money
 * mutation has been applied, while the fulfillment update is being applied —
 * and assert that the money went back. They fail against the previous design.
 */

/** Wraps a repository so `update` fails once, after money has already moved. */
function failingUpdate(inner: FulfillmentRepository): FulfillmentRepository {
  return {
    insert: (f, s) => inner.insert(f, s),
    get: (id) => inner.get(id),
    all: () => inner.all(),
    findByOrderReference: (r) => inner.findByOrderReference(r),
    update: async (_f: Parameters<FulfillmentRepository["update"]>[0], _s?: TransactionScope) => {
      throw new Error("the fulfillment row could not be written");
    },
  };
}

interface Harness {
  name: string;
  make(): Promise<{ store: Persistence; close(): Promise<void> }>;
}

const harnesses: Harness[] = [
  {
    name: "in-memory",
    async make() {
      return { store: memoryPersistence(new FixedClock()), async close() {} };
    },
  },
];

const url = process.env.DATABASE_URL;
if (url) {
  harnesses.push({
    name: "postgres",
    async make() {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: url, max: 4 });
      await pool.query(
        `truncate membership, session, principal, identity_link, identity,
         organization, outbox, inbox, fulfillment, ledger_entry,
         ledger_transaction, payment_authorization, wallet, service_area,
         city, region, country, audit_entry restart identity cascade`,
      );
      return {
        store: postgresPersistence(pool as never, new FixedClock()),
        async close() {
          await pool.end();
        },
      };
    },
  });
}

describe.each(harnesses)("settlement atomicity on $name", (harness) => {
  async function setup(breakFulfillment: boolean, _withOutbox = false) {
    const clock = new FixedClock();
    const { store, close } = await harness.make();
    const organization = new OrganizationService(
      store.organization,
      store.audit,
      clock,
      store.boundary,
    );
    const money = new MoneyService(store.money, store.outbox, store.boundary, store.audit, clock);
    const fulfillment = new FulfillmentService(
      breakFulfillment ? failingUpdate(store.fulfillment) : store.fulfillment,
      store.outbox,
      store.boundary,
      store.audit,
      clock,
      money,
    );

    const org = await organization.create({
      name: "Acme",
      country_code: "SA",
      correlation_id: "corr-1",
    });
    const { wallet } = await money.createWallet({
      owner_type: "organization",
      owner_id: org.organization_id,
      currency: "SAR",
      correlation_id: "corr-1",
    });
    await money.credit({
      wallet_id: wallet.wallet_id,
      amount_minor: 10_000,
      business_reference: `topup:${randomUUID()}`,
      correlation_id: "corr-1",
    });
    const hold = await money.authorize({
      wallet_id: wallet.wallet_id,
      amount_minor: 4_000,
      business_reference: `hold:${randomUUID()}`,
      correlation_id: "corr-1",
    });

    const orderReference = `ORD-${randomUUID()}`;
    const created = await fulfillment.consumeMarketOrder(
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
          payment_authorization_id: hold.authorization_id,
        },
      }),
    );

    return { clock, money, fulfillment, wallet, hold, created, outbox: store.outbox, close };
  }

  function completion(fulfillmentId: string, at: Date, outcome: "completed" | "failed") {
    return makeEvent({
      event_type: "move.job.completed",
      version: 1,
      producer: "wasla-move",
      occurred_at: at,
      correlation_id: "corr-1",
      entity_type: "job",
      entity_id: "JOB-1",
      payload: {
        fulfillment_id: fulfillmentId,
        job_id: "JOB-1",
        outcome,
        completed_at: at.toISOString(),
      },
    });
  }

  it("captures the hold and closes the fulfillment in one commit", async () => {
    const h = await setup(false);
    try {
      expect(h.created.settlement_state).toBe("held");

      const closed = await h.fulfillment.consumeMoveCompletion(
        completion(h.created.fulfillment_id, h.clock.now(), "completed"),
      );

      expect(closed).toMatchObject({ status: "completed", settlement_state: "captured" });
      const balance = await h.money.balance(h.wallet.wallet_id);
      expect(balance.held_minor).toBe(0);
      expect(balance.posted_minor).toBe(6_000);
      expect(await h.fulfillment.listFinanciallyInconsistent()).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it("puts the captured money back when the fulfillment row cannot be written", async () => {
    const h = await setup(true);
    try {
      await expect(
        h.fulfillment.consumeMoveCompletion(
          completion(h.created.fulfillment_id, h.clock.now(), "completed"),
        ),
      ).rejects.toThrow(/the fulfillment row could not be written/);

      // This is the assertion the old design could not satisfy. The capture
      // was applied before the fulfillment update failed, so if money and
      // execution are not one transaction, the funds stay captured for a
      // fulfillment that never closed.
      const authorization = await h.money.getAuthorization(h.hold.authorization_id);
      expect(authorization.status).toBe("authorized");

      const balance = await h.money.balance(h.wallet.wallet_id);
      expect(balance.held_minor).toBe(4_000);
      expect(balance.posted_minor).toBe(10_000);
      expect(balance.available_minor).toBe(6_000);
    } finally {
      await h.close();
    }
  });

  it("puts the released money back when the fulfillment row cannot be written", async () => {
    const h = await setup(true);
    try {
      await expect(
        h.fulfillment.consumeMoveCompletion(
          completion(h.created.fulfillment_id, h.clock.now(), "failed"),
        ),
      ).rejects.toThrow(/the fulfillment row could not be written/);

      // The mirror image: a release that survived a failed closure would free
      // funds for work still recorded as in progress.
      const authorization = await h.money.getAuthorization(h.hold.authorization_id);
      expect(authorization.status).toBe("authorized");
      expect((await h.money.balance(h.wallet.wallet_id)).held_minor).toBe(4_000);
    } finally {
      await h.close();
    }
  });

  it("emits no settlement or closure event when the commit fails", async () => {
    const h = await setup(true, true);
    try {
      await expect(
        h.fulfillment.consumeMoveCompletion(
          completion(h.created.fulfillment_id, h.clock.now(), "completed"),
        ),
      ).rejects.toThrow();

      // The outbox append is the last thing a commit does, so a failure
      // anywhere earlier must leave nothing for the relay to publish.
      const types = (await h.outbox.all()).map((r) => r.event.event_type);
      expect(types).not.toContain("core.payment.captured");
      expect(types).not.toContain("core.fulfillment.closed");
    } finally {
      await h.close();
    }
  });
});
