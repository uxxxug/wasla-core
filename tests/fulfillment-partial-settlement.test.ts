import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreApp, type CoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { makeEvent, type EventEnvelope } from "../src/platform/eventing/envelope.js";
import { isFinanciallyConsistent } from "../src/modules/fulfillment/domain.js";
import { withTransaction } from "../src/platform/eventing/unit-of-work.js";
import {
  memoryPersistence,
  postgresPersistence,
  type Persistence,
} from "../src/platform/persistence/backends.js";

/**
 * The fulfillment settlement state after migration 0009 made a hold capturable
 * in legs.
 *
 * `settlement_state = 'released'` is a claim with a precise meaning: the hold
 * was voided and **no money moved**. Before this suite existed, three separate
 * paths wrote that value for a hold that had already moved part of the payer's
 * money, because the fulfillment vocabulary predated `partially_captured` and
 * the money port answered `unknown` so fulfillment had nothing to read.
 *
 * Every case here is a way CORE can end up asserting that money stayed in the
 * wallet when it did not. That is the worst class of defect available to this
 * module: `isFinanciallyConsistent` returned true, so the reconciliation read —
 * the one mechanism meant to surface exactly this — reported nothing, and the
 * closure event told MARKET the same falsehood.
 *
 * Both backends run every case, because the value is constrained by
 * `fulfillment_settlement_state_check` and
 * `fulfillment_settlement_alignment_check` in the schema as well as by the
 * service. A memory store that accepts a pair Postgres refuses would certify a
 * bug, and a database that refuses a pair the service legitimately produces
 * would fail in production only.
 */

const url = process.env.DATABASE_URL;
const CORRELATION = "corr-partial-settlement";

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
    `truncate event_delivery, event_subscription, membership, session, principal,
     identity_link, identity, organization, outbox, inbox, inbound_event,
     fulfillment, ledger_entry, ledger_transaction, payment_authorization,
     wallet, service_area, city, region, country, audit_entry
     restart identity cascade`,
  );
  await pool.end();
}

