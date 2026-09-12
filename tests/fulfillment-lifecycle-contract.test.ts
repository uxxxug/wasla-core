import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreApp, type CoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { makeEvent, type EventEnvelope } from "../src/platform/eventing/envelope.js";
import { carriesTenantScope } from "../src/modules/notification/domain.js";
import {
  memoryPersistence,
  postgresPersistence,
  type Persistence,
} from "../src/platform/persistence/backends.js";

/**
 * What the fulfillment lifecycle events promise the systems that consume them.
 *
 * MARKET → CORE → MOVE → CORE → MARKET only works if the events CORE publishes
 * in the middle are self-sufficient. Two things they were not:
 *
 *  1. **No tenant.** `core.fulfillment.dispatched`, `.completed` and
 *     `.cancelled` named the fulfillment, the order and the money and never the
 *     organization — the one fact only CORE owns. A consumer could not route a
 *     closure by tenant without calling CORE back, and a tenant-scoped
 *     notification recipient for those types matched nothing, for ever, which
 *     is why `NotificationRecipientRegistry` had to refuse the registration
 *     outright (blocker B-23).
 *  2. **No amount on success.** Both closure events could carry
 *     `captured_minor`, but only the failure paths ever did: the capture port
 *     answered `unknown`, so a delivered order published no figure at all. The
 *     amount a payer paid was therefore readable for work that was cancelled
 *     and not for work that was performed.
 *
 * These tests pin both as guarantees rather than as current behaviour, and pin
 * them against the **published schemas** rather than against the code that
 * produces them — a payload and a contract that are only checked against each
 * other by hand drift apart, which is how the `move.job.rejected` consumer came
 * to accept a payload its own contract forbade.
 *
 * Both backends run every case: the alignment check in the schema constrains
 * these pairs too, and a memory store more permissive than Postgres certifies a
 * bug instead of catching it.
 */

const url = process.env.DATABASE_URL;
const CORRELATION = "corr-lifecycle-contract";

/** The published contract for an event type, read from the repository. */
function schemaFor(eventType: string): {
  required: string[];
  properties: Record<string, unknown>;
  additionalProperties: boolean;
} {
  const path = new URL(
    `../contracts/events/${eventType}.v1.schema.json`,
    import.meta.url,
  ).pathname;
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Asserts a payload satisfies the published schema's structural promises.
 *
 * Deliberately not a full JSON Schema validator: this checks the two properties
 * that actually go wrong between a producer and its contract — a required field
 * the producer forgot, and a field the producer invented that the contract
 * forbids. Types are already pinned by the assertions in each test.
 */
function assertMatchesContract(eventType: string, payload: Record<string, unknown>): void {
  const schema = schemaFor(eventType);
  for (const field of schema.required) {
    expect(
      Object.prototype.hasOwnProperty.call(payload, field),
      `${eventType} payload is missing required field "${field}"`,
    ).toBe(true);
    expect(payload[field], `${eventType} required field "${field}" is null/undefined`).not.toBe(
      undefined,
    );
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(payload)) {
      expect(
        Object.prototype.hasOwnProperty.call(schema.properties, key),
        `${eventType} payload carries "${key}", which the contract does not declare`,
      ).toBe(true);
    }
  }
}

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

