/**
 * A hold past its expiry can no longer be captured, so it must not keep
 * blocking the wallet until the sweep happens to run.
 */
import { describe, expect, it } from "vitest";
import { createCoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";

async function walletWithExpiringHold(amount: number, hold: number) {
  const clock = new FixedClock();
  const core = createCoreApp({ clock });
  const { wallet } = await core.money.createWallet({
    owner_type: "identity",
    owner_id: "i-expired-hold",
    currency: "SAR",
    correlation_id: "c",
  });
  await core.money.credit({
    wallet_id: wallet.wallet_id,
    amount_minor: amount,
    business_reference: "deposit-expired-hold",
    correlation_id: "c",
  });
  const authorization = await core.money.authorize({
    wallet_id: wallet.wallet_id,
    amount_minor: hold,
    business_reference: "order-expired-hold",
    correlation_id: "c",
    expires_at: new Date(clock.now().getTime() + 60_000),
  });
  return { core, clock, wallet, authorization };
}

describe("expired holds stop blocking funds before the sweep runs", () => {
  it("moves an expired hold out of held_minor and into expired_hold_minor", async () => {
    const { core, clock, wallet } = await walletWithExpiringHold(3_000, 1_000);

    expect(await core.money.balance(wallet.wallet_id)).toEqual({
      posted_minor: 3_000,
      held_minor: 1_000,
      available_minor: 2_000,
      expired_hold_minor: 0,
    });

    clock.advance(60_001);

    expect(await core.money.balance(wallet.wallet_id)).toEqual({
      posted_minor: 3_000,
      held_minor: 0,
      available_minor: 3_000,
      expired_hold_minor: 1_000,
    });
  });

  it("authorizes against funds an expired hold no longer guards", async () => {
    const { core, clock, wallet } = await walletWithExpiringHold(1_000, 1_000);

    // While the hold is live the wallet is fully committed.
    await expect(
      core.money.authorize({
        wallet_id: wallet.wallet_id,
        amount_minor: 1_000,
        business_reference: "order-second-live",
        correlation_id: "c",
      }),
    ).rejects.toThrow(/insufficient/);

    clock.advance(60_001);

    const second = await core.money.authorize({
      wallet_id: wallet.wallet_id,
      amount_minor: 1_000,
      business_reference: "order-second-expired",
      correlation_id: "c",
    });
    expect(second.status).toBe("authorized");
  });

  it("keeps the ledger untouched when the sweep finally releases the hold", async () => {
    const { core, clock, wallet, authorization } = await walletWithExpiringHold(3_000, 1_000);
    clock.advance(60_001);
    const before = await core.money.balance(wallet.wallet_id);

    const swept = await core.money.expireDueAuthorizations("sweep");

    expect(swept).toHaveLength(1);
    expect((await core.money.getAuthorization(authorization.authorization_id)).status).toBe("voided");
    expect(await core.money.balance(wallet.wallet_id)).toEqual({
      posted_minor: before.posted_minor,
      held_minor: 0,
      available_minor: before.available_minor,
      expired_hold_minor: 0,
    });
  });
});
