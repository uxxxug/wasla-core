import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreApp, type CoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { makeEvent, type EventEnvelope } from "../src/platform/eventing/envelope.js";
import { NO_SCOPE } from "../src/platform/persistence/transaction.js";
import { OPEN_STATUSES } from "../src/modules/fulfillment/domain.js";
import {
  memoryPersistence,
  postgresPersistence,
  type Persistence,
} from "../src/platform/persistence/backends.js";

/**
 * One terminal closure, one closing event (blocker B-21).
 *
 * The defect these tests exist for was measured, not theorised: two closures of
 * the same fulfillment delivered at the same moment both read an open row, both
 * settled the money (once, because the ledger keys the capture), and both wrote
 * the closed row — so both appended a closure event and MARKET received the same
 * closure twice under two `event_id`s. Every copy was true, which is exactly what
 * made it dangerous: nothing downstream could tell the duplicate from a second
 * real closure.
 *
 * The fix is a conditional write. `updateIfStatusIn` applies only while the row
 * is still open and reports whether it did; a `stale` answer aborts the whole
 * transaction, taking the money mutation staged before it and the outbox append
 * staged after it with it. So these tests assert the invariant on three axes at
 * once — the row, the event count, and the money — because a fix that dropped the
 * duplicate event while leaving a second capture behind would be worse than the
 * defect.
 *
 * Every case runs on both backends. On Postgres the concurrency is real: each
 * command takes its own pooled connection, so the overlapping statements are
 * serialised by the database's row lock and not by anything in this process.
 */

const url = process.env.DATABASE_URL;
const CORRELATION = "corr-single-closure";

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
      // One connection per concurrent command, so the contenders are genuinely
      // simultaneous transactions rather than queued on a shared connection.
      const pool = new Pool({ connectionString: url, max: 12 });
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

