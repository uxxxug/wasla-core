import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createCoreApp, type CoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { makeEvent, type EventEnvelope } from "../src/platform/eventing/envelope.js";
import { NO_SCOPE } from "../src/platform/persistence/transaction.js";
import { financialDisposition } from "../src/modules/fulfillment/domain.js";
import {
  memoryPersistence,
  postgresPersistence,
  type Persistence,
} from "../src/platform/persistence/backends.js";

/**
 * MOVE delivered work after CORE had already cancelled the order (blocker B-29).
 *
 * The defect was measured against this code, not imagined. MOVE executes over
 * minutes; a cancellation can land in the middle of that. CORE closed the
 * fulfillment `cancelled`, released the hold and told MARKET, which told the
 * customer their order was cancelled and gave the money back. MOVE's already
 * in-flight `move.job.completed` then arrived saying the work was done, and CORE
 * answered it with a 409. Two things followed, both bad:
 *
 *   1. The inbound dispatcher retries anything thrown at it, and this refusal can
 *      never come good — a cancelled fulfillment does not reopen. So the report was
 *      retried five times across hours of backoff and then dead-lettered as an
 *      error string in `inbound_event`. The only record that the work happened was
 *      a failed queue row.
 *   2. The fulfillment read `cancelled` + `released`, which is a textbook settled
 *      cancellation, so `listFinanciallyInconsistent()` and
 *      `listPendingFinancialDecision()` both returned nothing. CORE asserted that
 *      no money question was open while a driver had delivered the order for free.
 *
 * What CORE does now is record the fact and answer the report. It moves no money,
 * deliberately: the hold was voided by the cancellation and a voided hold cannot be
 * captured, and re-charging a payer who has been told their order was cancelled is
 * not a decision CORE has been given. Who pays MOVE, whether the payer is
 * re-charged and who absorbs the loss are policy questions of B-20's kind. CORE's
 * job is to hold the question where someone can see it, and to tell MARKET, which
 * is the only side that can talk to the customer.
 *
 * The existing simultaneous-race test in `fulfillment-single-closure.test.ts`
 * covered neither of these: it asserts the losing closure changes nothing, which
 * is still true. The shape that mattered is sequential, and nothing covered it.
 *
 * Every case runs on both backends, because the guard is a conditional write and a
 * check constraint, and an in-memory-only proof would say nothing about the one
 * that ships.
 */

const url = process.env.DATABASE_URL;
const CORRELATION = "corr-post-cancellation";
const NEW_EVENT = "core.fulfillment.executed_after_cancellation";

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

