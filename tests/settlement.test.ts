import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreApp, type CoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import {
  memoryPersistence,
  postgresPersistence,
  type Persistence,
} from "../src/platform/persistence/backends.js";
import { testId } from "./support/ids.js";

/**
 * Settlement past a single all-or-nothing capture.
 *
 * Before migration 0009 `amount_minor` carried two meanings at once — what the
 * payer consented to, and what actually moved — so capture could only ever be
 * the whole hold. Splitting them into a fixed ceiling plus two growing
 * aggregates is what makes a partial capture and a refund expressible, and
 * every test here is about a way that split can go wrong:
 *
 *   - money counted twice, because a partially captured hold still claims its
 *     full amount is held while part of it is already posted;
 *   - money conjured, by capturing or refunding past a ceiling;
 *   - a record that lies about what happened, by calling a hold `voided` when
 *     money did move, or by treating a refund as an un-capture;
 *   - a retried request charging twice.
 *
 * Both backends run the same cases. The aggregates live in one place and the
 * ledger in another, so the two can drift — and a memory store that tolerates
 * drift Postgres refuses would certify bugs the database would have caught.
 */

const url = process.env.DATABASE_URL;

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

describe.each(backends)("settlement on $name", (backend) => {
  let store: Persistence;
  let close: () => Promise<void>;
  let clock: FixedClock;
  let core: CoreApp;

  beforeEach(async () => {
    await truncate();
    clock = new FixedClock();
    const opened = await backend.open();
    store = opened.store;
    close = opened.close;
    core = createCoreApp({ clock, persistence: store });
  });

  afterEach(async () => {
    await close();
  });

  /** A funded wallet with one hold on it. */
  const held = async (funds: number, hold: number, label = "s") => {
    const { wallet } = await core.money.createWallet({
      owner_type: "identity",
      owner_id: testId(`i-${label}`),
      currency: "SAR",
      correlation_id: "c",
    });
    await core.money.credit({
      wallet_id: wallet.wallet_id,
      amount_minor: funds,
      business_reference: `deposit-${label}-${wallet.wallet_id}`,
      correlation_id: "c",
    });
    const authorization = await core.money.authorize({
      wallet_id: wallet.wallet_id,
      amount_minor: hold,
      business_reference: `order-${label}-${wallet.wallet_id}`,
      correlation_id: "c",
    });
    return { wallet, authorization };
  };

  it("holds only the uncaptured remainder, so a partial capture is not counted twice", async () => {
    const { wallet, authorization } = await held(10_000, 6_000, "remainder");

    await core.money.capture({
      authorization_id: authorization.authorization_id,
      amount_minor: 2_000,
      capture_reference: "leg-1",
      correlation_id: "c",
    });

    // 2 000 has left the wallet, so it is in `posted_minor`. If the hold still
    // claimed its whole 6 000 the same 2 000 would be deducted a second time
    // and the wallet would look 2 000 poorer than it is — which would refuse
    // an authorization it can afford.
    expect(await core.money.balance(wallet.wallet_id)).toEqual({
      posted_minor: 8_000,
      held_minor: 4_000,
      available_minor: 4_000,
      expired_hold_minor: 0,
    });

    // And the money is genuinely available: this only fits because the hold
    // shrank rather than staying at 6 000.
    const second = await core.money.authorize({
      wallet_id: wallet.wallet_id,
      amount_minor: 4_000,
      business_reference: `order-remainder-2-${wallet.wallet_id}`,
      correlation_id: "c",
    });
    expect(second.amount_minor).toBe(4_000);
  });

  it("keeps the hold open and capturable until the consented amount is reached", async () => {
    const { authorization } = await held(10_000, 5_000, "split");
    const id = authorization.authorization_id;

    await core.money.capture({
      authorization_id: id,
      amount_minor: 1_500,
      capture_reference: "leg-1",
      correlation_id: "c",
    });
    const midway = await store.money.getAuthorization(id);
    // Still `authorized`: part of what the payer consented to is unused, and
    // an unused part of a consent is not a reason to discard the rest.
    expect(midway?.status).toBe("authorized");
    expect(midway?.captured_minor).toBe(1_500);
    expect(midway?.captured_at).toBeNull();

    await core.money.capture({
      authorization_id: id,
      amount_minor: 3_500,
      capture_reference: "leg-2",
      correlation_id: "c",
    });
    const done = await store.money.getAuthorization(id);
    expect(done?.status).toBe("captured");
    expect(done?.captured_minor).toBe(5_000);
    expect(done?.captured_at).not.toBeNull();

    // Two captures, two ledger transactions, both attributed to the hold by
    // foreign key rather than by parsing a reference string.
    const ledger = (await store.money.transactions()).filter(
      (transaction) => transaction.authorization_id === id,
    );
    expect(ledger.map((transaction) => transaction.kind)).toEqual(["capture", "capture"]);
    // Keyed by reference rather than read in order: both captures share an
    // `occurred_at` under a fixed clock, and CORE promises no ordering between
    // two transactions at the same instant. Postgres breaks the tie on the
    // transaction id and memory returns insertion order, so an ordered
    // assertion here would pass on one backend and fail on the other while
    // testing nothing CORE guarantees.
    const capturedBy = Object.fromEntries(
      ledger.map((transaction) => [
        transaction.business_reference,
        transaction.entries.find((entry) => entry.account_reference === "clearing:captured")
          ?.amount_minor,
      ]),
    );
    expect(capturedBy[`capture:${id}:leg-1`]).toBe(1_500);
    expect(capturedBy[`capture:${id}:leg-2`]).toBe(3_500);
  });

  it("refuses to capture past the amount the payer consented to", async () => {
    const { authorization } = await held(10_000, 4_000, "ceiling");

    await core.money.capture({
      authorization_id: authorization.authorization_id,
      amount_minor: 3_000,
      capture_reference: "leg-1",
      correlation_id: "c",
    });

    // The wallet holds 10 000 and could easily fund this. It is refused
    // because the ceiling is a consent, not a balance: charging past it is
    // charging for something nobody agreed to.
    await expect(
      core.money.capture({
        authorization_id: authorization.authorization_id,
        amount_minor: 1_001,
        capture_reference: "leg-2",
        correlation_id: "c",
      }),
    ).rejects.toThrow(/exceeds the remaining hold of 1000/);

    const stored = await store.money.getAuthorization(authorization.authorization_id);
    expect(stored?.captured_minor).toBe(3_000);
  });

  it("refuses a partial capture that cannot be retried safely", async () => {
    const { authorization } = await held(10_000, 4_000, "unkeyed");

    // Without a key of its own this capture would take the reference derived
    // from the authorization, so a retry and a second, additional capture
    // would be indistinguishable. CORE refuses rather than guessing which one
    // the caller meant.
    await expect(
      core.money.capture({
        authorization_id: authorization.authorization_id,
        amount_minor: 1_000,
        correlation_id: "c",
      }),
    ).rejects.toThrow(/capture_reference is required/);

    const stored = await store.money.getAuthorization(authorization.authorization_id);
    expect(stored?.captured_minor).toBe(0);
  });

  it("charges once when the same partial capture is retried", async () => {
    const { wallet, authorization } = await held(10_000, 5_000, "retry");

    const first = await core.money.capture({
      authorization_id: authorization.authorization_id,
      amount_minor: 2_000,
      capture_reference: "leg-1",
      correlation_id: "c",
    });
    const again = await core.money.capture({
      authorization_id: authorization.authorization_id,
      amount_minor: 2_000,
      capture_reference: "leg-1",
      correlation_id: "c",
    });

    expect(again.transaction_id).toBe(first.transaction_id);
    const balance = await core.money.balance(wallet.wallet_id);
    expect(balance.posted_minor).toBe(8_000);
    expect(
      (await store.money.transactions()).filter(
        (transaction) => transaction.authorization_id === authorization.authorization_id,
      ),
    ).toHaveLength(1);
  });

  it("still captures a whole hold with the reference it always used", async () => {
    const { authorization } = await held(10_000, 5_000, "whole");

    // No amount and no reference: exactly the call every caller made before
    // 0009, and it must still mean "capture all of it" under the same ledger
    // key, or an in-flight retry from before the migration would charge twice.
    const captured = await core.money.capture({
      authorization_id: authorization.authorization_id,
      correlation_id: "c",
    });
    expect(captured.business_reference).toBe(`capture:${authorization.authorization_id}`);

    const again = await core.money.capture({
      authorization_id: authorization.authorization_id,
      correlation_id: "c",
    });
    expect(again.transaction_id).toBe(captured.transaction_id);
  });

  it("closes a part-captured hold as partially_captured, releasing only the rest", async () => {
    const { wallet, authorization } = await held(10_000, 6_000, "close");

    await core.money.capture({
      authorization_id: authorization.authorization_id,
      amount_minor: 2_500,
      capture_reference: "leg-1",
      correlation_id: "c",
    });
    await core.money.voidAuthorization({
      authorization_id: authorization.authorization_id,
      reason: "remainder not needed",
      correlation_id: "c",
    });

    const stored = await store.money.getAuthorization(authorization.authorization_id);
    // Not `voided`: that would claim nothing moved when 2 500 did, and it is
    // the record a reconciliation would trust. Not `captured` either, which
    // would overstate the movement as the full 6 000.
    expect(stored?.status).toBe("partially_captured");
    expect(stored?.captured_minor).toBe(2_500);
    expect(stored?.void_reason).toBe("remainder not needed");

    // Only the remainder came back. A void cannot undo money that already
    // left; that would take a refund.
    expect(await core.money.balance(wallet.wallet_id)).toEqual({
      posted_minor: 7_500,
      held_minor: 0,
      available_minor: 7_500,
      expired_hold_minor: 0,
    });
  });

  it("reports the released remainder, not the whole hold, when closing", async () => {
    const { authorization } = await held(10_000, 6_000, "event");
    await core.money.capture({
      authorization_id: authorization.authorization_id,
      amount_minor: 2_500,
      capture_reference: "leg-1",
      correlation_id: "c-release",
    });
    await core.money.voidAuthorization({
      authorization_id: authorization.authorization_id,
      reason: "remainder not needed",
      correlation_id: "c-release",
    });

    const voided = (await store.outbox.all()).find(
      (record) => record.event.event_type === "core.payment.voided",
    );
    const payload = voided?.event.payload as { amount_minor: number; captured_minor: number };
    // A subscriber crediting back `amount_minor` would return 6 000 for a
    // 3 500 release if this were the authorization's full amount.
    expect(payload.amount_minor).toBe(3_500);
    expect(payload.captured_minor).toBe(2_500);
  });

  it("returns captured money as a balanced reversal without un-capturing", async () => {
    const { wallet, authorization } = await held(10_000, 5_000, "refund");
    await core.money.capture({
      authorization_id: authorization.authorization_id,
      correlation_id: "c",
    });

    const refund = await core.money.refund({
      authorization_id: authorization.authorization_id,
      amount_minor: 2_000,
      refund_reference: "return-1",
      reason: "item returned",
      correlation_id: "c",
    });

    expect(refund.kind).toBe("refund");
    // The exact reverse of a capture: back into the wallet, out of the account
    // it was captured into.
    const byAccount = Object.fromEntries(
      refund.entries.map((entry) => [entry.account_reference, entry.amount_minor]),
    );
    expect(byAccount[`wallet:${wallet.wallet_id}`]).toBe(2_000);
    expect(byAccount["clearing:captured"]).toBe(-2_000);

    const stored = await store.money.getAuthorization(authorization.authorization_id);
    // A refund is not an un-capture. The history shows money leaving and
    // coming back, rather than never having left.
    expect(stored?.status).toBe("captured");
    expect(stored?.captured_minor).toBe(5_000);
    expect(stored?.refunded_minor).toBe(2_000);

    // And it does not restore the hold — the money is simply spendable again.
    expect(await core.money.balance(wallet.wallet_id)).toEqual({
      posted_minor: 7_000,
      held_minor: 0,
      available_minor: 7_000,
      expired_hold_minor: 0,
    });
  });

  it("refuses to refund more than was captured", async () => {
    const { authorization } = await held(10_000, 5_000, "over-refund");
    await core.money.capture({
      authorization_id: authorization.authorization_id,
      amount_minor: 3_000,
      capture_reference: "leg-1",
      correlation_id: "c",
    });

    await expect(
      core.money.refund({
        authorization_id: authorization.authorization_id,
        amount_minor: 3_001,
        refund_reference: "return-1",
        reason: "too much",
        correlation_id: "c",
      }),
    ).rejects.toThrow(/exceeds the refundable amount of 3000/);

    await core.money.refund({
      authorization_id: authorization.authorization_id,
      amount_minor: 3_000,
      refund_reference: "return-1",
      reason: "all of it",
      correlation_id: "c",
    });
    // The ceiling is what was captured, and a refund consumes it. Refunding
    // the same capture twice would pay the money out twice over.
    await expect(
      core.money.refund({
        authorization_id: authorization.authorization_id,
        refund_reference: "return-2",
        reason: "again",
        correlation_id: "c",
      }),
    ).rejects.toThrow(/nothing refundable remains/);
  });

  it("refuses to refund a hold that never moved money", async () => {
    const { authorization } = await held(10_000, 5_000, "nothing");

    // A void is what releases this. Conflating the two would let a caller pay
    // out money the payer never actually spent.
    await expect(
      core.money.refund({
        authorization_id: authorization.authorization_id,
        refund_reference: "return-1",
        reason: "nothing captured",
        correlation_id: "c",
      }),
    ).rejects.toThrow(/nothing has been captured/);
  });

  it("pays out once when the same refund is retried", async () => {
    const { wallet, authorization } = await held(10_000, 5_000, "refund-retry");
    await core.money.capture({
      authorization_id: authorization.authorization_id,
      correlation_id: "c",
    });

    const first = await core.money.refund({
      authorization_id: authorization.authorization_id,
      amount_minor: 1_000,
      refund_reference: "return-1",
      reason: "item returned",
      correlation_id: "c",
    });
    const again = await core.money.refund({
      authorization_id: authorization.authorization_id,
      amount_minor: 1_000,
      refund_reference: "return-1",
      reason: "item returned",
      correlation_id: "c",
    });

    expect(again.transaction_id).toBe(first.transaction_id);
    expect((await core.money.balance(wallet.wallet_id)).posted_minor).toBe(6_000);
    expect(
      (await store.money.getAuthorization(authorization.authorization_id))?.refunded_minor,
    ).toBe(1_000);
  });

  it("refunds a part-captured hold up to what actually moved", async () => {
    const { wallet, authorization } = await held(10_000, 6_000, "partial-refund");
    await core.money.capture({
      authorization_id: authorization.authorization_id,
      amount_minor: 2_000,
      capture_reference: "leg-1",
      correlation_id: "c",
    });
    await core.money.voidAuthorization({
      authorization_id: authorization.authorization_id,
      reason: "remainder not needed",
      correlation_id: "c",
    });

    // A closed hold can still be refunded: the money moved and can come back.
    // The limit is what was captured, not what was held.
    await expect(
      core.money.refund({
        authorization_id: authorization.authorization_id,
        amount_minor: 2_001,
        refund_reference: "return-1",
        reason: "too much",
        correlation_id: "c",
      }),
    ).rejects.toThrow(/exceeds the refundable amount of 2000/);

    await core.money.refund({
      authorization_id: authorization.authorization_id,
      refund_reference: "return-1",
      reason: "item returned",
      correlation_id: "c",
    });
    expect((await core.money.balance(wallet.wallet_id)).posted_minor).toBe(10_000);
    const stored = await store.money.getAuthorization(authorization.authorization_id);
    expect(stored?.status).toBe("partially_captured");
    expect(stored?.refunded_minor).toBe(2_000);
  });

  it("keeps the aggregates equal to what the ledger says moved", async () => {
    const { authorization } = await held(10_000, 6_000, "drift");
    const id = authorization.authorization_id;
    await core.money.capture({
      authorization_id: id,
      amount_minor: 2_500,
      capture_reference: "leg-1",
      correlation_id: "c",
    });
    await core.money.refund({
      authorization_id: id,
      amount_minor: 1_000,
      refund_reference: "return-1",
      reason: "item returned",
      correlation_id: "c",
    });

    // `captured_minor` and `refunded_minor` are a summary of the ledger, and a
    // summary that can disagree with what it summarises is a liability. Both
    // backends refuse the disagreement rather than trusting the summary, so
    // writing one directly has to fail.
    const stored = await store.money.getAuthorization(id);
    await expect(
      core.boundary.run((scope) =>
        store.money.updateAuthorization(
          { ...stored!, captured_minor: 3_000 },
          scope,
        ),
      ),
    ).rejects.toThrow();

    expect((await store.money.getAuthorization(id))?.captured_minor).toBe(2_500);
  });

  it("releases only the remainder when a part-captured hold expires", async () => {
    const { wallet } = await core.money.createWallet({
      owner_type: "identity",
      owner_id: testId("i-expire-partial"),
      currency: "SAR",
      correlation_id: "c",
    });
    await core.money.credit({
      wallet_id: wallet.wallet_id,
      amount_minor: 10_000,
      business_reference: `deposit-expire-${wallet.wallet_id}`,
      correlation_id: "c",
    });
    const authorization = await core.money.authorize({
      wallet_id: wallet.wallet_id,
      amount_minor: 6_000,
      business_reference: `order-expire-${wallet.wallet_id}`,
      correlation_id: "c",
      expires_at: new Date(clock.now().getTime() + 60_000),
    });
    await core.money.capture({
      authorization_id: authorization.authorization_id,
      amount_minor: 2_000,
      capture_reference: "leg-1",
      correlation_id: "c",
    });

    clock.advance(60_001);
    // Only the uncaptured 4 000 is still at stake, so that is what the sweep
    // must show as pending release.
    expect((await core.money.balance(wallet.wallet_id)).expired_hold_minor).toBe(4_000);

    await core.money.expireDueAuthorizations("c-sweep");

    const stored = await store.money.getAuthorization(authorization.authorization_id);
    expect(stored?.status).toBe("partially_captured");
    expect(await core.money.balance(wallet.wallet_id)).toEqual({
      posted_minor: 8_000,
      held_minor: 0,
      available_minor: 8_000,
      expired_hold_minor: 0,
    });
  });
});
