import { beforeEach, describe, expect, it } from "vitest";
import { createCoreApp, type CoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { MarketSimulator, MoveSimulator } from "./support/product-simulators.js";

/**
 * WASLA vertical slice: MARKET commercial order → CORE fulfillment + money →
 * MOVE operational job → execution → CORE closure → MARKET closure.
 *
 * MOVE and MARKET never talk to each other; every hop goes through CORE and
 * through a published contract.
 */
describe("WASLA vertical slice", () => {
  let clock: FixedClock;
  let core: CoreApp;
  let market: MarketSimulator;
  let move: MoveSimulator;

  const ORG = "org-1";

  beforeEach(() => {
    clock = new FixedClock();
    core = createCoreApp({ clock });
    market = new MarketSimulator(core.bus, clock);
    move = new MoveSimulator(core.bus, clock);
    market.attach(core.bus);
    move.attach(core.bus);
  });

  /** Relays everything CORE staged in its outbox until the system is quiet. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const result = await core.publisher.drainOnce();
      if (result.published === 0) return;
    }
  }

  async function fundedHold(reference: string, expiresAt?: string) {
    const { wallet } = await core.money.createWallet({
      owner_type: "organization",
      owner_id: ORG,
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
      expires_at: expiresAt ?? null,
    });
    return { wallet, authorization };
  }

  it("1. happy path: order → fulfillment → job → execution → closure on both sides", async () => {
    const { wallet, authorization } = await fundedHold("order-1");
    await core.bus.publish(
      market.submit({
        order_id: "order-1",
        organization_id: ORG,
        requested_service: "delivery",
        payment_authorization_id: authorization.authorization_id,
        correlation_id: "corr-1",
      }),
    );
    await settle();

    const fulfillment = (await core.fulfillment.findByOrderReference("order-1"))!;
    expect(fulfillment.status).toBe("dispatched");
    const job = move.jobFor(fulfillment.fulfillment_id)!;
    expect(job.status).toBe("created");

    await core.bus.publish(move.completion(job.job_id, "completed", "corr-1"));
    await settle();

    expect((await core.fulfillment.require(fulfillment.fulfillment_id)).status).toBe("completed");
    expect(market.orders.get("order-1")!.status).toBe("completed");
    // Money moved exactly once, on success only.
    expect((await core.money.balance(wallet.wallet_id)).held_minor).toBe(0);
    expect((await core.money.balance(wallet.wallet_id)).posted_minor).toBe(15_000);
    // MOVE never received order contents; MARKET never received job details.
    const created = (await core.outbox.all()).find(
      (r) => r.event.event_type === "core.fulfillment.created",
    )!;
    expect(Object.keys(created.event.payload as object)).toEqual([
      "fulfillment_id",
      "organization_id",
      "order_reference",
      "requested_service",
    ]);
  });

  it("2. duplicate delivery of every event changes nothing", async () => {
    const { authorization } = await fundedHold("order-2");
    const order = market.submit({
      order_id: "order-2",
      organization_id: ORG,
      requested_service: "delivery",
      payment_authorization_id: authorization.authorization_id,
      correlation_id: "corr-2",
    });
    await core.bus.publish(order);
    await core.bus.publish(order);
    await settle();

    const fulfillment = (await core.fulfillment.findByOrderReference("order-2"))!;
    const job = move.jobFor(fulfillment.fulfillment_id)!;
    expect(move.jobs.size).toBe(1);

    const completion = move.completion(job.job_id, "completed", "corr-2");
    await core.bus.publish(completion);
    await core.bus.publish(completion);
    await settle();

    expect(
      (await core.outbox.all()).filter((r) => r.event.event_type === "core.fulfillment.completed"),
    ).toHaveLength(1);
    expect(market.orders.get("order-2")!.status).toBe("completed");
  });

  it("3. a transient consumer failure is retried and then succeeds", async () => {
    let attempts = 0;
    core.bus.subscribe("flaky.consumer", "core.fulfillment.created", () => {
      attempts += 1;
      if (attempts < 3) throw new Error("transient downstream failure");
    });
    await core.bus.publish(
      market.submit({
        order_id: "order-3",
        organization_id: ORG,
        requested_service: "delivery",
        correlation_id: "corr-3",
      }),
    );
    await settle();

    expect(attempts).toBe(3);
    expect(core.bus.deadLetters).toHaveLength(0);
    expect((await core.fulfillment.findByOrderReference("order-3"))!.status).toBe("dispatched");
  });

  it("4. a network failure after a successful write loses nothing — the outbox replays", async () => {
    await core.bus.publish(
      market.submit({
        order_id: "order-4",
        organization_id: ORG,
        requested_service: "delivery",
        correlation_id: "corr-4",
      }),
    );
    // The write committed, but the relay cannot reach the transport.
    const originalPublish = core.bus.publish.bind(core.bus);
    let down = true;
    core.bus.publish = async (event) => {
      if (down) throw new Error("network unreachable");
      return originalPublish(event);
    };
    const failed = await core.publisher.drainOnce();
    expect(failed.published).toBe(0);
    expect((await core.outbox.byStatus("pending")).length).toBeGreaterThan(0);
    expect((await core.fulfillment.findByOrderReference("order-4"))!.status).toBe("coordinating");

    // Transport returns; the relay replays the pending record.
    down = false;
    clock.advance(60_000);
    await settle();
    expect((await core.fulfillment.findByOrderReference("order-4"))!.status).toBe("dispatched");
  });

  it("5. an expired money hold blocks a success claim and closes the order as failed", async () => {
    const expiry = new Date(clock.now().getTime() + 60_000).toISOString();
    const { wallet, authorization } = await fundedHold("order-5", expiry);
    await core.bus.publish(
      market.submit({
        order_id: "order-5",
        organization_id: ORG,
        requested_service: "delivery",
        payment_authorization_id: authorization.authorization_id,
        correlation_id: "corr-5",
      }),
    );
    await settle();
    const fulfillment = (await core.fulfillment.findByOrderReference("order-5"))!;
    const job = move.jobFor(fulfillment.fulfillment_id)!;

    clock.advance(120_000); // the hold expires while the job is running
    await core.bus.publish(move.completion(job.job_id, "completed", "corr-5"));
    await settle();

    const closed = await core.fulfillment.require(fulfillment.fulfillment_id);
    expect(closed.status).toBe("failed");
    expect(closed.closure_reason).toContain("payment_settlement_failed");
    expect(market.orders.get("order-5")!.status).toBe("failed");
    // No money moved and the hold is released.
    expect(await core.money.balance(wallet.wallet_id)).toMatchObject({
      posted_minor: 20_000,
      held_minor: 0,
    });
  });

  it("6. cancelling releases the hold, closes the order and stops the job", async () => {
    const { wallet, authorization } = await fundedHold("order-6");
    await core.bus.publish(
      market.submit({
        order_id: "order-6",
        organization_id: ORG,
        requested_service: "delivery",
        payment_authorization_id: authorization.authorization_id,
        correlation_id: "corr-6",
      }),
    );
    await settle();
    const fulfillment = (await core.fulfillment.findByOrderReference("order-6"))!;

    await core.fulfillment.cancel({
      fulfillment_id: fulfillment.fulfillment_id,
      reason: "customer_cancelled",
      correlation_id: "corr-6",
    });
    // Cancelling twice is idempotent.
    await core.fulfillment.cancel({
      fulfillment_id: fulfillment.fulfillment_id,
      reason: "customer_cancelled",
      correlation_id: "corr-6",
    });
    await settle();

    expect((await core.fulfillment.require(fulfillment.fulfillment_id)).status).toBe("cancelled");
    expect(market.orders.get("order-6")!.status).toBe("cancelled");
    expect(move.jobFor(fulfillment.fulfillment_id)!.status).toBe("cancelled");
    expect(await core.money.balance(wallet.wallet_id)).toMatchObject({
      posted_minor: 20_000,
      held_minor: 0,
    });
    expect(
      (await core.outbox.all()).filter((r) => r.event.event_type === "core.fulfillment.cancelled"),
    ).toHaveLength(1);
    // A late completion for a cancelled fulfillment is refused.
    await expect(
      core.fulfillment.consumeMoveCompletion(move.completion("job-1", "completed", "corr-6")),
    ).rejects.toThrow(/cancelled/);
  });

  it("7. MOVE failing to create a job fails the fulfillment and refunds the hold", async () => {
    const { wallet, authorization } = await fundedHold("order-7");
    move.rejectWith = "no_capacity";
    await core.bus.publish(
      market.submit({
        order_id: "order-7",
        organization_id: ORG,
        requested_service: "delivery",
        payment_authorization_id: authorization.authorization_id,
        correlation_id: "corr-7",
      }),
    );
    await settle();

    const fulfillment = (await core.fulfillment.findByOrderReference("order-7"))!;
    expect(fulfillment.status).toBe("failed");
    expect(fulfillment.closure_reason).toBe("no_capacity");
    expect(market.orders.get("order-7")!.status).toBe("failed");
    expect(await core.money.balance(wallet.wallet_id)).toMatchObject({
      posted_minor: 20_000,
      held_minor: 0,
    });
  });

  it("8. replaying the whole event history after a restart produces no new effects", async () => {
    const { authorization } = await fundedHold("order-8");
    await core.bus.publish(
      market.submit({
        order_id: "order-8",
        organization_id: ORG,
        requested_service: "delivery",
        payment_authorization_id: authorization.authorization_id,
        correlation_id: "corr-8",
      }),
    );
    await settle();
    const fulfillment = (await core.fulfillment.findByOrderReference("order-8"))!;
    const job = move.jobFor(fulfillment.fulfillment_id)!;
    await core.bus.publish(move.completion(job.job_id, "completed", "corr-8"));
    await settle();

    const before = {
      fulfillment: await core.fulfillment.require(fulfillment.fulfillment_id),
      order: { ...market.orders.get("order-8")! },
      jobs: move.jobs.size,
      events: (await core.outbox.all()).length,
    };

    // Restart of the relay: every published event is delivered a second time.
    for (const record of await core.outbox.all()) {
      await core.bus.publish(record.event);
    }

    expect(await core.fulfillment.require(fulfillment.fulfillment_id)).toEqual(before.fulfillment);
    expect(market.orders.get("order-8")).toEqual(before.order);
    expect(move.jobs.size).toBe(before.jobs);
    expect((await core.outbox.all()).length).toBe(before.events);
    expect(core.bus.deadLetters).toHaveLength(0);
  });
});