describe.each(backends)("execution after cancellation on $name", (backend) => {
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

  /** A wallet funded with `amount` and a hold over the whole of it. */
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

  function accepted(fulfillmentId: string, jobId: string): EventEnvelope {
    return makeEvent({
      event_type: "move.job.accepted",
      version: 1,
      producer: "wasla-move",
      occurred_at: clock.now(),
      correlation_id: CORRELATION,
      entity_type: "operational_job",
      entity_id: jobId,
      payload: {
        fulfillment_id: fulfillmentId,
        job_id: jobId,
        accepted_at: clock.now().toISOString(),
      },
    });
  }

  function completion(
    fulfillmentId: string,
    jobId: string,
    outcome: "completed" | "failed",
    completedAt = clock.now().toISOString(),
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
        completed_at: completedAt,
      },
    });
  }

  async function outboxFor(fulfillmentId: string) {
    return (await core.outbox.all()).filter((record) => record.event.entity_id === fulfillmentId);
  }

  async function eventsOfType(fulfillmentId: string, type: string) {
    return (await outboxFor(fulfillmentId)).filter((r) => r.event.event_type === type);
  }

  async function auditActions(fulfillmentId: string): Promise<string[]> {
    return (await core.audit.forEntity("fulfillment", fulfillmentId)).map((e) => e.action);
  }

  /** A cancelled fulfillment whose hold was released, and MOVE still working. */
  async function cancelledAfterDispatch(tag: string, jobId: string) {
    const funded = await fundedHold(tag);
    const created = await core.fulfillment.consumeMarketOrder(
      order(`order-${tag}`, funded.authorization.authorization_id),
    );
    await core.fulfillment.consumeJobAccepted(accepted(created.fulfillment_id, jobId));
    const cancelled = await core.fulfillment.cancel({
      fulfillment_id: created.fulfillment_id,
      reason: "customer_cancelled",
      correlation_id: CORRELATION,
    });
    return { ...funded, fulfillment: cancelled };
  }

  // 1. The whole defect in one case: the report is answered, the fact is recorded,
  //    no money moves, MARKET is told, and the money question is queued where
  //    someone will look at it.
  it("records the execution, publishes it and leaves the money exactly where the cancellation left it", async () => {
    const { wallet, authorization, fulfillment } = await cancelledAfterDispatch("main", "job-main");
    expect(fulfillment).toMatchObject({ status: "cancelled", settlement_state: "released" });
    const executedAt = "2026-01-01T04:30:00.000Z";

    const marked = await core.fulfillment.consumeMoveCompletion(
      completion(fulfillment.fulfillment_id, "job-main", "completed", executedAt),
    );

    // The cancellation is untouched. It happened, and it is still the truth about
    // the order; the new fact sits beside it rather than overwriting it.
    expect(marked).toMatchObject({
      status: "cancelled",
      settlement_state: "released",
      closure_reason: "customer_cancelled",
      completed_at: fulfillment.completed_at,
      // MOVE's own instant, not CORE's receipt time. The distance between the two
      // closure instants is the first question anyone asks about one of these.
      executed_after_cancellation_at: executedAt,
      executed_after_cancellation_job_reference: "job-main",
    });
    expect(await core.fulfillment.require(fulfillment.fulfillment_id)).toEqual(marked);

    // No second closure, and no re-publication of the cancellation: MARKET already
    // handled that one and must not handle it twice.
    expect(await eventsOfType(fulfillment.fulfillment_id, "core.fulfillment.cancelled")).toHaveLength(
      1,
    );
    expect(await eventsOfType(fulfillment.fulfillment_id, "core.fulfillment.completed")).toHaveLength(
      0,
    );

    const published = await eventsOfType(fulfillment.fulfillment_id, NEW_EVENT);
    expect(published).toHaveLength(1);
    expect(published[0]!.event.payload).toMatchObject({
      fulfillment_id: fulfillment.fulfillment_id,
      organization_id: organizationId,
      order_reference: "order-main",
      job_id: "job-main",
      executed_at: executedAt,
      cancelled_at: fulfillment.completed_at,
      cancellation_reason: "customer_cancelled",
      settlement_state: "released",
      financial_decision_required: true,
    });

    // The money is where the cancellation put it: fully back, hold gone. CORE
    // cannot capture a voided hold and will not re-charge a refunded payer.
    expect(await core.money.balance(wallet.wallet_id)).toMatchObject({
      posted_minor: 6_000,
      held_minor: 0,
    });
    expect(await core.money.getAuthorization(authorization.authorization_id)).toMatchObject({
      status: "voided",
      captured_minor: 0,
    });

    expect(await auditActions(fulfillment.fulfillment_id)).toContain(
      "fulfillment.executed_after_cancellation",
    );

    // And the reading that was wrong before: this fulfillment now says a money
    // decision is open on it, instead of claiming to be settled.
    expect(financialDisposition(marked)).toBe("decision_required");
    const pending = await core.fulfillment.listPendingFinancialDecision();
    expect(pending.map((f) => f.fulfillment_id)).toEqual([fulfillment.fulfillment_id]);
  });

  // 2. Redelivery. MOVE's queue retries, so the same report will arrive again. One
  //    marker, one event, one audit entry — the marker is as single-valued as the
  //    closure it sits next to.
  it("records the same report once however many times it is delivered", async () => {
    const { fulfillment } = await cancelledAfterDispatch("twice", "job-twice");
    const report = completion(fulfillment.fulfillment_id, "job-twice", "completed");

    const first = await core.fulfillment.consumeMoveCompletion(report);
    const second = await core.fulfillment.consumeMoveCompletion(report);
    // A different job reporting afterwards must not overwrite the first record
    // either: the earliest report is the one that is kept.
    const other = await core.fulfillment.consumeMoveCompletion(
      completion(fulfillment.fulfillment_id, "job-other", "completed", "2026-02-02T00:00:00.000Z"),
    );

    expect(second).toEqual(first);
    expect(other).toEqual(first);
    expect(await eventsOfType(fulfillment.fulfillment_id, NEW_EVENT)).toHaveLength(1);
    expect(
      (await auditActions(fulfillment.fulfillment_id)).filter(
        (a) => a === "fulfillment.executed_after_cancellation",
      ),
    ).toHaveLength(1);
    expect(await core.fulfillment.listPendingFinancialDecision()).toHaveLength(1);
  });

  // 3. `failed` after a cancellation is not this case. MOVE saying the work was not
  //    delivered and CORE saying the order was cancelled agree with each other, so
  //    there is nothing to record and nobody has a decision to take. It is still
  //    answered rather than refused, because a 409 would be retried until the
  //    report was dead-lettered over a report that contradicts nothing.
  it("records nothing when the late report says the work was not delivered", async () => {
    const { fulfillment } = await cancelledAfterDispatch("failed", "job-failed");

    const answered = await core.fulfillment.consumeMoveCompletion(
      completion(fulfillment.fulfillment_id, "job-failed", "failed"),
    );

    expect(answered).toMatchObject({
      status: "cancelled",
      executed_after_cancellation_at: null,
      executed_after_cancellation_job_reference: null,
    });
    expect(await eventsOfType(fulfillment.fulfillment_id, NEW_EVENT)).toHaveLength(0);
    expect(await core.fulfillment.listPendingFinancialDecision()).toHaveLength(0);
    expect(await core.fulfillment.listFinanciallyInconsistent()).toHaveLength(0);
  });

  // 4. The ordering that produces this most often, and the reason the job reference
  //    is stored separately: the cancellation beat MOVE's acceptance, so
  //    `move_job_reference` is null and there is nowhere else to put the job id.
  it("records the job that reported even when the cancellation beat MOVE's acceptance", async () => {
    const funded = await fundedHold("early");
    const created = await core.fulfillment.consumeMarketOrder(
      order("order-early", funded.authorization.authorization_id),
    );
    const cancelled = await core.fulfillment.cancel({
      fulfillment_id: created.fulfillment_id,
      reason: "customer_cancelled",
      correlation_id: CORRELATION,
    });
    expect(cancelled.move_job_reference).toBeNull();

    const marked = await core.fulfillment.consumeMoveCompletion(
      completion(created.fulfillment_id, "job-early", "completed"),
    );

    expect(marked).toMatchObject({
      move_job_reference: null,
      executed_after_cancellation_job_reference: "job-early",
    });
    const published = await eventsOfType(created.fulfillment_id, NEW_EVENT);
    expect(published[0]!.event.payload).toMatchObject({ job_id: "job-early" });
  });

  // 5. The queue consequence, end to end. This is the half of the defect that was
  //    invisible from the service: the report used to be retried until the inbound
  //    row was dead-lettered. It must now be processed on the first pass.
  it("processes the late report through the inbound queue instead of dead-lettering it", async () => {
    const { fulfillment } = await cancelledAfterDispatch("queue", "job-queue");
    const report = completion(fulfillment.fulfillment_id, "job-queue", "completed");

    expect(await core.ingress.submit("wasla-move", report)).toMatchObject({ accepted: true });
    const drained = await core.dispatcher.drainOnce();

    expect(drained).toMatchObject({ processed: 1, failed: 0, dead: 0 });
    expect(await store.inbound.byStatus("processed")).toHaveLength(1);
    expect(await store.inbound.byStatus("dead")).toHaveLength(0);
    expect(await core.fulfillment.require(fulfillment.fulfillment_id)).toMatchObject({
      executed_after_cancellation_job_reference: "job-queue",
    });
  });

  // 6. The repository contract underneath, on both backends. The service's early
  //    return is a fast path; this conditional write is the actual guard, and if the
  //    two backends disagree about it every case above measures a different thing
  //    depending on where it runs.
  it("applies the marker only while the row is cancelled and unmarked", async () => {
    const { fulfillment } = await cancelledAfterDispatch("repo", "job-repo");
    const mark = (jobReference: string, executedAt: string) =>
      store.fulfillment.markExecutedAfterCancellation(
        {
          fulfillment_id: fulfillment.fulfillment_id,
          executed_at: executedAt,
          job_reference: jobReference,
        },
        NO_SCOPE,
      );

    expect(await mark("job-a", "2026-01-01T05:00:00.000Z")).toBe("applied");
    // Already marked: refused, and the first record stands.
    expect(await mark("job-b", "2026-01-02T05:00:00.000Z")).toBe("stale");
    expect(await store.fulfillment.get(fulfillment.fulfillment_id)).toMatchObject({
      executed_after_cancellation_job_reference: "job-a",
      executed_after_cancellation_at: "2026-01-01T05:00:00.000Z",
    });

    // A row that is not cancelled is not this case at all, whatever it is: an open
    // fulfillment is still live and a completed one delivered what it charged for.
    const open = await core.fulfillment.consumeMarketOrder(order("order-open", null));
    expect(
      await store.fulfillment.markExecutedAfterCancellation(
        {
          fulfillment_id: open.fulfillment_id,
          executed_at: "2026-01-01T05:00:00.000Z",
          job_reference: "job-open",
        },
        NO_SCOPE,
      ),
    ).toBe("stale");
    expect(await store.fulfillment.get(open.fulfillment_id)).toMatchObject({
      executed_after_cancellation_at: null,
    });

    // An absent row is stale, not a crash: a report can outlive its fulfillment.
    expect(
      await store.fulfillment.markExecutedAfterCancellation(
        {
          fulfillment_id: randomUUID(),
          executed_at: "2026-01-01T05:00:00.000Z",
          job_reference: "job-absent",
        },
        NO_SCOPE,
      ),
    ).toBe("stale");
  });

  // 7. The disposition ordering. A marker means a decision is open, but it must not
  //    hide a real defect: a row still holding money is inconsistent first, because
  //    that is CORE's own bug and this is someone else's decision.
  it("reads a marked cancellation as a decision and never as settled", async () => {
    const { fulfillment } = await cancelledAfterDispatch("disposition", "job-disposition");
    const marked = await core.fulfillment.consumeMoveCompletion(
      completion(fulfillment.fulfillment_id, "job-disposition", "completed"),
    );

    expect(financialDisposition({ ...marked, settlement_state: "released" })).toBe(
      "decision_required",
    );
    // No hold ever existed, so no money question is open, but work was still
    // delivered against a cancelled order and someone must decide about it.
    expect(financialDisposition({ ...marked, settlement_state: "none" })).toBe("decision_required");
    // Still holding money on a closed row is CORE failing to finish its own work.
    // That reading must survive the marker.
    expect(financialDisposition({ ...marked, settlement_state: "held" })).toBe("inconsistent");
    expect(financialDisposition({ ...marked, settlement_state: "unsettled" })).toBe("inconsistent");
    // And the unmarked cancellation is unaffected: a released hold is settled.
    expect(financialDisposition({ ...fulfillment, settlement_state: "released" })).toBe("settled");
  });
});

