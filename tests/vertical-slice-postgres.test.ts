/**
 * The vertical slice, on a real database.
 *
 * `tests/vertical-slice.test.ts` proves the coordination logic is correct.
 * It cannot prove the logic still holds when state lives in Postgres:
 * every repository there is a `Map`, so it never rejects a row, never
 * enforces a foreign key, and never applies the settlement-alignment check.
 *
 * This file runs the same MARKET → CORE → MOVE → CORE → MARKET flow against
 * the Postgres backend, so the database gets the chance to refuse anything
 * the in-memory adapters would have accepted.
 *
 * Skipped without DATABASE_URL. Run with:
 *
 *   DATABASE_URL=postgres://... node scripts/db-migrate.mjs up
 *   DATABASE_URL=postgres://... npx vitest run tests/vertical-slice-postgres.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createCoreApp, type CoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import {
  postgresPersistence,
  type PostgresPool,
} from "../src/platform/persistence/backends.js";
import { MarketSimulator, MoveSimulator } from "./support/product-simulators.js";

const DATABASE_URL = process.env["DATABASE_URL"];

describe.skipIf(!DATABASE_URL)("WASLA vertical slice on Postgres", () => {
  let pool: PostgresPool & { end(): Promise<void> };
  let clock: FixedClock;
  let core: CoreApp;
  let market: MarketSimulator;
  let move: MoveSimulator;
  let organizationId: string;

  beforeEach(async () => {
    if (!pool) {
      const { Pool } = await import("pg");
      pool = new Pool({ connectionString: DATABASE_URL, max: 4 }) as unknown as typeof pool;
    }
    await pool.query(
      `truncate fulfillment, ledger_entry, ledger_transaction, payment_authorization,
       wallet, membership, session, principal, identity_link, identity,
       organization, outbox, inbox, audit_entry restart identity cascade`,
    );

    clock = new FixedClock();
    core = createCoreApp({ clock, persistence: postgresPersistence(pool, clock) });
    market = new MarketSimulator(core.bus, clock);
    move = new MoveSimulator(core.bus, clock);
    market.attach(core.bus);
    move.attach(core.bus);

    // A real organization row, because the fulfillment table has a foreign
    // key to it. The in-memory suite can use testId("org-1"); Postgres cannot.
    const created = await core.organization.create({
      name: "Wasla Logistics",
      country_code: "SA",
      correlation_id: "corr-setup",
    });
    organizationId = created.organization_id;
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const result = await core.publisher.drainOnce();
      if (result.published === 0) return;
    }
  }

  async function fundedHold(reference: string) {
    const { wallet } = await core.money.createWallet({
      owner_type: "organization",
      owner_id: organizationId,
      currency: "SAR",
      correlation_id: "corr-setup",
    });
    await core.money.credit({
      wallet_id: wallet.wallet_id,
      amount_minor: 20_000,
      business_reference: `deposit-${reference}`,
      correlation_id: "corr-setup",
    });
    const authorization = await core.money.authorize({
      wallet_id: wallet.wallet_id,
      amount_minor: 5_000,
      business_reference: reference,
      correlation_id: "corr-setup",
      expires_at: null,
    });
    return { wallet, authorization };
  }

  it("reports which backend it is running on", () => {
    expect(core.persistence).toBe("postgres");
  });

  it("carries an order through to completion and captures the hold", async () => {
    const reference = `order-${randomUUID()}`;
    const { wallet, authorization } = await fundedHold(reference);

    await core.bus.publish(
      market.submit({
        order_id: reference,
        organization_id: organizationId,
        requested_service: "delivery",
        payment_authorization_id: authorization.authorization_id,
        correlation_id: "corr-1",
      }),
    );
    await settle();

    const dispatched = (await core.fulfillment.findByOrderReference(reference))!;
    expect(dispatched.status).toBe("dispatched");
    expect(dispatched.settlement_state).toBe("held");

    const job = move.jobFor(dispatched.fulfillment_id)!;
    await core.bus.publish(move.completion(job.job_id, "completed", "corr-1"));
    await settle();

    const completed = (await core.fulfillment.findByOrderReference(reference))!;
    expect(completed.status).toBe("completed");
    expect(completed.settlement_state).toBe("captured");

    // The money moved, and it moved in a balanced ledger transaction that the
    // database's deferred balance trigger accepted at COMMIT.
    const balance = await core.money.balance(wallet.wallet_id);
    expect(balance.held_minor).toBe(0);
    expect(balance.posted_minor).toBe(15_000);

    const captured = await core.money.getAuthorization(authorization.authorization_id);
    expect(captured?.status).toBe("captured");

    expect(market.orders.get(reference)!.status).toBe("completed");
  });

  it("releases the hold when MOVE rejects the job", async () => {
    const reference = `order-${randomUUID()}`;
    const { wallet, authorization } = await fundedHold(reference);
    move.rejectWith = "no capacity";

    await core.bus.publish(
      market.submit({
        order_id: reference,
        organization_id: organizationId,
        requested_service: "delivery",
        payment_authorization_id: authorization.authorization_id,
        correlation_id: "corr-2",
      }),
    );
    await settle();

    const failed = (await core.fulfillment.findByOrderReference(reference))!;
    expect(failed.status).toBe("failed");
    expect(failed.settlement_state).toBe("released");

    const balance = await core.money.balance(wallet.wallet_id);
    expect(balance.held_minor).toBe(0);
    expect(balance.posted_minor).toBe(20_000);
  });

  it("survives a duplicated delivery of every event", async () => {
    const reference = `order-${randomUUID()}`;
    const { authorization } = await fundedHold(reference);

    const order = market.submit({
      order_id: reference,
      organization_id: organizationId,
      requested_service: "delivery",
      payment_authorization_id: authorization.authorization_id,
      correlation_id: "corr-3",
    });
    await core.bus.publish(order);
    await core.bus.publish(order);
    await settle();

    const fulfillment = (await core.fulfillment.findByOrderReference(reference))!;
    const job = move.jobFor(fulfillment.fulfillment_id)!;
    expect(move.jobs.size).toBe(1);

    const completion = move.completion(job.job_id, "completed", "corr-3");
    await core.bus.publish(completion);
    await core.bus.publish(completion);
    await settle();

    // The inbox that made this idempotent is a table now, not a Set.
    expect(
      (await core.outbox.all()).filter(
        (record) => record.event.event_type === "core.fulfillment.completed",
      ),
    ).toHaveLength(1);
    expect(market.orders.get(reference)!.status).toBe("completed");
  });

  it("leaves no pending outbox rows once the relay has drained", async () => {
    const reference = `order-${randomUUID()}`;
    const { authorization } = await fundedHold(reference);

    await core.bus.publish(
      market.submit({
        order_id: reference,
        organization_id: organizationId,
        requested_service: "delivery",
        payment_authorization_id: authorization.authorization_id,
        correlation_id: "corr-4",
      }),
    );
    await settle();

    const fulfillment = (await core.fulfillment.findByOrderReference(reference))!;
    const job = move.jobFor(fulfillment.fulfillment_id)!;
    await core.bus.publish(move.completion(job.job_id, "completed", "corr-4"));
    await settle();

    expect(await core.outbox.byStatus("pending")).toHaveLength(0);
    expect(await core.outbox.byStatus("dead")).toHaveLength(0);
    expect((await core.outbox.byStatus("published")).length).toBeGreaterThan(0);
  });

  it("writes the audit trail to the database", async () => {
    const reference = `order-${randomUUID()}`;
    const { authorization } = await fundedHold(reference);

    await core.bus.publish(
      market.submit({
        order_id: reference,
        organization_id: organizationId,
        requested_service: "delivery",
        payment_authorization_id: authorization.authorization_id,
        correlation_id: "corr-5",
      }),
    );
    await settle();

    const fulfillment = (await core.fulfillment.findByOrderReference(reference))!;
    const trail = await core.audit.forEntity("fulfillment", fulfillment.fulfillment_id);
    expect(trail.length).toBeGreaterThan(0);
    expect(trail.map((entry) => entry.action)).toContain("fulfillment.created");
  });
});
