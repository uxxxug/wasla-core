import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreApp, type CoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { makeEvent, type EventEnvelope } from "../src/platform/eventing/envelope.js";
import {
  memoryPersistence,
  postgresPersistence,
  type Persistence,
} from "../src/platform/persistence/backends.js";

/**
 * Open work whose funding is gone — the contradiction no single-module read can
 * see (row 19 of the table in `docs/settlement.md`).
 *
 * The fulfillment row says `dispatched` and `held`, and it is internally
 * consistent: `listFinanciallyInconsistent` is right to leave it alone, and
 * `listPendingFinancialDecision` is right too, because no money has moved for
 * undelivered work yet. The hold it names has meanwhile expired, been voided or
 * been captured out of band. Nothing was written wrongly; the pair simply stopped
 * being true, and only comparing the two modules reveals it.
 *
 * These tests fix what the read is allowed to do: report, and change nothing. No
 * new status, no mutation, no closure. What happens to work whose funding
 * disappeared — re-authorise, abandon, charge nothing — is a decision CORE has
 * not been given, and a read that quietly closed these would be CORE inventing
 * one.
 */

const url = process.env.DATABASE_URL;
const CORRELATION = "corr-stale-holds";

interface Backend {
  name: string;
  open(clock: FixedClock): Promise<{ store: Persistence; close(): Promise<void> }>;
}

const backends: Backend[] = [
  {
    name: "in-memory",
    async open(clock) {
      return { store: memoryPersistence(clock), async close() {} };
    },
  },
];

