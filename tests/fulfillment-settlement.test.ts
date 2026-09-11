/**
 * Money bound to execution: every fulfillment closure must leave the money in
 * a state that agrees with the execution outcome, and an inconsistency must be
 * explicit rather than silent.
 */
import { describe, expect, it } from "vitest";
import { createCoreApp, type CoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { makeEvent, type EventEnvelope } from "../src/platform/eventing/envelope.js";
import { isFinanciallyConsistent } from "../src/modules/fulfillment/domain.js";
import {
  FulfillmentService,
  InMemoryFulfillmentRepository,
  type FulfillmentPaymentPort,
} from "../src/modules/fulfillment/service.js";
import { InMemoryAuditLog } from "../src/platform/audit/audit.js";
import { InMemoryOutbox } from "../src/platform/eventing/outbox.js";

const CORRELATION = "corr-settlement";

function fundedOrder(
  core: CoreApp,
  orderId: string,
  authorizationId: string | null,
): EventEnvelope {
  return makeEvent({
    event_type: "market.order.created",
    version: 1,
    producer: "wasla-market",
    occurred_at: core.clock.now(),
    correlation_id: CORRELATION,
    entity_type: "commercial_order",
    entity_id: orderId,
    payload: {
      order_id: orderId,
      organization_id: "org-1",
      requested_service: "delivery",
      payment_authorization_id: authorizationId,
    },
  });
}

function completion(
  core: CoreApp,
  fulfillmentId: string,
  jobId: string,
  outcome: "completed" | "failed",
): EventEnvelope {
  return makeEvent({
    event_type: "move.job.completed",
    version: 1,
    producer: "wasla-move",
    occurred_at: core.clock.now(),
    correlation_id: CORRELATION,
    entity_type: "operational_job",
    entity_id: jobId,
    payload: {
      fulfillment_id: fulfillmentId,
      job_id: jobId,
      outcome,
      completed_at: core.clock.now().toISOString(),
    },
  });
}

/** A wallet funded with `amount` minor units plus a hold of the same amount. */
async function fundedHold(core: CoreApp, reference: string, amount = 5_000) {
  const { wallet } = core.money.createWallet({
    owner_type: "organization",
    owner_id: `org-${reference}`,
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

function closureEvent(core: CoreApp, fulfillmentId: string) {
  const record = core.outbox
    .all()
    .find(
      (r) =>
        r.event.entity_id === fulfillmentId &&
        (r.event.event_type === "core.fulfillment.completed" ||
          r.event.event_type === "core.fulfillment.cancelled"),
    );
  return record?.event;
}

describe("settlement state binds money to execution", () => {
  it("holds the money while the work is open and captures it on success", async () => {
    const core = createCoreApp({ clock: new FixedClock() });
    const { wallet, authorization } = await fundedHold(core, "success");

    const created = await core.fulfillment.consumeMarketOrder(
      fundedOrder(core, "order-s1", authorization.authorization_id),
    );
    expect(created.settlement_state).toBe("held");
    expect(core.money.balance(wallet.wallet_id).held_minor).toBe(5_000);

    const closed = await core.fulfillment.consumeMoveCompletion(
      completion(core, created.fulfillment_id, "job-s1", "completed"),
    );
    expect(closed).toMatchObject({ status: "completed", settlement_state: "captured" });
    expect(core.money.getAuthorization(authorization.authorization_id).status).toBe("captured");
    expect(core.money.balance(wallet.wallet_id)).toMatchObject({
      held_minor: 0,
      posted_minor: 0,
    });
    expect(isFinanciallyConsistent(closed)).toBe(true);
    expect(core.fulfillment.listFinanciallyInconsistent()).toHaveLength(0);
  });

  it("releases the hold when MOVE reports a failed execution", async () => {
    const core = createCoreApp({ clock: new FixedClock() });
    const { wallet, authorization } = await fundedHold(core, "failure");
    const created = await core.fulfillment.consumeMarketOrder(
      fundedOrder(core, "order-s2", authorization.authorization_id),
    );

    const closed = await core.fulfillment.consumeMoveCompletion(
      completion(core, created.fulfillment_id, "job-s2", "failed"),
    );

    expect(closed).toMatchObject({ status: "failed", settlement_state: "released" });
    expect(core.money.getAuthorization(authorization.authorization_id).status).toBe("voided");
    expect(core.money.balance(wallet.wallet_id).available_minor).toBe(5_000);
    expect(core.fulfillment.listFinanciallyInconsistent()).toHaveLength(0);
  });

  it("releases the hold on cancellation and on MOVE rejection", async () => {
    const core = createCoreApp({ clock: new FixedClock() });
    const cancelHold = await fundedHold(core, "cancel");
    const rejectHold = await fundedHold(core, "reject");

    const toCancel = await core.fulfillment.consumeMarketOrder(
      fundedOrder(core, "order-s3", cancelHold.authorization.authorization_id),
    );
    const cancelled = await core.fulfillment.cancel({
      fulfillment_id: toCancel.fulfillment_id,
      reason: "customer withdrew",
      correlation_id: CORRELATION,
    });
    expect(cancelled).toMatchObject({ status: "cancelled", settlement_state: "released" });
    expect(core.money.balance(cancelHold.wallet.wallet_id).held_minor).toBe(0);

    const toReject = await core.fulfillment.consumeMarketOrder(
      fundedOrder(core, "order-s4", rejectHold.authorization.authorization_id),
    );
    const rejected = await core.fulfillment.consumeJobRejected(
      makeEvent({
        event_type: "move.job.rejected",
        version: 1,
        producer: "wasla-move",
        occurred_at: core.clock.now(),
        correlation_id: CORRELATION,
        entity_type: "operational_job",
        entity_id: toReject.fulfillment_id,
        payload: {
          fulfillment_id: toReject.fulfillment_id,
          reason: "no capacity",
          rejected_at: core.clock.now().toISOString(),
        },
      }),
    );
    expect(rejected).toMatchObject({ status: "failed", settlement_state: "released" });
    expect(core.money.balance(rejectHold.wallet.wallet_id).held_minor).toBe(0);
    expect(core.fulfillment.listFinanciallyInconsistent()).toHaveLength(0);
  });

  it("publishes the settlement state on the closure contract", async () => {
    const core = createCoreApp({ clock: new FixedClock() });
    const { authorization } = await fundedHold(core, "contract");
    const created = await core.fulfillment.consumeMarketOrder(
      fundedOrder(core, "order-s5", authorization.authorization_id),
    );
    await core.fulfillment.consumeMoveCompletion(
      completion(core, created.fulfillment_id, "job-s5", "completed"),
    );

    const event = closureEvent(core, created.fulfillment_id);
    expect(event?.payload).toMatchObject({ outcome: "completed", settlement_state: "captured" });
  });
});

describe("a hold that cannot guard the execution is refused at intake", () => {
  it("refuses an order whose declared hold does not exist and never asks MOVE to work", async () => {
    const core = createCoreApp({ clock: new FixedClock() });
    const refused = await core.fulfillment.consumeMarketOrder(
      fundedOrder(core, "order-s6", "11111111-1111-4111-8111-111111111111"),
    );

    expect(refused).toMatchObject({
      status: "failed",
      settlement_state: "none",
      closure_reason: "payment_hold_not_found",
    });
    expect(
      core.outbox.all().filter((r) => r.event.event_type === "core.fulfillment.created"),
    ).toHaveLength(0);
    expect(closureEvent(core, refused.fulfillment_id)?.payload).toMatchObject({
      outcome: "failed",
      reason: "payment_hold_not_found",
    });
    expect(core.fulfillment.listFinanciallyInconsistent()).toHaveLength(0);
  });

  it("refuses an order whose hold has already expired and releases it", async () => {
    const clock = new FixedClock();
    const core = createCoreApp({ clock });
    const { wallet } = await fundedHold(core, "expiry");
    // The first hold consumes the funded balance; top up so a second, expiring
    // hold can be authorized.
    await core.money.credit({
      wallet_id: wallet.wallet_id,
      amount_minor: 100,
      business_reference: "topup:expiry-extra",
      correlation_id: CORRELATION,
    });
    const shortHold = await core.money.authorize({
      wallet_id: wallet.wallet_id,
      amount_minor: 1,
      business_reference: "hold:expiring",
      correlation_id: CORRELATION,
      expires_at: new Date(clock.now().getTime() + 60_000),
    });
    clock.advance(120_000);

    const refused = await core.fulfillment.consumeMarketOrder(
      fundedOrder(core, "order-s7", shortHold.authorization_id),
    );

    expect(refused).toMatchObject({
      status: "failed",
      settlement_state: "released",
      closure_reason: "payment_hold_expired",
    });
    expect(core.money.getAuthorization(shortHold.authorization_id).status).toBe("voided");
    expect(core.fulfillment.listFinanciallyInconsistent()).toHaveLength(0);
  });

  it("refuses an order whose hold was already voided", async () => {
    const core = createCoreApp({ clock: new FixedClock() });
    const { authorization } = await fundedHold(core, "voided");
    await core.money.voidAuthorization({
      authorization_id: authorization.authorization_id,
      reason: "released early",
      correlation_id: CORRELATION,
    });

    const refused = await core.fulfillment.consumeMarketOrder(
      fundedOrder(core, "order-s8", authorization.authorization_id),
    );
    expect(refused).toMatchObject({
      status: "failed",
      settlement_state: "released",
      closure_reason: "payment_hold_not_authorized",
    });
  });

  it("still coordinates an unfunded order", async () => {
    const core = createCoreApp({ clock: new FixedClock() });
    const created = await core.fulfillment.consumeMarketOrder(fundedOrder(core, "order-s9", null));
    expect(created).toMatchObject({ status: "coordinating", settlement_state: "none" });
    expect(
      core.outbox.all().filter((r) => r.event.event_type === "core.fulfillment.created"),
    ).toHaveLength(1);
  });
});

describe("an unreleasable hold is reported, never swallowed", () => {
  /** A payment port whose void always fails, as an out-of-band capture would. */
  function brokenPort(): FulfillmentPaymentPort {
    return {
      capture: async () => {
        throw new Error("authorization cannot be captured");
      },
      voidAuthorization: async () => {
        throw new Error("a captured authorization cannot be voided");
      },
      getAuthorization: () => ({ status: "authorized", expires_at: null }),
    };
  }

  function serviceWithBrokenPort() {
    const clock = new FixedClock();
    const outbox = new InMemoryOutbox(clock);
    const audit = new InMemoryAuditLog(clock);
    const service = new FulfillmentService(
      new InMemoryFulfillmentRepository(),
      outbox,
      audit,
      clock,
      brokenPort(),
    );
    return { service, outbox, audit, clock };
  }

  function order(clock: FixedClock, orderId: string): EventEnvelope {
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
        organization_id: "org-1",
        requested_service: "delivery",
        payment_authorization_id: "22222222-2222-4222-8222-222222222222",
      },
    });
  }

  it("marks a cancellation whose hold cannot be released as unsettled and audits it", async () => {
    const { service, audit } = serviceWithBrokenPort();
    const clock = new FixedClock();
    const created = await service.consumeMarketOrder(order(clock, "order-u1"));

    const cancelled = await service.cancel({
      fulfillment_id: created.fulfillment_id,
      reason: "operator cancelled",
      correlation_id: CORRELATION,
    });

    expect(cancelled).toMatchObject({ status: "cancelled", settlement_state: "unsettled" });
    expect(isFinanciallyConsistent(cancelled)).toBe(false);
    const inconsistency = audit
      .forEntity("fulfillment", created.fulfillment_id)
      .find((entry) => entry.action === "fulfillment.settlement_inconsistent");
    expect(inconsistency).toBeDefined();
    expect(inconsistency?.metadata).toMatchObject({ attempted: "void" });
    expect(service.listFinanciallyInconsistent()).toHaveLength(1);
  });

  it("never reports success when the hold could not be captured", async () => {
    const { service } = serviceWithBrokenPort();
    const clock = new FixedClock();
    const created = await service.consumeMarketOrder(order(clock, "order-u2"));
    await service.consumeJobAccepted(
      makeEvent({
        event_type: "move.job.accepted",
        version: 1,
        producer: "wasla-move",
        occurred_at: clock.now(),
        correlation_id: CORRELATION,
        entity_type: "operational_job",
        entity_id: "job-u2",
        payload: {
          fulfillment_id: created.fulfillment_id,
          job_id: "job-u2",
          accepted_at: clock.now().toISOString(),
        },
      }),
    );

    const closed = await service.consumeMoveCompletion(
      makeEvent({
        event_type: "move.job.completed",
        version: 1,
        producer: "wasla-move",
        occurred_at: clock.now(),
        correlation_id: CORRELATION,
        entity_type: "operational_job",
        entity_id: "job-u2",
        payload: {
          fulfillment_id: created.fulfillment_id,
          job_id: "job-u2",
          outcome: "completed",
          completed_at: clock.now().toISOString(),
        },
      }),
    );

    expect(closed.status).toBe("failed");
    expect(closed.closure_reason).toContain("payment_settlement_failed");
    expect(closed.settlement_state).toBe("unsettled");
  });

  it("scopes the reconciliation read to one organization", async () => {
    const { service } = serviceWithBrokenPort();
    const clock = new FixedClock();
    const created = await service.consumeMarketOrder(order(clock, "order-u3"));
    await service.cancel({
      fulfillment_id: created.fulfillment_id,
      reason: "operator cancelled",
      correlation_id: CORRELATION,
    });

    expect(service.listFinanciallyInconsistent("org-1")).toHaveLength(1);
    expect(service.listFinanciallyInconsistent("org-other")).toHaveLength(0);
  });
});