// 8. The database's own guards, which no in-memory backend can express. The marker
//    is two columns that are only ever written together and only ever on a
//    cancelled row; a half-written marker would make the event unbuildable and a
//    marker on an open row would put a live fulfillment in the decision queue.
describe.runIf(url)("execution-after-cancellation constraints in postgres", () => {
  it("refuses a half-written marker and a marker on a row that is not cancelled", async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url, max: 1 });
    try {
      const org = randomUUID();
      await pool.query(
        `insert into organization (organization_id, name, country_code, status,
           source_system, created_at)
         values ($1, $2, 'SA', 'active', 'core', now())`,
        [org, `org-${org.slice(0, 8)}`],
      );
      const insert = async (
        status: string,
        settlement: string,
        executedAt: string | null,
        jobReference: string | null,
      ) =>
        await pool.query(
          `insert into fulfillment (fulfillment_id, organization_id, market_order_reference,
             status, settlement_state, created_at, completed_at,
             executed_after_cancellation_at, executed_after_cancellation_job_reference)
           values ($1, $2, $3, $4, $5, now(), now(), $6, $7)`,
          [randomUUID(), org, `order-${randomUUID()}`, status, settlement, executedAt, jobReference],
        );

      // Both columns or neither.
      await expect(insert("cancelled", "released", "2026-01-01T00:00:00Z", null)).rejects.toThrow(
        /fulfillment_execution_after_cancellation_check/,
      );
      await expect(insert("cancelled", "released", null, "job-x")).rejects.toThrow(
        /fulfillment_execution_after_cancellation_check/,
      );
      // Only on a cancellation.
      await expect(
        insert("completed", "captured", "2026-01-01T00:00:00Z", "job-x"),
      ).rejects.toThrow(/fulfillment_execution_after_cancellation_status_check/);
      // The shape the code writes is accepted.
      await expect(
        insert("cancelled", "released", "2026-01-01T00:00:00Z", "job-x"),
      ).resolves.toBeTruthy();
    } finally {
      await pool.end();
    }
  });
});
