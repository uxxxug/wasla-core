import { describe, expect, it } from "vitest";
import { createCoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { assertBalanced } from "../src/modules/money/domain.js";

describe("money", () => {
  it("posts immutable balanced entries and reports available balance", async () => {
    const core = createCoreApp({ clock: new FixedClock() });
    const { wallet } = core.money.createWallet({
      owner_type: "identity",
      owner_id: "identity-1",
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
    expect(core.money.balance(wallet.wallet_id)).toEqual({
      posted_minor: 10_000,
      held_minor: 0,
      available_minor: 10_000,
    });
  });

  it("authorizes, holds and captures funds exactly once", async () => {
    const core = createCoreApp({ clock: new FixedClock() });
    const { wallet } = core.money.createWallet({
      owner_type: "organization",
      owner_id: "org-1",
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
    expect(core.money.balance(wallet.wallet_id).available_minor).toBe(3_750);

    const capture = await core.money.capture({ authorization_id: first.authorization_id, correlation_id: "c" });
    const repeated = await core.money.capture({ authorization_id: first.authorization_id, correlation_id: "c-2" });
    expect(repeated.transaction_id).toBe(capture.transaction_id);
    expect(() => assertBalanced(capture.entries)).not.toThrow();
    expect(core.money.balance(wallet.wallet_id)).toEqual({
      posted_minor: 3_750,
      held_minor: 0,
      available_minor: 3_750,
    });
  });

  it("rejects invalid amounts, currencies and insufficient funds", async () => {
    const core = createCoreApp({ clock: new FixedClock() });
    expect(() =>
      core.money.createWallet({
        owner_type: "identity",
        owner_id: "i-1",
        currency: "riyals",
        correlation_id: "c",
      }),
    ).toThrow(/currency/);
    const { wallet } = core.money.createWallet({
      owner_type: "identity",
      owner_id: "i-1",
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
});