import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreApp, type CoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { makeEvent, type EventEnvelope } from "../src/platform/eventing/envelope.js";
import {
  financialDisposition,
  isFinanciallyConsistent,
  requiresFinancialDecision,
} from "../src/modules/fulfillment/domain.js";
import {
  memoryPersistence,
  postgresPersistence,
  type Persistence,
} from "../src/platform/persistence/backends.js";

/**
 * The contract for money that moved before the work stopped (blocker B-20).
 *
 * The previous cycle made `partially_captured` storable, so CORE stopped
 * claiming that 2 500 came back when it had not. That fixed the record but left
 * the consequence implicit: a `core.fulfillment.cancelled` event carrying a
 * money state a consumer may ignore is still read downstream as "the customer
 * was refunded", and the reconciliation read mixed those cases in with CORE's
 * own bookkeeping defects.
 *
 * These tests pin the five closure shapes end to end — what the row says, what
 * the wallet says, what the event says, and which queue the case lands in — so
 * the boundary between "CORE recorded the truth" and "somebody still owes a
 * decision" cannot be crossed by accident. None of them asserts a policy: no
 * test here expects a refund, a fee, or a settlement of the captured amount,
 * because none of those has been decided.
 *
 * Both backends run every case. The pairs are constrained by
 * `fulfillment_settlement_alignment_check` as well as by the service, and a
 * memory store more permissive than Postgres certifies bugs.
 */

const url = process.env.DATABASE_URL;
const CORRELATION = "corr-financial-decision";

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