describe.each(backends)("fulfillment lifecycle events on $name", (backend) => {
  let close: () => Promise<void>;
  let core: CoreApp;
  let clock: FixedClock;
  let organizationId: string;

  beforeEach(async () => {
    await truncate();
    const opened = await backend.open();
    close = opened.close;
    clock = new FixedClock();
    core = createCoreApp({ clock, persistence: opened.store });
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

  function order(
    orderId: string,
    authorizationId: string | null,
    tenant = organizationId,
  ): EventEnvelope {
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
        organization_id: tenant,
        requested_service: "delivery",
        payment_authorization_id: authorizationId,
      },
    });
  }

  function acceptance(fulfillmentId: string, jobId: string): EventEnvelope {
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

  function rejection(fulfillmentId: string, jobId: string): EventEnvelope {
    return makeEvent({
      event_type: "move.job.rejected",
      version: 1,
      producer: "wasla-move",
      occurred_at: clock.now(),
      correlation_id: CORRELATION,
      entity_type: "operational_job",
      entity_id: jobId,
      payload: {
        fulfillment_id: fulfillmentId,
        reason: "no_capacity",
        rejected_at: clock.now().toISOString(),
      },
    });
  }

  /** Every event CORE published about this fulfillment. Order is not implied. */
  async function published(fulfillmentId: string) {
    return (await core.outbox.all())
      .map((record) => record.event)
      .filter(
        (event) =>
          event.entity_id === fulfillmentId && event.event_type.startsWith("core.fulfillment."),
      );
  }

  /**
   * The one event of a given type published about this fulfillment.
   *
   * Selected by type rather than by position. Under a fixed clock every event in
   * a run shares an `occurred_at`, so "the last one in the outbox" is not a
   * defined thing to ask for, and a test that asked for it would pass or fail on
   * how the store happened to order equal rows. Asserting there is exactly one
   * is also the assertion worth making: a second closure event is B-21.
   */
  async function only(fulfillmentId: string, eventType: string) {
    const matches = (await published(fulfillmentId)).filter(
      (event) => event.event_type === eventType,
    );
    expect(matches, `expected exactly one ${eventType}`).toHaveLength(1);
    return matches[0]!;
  }

  // ─────────────────────────── the tenant on every event ───────────────────────────

  it("names the tenant on every lifecycle event of a whole successful run", async () => {
    const { authorization } = await fundedHold("tenant-happy");
    const created = await core.fulfillment.consumeMarketOrder(
      order("order-tenant-1", authorization.authorization_id),
    );
    await core.fulfillment.consumeJobAccepted(acceptance(created.fulfillment_id, "job-tenant-1"));
    await core.fulfillment.consumeMoveCompletion(
      completion(created.fulfillment_id, "job-tenant-1", "completed"),
    );

    const events = await published(created.fulfillment_id);
    // Sorted, not compared in outbox order: every event in this run is stamped
    // by the same fixed clock, so the store is free to return them in any order
    // and asserting one would be asserting an implementation detail. What the
    // run guarantees is that all three exist, exactly once each.
    expect(events.map((event) => event.event_type).sort()).toEqual([
      "core.fulfillment.completed",
      "core.fulfillment.created",
      "core.fulfillment.dispatched",
    ]);
    // The whole point: not one of the three leaves the consumer guessing.
    for (const event of events) {
      expect(
        (event.payload as { organization_id?: string }).organization_id,
        `${event.event_type} must name its tenant`,
      ).toBe(organizationId);
      assertMatchesContract(event.event_type, event.payload as Record<string, unknown>);
    }
  });

  it("names the tenant on a cancellation and on a MOVE rejection", async () => {
    const cancelledHold = await fundedHold("tenant-cancel");
    const toCancel = await core.fulfillment.consumeMarketOrder(
      order("order-tenant-2", cancelledHold.authorization.authorization_id),
    );
    await core.fulfillment.cancel({
      fulfillment_id: toCancel.fulfillment_id,
      reason: "customer_cancelled",
      correlation_id: CORRELATION,
    });

    const rejectedHold = await fundedHold("tenant-reject");
    const toReject = await core.fulfillment.consumeMarketOrder(
      order("order-tenant-3", rejectedHold.authorization.authorization_id),
    );
    await core.fulfillment.consumeJobRejected(rejection(toReject.fulfillment_id, "job-tenant-3"));

    const cancellation = (await published(toCancel.fulfillment_id)).find(
      (event) => event.event_type === "core.fulfillment.cancelled",
    );
    const rejected = (await published(toReject.fulfillment_id)).find(
      (event) => event.event_type === "core.fulfillment.completed",
    );

    expect(cancellation?.payload).toMatchObject({
      organization_id: organizationId,
      settlement_state: "released",
    });
    // A MOVE rejection closes as `failed`, which is published on the completed
    // event with `outcome: "failed"` — a tenant is needed there just as much.
    expect(rejected?.payload).toMatchObject({
      organization_id: organizationId,
      outcome: "failed",
      settlement_state: "released",
    });
    assertMatchesContract("core.fulfillment.cancelled", cancellation!.payload as never);
    assertMatchesContract("core.fulfillment.completed", rejected!.payload as never);
  });

  it("names the tenant even when the fulfillment is born closed by a refused hold", async () => {
    // The refusal path is the one place a fulfillment is created and closed in a
    // single transaction, and the only event it ever publishes is the closure —
    // `core.fulfillment.created` is deliberately never sent. If the tenant were
    // taken from a prior created event rather than from the row, this is the
    // case that would carry nothing.
    const created = await core.fulfillment.consumeMarketOrder(
      order("order-tenant-4", "00000000-0000-4000-8000-000000000000"),
    );
    expect(created).toMatchObject({
      status: "failed",
      closure_reason: "payment_hold_not_found",
    });

    const events = await published(created.fulfillment_id);
    expect(events.map((event) => event.event_type)).toEqual(["core.fulfillment.completed"]);
    expect(events[0]!.payload).toMatchObject({
      organization_id: organizationId,
      outcome: "failed",
    });
    assertMatchesContract("core.fulfillment.completed", events[0]!.payload as never);
  });

  it("carries the tenant of the order it was created for, not of the last order seen", async () => {
    // Two tenants, interleaved. A tenant read from anywhere other than the
    // fulfillment row — a service field, a cached last value — passes every
    // single-tenant test above and fails this one.
    const other = await organization();
    const first = await core.fulfillment.consumeMarketOrder(order("order-tenant-5", null));
    const second = await core.fulfillment.consumeMarketOrder(
      order("order-tenant-6", null, other),
    );

    await core.fulfillment.cancel({
      fulfillment_id: first.fulfillment_id,
      reason: "customer_cancelled",
      correlation_id: CORRELATION,
    });
    await core.fulfillment.cancel({
      fulfillment_id: second.fulfillment_id,
      reason: "customer_cancelled",
      correlation_id: CORRELATION,
    });

    const firstClosure = await only(first.fulfillment_id, "core.fulfillment.cancelled");
    const secondClosure = await only(second.fulfillment_id, "core.fulfillment.cancelled");
    expect(firstClosure.payload).toMatchObject({ organization_id: organizationId });
    expect(secondClosure.payload).toMatchObject({ organization_id: other });
    expect(organizationId).not.toBe(other);
  });

  // ───────────────────────── the amount that actually moved ─────────────────────────

  it("states the whole captured amount when the work is delivered", async () => {
    const { wallet, authorization } = await fundedHold("amount-full");
    const created = await core.fulfillment.consumeMarketOrder(
      order("order-amount-1", authorization.authorization_id),
    );
    const closed = await core.fulfillment.consumeMoveCompletion(
      completion(created.fulfillment_id, "job-amount-1", "completed"),
    );

    expect(closed).toMatchObject({ status: "completed", settlement_state: "captured" });
    const closure = await only(created.fulfillment_id, "core.fulfillment.completed");
    expect(closure.payload).toMatchObject({
      outcome: "completed",
      settlement_state: "captured",
      captured_minor: 6_000,
      financial_decision_required: false,
    });
    // The figure is the money module's, not the event's own arithmetic.
    expect(await core.money.getAuthorization(authorization.authorization_id)).toMatchObject({
      status: "captured",
      captured_minor: 6_000,
    });
    expect(await core.money.balance(wallet.wallet_id)).toMatchObject({ held_minor: 0 });
  });

  it("states the running total, not the amount of the last capture leg", async () => {
    // The falsifiable one. 6 000 held, 2 500 captured out of band, then the work
    // completes and CORE captures the 3 500 remainder. An implementation that
    // reported the ledger leg would publish 3 500 — a true number about the
    // wrong thing, and an understatement of what the payer paid by 2 500.
    const { authorization } = await fundedHold("amount-legs");
    const created = await core.fulfillment.consumeMarketOrder(
      order("order-amount-2", authorization.authorization_id),
    );
    await core.money.capture({
      authorization_id: authorization.authorization_id,
      amount_minor: 2_500,
      capture_reference: "leg-1",
      correlation_id: CORRELATION,
    });

    const closed = await core.fulfillment.consumeMoveCompletion(
      completion(created.fulfillment_id, "job-amount-2", "completed"),
    );

    expect(closed).toMatchObject({ status: "completed", settlement_state: "captured" });
    const closure = await only(created.fulfillment_id, "core.fulfillment.completed");
    expect(closure.payload).toMatchObject({
      settlement_state: "captured",
      captured_minor: 6_000,
    });
    expect((closure.payload as { captured_minor: number }).captured_minor).not.toBe(3_500);
  });

  it("publishes no amount when there was no hold to capture", async () => {
    // Absence still means "not observed" and must not become 0. An unfunded
    // order coordinates and completes; nothing moved, and CORE says nothing
    // about an amount rather than saying zero moved.
    const created = await core.fulfillment.consumeMarketOrder(order("order-amount-3", null));
    const closed = await core.fulfillment.consumeMoveCompletion(
      completion(created.fulfillment_id, "job-amount-3", "completed"),
    );

    expect(closed).toMatchObject({ status: "completed", settlement_state: "none" });
    const closure = await only(created.fulfillment_id, "core.fulfillment.completed");
    expect(closure.payload).not.toHaveProperty("captured_minor");
    assertMatchesContract("core.fulfillment.completed", closure.payload as never);
  });

  it("does not restate or double the amount when the completion is redelivered", async () => {
    const { authorization } = await fundedHold("amount-repeat");
    const created = await core.fulfillment.consumeMarketOrder(
      order("order-amount-4", authorization.authorization_id),
    );
    const event = completion(created.fulfillment_id, "job-amount-4", "completed");

    await core.fulfillment.consumeMoveCompletion(event);
    await core.fulfillment.consumeMoveCompletion(event);
    await core.fulfillment.consumeMoveCompletion(event);

    const closures = (await published(created.fulfillment_id)).filter(
      (item) => item.event_type === "core.fulfillment.completed",
    );
    // One closure, one amount. At-least-once delivery must not turn into
    // at-least-once money.
    expect(closures).toHaveLength(1);
    expect(closures[0]!.payload).toMatchObject({ captured_minor: 6_000 });
    expect(await core.money.getAuthorization(authorization.authorization_id)).toMatchObject({
      captured_minor: 6_000,
    });
  });
});

