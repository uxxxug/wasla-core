import { testId } from "./support/ids.js";
import { describe, expect, it } from "vitest";
import { createCoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { assertBalanced } from "../src/modules/money/domain.js";

describe("money", () => {
  it("posts immutable balanced entries and reports available balance", async () => {
    const core = createCoreApp({ clock: new FixedClock() });
    const { wallet } = await core.money.createWallet({
      owner_type: "identity",
      owner_id: testId("identity-1"),
      currency: "sar",
      correlation_id: "corr-money",
    });
    const credit = await core.money.credit({
      wallet_id: wallet.wallet_id,
      amount_minor: 10_000,
      business_reference: "deposit-1",
      correlation_id: "corr-money",
    });
    expect(() => assertBalanced(credit.entries)).not.toThrow();
    expect(await core.money.balance(wallet.wallet_id)).toEqual({
      posted_minor: 10_000,
      held_minor: 0,
      available_minor: 10_000,
      expired_hold_minor: 0,
    });
  });

  it("authorizes, holds and captures funds exactly once", async () => {
    const core = createCoreApp({ clock: new FixedClock() });
    const { wallet } = await core.money.createWallet({
      owner_type: "organization",
      owner_id: testId("org-1"),
      currency: "SAR",
      correlation_id: "c",
    });
    await core.money.credit({
      wallet_id: wallet.wallet_id,
      amount_minor: 5_000,
      business_reference: "deposit-2",
      correlation_id: "c",
    });
    const first = await core.money.authorize({
      wallet_id: wallet.wallet_id,
      amount_minor: 1_250,
      business_reference: "order-44",
      correlation_id: "c",
    });
    const duplicate = await core.money.authorize({
      wallet_id: wallet.wallet_id,
      amount_minor: 1_250,
      business_reference: "order-44",
      correlation_id: "another-correlation",
    });
    expect(duplicate.authorization_id).toBe(first.authorization_id);
    expect((await core.money.balance(wallet.wallet_id)).available_minor).toBe(3_750);

    const capture = await core.money.capture({ authorization_id: first.authorization_id, correlation_id: "c" });
    const repeated = await core.money.capture({ authorization_id: first.authorization_id, correlation_id: "c-2" });
    expect(repeated.transaction_id).toBe(capture.transaction_id);
    expect(() => assertBalanced(capture.entries)).not.toThrow();
    expect(await core.money.balance(wallet.wallet_id)).toEqual({
      posted_minor: 3_750,
      held_minor: 0,
      available_minor: 3_750,
      expired_hold_minor: 0,
    });
  });

  it("rejects invalid amounts, currencies and insufficient funds", async () => {
    const core = createCoreApp({ clock: new FixedClock() });
    await expect(
      core.money.createWallet({
        owner_type: "identity",
        owner_id: testId("i-1"),
        currency: "riyals",
        correlation_id: "c",
      }),
    ).rejects.toThrow(/currency/);
    const { wallet } = await core.money.createWallet({
      owner_type: "identity",
      owner_id: testId("i-1"),
      currency: "SAR",
      correlation_id: "c",
    });
    await expect(
      core.money.authorize({
        wallet_id: wallet.wallet_id,
        amount_minor: 1,
        business_reference: "order-empty-wallet",
        correlation_id: "c",
      }),
    ).rejects.toThrow(/insufficient/);
  });
  it("voids a hold idempotently and refuses to void a captured hold", async () => {
    const core = createCoreApp({ clock: new FixedClock() });
    const { wallet } = await core.money.createWallet({
      owner_type: "identity",
      owner_id: testId("i-void"),
      currency: "SAR",
      correlation_id: "c",
    });
    await core.money.credit({
      wallet_id: wallet.wallet_id,
      amount_minor: 2_000,
      business_reference: "deposit-void",
      correlation_id: "c",
    });
    const hold = await core.money.authorize({
      wallet_id: wallet.wallet_id,
      amount_minor: 800,
      business_reference: "order-void",
      correlation_id: "c",
    });
    expect((await core.money.balance(wallet.wallet_id)).available_minor).toBe(1_200);

    const voided = await core.money.voidAuthorization({
      authorization_id: hold.authorization_id,
      reason: "customer cancelled",
      correlation_id: "c",
    });
    const repeated = await core.money.voidAuthorization({
      authorization_id: hold.authorization_id,
      reason: "customer cancelled",
      correlation_id: "c-2",
    });
    expect(voided.status).toBe("voided");
    expect(repeated.voided_at).toBe(voided.voided_at);
    expect(await core.money.balance(wallet.wallet_id)).toEqual({
      posted_minor: 2_000,
      held_minor: 0,
      available_minor: 2_000,
      expired_hold_minor: 0,
    });

    const captureHold = await core.money.authorize({
      wallet_id: wallet.wallet_id,
      amount_minor: 500,
      business_reference: "order-capture",
      correlation_id: "c",
    });
    await core.money.capture({ authorization_id: captureHold.authorization_id, correlation_id: "c" });
    await expect(
      core.money.voidAuthorization({
        authorization_id: captureHold.authorization_id,
        reason: "late",
        correlation_id: "c",
      }),
    ).rejects.toThrow(/captured authorization cannot be voided/);
  });

  it("expires due holds without moving money and blocks capture after expiry", async () => {
    const clock = new FixedClock();
    const core = createCoreApp({ clock });
    const { wallet } = await core.money.createWallet({
      owner_type: "identity",
      owner_id: testId("i-expiry"),
      currency: "SAR",
      correlation_id: "c",
    });
    await core.money.credit({
      wallet_id: wallet.wallet_id,
      amount_minor: 3_000,
      business_reference: "deposit-expiry",
      correlation_id: "c",
    });
    const hold = await core.money.authorize({
      wallet_id: wallet.wallet_id,
      amount_minor: 1_000,
      business_reference: "order-expiry",
      correlation_id: "c",
      expires_at: new Date(clock.now().getTime() + 60_000),
    });
    expect(await core.money.expireDueAuthorizations("sweep")).toHaveLength(0);

    clock.advance(60_001);
    await expect(
      core.money.capture({ authorization_id: hold.authorization_id, correlation_id: "c" }),
    ).rejects.toThrow(/expired/);

    const expired = await core.money.expireDueAuthorizations("sweep");
    expect(expired).toHaveLength(1);
    expect(expired[0]?.void_reason).toBe("expired");
    expect(await core.money.balance(wallet.wallet_id)).toEqual({
      posted_minor: 3_000,
      held_minor: 0,
      available_minor: 3_000,
      expired_hold_minor: 0,
    });
    expect(await core.money.expireDueAuthorizations("sweep")).toHaveLength(0);
    expect(
      (await core.outbox.byStatus("pending")).filter((row) => row.event.event_type === "core.payment.voided"),
    ).toHaveLength(1);
  });

  it("rejects an expiry in the past", async () => {
    const clock = new FixedClock();
    const core = createCoreApp({ clock });
    const { wallet } = await core.money.createWallet({
      owner_type: "identity",
      owner_id: testId("i-past"),
      currency: "SAR",
      correlation_id: "c",
    });
    await core.money.credit({
      wallet_id: wallet.wallet_id,
      amount_minor: 100,
      business_reference: "deposit-past",
      correlation_id: "c",
    });
    await expect(
      core.money.authorize({
        wallet_id: wallet.wallet_id,
        amount_minor: 50,
        business_reference: "order-past",
        correlation_id: "c",
        expires_at: new Date(clock.now().getTime() - 1),
      }),
    ).rejects.toThrow(/expires_at/);
  });
});