describe.each(backends)("partial settlement on $name", (backend) => {
  let store: Persistence;
  let close: () => Promise<void>;
  let core: CoreApp;
  let clock: FixedClock;
  let organizationId: string;

  beforeEach(async () => {
    await truncate();
    const opened = await backend.open();
    store = opened.store;
    close = opened.close;
    clock = new FixedClock();
    core = createCoreApp({ clock, persistence: store });
    organizationId = await organization();
  });

  afterEach(async () => {
    await close();
  });

  /**
   * Postgres has a foreign key from `fulfillment.organization_id`, so a real
   * organization is created rather than a fabricated identifier. The memory
   * backend does not need it and is unaffected by having it.
   */
  async function organization(): Promise<string> {
    const created = await core.organization.create({
      name: `org-${Math.random().toString(36).slice(2, 10)}`,
      country_code: "SA",
      correlation_id: CORRELATION,
    });
    return created.organization_id;
  }

  /** A wallet funded with `amount` and a hold for the whole of it. */
  async function fundedHold(reference: string, amount = 6_000) {
    const owner = await organization();
    const { wallet } = await core.money.createWallet({
      owner_type: "organization",
      owner_id: owner,
      currency: "SAR",
      correlation_id: CORRELATION,
    });
    await core.money.credit({
      wallet_id: wallet.wallet_id,
      amount_minor: amount,
      business_reference: `topup:${reference}`,
      correlation_id: CORRELATION,
    });
    const authorization = await core.money.authorize({
      wallet_id: wallet.wallet_id,
      amount_minor: amount,
      business_reference: `hold:${reference}`,
      correlation_id: CORRELATION,
    });
    return { wallet, authorization };
  }

  function order(orderId: string, authorizationId: string | null): EventEnvelope {
    return makeEvent({
      event_type: "market.order.created",
      version: 1,
      producer: "wasla-market",
      occurred_at: clock.now(),
      correlation_id: CORRELATION,
      entity_type: "commercial_order",
      entity_id: orderId,
      payload: {
        order_id: orderId,
        organization_id: organizationId,
        requested_service: "delivery",
        payment_authorization_id: authorizationId,
      },
    });
  }

  function rejection(fulfillmentId: string, reason: string): EventEnvelope {
    return makeEvent({
      event_type: "move.job.rejected",
      version: 1,
      producer: "wasla-move",
      occurred_at: clock.now(),
      correlation_id: CORRELATION,
      entity_type: "operational_job",
      entity_id: fulfillmentId,
      payload: { fulfillment_id: fulfillmentId, reason, rejected_at: clock.now().toISOString() },
    });
  }

  function completion(
    fulfillmentId: string,
    jobId: string,
    outcome: "completed" | "failed",
  ): EventEnvelope {
    return makeEvent({
      event_type: "move.job.completed",
      version: 1,
      producer: "wasla-move",
      occurred_at: clock.now(),
      correlation_id: CORRELATION,
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

  async function closureEvent(fulfillmentId: string) {
    return (await core.outbox.all()).find(
      (record) =>
        record.event.entity_id === fulfillmentId &&
        (record.event.event_type === "core.fulfillment.completed" ||
          record.event.event_type === "core.fulfillment.cancelled"),
    )?.event;
  }

  it("records a rejection after a partial capture as partially_captured, not released", async () => {
    const { wallet, authorization } = await fundedHold("reject");
    const created = await core.fulfillment.consumeMarketOrder(
      order("order-p1", authorization.authorization_id),
    );
    // 2 500 of the 6 000 consented amount leaves the wallet before MOVE answers.
    await core.money.capture({
      authorization_id: authorization.authorization_id,
      amount_minor: 2_500,
      capture_reference: "leg-1",
      correlation_id: CORRELATION,
    });

    const rejected = await core.fulfillment.consumeJobRejected(
      rejection(created.fulfillment_id, "no capacity"),
    );

    expect(rejected).toMatchObject({ status: "failed", settlement_state: "partially_captured" });
    // The money side agrees, and the wallet proves 2 500 actually moved: a
    // `released` record here would have asserted the balance was untouched.
    const hold = await core.money.getAuthorization(authorization.authorization_id);
    expect(hold).toMatchObject({ status: "partially_captured", captured_minor: 2_500 });
    expect(await core.money.balance(wallet.wallet_id)).toMatchObject({
      posted_minor: 3_500,
      held_minor: 0,
    });
  });

  it("surfaces money moved against failed work in the reconciliation read", async () => {
    const { authorization } = await fundedHold("reconcile");
    const created = await core.fulfillment.consumeMarketOrder(
      order("order-p2", authorization.authorization_id),
    );
    await core.money.capture({
      authorization_id: authorization.authorization_id,
      amount_minor: 1_000,
      capture_reference: "leg-1",
      correlation_id: CORRELATION,
    });
    const rejected = await core.fulfillment.consumeJobRejected(
      rejection(created.fulfillment_id, "no capacity"),
    );

    // Nothing is broken in the bookkeeping; the payer has simply paid for work
    // that did not happen, and whether that is refunded is not CORE's decision
    // (B-20). Reporting it is — an operator can act on a case CORE surfaced.
    expect(isFinanciallyConsistent(rejected)).toBe(false);
    const inconsistent = await core.fulfillment.listFinanciallyInconsistent(organizationId);
    expect(inconsistent.map((item) => item.fulfillment_id)).toContain(created.fulfillment_id);
  });

  it("publishes partially_captured on the closure contract MARKET consumes", async () => {
    const { authorization } = await fundedHold("contract");
    const created = await core.fulfillment.consumeMarketOrder(
      order("order-p3", authorization.authorization_id),
    );
    await core.money.capture({
      authorization_id: authorization.authorization_id,
      amount_minor: 2_000,
      capture_reference: "leg-1",
      correlation_id: CORRELATION,
    });

    await core.fulfillment.cancel({
      fulfillment_id: created.fulfillment_id,
      reason: "customer withdrew",
      correlation_id: CORRELATION,
    });

    // MARKET decides what to tell the customer from this field. Told
    // `released` it would say the money was returned, which would be wrong.
    expect((await closureEvent(created.fulfillment_id))?.payload).toMatchObject({
      reason: "customer withdrew",
      settlement_state: "partially_captured",
    });
  });

  it("keeps a cancellation that moved nothing reported as released", async () => {
    const { wallet, authorization } = await fundedHold("untouched");
    const created = await core.fulfillment.consumeMarketOrder(
      order("order-p4", authorization.authorization_id),
    );

    const cancelled = await core.fulfillment.cancel({
      fulfillment_id: created.fulfillment_id,
      reason: "customer withdrew",
      correlation_id: CORRELATION,
    });

    // The regression guard for the fix itself: widening the vocabulary must not
    // relabel the ordinary case, which is the one MARKET already consumes.
    expect(cancelled).toMatchObject({ status: "cancelled", settlement_state: "released" });
    expect(isFinanciallyConsistent(cancelled)).toBe(true);
    expect((await core.money.balance(wallet.wallet_id)).available_minor).toBe(6_000);
    expect(await core.fulfillment.listFinanciallyInconsistent(organizationId)).toHaveLength(0);
  });

  it("refuses an order whose hold already closed part-captured, and says so", async () => {
    const { authorization } = await fundedHold("intake");
    await core.money.capture({
      authorization_id: authorization.authorization_id,
      amount_minor: 2_500,
      capture_reference: "leg-1",
      correlation_id: CORRELATION,
    });
    await core.money.voidAuthorization({
      authorization_id: authorization.authorization_id,
      reason: "remainder released",
      correlation_id: CORRELATION,
    });

    const refused = await core.fulfillment.consumeMarketOrder(
      order("order-p5", authorization.authorization_id),
    );

    // Refused for the same reason a fully captured hold is: nothing is left to
    // guard the execution. Recorded truthfully, so it reaches reconciliation
    // instead of reading as a hold that was cleanly returned.
    expect(refused).toMatchObject({
      status: "failed",
      settlement_state: "partially_captured",
      closure_reason: "payment_hold_partially_captured",
    });
    expect(
      (await core.outbox.all()).filter((r) => r.event.event_type === "core.fulfillment.created"),
    ).toHaveLength(0);
    expect(isFinanciallyConsistent(refused)).toBe(false);
  });

  it("never reports a success it settled out of a hold that had already closed", async () => {
    const { authorization } = await fundedHold("late");
    const created = await core.fulfillment.consumeMarketOrder(
      order("order-p6", authorization.authorization_id),
    );
    await core.money.capture({
      authorization_id: authorization.authorization_id,
      amount_minor: 2_500,
      capture_reference: "leg-1",
      correlation_id: CORRELATION,
    });
    await core.money.voidAuthorization({
      authorization_id: authorization.authorization_id,
      reason: "remainder released",
      correlation_id: CORRELATION,
    });

    const closed = await core.fulfillment.consumeMoveCompletion(
      completion(created.fulfillment_id, "job-p6", "completed"),
    );

    // The capture is refused (the hold is closed), so the outcome flips to
    // failed as it always did. What changed is the money state: the closure no
    // longer claims the 2 500 never left.
    expect(closed.status).toBe("failed");
    expect(closed.closure_reason).toContain("payment_settlement_failed");
    expect(closed.settlement_state).toBe("partially_captured");
  });

  it("still captures the remainder of a part-captured hold when MOVE succeeds", async () => {
    const { wallet, authorization } = await fundedHold("remainder");
    const created = await core.fulfillment.consumeMarketOrder(
      order("order-p7", authorization.authorization_id),
    );
    await core.money.capture({
      authorization_id: authorization.authorization_id,
      amount_minor: 2_500,
      capture_reference: "leg-1",
      correlation_id: CORRELATION,
    });

    const closed = await core.fulfillment.consumeMoveCompletion(
      completion(created.fulfillment_id, "job-p7", "completed"),
    );

    // A hold left open by a partial capture still guards the execution, so
    // success captures what remains and the whole consented amount has moved.
    // `captured` is the truthful state here, not `partially_captured`.
    expect(closed).toMatchObject({ status: "completed", settlement_state: "captured" });
    expect(await core.money.getAuthorization(authorization.authorization_id)).toMatchObject({
      status: "captured",
      captured_minor: 6_000,
    });
    expect(await core.money.balance(wallet.wallet_id)).toMatchObject({
      posted_minor: 0,
      held_minor: 0,
    });
    expect(isFinanciallyConsistent(closed)).toBe(true);
    expect(await core.fulfillment.listFinanciallyInconsistent(organizationId)).toHaveLength(0);
  });

  it("accepts a completed fulfillment that cost less than the consented ceiling", async () => {
    const { authorization } = await fundedHold("cheaper");
    const created = await core.fulfillment.consumeMarketOrder(
      order("order-p8", authorization.authorization_id),
    );

    // Written through the repository rather than through a closure path,
    // because CORE has no route that captures part of a hold *and* completes:
    // that needs the amount from MARKET (recorded as an external dependency).
    // The assertion is about the pair being storable and consistent — which is
    // enforced by `fulfillment_settlement_alignment_check` on Postgres, so this
    // fails on the real engine if the migration is wrong.
    await core.money.capture({
      authorization_id: authorization.authorization_id,
      amount_minor: 4_000,
      capture_reference: "leg-1",
      correlation_id: CORRELATION,
    });
    await core.money.voidAuthorization({
      authorization_id: authorization.authorization_id,
      reason: "job cost less than quoted",
      correlation_id: CORRELATION,
    });
    const completed = {
      ...created,
      status: "completed" as const,
      settlement_state: "partially_captured" as const,
      completed_at: clock.now().toISOString(),
      closure_reason: null,
    };
    await withTransaction(store, async (uow) => {
      uow.stage((scope) => store.fulfillment.update(completed, scope));
    });

    expect(isFinanciallyConsistent(completed)).toBe(true);
    const stored = await core.fulfillment.require(created.fulfillment_id);
    expect(stored.settlement_state).toBe("partially_captured");
    expect(await core.fulfillment.listFinanciallyInconsistent(organizationId)).toHaveLength(0);
  });
});

describe("the settlement vocabulary and the database agree", () => {
  it("keeps every state the domain can produce inside the schema's value list", async () => {
    const { readFileSync } = await import("node:fs");
    const migration = readFileSync(
      new URL("../db/migrations/0011_fulfillment_partial_settlement.sql", import.meta.url).pathname,
      "utf8",
    );
    // The TypeScript union and the CHECK constraint are two declarations of one
    // vocabulary. Nothing else keeps them in step, and the last time they drifted
    // it took the whole `partially_captured` gap to notice.
    for (const state of ["none", "held", "captured", "partially_captured", "released", "unsettled"]) {
      expect(migration).toContain(`'${state}'`);
    }
  });

  it("publishes the same vocabulary on both closure contracts", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of [
      "core.fulfillment.completed.v1.schema.json",
      "core.fulfillment.cancelled.v1.schema.json",
    ]) {
      const schema = JSON.parse(
        readFileSync(new URL(`../contracts/events/${file}`, import.meta.url).pathname, "utf8"),
      );
      expect(schema.properties.settlement_state.enum).toContain("partially_captured");
    }
  });
});