if (url) {
  backends.push({
    name: "postgres",
    async open(clock) {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: url, max: 6 });
      return {
        store: postgresPersistence(pool as never, clock),
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

describe.each(backends)("stale holds on open work on $name", (backend) => {
  let store: Persistence;
  let close: () => Promise<void>;
  let core: CoreApp;
  let clock: FixedClock;
  let organizationId: string;

  beforeEach(async () => {
    await truncate();
    clock = new FixedClock();
    const opened = await backend.open(clock);
    store = opened.store;
    close = opened.close;
    core = createCoreApp({ clock, persistence: store });
    organizationId = (
      await core.organization.create({
        name: `org-${Math.random().toString(36).slice(2, 10)}`,
        country_code: "SA",
        correlation_id: CORRELATION,
      })
    ).organization_id;
  });

  afterEach(async () => {
    await close();
  });

  /** A hold that expires `ttl` milliseconds from now, over a fully funded wallet. */
  async function hold(reference: string, ttl: number | null, amount = 6_000) {
    const owner = (
      await core.organization.create({
        name: `own-${Math.random().toString(36).slice(2, 10)}`,
        country_code: "SA",
        correlation_id: CORRELATION,
      })
    ).organization_id;
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
      ...(ttl === null ? {} : { expires_at: new Date(clock.now().getTime() + ttl) }),
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

  /** Dispatched work guarded by a hold that expires after `ttl`. */
  async function dispatched(tag: string, ttl: number | null) {
    const funded = await hold(tag, ttl);
    const created = await core.fulfillment.consumeMarketOrder(
      order(`order-${tag}`, funded.authorization.authorization_id),
    );
    await core.fulfillment.consumeJobAccepted(accepted(created.fulfillment_id, `job-${tag}`));
    return { ...funded, fulfillment: created };
  }

  // The condition itself: work still open, hold no longer able to settle it, and
  // the row that says so is not wrong about anything.
  it("finds open work whose hold expired, which neither other reconciliation read can see", async () => {
    const stale = await dispatched("expired", 60_000);
    const healthy = await dispatched("healthy", null);

    // Before the expiry both are fine.
    expect(await core.fulfillment.listStaleHolds(organizationId)).toHaveLength(0);

    clock.advance(60_001);

    const found = await core.fulfillment.listStaleHolds(organizationId);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      reason: "payment_hold_expired",
      hold_captured_minor: 0,
      settlement_state_if_closed: "held",
    });
    expect(found[0]!.fulfillment.fulfillment_id).toBe(stale.fulfillment.fulfillment_id);

    // The row is untouched and still internally consistent, which is exactly why
    // the other two reads say nothing: this is not a defect and not a decision
    // owed, it is work that lost its funding.
    expect(await core.fulfillment.require(stale.fulfillment.fulfillment_id)).toMatchObject({
      status: "dispatched",
      settlement_state: "held",
    });
    expect(await core.fulfillment.listFinanciallyInconsistent(organizationId)).toHaveLength(0);
    expect(await core.fulfillment.listPendingFinancialDecision(organizationId)).toHaveLength(0);

    // And the healthy fulfillment is not swept up with it.
    expect(
      found.some((item) => item.fulfillment.fulfillment_id === healthy.fulfillment.fulfillment_id),
    ).toBe(false);
  });

  // A hold voided out of band under open work, and one partially captured out of
  // band: the same liveness failure, different money facts, and the read says
  // which settlement state each would take if it closed now.
  it("reports what each stale case would settle as, without closing anything", async () => {
    const voided = await dispatched("voided", null);
    await core.money.voidAuthorization({
      authorization_id: voided.authorization.authorization_id,
      reason: "operator_released_the_hold",
      correlation_id: CORRELATION,
    });
    const partial = await dispatched("partial", null);
    await core.money.capture({
      authorization_id: partial.authorization.authorization_id,
      amount_minor: 2_500,
      capture_reference: "leg-1",
      correlation_id: CORRELATION,
    });
    await core.money.voidAuthorization({
      authorization_id: partial.authorization.authorization_id,
      reason: "operator_released_the_remainder",
      correlation_id: CORRELATION,
    });

    const found = await core.fulfillment.listStaleHolds(organizationId);
    const byId = new Map(found.map((item) => [item.fulfillment.fulfillment_id, item]));
    expect(found).toHaveLength(2);
    expect(byId.get(voided.fulfillment.fulfillment_id)).toMatchObject({
      reason: "payment_hold_not_authorized",
      settlement_state_if_closed: "released",
      hold_captured_minor: 0,
    });
    // The one that already moved money is the one that will need a B-20 decision
    // the moment it closes. Reported, not acted on.
    expect(byId.get(partial.fulfillment.fulfillment_id)).toMatchObject({
      reason: "payment_hold_partially_captured",
      settlement_state_if_closed: "partially_captured",
      hold_captured_minor: 2_500,
    });

    // Reading changed nothing: both are still open and still say `held`.
    for (const item of found) {
      expect(await core.fulfillment.require(item.fulfillment.fulfillment_id)).toMatchObject({
        status: "dispatched",
        settlement_state: "held",
      });
    }
    // Reading twice gives the same answer, which a read that mutated would not.
    expect(await core.fulfillment.listStaleHolds(organizationId)).toHaveLength(2);
  });

  // Closed work is out of scope: a closure already settled the hold, or recorded
  // that it could not, and that case belongs to the other two reads.
  it("ignores closed fulfillments and unfunded ones", async () => {
    const closed = await dispatched("closed", 60_000);
    await core.fulfillment.cancel({
      fulfillment_id: closed.fulfillment.fulfillment_id,
      reason: "customer_cancelled",
      correlation_id: CORRELATION,
    });
    // Unfunded coordination: no hold to go stale.
    await core.fulfillment.consumeMarketOrder(order("order-unfunded", null));

    clock.advance(60_001);

    expect(await core.fulfillment.listStaleHolds(organizationId)).toHaveLength(0);
  });

  it("serves the stale-hold queue over HTTP, separately from the other two", async () => {
    const stale = await dispatched("http", 60_000);
    clock.advance(60_001);
    const token = await operator();

    const response = await core.router.handle({
      method: "GET",
      url: `/v1/fulfillments/reconciliation/stale-holds?organization_id=${organizationId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    const body = response.body as {
      count: number;
      items: Array<{ reason: string; fulfillment: { fulfillment_id: string; financial_disposition: string } }>;
    };
    expect(body.count).toBe(1);
    expect(body.items[0]!.reason).toBe("payment_hold_expired");
    expect(body.items[0]!.fulfillment.fulfillment_id).toBe(stale.fulfillment.fulfillment_id);
    // The disposition is the row's own, and the row is still awaiting execution:
    // the money question is not open yet, the funding is.
    expect(body.items[0]!.fulfillment.financial_disposition).toBe("awaiting_execution");

    const missingOrg = await core.router.handle({
      method: "GET",
      url: "/v1/fulfillments/reconciliation/stale-holds",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missingOrg.status).toBe(400);
  });

  /** A platform admin session token for the organization under test. */
  async function operator(): Promise<string> {
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
    return token;
  }
});