// ───────────────────── the contract, independent of any backend ─────────────────────

describe("the published lifecycle contracts and the notification registry agree", () => {
  const lifecycleEvents = [
    "core.fulfillment.created",
    "core.fulfillment.dispatched",
    "core.fulfillment.completed",
    "core.fulfillment.cancelled",
  ];

  it("requires organization_id in every published fulfillment event schema", () => {
    for (const eventType of lifecycleEvents) {
      const schema = schemaFor(eventType);
      expect(schema.required, `${eventType} must require organization_id`).toContain(
        "organization_id",
      );
      expect(schema.properties).toHaveProperty("organization_id");
    }
  });

  it("treats exactly the events that name a tenant as tenant-scopable", () => {
    // The registry's list and the schemas are two statements of one fact. When
    // they disagree the failure is silent in the worst direction: a recipient is
    // accepted for an event that cannot match it, and nobody is notified.
    for (const eventType of lifecycleEvents) {
      expect(carriesTenantScope(eventType), `${eventType} should be tenant-scopable`).toBe(true);
    }
    // And the guard still holds where it should: a CORE event with no
    // organization in its payload is still refused a tenant scope.
    expect(carriesTenantScope("core.payment.captured")).toBe(false);
    expect(carriesTenantScope("core.identity.verified")).toBe(false);
  });

  it("declares captured_minor on both closure contracts", () => {
    for (const eventType of ["core.fulfillment.completed", "core.fulfillment.cancelled"]) {
      const schema = schemaFor(eventType);
      expect(schema.properties).toHaveProperty("captured_minor");
      // Optional on purpose, and it must stay optional: absent is how CORE says
      // it did not observe an amount, and a required field would force it to
      // pick a number — 0 — that asserts nothing moved.
      expect(schema.required).not.toContain("captured_minor");
    }
  });
});