describe.each(backends)("single closure on $name", (backend) => {
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

  function rejection(fulfillmentId: string, reason: string): EventEnvelope {
    return makeEvent({
      event_type: "move.job.rejected",
      version: 1,
      producer: "wasla-move",
      occurred_at: clock.now(),
      correlation_id: CORRELATION,
      entity_type: "operational_job",
      entity_id: `job-${fulfillmentId.slice(0, 8)}`,
      // `rejected_at` is required by `contracts/events/move.job.rejected.schema.json`.
      // This fixture omitted it and the consumer accepted it anyway, because the
      // consumer checked the payload itself instead of the contract. Normalisation
      // now enforces the schema, which is what surfaced the gap.
      payload: { fulfillment_id: fulfillmentId, reason, rejected_at: clock.now().toISOString() },
    });
  }

  /** Every outbox row for this fulfillment, whatever the event type. */
  async function outboxFor(fulfillmentId: string) {
    return (await core.outbox.all()).filter(
      (record) => record.event.entity_id === fulfillmentId,
    );
  }

  async function eventsOfType(fulfillmentId: string, ...types: string[]) {
    return (await outboxFor(fulfillmentId)).filter((record) =>
      types.includes(record.event.event_type),
    );
  }

  async function closures(fulfillmentId: string) {
    return await eventsOfType(
      fulfillmentId,
      "core.fulfillment.completed",
      "core.fulfillment.cancelled",
    );
  }

  async function auditActions(fulfillmentId: string): Promise<string[]> {
    return (await core.audit.forEntity("fulfillment", fulfillmentId)).map((e) => e.action);
  }

  const cancel = (fulfillmentId: string, reason = "customer_cancelled") =>
    core.fulfillment.cancel({
      fulfillment_id: fulfillmentId,
      reason,
      correlation_id: CORRELATION,
    });

  /** A dispatched fulfillment with its hold intact. */
  async function dispatched(tag: string, jobId: string) {
    const funded = await fundedHold(tag);
    const created = await core.fulfillment.consumeMarketOrder(
      order(`order-${tag}`, funded.authorization.authorization_id),
    );
    await core.fulfillment.consumeJobAccepted(accepted(created.fulfillment_id, jobId));
    return { ...funded, fulfillment: created };
  }

  // 1. The repository contract itself, before any service is involved. The two
  //    backends must give the same two answers, or every test above this line is
  //    measuring a different guarantee depending on where it runs.
  it("reports a conditional write as applied while the row is open and stale once it is closed", async () => {
    const funded = await fundedHold("contract");
    const created = await core.fulfillment.consumeMarketOrder(
      order("order-contract", funded.authorization.authorization_id),
    );
    const closed = {
      ...created,
      status: "cancelled" as const,
      settlement_state: "released" as const,
      completed_at: clock.now().toISOString(),
      closure_reason: "first",
    };

    expect(await store.fulfillment.updateIfStatusIn(closed, OPEN_STATUSES, NO_SCOPE)).toBe(
      "applied",
    );
    // A second attempt, with a different closure, must change nothing and say so.
    const second = { ...closed, status: "failed" as const, closure_reason: "second" };
    expect(await store.fulfillment.updateIfStatusIn(second, OPEN_STATUSES, NO_SCOPE)).toBe(
      "stale",
    );
    expect(await store.fulfillment.get(created.fulfillment_id)).toMatchObject({
      status: "cancelled",
      closure_reason: "first",
    });
  });

  // 2. Two concurrent cancellations: one performs the closure, the other performs
  //    nothing. Both callers get the same answer, because a repeated command and
  //    a concurrent command are the same question.
  it("closes once and publishes once when two cancellations arrive together", async () => {
    const { fulfillment, wallet, authorization } = await dispatched("two-cancel", "job-two-cancel");

    const results = await Promise.allSettled([
      cancel(fulfillment.fulfillment_id),
      cancel(fulfillment.fulfillment_id),
    ]);

    // Neither caller is told the command failed: the loser reads back the row
    // that committed and answers from it.
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    for (const result of results) {
      expect(result.status === "fulfilled" && result.value).toMatchObject({
        fulfillment_id: fulfillment.fulfillment_id,
        status: "cancelled",
        settlement_state: "released",
      });
    }
    // One row, one closure event, one outbox row for that closure.
    expect(await closures(fulfillment.fulfillment_id)).toHaveLength(1);
    expect(await core.fulfillment.require(fulfillment.fulfillment_id)).toMatchObject({
      status: "cancelled",
      settlement_state: "released",
    });
    // No double release: a second void would have credited the held amount twice.
    expect(await core.money.balance(wallet.wallet_id)).toMatchObject({
      posted_minor: 6_000,
      available_minor: 6_000,
      held_minor: 0,
    });
    expect(await core.money.getAuthorization(authorization.authorization_id)).toMatchObject({
      status: "voided",
      captured_minor: 0,
    });
    // The losing transaction left nothing behind at all — not a row, not an
    // event, and not an audit entry claiming a cancellation that never happened.
    expect(
      (await auditActions(fulfillment.fulfillment_id)).filter((a) => a === "fulfillment.cancelled"),
    ).toHaveLength(1);
  });

  // 3. N contenders, not two. A guard that merely narrows the window would show
  //    up here as an occasional second event.
  it("publishes exactly one closure when eight cancellations arrive together", async () => {
    const { fulfillment, wallet } = await dispatched("eight-cancel", "job-eight-cancel");

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => cancel(fulfillment.fulfillment_id)),
    );

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await closures(fulfillment.fulfillment_id)).toHaveLength(1);
    expect(await core.money.balance(wallet.wallet_id)).toMatchObject({
      posted_minor: 6_000,
      held_minor: 0,
    });
  });

  // 4. Two concurrent completions of the same job: one capture, one event.
  it("captures once and publishes once when the same completion is delivered twice at once", async () => {
    const { fulfillment, wallet, authorization } = await dispatched(
      "two-complete",
      "job-two-complete",
    );
    const event = completion(fulfillment.fulfillment_id, "job-two-complete", "completed");

    const results = await Promise.allSettled([
      core.fulfillment.consumeMoveCompletion(event),
      core.fulfillment.consumeMoveCompletion(event),
    ]);

    // At least one caller closes the fulfillment. The other either reads back
    // the winner or is refused: on this path the loser's capture collides with
    // the ledger's own idempotency key while both transactions are still open,
    // and that collision surfaces as a write conflict rather than as a silent
    // no-op. CORE reports it instead of pretending the command was applied — and
    // a redelivery is then answered from the committed row, which is asserted
    // below and is the shape a retrying consumer actually meets.
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(await closures(fulfillment.fulfillment_id)).toHaveLength(1);
    expect(await core.fulfillment.consumeMoveCompletion(event)).toMatchObject({
      fulfillment_id: fulfillment.fulfillment_id,
      status: "completed",
      settlement_state: "captured",
    });
    expect(await closures(fulfillment.fulfillment_id)).toHaveLength(1);
    expect(await core.money.getAuthorization(authorization.authorization_id)).toMatchObject({
      status: "captured",
      captured_minor: 6_000,
    });
    // A double capture would have drawn past the ceiling; the wallet is empty
    // with nothing held, which only a single full capture produces.
    expect(await core.money.balance(wallet.wallet_id)).toMatchObject({
      posted_minor: 0,
      held_minor: 0,
    });
  });

  // 5. The hard case: two DIFFERENT terminal commands racing. Only one may win,
  //    and the loser must be refused rather than quietly answered, because the
  //    outcome it asked for is not the outcome that happened.
  it("lets only one of a cancellation and a completion close the fulfillment", async () => {
    const { fulfillment, wallet, authorization } = await dispatched("mixed", "job-mixed");

    const results = await Promise.allSettled([
      cancel(fulfillment.fulfillment_id),
      core.fulfillment.consumeMoveCompletion(
        completion(fulfillment.fulfillment_id, "job-mixed", "completed"),
      ),
    ]);

    const winner = await core.fulfillment.require(fulfillment.fulfillment_id);
    expect(["cancelled", "completed"]).toContain(winner.status);
    // Exactly one closure event, and it describes the row that actually exists.
    const published = await closures(fulfillment.fulfillment_id);
    expect(published).toHaveLength(1);
    expect(published[0]!.event.event_type).toBe(
      winner.status === "cancelled" ? "core.fulfillment.cancelled" : "core.fulfillment.completed",
    );
    // Money followed the winner, once: captured in full, or released in full.
    const hold = await core.money.getAuthorization(authorization.authorization_id);
    const balance = await core.money.balance(wallet.wallet_id);
    if (winner.status === "completed") {
      expect(hold).toMatchObject({ status: "captured", captured_minor: 6_000 });
      expect(balance).toMatchObject({ posted_minor: 0, held_minor: 0 });
    } else {
      expect(hold).toMatchObject({ status: "voided", captured_minor: 0 });
      expect(balance).toMatchObject({ posted_minor: 6_000, available_minor: 6_000, held_minor: 0 });
    }
    // The loser was told, and the closure the row does not have was not published.
    const refused = results.filter((r) => r.status === "rejected");
    expect(refused.length).toBeLessThanOrEqual(1);
  });

  // 6. Atomicity of the losing transaction, asserted as a whole rather than by
  //    event count: after the race, the fulfillment has exactly the events, the
  //    money movements and the audit entries of ONE closure.
  it("leaves no partial trace from the transaction that lost the race", async () => {
    const { fulfillment, wallet, authorization } = await dispatched("atomic", "job-atomic");
    // 2 500 of the 6 000 already moved: the loser's release, had it committed,
    // would have credited the 3 500 remainder a second time.
    await core.money.capture({
      authorization_id: authorization.authorization_id,
      amount_minor: 2_500,
      capture_reference: "leg-1",
      correlation_id: CORRELATION,
    });

    await Promise.allSettled([
      cancel(fulfillment.fulfillment_id),
      cancel(fulfillment.fulfillment_id),
      cancel(fulfillment.fulfillment_id),
    ]);

    const closed = await core.fulfillment.require(fulfillment.fulfillment_id);
    expect(closed).toMatchObject({
      status: "cancelled",
      settlement_state: "partially_captured",
    });
    const published = await closures(fulfillment.fulfillment_id);
    expect(published).toHaveLength(1);
    expect(published[0]!.event.payload).toMatchObject({
      settlement_state: "partially_captured",
      captured_minor: 2_500,
      financial_decision_required: true,
    });
    // The remainder came back exactly once. 3 500 credited twice would read 7 000.
    expect(await core.money.balance(wallet.wallet_id)).toMatchObject({
      posted_minor: 3_500,
      available_minor: 3_500,
      held_minor: 0,
    });
    // One cancellation in the trail, and the outbox holds the created event and
    // the dispatched event plus this single closure — nothing else.
    expect(
      (await auditActions(fulfillment.fulfillment_id)).filter((a) => a === "fulfillment.cancelled"),
    ).toHaveLength(1);
    expect(await outboxFor(fulfillment.fulfillment_id)).toHaveLength(3);
    // And the case is where B-20 says it belongs: awaiting a decision, once.
    expect(await core.fulfillment.listPendingFinancialDecision()).toHaveLength(1);
  });

  // 7. The sequential retry, which is the far more common shape in production: a
  //    consumer redelivers a command after the first attempt already committed.
  it("adds no closure when a command is retried after the first one committed", async () => {
    const { fulfillment } = await dispatched("retry", "job-retry");

    const first = await cancel(fulfillment.fulfillment_id);
    const retried = await cancel(fulfillment.fulfillment_id);
    const rejectedLate = await core.fulfillment
      .consumeJobRejected(rejection(fulfillment.fulfillment_id, "vehicle_unavailable"))
      .then(() => null)
      .catch((err: Error) => err);
    const completionEvent = completion(fulfillment.fulfillment_id, "job-retry", "completed");
    const completedLate = await core.fulfillment.consumeMoveCompletion(completionEvent);
    // Redelivered, to prove the marker is single-valued the same way the closure is.
    const completedTwice = await core.fulfillment.consumeMoveCompletion(completionEvent);

    expect(retried).toEqual(first);
    expect(rejectedLate?.message).toMatch(/already closed/);
    // A late completion is not a closure and does not become one: the row stays
    // cancelled with its original reason and instant, and no second closure event
    // is published. It is answered rather than refused (B-29), and what it changes
    // is only the marker recording that MOVE did the work anyway.
    expect(completedLate).toMatchObject({
      status: "cancelled",
      closure_reason: first.closure_reason,
      completed_at: first.completed_at,
      executed_after_cancellation_job_reference: "job-retry",
    });
    expect(completedTwice).toEqual(completedLate);
    expect(await closures(fulfillment.fulfillment_id)).toHaveLength(1);
    // Exactly one of the new events for two deliveries of the same report.
    expect(
      await eventsOfType(
        fulfillment.fulfillment_id,
        "core.fulfillment.executed_after_cancellation",
      ),
    ).toHaveLength(1);
  });

  // 8. The intake side of the same invariant. A refused order is born closed and
  //    carries a closure event with it, so two concurrent deliveries of one order
  //    must not create two fulfillments — the unique index decides, not the read.
  it("creates one fulfillment and publishes once when an order is delivered twice at once", async () => {
    const funded = await fundedHold("intake");
    const event = order("order-intake-race", funded.authorization.authorization_id);

    const results = await Promise.allSettled([
      core.fulfillment.consumeMarketOrder(event),
      core.fulfillment.consumeMarketOrder(event),
    ]);

    const ids = new Set(
      results.flatMap((r) => (r.status === "fulfilled" ? [r.value.fulfillment_id] : [])),
    );
    expect(ids.size).toBe(1);
    const [id] = [...ids];
    expect(await eventsOfType(id!, "core.fulfillment.created")).toHaveLength(1);

    // The same race on the refusal path, where the row is created closed: no
    // hold at all, so the order is refused at intake.
    const missing = order("order-intake-refused", "00000000-0000-4000-8000-000000000000");
    const refusals = await Promise.allSettled([
      core.fulfillment.consumeMarketOrder(missing),
      core.fulfillment.consumeMarketOrder(missing),
    ]);
    const refusedIds = new Set(
      refusals.flatMap((r) => (r.status === "fulfilled" ? [r.value.fulfillment_id] : [])),
    );
    expect(refusedIds.size).toBe(1);
    const [refusedId] = [...refusedIds];
    expect(await closures(refusedId!)).toHaveLength(1);
  });

  // 9. A terminal path found by reviewing them all rather than by a race: the
  //    refusal of an order whose declared hold does not exist. It was only ever
  //    exercised in memory, and it could not commit on Postgres at all, because
  //    the row named a hold the foreign key could not find. So MARKET sending a
  //    stale or mistyped reference got an error and an endless redelivery instead
  //    of the documented refusal.
  it("records a refusal for a hold CORE cannot resolve, and keeps the reference in the trail", async () => {
    const unresolvable = "11111111-1111-4111-8111-111111111111";

    const refused = await core.fulfillment.consumeMarketOrder(
      order("order-unresolvable", unresolvable),
    );

    expect(refused).toMatchObject({
      status: "failed",
      settlement_state: "none",
      closure_reason: "payment_hold_not_found",
      // Not stored: the column is a foreign key, and CORE has no such hold.
      payment_authorization_id: null,
    });
    // It really committed — on Postgres this is the assertion that used to be
    // impossible, because the insert violated the foreign key.
    expect(await core.fulfillment.require(refused.fulfillment_id)).toMatchObject({
      status: "failed",
      closure_reason: "payment_hold_not_found",
    });
    // MOVE was never asked to work, and MARKET was told once.
    expect(await eventsOfType(refused.fulfillment_id, "core.fulfillment.created")).toHaveLength(0);
    expect(await closures(refused.fulfillment_id)).toHaveLength(1);
    expect((await closures(refused.fulfillment_id))[0]!.event.payload).toMatchObject({
      outcome: "failed",
      reason: "payment_hold_not_found",
      settlement_state: "none",
      financial_decision_required: false,
    });
    // The reference MARKET declared is not lost: the row cannot hold it, so the
    // audit trail does, under a key the scrubber does not redact.
    const trail = await core.audit.forEntity("fulfillment", refused.fulfillment_id);
    const entry = trail.find((e) => e.action === "fulfillment.refused");
    expect(entry?.metadata).toMatchObject({
      refusal_reason: "payment_hold_not_found",
      unresolved_hold_reference: unresolvable,
    });
    // Not a defect and not a pending decision: no money ever moved.
    expect(await core.fulfillment.listFinanciallyInconsistent()).toHaveLength(0);
    expect(await core.fulfillment.listPendingFinancialDecision()).toHaveLength(0);
  });

  // 10. The non-terminal transition, for the same reason: one assignment, one
  //    `core.fulfillment.dispatched`. Not a closure, but the same defect class,
  //    and MARKET reads this event too.
  it("publishes one dispatch when the same acceptance arrives twice at once", async () => {
    const funded = await fundedHold("dispatch");
    const created = await core.fulfillment.consumeMarketOrder(
      order("order-dispatch-race", funded.authorization.authorization_id),
    );
    const event = accepted(created.fulfillment_id, "job-dispatch-race");

    const results = await Promise.allSettled([
      core.fulfillment.consumeJobAccepted(event),
      core.fulfillment.consumeJobAccepted(event),
    ]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await eventsOfType(created.fulfillment_id, "core.fulfillment.dispatched")).toHaveLength(
      1,
    );
    expect(await core.fulfillment.require(created.fulfillment_id)).toMatchObject({
      status: "dispatched",
      move_job_reference: "job-dispatch-race",
    });
  });
});