describe.each(backends)("financial decision boundary on $name", (backend) => {
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

  async function organization(): Promise<string> {
    const created = await core.organization.create({
      name: `org-${Math.random().toString(36).slice(2, 10)}`,
      country_code: "SA",
      correlation_id: CORRELATION,
    });
    return created.organization_id;
  }

  /** A wallet funded with `amount`, and a hold over the whole of it. */
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

  async function closureEvents(fulfillmentId: string) {
    return (await core.outbox.all())
      .filter(
        (record) =>
          record.event.entity_id === fulfillmentId &&
          (record.event.event_type === "core.fulfillment.completed" ||
            record.event.event_type === "core.fulfillment.cancelled"),
      )
      .map((record) => record.event);
  }

  async function capture(authorizationId: string, amount: number, reference: string) {
    await core.money.capture({
      authorization_id: authorizationId,
      amount_minor: amount,
      capture_reference: reference,
      correlation_id: CORRELATION,
    });
  }

  // (a) Nothing moved. `released` is true here, and the event must say so
  //     plainly so the ordinary refundable cancellation stays ordinary.
  it("reports a cancellation that moved no money as fully released, with no decision pending", async () => {
    const { wallet, authorization } = await fundedHold("a-none");
    const created = await core.fulfillment.consumeMarketOrder(
      order("order-fd-a", authorization.authorization_id),
    );

    const cancelled = await core.fulfillment.cancel({
      fulfillment_id: created.fulfillment_id,
      reason: "customer_cancelled",
      correlation_id: CORRELATION,
    });

    expect(cancelled).toMatchObject({ status: "cancelled", settlement_state: "released" });
    expect(financialDisposition(cancelled)).toBe("settled");
    expect(requiresFinancialDecision(cancelled)).toBe(false);
    expect(isFinanciallyConsistent(cancelled)).toBe(true);
    // The whole 6 000 is spendable again and the hold reserves nothing.
    expect(await core.money.balance(wallet.wallet_id)).toMatchObject({
      posted_minor: 6_000,
      available_minor: 6_000,
      held_minor: 0,
    });
    const [event] = await closureEvents(created.fulfillment_id);
    expect(event?.payload).toMatchObject({
      settlement_state: "released",
      captured_minor: 0,
      financial_decision_required: false,
    });
    expect(await core.fulfillment.listPendingFinancialDecision(organizationId)).toHaveLength(0);
    expect(await core.fulfillment.listFinanciallyInconsistent(organizationId)).toHaveLength(0);
  });

  // (b) The reference case: 6 000 reserved, 2 500 moved, execution cancelled.
  //     CORE must keep the 2 500 on the record, must not publish anything a
  //     consumer can read as a refund, and must not consider the case finished.
  it("keeps a cancellation after a partial capture out of the refunded and the settled piles", async () => {
    const { wallet, authorization } = await fundedHold("b-partial");
    const created = await core.fulfillment.consumeMarketOrder(
      order("order-fd-b", authorization.authorization_id),
    );
    await capture(authorization.authorization_id, 2_500, "leg-1");

    const cancelled = await core.fulfillment.cancel({
      fulfillment_id: created.fulfillment_id,
      reason: "customer_cancelled",
      correlation_id: CORRELATION,
    });

    expect(cancelled).toMatchObject({
      status: "cancelled",
      settlement_state: "partially_captured",
    });
    // The money truth, independently: 2 500 left the wallet and stayed out.
    expect(await core.money.getAuthorization(authorization.authorization_id)).toMatchObject({
      status: "partially_captured",
      captured_minor: 2_500,
    });
    expect(await core.money.balance(wallet.wallet_id)).toMatchObject({
      posted_minor: 3_500,
      available_minor: 3_500,
      held_minor: 0,
    });

    // The event carries the amount and the pending decision. Both matter: the
    // state alone is a value a consumer may not recognise, and an unrecognised
    // money state used to be read as "released".
    const [event] = await closureEvents(created.fulfillment_id);
    expect(event?.payload).toMatchObject({
      settlement_state: "partially_captured",
      captured_minor: 2_500,
      financial_decision_required: true,
    });

    // Not settled, and not a CORE defect either: it is the decision queue.
    expect(financialDisposition(cancelled)).toBe("decision_required");
    expect(isFinanciallyConsistent(cancelled)).toBe(false);
    const pending = await core.fulfillment.listPendingFinancialDecision(organizationId);
    expect(pending.map((item) => item.fulfillment_id)).toEqual([created.fulfillment_id]);

    // And CORE decided nothing on its own. A refund would have credited the
    // 2 500 back and the posted balance would read 6 000; it reads 3 500, so no
    // refund was posted and none is implied by the cancellation.
    expect(await core.money.balance(wallet.wallet_id)).toMatchObject({ posted_minor: 3_500 });
  });

  // (c) The work was delivered. The full ceiling is captured and nothing is
  //     pending — this is the path that must stay clean of the new flag.
  it("settles a completed execution with the whole hold captured and nothing pending", async () => {
    const { wallet, authorization } = await fundedHold("c-full");
    const created = await core.fulfillment.consumeMarketOrder(
      order("order-fd-c", authorization.authorization_id),
    );

    const closed = await core.fulfillment.consumeMoveCompletion(
      completion(created.fulfillment_id, "job-fd-c", "completed"),
    );

    expect(closed).toMatchObject({ status: "completed", settlement_state: "captured" });
    expect(financialDisposition(closed)).toBe("settled");
    expect(await core.money.getAuthorization(authorization.authorization_id)).toMatchObject({
      status: "captured",
      captured_minor: 6_000,
    });
    expect(await core.money.balance(wallet.wallet_id)).toMatchObject({
      posted_minor: 0,
      held_minor: 0,
    });
    const [event] = await closureEvents(created.fulfillment_id);
    expect(event?.payload).toMatchObject({
      outcome: "completed",
      settlement_state: "captured",
      financial_decision_required: false,
    });
    // `captured_minor` is the whole ceiling, and it is stated. This assertion
    // used to pin the opposite — that the amount was absent because the capture
    // port reported a ledger transaction rather than the hold. That made the
    // success event the only closure event carrying no amount, so "what did this
    // delivered order cost" was answerable for cancelled work and not for
    // completed work. The port now reports the hold's running total, so the
    // figure is one CORE was given and not one it inferred.
    expect(event?.payload).toMatchObject({ captured_minor: 6_000 });
    expect(await core.fulfillment.listPendingFinancialDecision(organizationId)).toHaveLength(0);
    expect(await core.fulfillment.listFinanciallyInconsistent(organizationId)).toHaveLength(0);
  });

  // (d) The same closure delivered twice. The financial truth is written once.
  it("does not move the financial truth twice when a closure is repeated", async () => {
    const { wallet, authorization } = await fundedHold("d-repeat");
    const created = await core.fulfillment.consumeMarketOrder(
      order("order-fd-d", authorization.authorization_id),
    );
    await capture(authorization.authorization_id, 2_500, "leg-1");

    const first = await core.fulfillment.cancel({
      fulfillment_id: created.fulfillment_id,
      reason: "customer_cancelled",
      correlation_id: CORRELATION,
    });
    // Cancel again, then let a late completion arrive for the same fulfillment.
    const second = await core.fulfillment.cancel({
      fulfillment_id: created.fulfillment_id,
      reason: "customer_cancelled_again",
      correlation_id: CORRELATION,
    });
    // A late completion for an already cancelled fulfillment is refused rather
    // than allowed to overwrite the outcome. The refusal is what keeps the
    // money truth single-valued: a second settlement attempt here would try to
    // capture a hold that is already closed.
    await expect(
      core.fulfillment.consumeMoveCompletion(
        completion(created.fulfillment_id, "job-fd-d", "completed"),
      ),
    ).rejects.toThrow(/cancelled/);

    // One outcome, one reason, one closure event, one capture.
    expect(second).toMatchObject({
      status: "cancelled",
      settlement_state: "partially_captured",
      closure_reason: first.closure_reason,
      completed_at: first.completed_at,
    });
    expect(await core.fulfillment.require(created.fulfillment_id)).toMatchObject({
      status: "cancelled",
      settlement_state: "partially_captured",
      closure_reason: first.closure_reason,
    });
    expect(await closureEvents(created.fulfillment_id)).toHaveLength(1);
    expect(await core.money.getAuthorization(authorization.authorization_id)).toMatchObject({
      status: "partially_captured",
      captured_minor: 2_500,
    });
    // 3 500 back, 2 500 out — once. A second release would have credited the
    // remainder twice and posted 6 000.
    expect(await core.money.balance(wallet.wallet_id)).toMatchObject({
      posted_minor: 3_500,
      available_minor: 3_500,
    });
    expect(await core.fulfillment.listPendingFinancialDecision(organizationId)).toHaveLength(1);
  });

  // (e) Duplicate delivery at the same time — the shape a retrying broker
  //     produces. Neither a second capture nor a second release may happen.
  it("captures and releases once when the same closure is delivered concurrently", async () => {
    const settled = await fundedHold("e-concurrent-settle");
    const settledFulfillment = await core.fulfillment.consumeMarketOrder(
      order("order-fd-e1", settled.authorization.authorization_id),
    );
    const event = completion(settledFulfillment.fulfillment_id, "job-fd-e1", "completed");
    const settleResults = await Promise.allSettled([
      core.fulfillment.consumeMoveCompletion(event),
      core.fulfillment.consumeMoveCompletion(event),
    ]);
    // One may lose a race and reject; what matters is the money, not which.
    expect(settleResults.some((result) => result.status === "fulfilled")).toBe(true);
    expect(await core.money.getAuthorization(settled.authorization.authorization_id)).toMatchObject({
      status: "captured",
      captured_minor: 6_000,
    });
    // A double capture would have drawn more than the ceiling; the wallet is at
    // zero with nothing held, which only the single full capture produces.
    expect(await core.money.balance(settled.wallet.wallet_id)).toMatchObject({
      posted_minor: 0,
      held_minor: 0,
    });
    // Money stays single-valued because the capture is keyed in the ledger, and
    // since B-21 the closure is single-valued too: the closing update applies
    // only while the row is still open, so the losing transaction rolls back and
    // takes its outbox row with it. Exactly one closure event, whichever
    // transaction won. `tests/fulfillment-single-closure.test.ts` holds the full
    // proof; this file keeps the assertion because the money facts it asserts
    // are only meaningful if the event carrying them is not duplicated.
    const settledEvents = await closureEvents(settledFulfillment.fulfillment_id);
    expect(settledEvents).toHaveLength(1);
    for (const closure of settledEvents) {
      expect(closure.payload).toMatchObject({
        outcome: "completed",
        settlement_state: "captured",
        financial_decision_required: false,
      });
    }
    expect(await core.fulfillment.require(settledFulfillment.fulfillment_id)).toMatchObject({
      status: "completed",
      settlement_state: "captured",
    });

    const released = await fundedHold("e-concurrent-release");
    const releasedFulfillment = await core.fulfillment.consumeMarketOrder(
      order("order-fd-e2", released.authorization.authorization_id),
    );
    await capture(released.authorization.authorization_id, 2_500, "leg-1");
    const cancelResults = await Promise.allSettled([
      core.fulfillment.cancel({
        fulfillment_id: releasedFulfillment.fulfillment_id,
        reason: "customer_cancelled",
        correlation_id: CORRELATION,
      }),
      core.fulfillment.cancel({
        fulfillment_id: releasedFulfillment.fulfillment_id,
        reason: "customer_cancelled",
        correlation_id: CORRELATION,
      }),
    ]);
    expect(cancelResults.some((result) => result.status === "fulfilled")).toBe(true);
    // The remainder came back exactly once, and the 2 500 stayed out exactly
    // once: a double release would have credited 3 500 twice.
    expect(await core.money.balance(released.wallet.wallet_id)).toMatchObject({
      posted_minor: 3_500,
      available_minor: 3_500,
      held_minor: 0,
    });
    expect(
      (await core.fulfillment.require(releasedFulfillment.fulfillment_id)).settlement_state,
    ).toBe("partially_captured");

    // Two cancels that genuinely overlap now produce one cancellation: the
    // conditional closing write (B-21) lets exactly one commit, and the other
    // unwinds completely — no second event, no second release. Before that fix
    // this assertion had to tolerate two.
    const events = await closureEvents(releasedFulfillment.fulfillment_id);
    expect(events).toHaveLength(1);
    for (const closure of events) {
      expect(closure.payload).toMatchObject({
        settlement_state: "partially_captured",
        captured_minor: 2_500,
        financial_decision_required: true,
      });
    }
  });

  // The two reconciliation reads answer different questions, and an operator
  // has to be able to tell a business decision from a CORE defect.
  it("keeps the pending-decision queue separate from the defect queue", async () => {
    const decision = await fundedHold("f-decision");
    const decided = await core.fulfillment.consumeMarketOrder(
      order("order-fd-f1", decision.authorization.authorization_id),
    );
    await capture(decision.authorization.authorization_id, 2_500, "leg-1");
    await core.fulfillment.cancel({
      fulfillment_id: decided.fulfillment_id,
      reason: "customer_cancelled",
      correlation_id: CORRELATION,
    });

    // A defect: money left for work that was never coordinated. CORE records it
    // as `unsettled`, which needs an engineer and not a pricing decision.
    const broken = await fundedHold("f-broken");
    await core.money.capture({
      authorization_id: broken.authorization.authorization_id,
      correlation_id: CORRELATION,
    });
    const refused = await core.fulfillment.consumeMarketOrder(
      order("order-fd-f2", broken.authorization.authorization_id),
    );
    expect(refused).toMatchObject({ status: "failed", settlement_state: "unsettled" });

    const inconsistent = await core.fulfillment.listFinanciallyInconsistent(organizationId);
    const pending = await core.fulfillment.listPendingFinancialDecision(organizationId);
    // Both are open money questions, so both are inconsistent...
    expect(inconsistent.map((item) => item.fulfillment_id).sort()).toEqual(
      [decided.fulfillment_id, refused.fulfillment_id].sort(),
    );
    // ...but only one of them is waiting on a decision rather than a fix.
    expect(pending.map((item) => item.fulfillment_id)).toEqual([decided.fulfillment_id]);
    expect(financialDisposition(refused)).toBe("inconsistent");
  });

  // The operator-facing surface, over HTTP, on both backends.
  it("serves the pending-decision queue and the derived disposition over HTTP", async () => {
    const registered = await core.identity.registerIdentity({
      channel_type: "web",
      external_id: `admin-${Math.random().toString(36).slice(2, 10)}`,
      correlation_id: CORRELATION,
    });
    await core.identity.grantMembership({
      principal_id: registered.principal.principal_id,
      organization_id: organizationId,
      roles: ["platform_admin"],
      correlation_id: CORRELATION,
    });
    const { token } = await core.identity.issueSession({
      principal_id: registered.principal.principal_id,
      channel_type: "web",
      correlation_id: CORRELATION,
    });
    const headers = { authorization: `Bearer ${token}` };

    const { authorization } = await fundedHold("g-http");
    const created = await core.fulfillment.consumeMarketOrder(
      order("order-fd-g", authorization.authorization_id),
    );
    await capture(authorization.authorization_id, 2_500, "leg-1");
    await core.fulfillment.cancel({
      fulfillment_id: created.fulfillment_id,
      reason: "customer_cancelled",
      correlation_id: CORRELATION,
    });

    const queue = await core.router.handle({
      method: "GET",
      url: `/v1/fulfillments/reconciliation/pending-financial-decision?organization_id=${organizationId}`,
      headers,
    });
    expect(queue.status).toBe(200);
    expect(queue.body).toMatchObject({ count: 1 });
    expect((queue.body as { items: { financial_disposition: string }[] }).items[0]).toMatchObject({
      fulfillment_id: created.fulfillment_id,
      settlement_state: "partially_captured",
      financial_disposition: "decision_required",
    });

    const read = await core.router.handle({
      method: "GET",
      url: `/v1/fulfillments/${created.fulfillment_id}`,
      headers,
    });
    expect(read.body).toMatchObject({ financial_disposition: "decision_required" });

    // The route is registered before the parameterised one, so it is never read
    // as a fulfillment id.
    expect(
      (
        await core.router.handle({
          method: "GET",
          url: "/v1/fulfillments/reconciliation/pending-financial-decision",
          headers,
        })
      ).status,
    ).toBe(400);
  });
});
