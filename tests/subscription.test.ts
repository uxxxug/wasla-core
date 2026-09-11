/**
 * Subscriptions, plans and entitlements (ADR 0013), on both backends.
 *
 * Every test here runs twice: once against the in-memory adapters and once
 * against Postgres when `DATABASE_URL` is set. That is not duplication for its
 * own sake. Migration 0010 puts real teeth in the database — an exclusion
 * constraint on overlapping periods, immutability triggers on an active plan's
 * terms, an append-only trigger on usage, and a deferred constraint trigger
 * that compares a settled period against the hold that settled it. The
 * in-memory store restates each of those by hand, and the only way to know the
 * restatement is faithful is to make the same assertions against both.
 *
 *   DATABASE_URL=postgres://... npx vitest run tests/subscription.test.ts
 *
 * Note the deliberate absence of any HTTP entitlement-check test: ADR 0008
 * closes the set of synchronous cross-system paths, so `checkEntitlement` is
 * reachable in-process only and is tested here through the service.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FixedClock } from "../src/platform/clock.js";
import { memoryPersistence, postgresPersistence } from "../src/platform/persistence/backends.js";
import type { Persistence } from "../src/platform/persistence/backends.js";
import { MoneyService } from "../src/modules/money/service.js";
import { OrganizationService } from "../src/modules/organization/service.js";
import { SubscriptionService } from "../src/modules/subscription/service.js";
import { CoreError } from "../src/platform/errors.js";

const DAY = 86_400_000;

interface Harness {
  name: string;
  make(): Promise<{ store: Persistence; close(): Promise<void> }>;
}

const harnesses: Harness[] = [
  {
    name: "in-memory",
    async make() {
      return { store: memoryPersistence(new FixedClock()), async close() {} };
    },
  },
];

const url = process.env["DATABASE_URL"];
if (url) {
  harnesses.push({
    name: "postgres",
    async make() {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: url, max: 4 });
      await pool.query(
        `truncate usage_record, subscription_period, subscription, plan_grant, plan,
         event_delivery, event_subscription, membership, session, principal,
         identity_link, identity, organization, outbox, inbox, inbound_event,
         fulfillment, ledger_entry, ledger_transaction, payment_authorization,
         wallet, service_area, city, region, country, audit_entry
         restart identity cascade`,
      );
      return {
        store: postgresPersistence(pool as never, new FixedClock()),
        async close() {
          await pool.end();
        },
      };
    },
  });
}

describe.each(harnesses)("subscriptions on $name", (harness) => {
  /**
   * A whole world: an organization to own things, a funded wallet to pay from,
   * an active plan, and the two services under test.
   *
   * The wallet is funded through the real `MoneyService` rather than by
   * inserting rows. Migration 0009's deferred trigger refuses any
   * authorization whose captured amount has no matching ledger entries, so a
   * fabricated fixture would not survive a commit — and that is the point:
   * the billing period has to be collectable by the same ledger everything
   * else uses, not by a test-only shortcut.
   */
  async function world(options: { funding?: number; currency?: string } = {}) {
    const created = await harness.make();
    const clock = new FixedClock();
    const { audit, outbox, boundary } = created.store;
    const money = new MoneyService(created.store.money, outbox, boundary, audit, clock);
    const organizations = new OrganizationService(created.store.organization, audit, clock, boundary);
    const billing = new SubscriptionService(
      created.store.subscription,
      money,
      outbox,
      boundary,
      audit,
      clock,
    );

    const currency = options.currency ?? "SAR";
    const organization = await organizations.create({
      name: "Wasla Logistics",
      country_code: "SA",
      correlation_id: randomUUID(),
    });
    const { wallet } = await money.createWallet({
      owner_type: "organization",
      owner_id: organization.organization_id,
      currency,
      correlation_id: randomUUID(),
    });
    const funding = options.funding ?? 100_000;
    if (funding > 0) {
      await money.credit({
        wallet_id: wallet.wallet_id,
        amount_minor: funding,
        business_reference: `top-up:${randomUUID()}`,
        correlation_id: randomUUID(),
      });
    }

    return { ...created, clock, money, billing, organization, wallet, currency };
  }

  /** An active plan with one metered grant and one unmetered grant. */
  async function activePlan(
    billing: SubscriptionService,
    overrides: {
      amount_minor?: number;
      currency?: string;
      grants?: ReadonlyArray<{ feature_key: string; limit_value: number | null }>;
    } = {},
  ) {
    const created = await billing.createPlan({
      code: `plan-${randomUUID().slice(0, 8)}`,
      name: "Growth",
      currency: overrides.currency ?? "SAR",
      amount_minor: overrides.amount_minor ?? 5_000,
      billing_interval: "month",
      grants: overrides.grants ?? [
        { feature_key: "shipments.monthly", limit_value: 3 },
        { feature_key: "support.priority", limit_value: null },
      ],
      correlation_id: randomUUID(),
    });
    const plan = await billing.activatePlan({
      plan_id: created.plan.plan_id,
      correlation_id: randomUUID(),
    });
    return plan;
  }

  it("collects the first period through the ledger and entitles the owner", async () => {
    const w = await world();
    try {
      const plan = await activePlan(w.billing);
      const result = await w.billing.subscribe({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        plan_id: plan.plan_id,
        wallet_id: w.wallet.wallet_id,
        correlation_id: randomUUID(),
      });

      expect(result.charge.collected).toBe(true);

      // Assert on the effect, not the return value: the period must be
      // settled in the store and the money must actually have left the wallet.
      const reread = await w.billing.getSubscription(result.subscription.subscription_id);
      expect(reread.subscription.status).toBe("active");
      expect(reread.periods).toHaveLength(1);
      expect(reread.periods[0]?.status).toBe("settled");
      expect(reread.periods[0]?.authorization_id).not.toBeNull();

      const balance = await w.money.balance(w.wallet.wallet_id);
      expect(balance.available_minor).toBe(95_000);

      const decision = await w.billing.checkEntitlement({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        feature_key: "shipments.monthly",
      });
      expect(decision).toMatchObject({ allowed: true, reason: "granted", remaining: 3 });
    } finally {
      await w.close();
    }
  });

  it("keeps the subscription when the wallet cannot pay, and refuses entitlement", async () => {
    // The signup must not be rolled back by a failed collection: if it were,
    // the caller would be invited to retry the signup and end up with a
    // second subscription once the wallet is topped up.
    const w = await world({ funding: 0 });
    try {
      const plan = await activePlan(w.billing);
      const result = await w.billing.subscribe({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        plan_id: plan.plan_id,
        wallet_id: w.wallet.wallet_id,
        correlation_id: randomUUID(),
      });

      expect(result.charge.collected).toBe(false);
      const reread = await w.billing.getSubscription(result.subscription.subscription_id);
      expect(reread.subscription.status).toBe("past_due");
      expect(reread.periods[0]?.status).toBe("uncollectible");

      const decision = await w.billing.checkEntitlement({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        feature_key: "support.priority",
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("subscription_past_due");
    } finally {
      await w.close();
    }
  });

  it("recovers a past_due subscription when the same period is collected later", async () => {
    const w = await world({ funding: 0 });
    try {
      const plan = await activePlan(w.billing);
      const result = await w.billing.subscribe({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        plan_id: plan.plan_id,
        wallet_id: w.wallet.wallet_id,
        correlation_id: randomUUID(),
      });

      await w.money.credit({
        wallet_id: w.wallet.wallet_id,
        amount_minor: 5_000,
        business_reference: `top-up:${randomUUID()}`,
        correlation_id: randomUUID(),
      });

      const retry = await w.billing.chargePeriod({
        period_id: result.period.period_id,
        correlation_id: randomUUID(),
      });
      expect(retry.collected).toBe(true);

      const reread = await w.billing.getSubscription(result.subscription.subscription_id);
      expect(reread.subscription.status).toBe("active");
      expect(reread.periods[0]?.status).toBe("settled");
      expect((await w.money.balance(w.wallet.wallet_id)).available_minor).toBe(0);
    } finally {
      await w.close();
    }
  });

  it("charges a period at most once however many times it is asked", async () => {
    const w = await world();
    try {
      const plan = await activePlan(w.billing);
      const result = await w.billing.subscribe({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        plan_id: plan.plan_id,
        wallet_id: w.wallet.wallet_id,
        correlation_id: randomUUID(),
      });

      // Three more attempts, each with its own correlation id, as a retrying
      // caller would produce.
      //
      // What makes this hold is not the early return inside `chargePeriod` —
      // removing that still leaves the balance correct, because the hold's
      // `business_reference` is derived from the period id and
      // `ledger_transaction.business_reference` is UNIQUE, so the ledger
      // refuses the second movement. The early return only avoids the work.
      // The load-bearing part is the derived reference, and the assertions
      // below are on the ledger's own numbers rather than on the balance
      // alone, so a second capture cannot hide behind a compensating credit.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const again = await w.billing.chargePeriod({
          period_id: result.period.period_id,
          correlation_id: randomUUID(),
        });
        expect(again.collected).toBe(true);
        expect(again.period.authorization_id).toBe(result.period.authorization_id);
      }
      expect((await w.money.balance(w.wallet.wallet_id)).available_minor).toBe(95_000);
      const hold = await w.money.getAuthorization(result.period.authorization_id ?? "");
      expect(hold.captured_minor).toBe(5_000);
      expect(hold.amount_minor).toBe(5_000);
    } finally {
      await w.close();
    }
  });

  it("refuses a second live subscription to the same plan for the same owner", async () => {
    const w = await world();
    try {
      const plan = await activePlan(w.billing);
      const input = {
        owner_type: "organization" as const,
        owner_id: w.organization.organization_id,
        plan_id: plan.plan_id,
        wallet_id: w.wallet.wallet_id,
        correlation_id: randomUUID(),
      };
      await w.billing.subscribe(input);
      await expect(w.billing.subscribe({ ...input, correlation_id: randomUUID() })).rejects.toThrow(
        CoreError,
      );
    } finally {
      await w.close();
    }
  });

  it("refuses to bill a plan in one currency to a wallet in another", async () => {
    const w = await world({ currency: "USD" });
    try {
      const plan = await activePlan(w.billing, { currency: "SAR" });
      await expect(
        w.billing.subscribe({
          owner_type: "organization",
          owner_id: w.organization.organization_id,
          plan_id: plan.plan_id,
          wallet_id: w.wallet.wallet_id,
          correlation_id: randomUUID(),
        }),
      ).rejects.toThrow(/priced in SAR but the wallet holds USD/);
    } finally {
      await w.close();
    }
  });

  it("refuses a subscription to a draft plan and to a retired plan", async () => {
    const w = await world();
    try {
      const draft = await w.billing.createPlan({
        code: `plan-${randomUUID().slice(0, 8)}`,
        name: "Unpublished",
        currency: "SAR",
        amount_minor: 1_000,
        billing_interval: "month",
        grants: [{ feature_key: "shipments.monthly", limit_value: 1 }],
        correlation_id: randomUUID(),
      });
      const attempt = {
        owner_type: "organization" as const,
        owner_id: w.organization.organization_id,
        wallet_id: w.wallet.wallet_id,
        correlation_id: randomUUID(),
      };
      await expect(
        w.billing.subscribe({ ...attempt, plan_id: draft.plan.plan_id }),
      ).rejects.toThrow(/draft and cannot be subscribed to/);

      const retired = await activePlan(w.billing);
      await w.billing.retirePlan({ plan_id: retired.plan_id, correlation_id: randomUUID() });
      await expect(
        w.billing.subscribe({ ...attempt, plan_id: retired.plan_id, correlation_id: randomUUID() }),
      ).rejects.toThrow(/retired and cannot be subscribed to/);
    } finally {
      await w.close();
    }
  });

  it("freezes an active plan's terms and grants", async () => {
    // A price that can be edited after anyone has subscribed makes settled
    // history unreadable: the period says 5000 and the plan says 9000, and
    // nothing records which one the customer agreed to. Changing a price
    // means publishing a new plan.
    const w = await world();
    try {
      const plan = await activePlan(w.billing);
      const store = w.store.subscription;
      await expect(
        w.store.boundary.run((scope) => store.updatePlan({ ...plan, amount_minor: 9_000 }, scope)),
      ).rejects.toThrow();
      await expect(
        w.store.boundary.run((scope) =>
          store.insertGrant(
            { plan_id: plan.plan_id, feature_key: "late.addition", limit_value: 1 },
            scope,
          ),
        ),
      ).rejects.toThrow();

      const reread = await w.billing.getPlan(plan.plan_id);
      expect(reread.plan.amount_minor).toBe(5_000);
      expect(reread.grants).toHaveLength(2);
    } finally {
      await w.close();
    }
  });

  it("refuses two periods of one subscription that overlap in time", async () => {
    const w = await world();
    try {
      const plan = await activePlan(w.billing);
      const result = await w.billing.subscribe({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        plan_id: plan.plan_id,
        wallet_id: w.wallet.wallet_id,
        correlation_id: randomUUID(),
      });
      const first = result.period;

      await expect(
        w.store.boundary.run((scope) =>
          w.store.subscription.insertPeriod(
            {
              period_id: randomUUID(),
              subscription_id: first.subscription_id,
              sequence: 99,
              starts_at: new Date(Date.parse(first.starts_at) + DAY).toISOString(),
              ends_at: new Date(Date.parse(first.ends_at) + DAY).toISOString(),
              status: "pending",
              currency: first.currency,
              amount_minor: first.amount_minor,
              authorization_id: null,
              created_at: new Date().toISOString(),
              settled_at: null,
              uncollectible_reason: null,
            },
            scope,
          ),
        ),
      ).rejects.toThrow();

      // Adjacent is not overlapping: periods are half-open, so one ending at
      // the instant the next begins must be accepted.
      const adjacentId = randomUUID();
      await w.store.boundary.run((scope) =>
        w.store.subscription.insertPeriod(
          {
            period_id: adjacentId,
            subscription_id: first.subscription_id,
            sequence: 2,
            starts_at: first.ends_at,
            ends_at: new Date(Date.parse(first.ends_at) + 28 * DAY).toISOString(),
            status: "pending",
            currency: first.currency,
            amount_minor: first.amount_minor,
            authorization_id: null,
            created_at: new Date().toISOString(),
            settled_at: null,
            uncollectible_reason: null,
          },
          scope,
        ),
      );
      expect((await w.store.subscription.getPeriod(adjacentId))?.sequence).toBe(2);
    } finally {
      await w.close();
    }
  });

  it("refuses a settled period whose amount disagrees with the hold that paid it", async () => {
    // This is 0010's deferred constraint trigger. It cannot be tested with a
    // fabricated authorization, because 0009's own deferred trigger refuses
    // one whose captured amount has no ledger entries behind it — so the hold
    // here is a real one, captured for a real 4000, and the period claims 5000.
    //
    // The assertion has to be a real commit. A savepoint release does not
    // check deferred constraints; only COMMIT does.
    const w = await world();
    try {
      const plan = await activePlan(w.billing);
      const authorization = await w.money.authorize({
        wallet_id: w.wallet.wallet_id,
        amount_minor: 4_000,
        business_reference: `mismatch:${randomUUID()}`,
        correlation_id: randomUUID(),
      });
      await w.money.capture({
        authorization_id: authorization.authorization_id,
        correlation_id: randomUUID(),
      });

      const result = await w.billing.subscribe({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        plan_id: plan.plan_id,
        wallet_id: w.wallet.wallet_id,
        correlation_id: randomUUID(),
      });
      const second = {
        period_id: randomUUID(),
        subscription_id: result.subscription.subscription_id,
        sequence: 2,
        starts_at: result.period.ends_at,
        ends_at: new Date(Date.parse(result.period.ends_at) + 28 * DAY).toISOString(),
        status: "pending" as const,
        currency: "SAR",
        amount_minor: 5_000,
        authorization_id: null,
        created_at: new Date().toISOString(),
        settled_at: null,
        uncollectible_reason: null,
      };
      await w.store.boundary.run((scope) => w.store.subscription.insertPeriod(second, scope));

      await expect(
        w.store.boundary.run(async (scope) => {
          await w.store.subscription.updatePeriod(
            {
              ...second,
              status: "settled",
              settled_at: new Date().toISOString(),
              authorization_id: authorization.authorization_id,
            },
            scope,
          );
        }),
      ).rejects.toThrow();

      const reread = await w.billing.getSubscription(result.subscription.subscription_id);
      expect(reread.periods.find((p) => p.period_id === second.period_id)?.status).toBe("pending");
    } finally {
      await w.close();
    }
  });

  it("counts usage against the grant and stops entitling once the limit is reached", async () => {
    const w = await world();
    try {
      const plan = await activePlan(w.billing);
      const result = await w.billing.subscribe({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        plan_id: plan.plan_id,
        wallet_id: w.wallet.wallet_id,
        correlation_id: randomUUID(),
      });

      for (let n = 0; n < 3; n += 1) {
        const recorded = await w.billing.recordUsage({
          subscription_id: result.subscription.subscription_id,
          feature_key: "shipments.monthly",
          quantity: 1,
          usage_reference: `shipment-${n}`,
          correlation_id: randomUUID(),
        });
        expect(recorded.recorded).toBe(true);
      }

      const exhausted = await w.billing.checkEntitlement({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        feature_key: "shipments.monthly",
      });
      expect(exhausted).toMatchObject({
        allowed: false,
        reason: "limit_exhausted",
        used: 3,
        remaining: 0,
      });

      // The unmetered grant on the same plan is unaffected.
      const unmetered = await w.billing.checkEntitlement({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        feature_key: "support.priority",
      });
      expect(unmetered).toMatchObject({ allowed: true, limit_value: null, remaining: null });

      // Over-quota consumption is still recorded. Dropping it would make the
      // billing and dispute basis incomplete; refusing further work is the
      // entitlement check's job, not the recorder's.
      const over = await w.billing.recordUsage({
        subscription_id: result.subscription.subscription_id,
        feature_key: "shipments.monthly",
        quantity: 1,
        usage_reference: "shipment-over",
        correlation_id: randomUUID(),
      });
      expect(over.recorded).toBe(true);
      const after = await w.billing.checkEntitlement({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        feature_key: "shipments.monthly",
      });
      expect(after.used).toBe(4);
      expect(after.remaining).toBe(0);
    } finally {
      await w.close();
    }
  });

  it("distinguishes an unmetered grant from a grant of nothing", async () => {
    const w = await world();
    try {
      const plan = await activePlan(w.billing, {
        grants: [{ feature_key: "api.calls", limit_value: 0 }],
      });
      await w.billing.subscribe({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        plan_id: plan.plan_id,
        wallet_id: w.wallet.wallet_id,
        correlation_id: randomUUID(),
      });
      const decision = await w.billing.checkEntitlement({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        feature_key: "api.calls",
      });
      expect(decision).toMatchObject({ allowed: false, reason: "limit_exhausted", limit_value: 0 });
    } finally {
      await w.close();
    }
  });

  it("treats a repeated usage reference as the same usage, not a second one", async () => {
    const w = await world();
    try {
      const plan = await activePlan(w.billing);
      const result = await w.billing.subscribe({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        plan_id: plan.plan_id,
        wallet_id: w.wallet.wallet_id,
        correlation_id: randomUUID(),
      });
      const input = {
        subscription_id: result.subscription.subscription_id,
        feature_key: "shipments.monthly",
        quantity: 1,
        usage_reference: "shipment-retried",
        correlation_id: randomUUID(),
      };
      const first = await w.billing.recordUsage(input);
      const replay = await w.billing.recordUsage({ ...input, correlation_id: randomUUID() });
      expect(first.recorded).toBe(true);
      expect(replay.recorded).toBe(false);
      expect(replay.usage.usage_id).toBe(first.usage.usage_id);

      const decision = await w.billing.checkEntitlement({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        feature_key: "shipments.monthly",
      });
      expect(decision.used).toBe(1);
    } finally {
      await w.close();
    }
  });

  it("refuses usage recorded outside the period it is attributed to", async () => {
    const w = await world();
    try {
      const plan = await activePlan(w.billing);
      const result = await w.billing.subscribe({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        plan_id: plan.plan_id,
        wallet_id: w.wallet.wallet_id,
        correlation_id: randomUUID(),
      });
      await expect(
        w.store.boundary.run((scope) =>
          w.store.subscription.insertUsage(
            {
              usage_id: randomUUID(),
              period_id: result.period.period_id,
              feature_key: "shipments.monthly",
              quantity: 1,
              usage_reference: "out-of-window",
              recorded_at: new Date(Date.parse(result.period.ends_at) + DAY).toISOString(),
              correlation_id: randomUUID(),
            },
            scope,
          ),
        ),
      ).rejects.toThrow();

      // An unparseable instant must be refused, not compared. NaN makes every
      // window comparison false, so a store that only compares would accept
      // the row while Postgres refuses it for being null.
      await expect(
        w.store.boundary.run((scope) =>
          w.store.subscription.insertUsage(
            {
              usage_id: randomUUID(),
              period_id: result.period.period_id,
              feature_key: "shipments.monthly",
              quantity: 1,
              usage_reference: "no-instant",
              recorded_at: "not an instant",
              correlation_id: randomUUID(),
            },
            scope,
          ),
        ),
      ).rejects.toThrow();
    } finally {
      await w.close();
    }
  });

  it("does not offer any way to change or delete a usage record", async () => {
    // Append-only is expressed by the absence of the operation, not by a
    // guard inside it: a port with no `updateUsage` cannot be called wrongly.
    const w = await world();
    try {
      const store = w.store.subscription as unknown as Record<string, unknown>;
      expect(store["updateUsage"]).toBeUndefined();
      expect(store["deleteUsage"]).toBeUndefined();
    } finally {
      await w.close();
    }
  });

  it("keeps coverage to the end of a paid period after cancellation, then expires it", async () => {
    // `cancelled` and `expired` must not collapse into one status: the first
    // says the owner asked to stop and has already paid for the rest of the
    // period, the second says coverage ran out. Billing the first as if it
    // were the second would be charging for a cancelled service.
    const w = await world();
    try {
      const plan = await activePlan(w.billing);
      const result = await w.billing.subscribe({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        plan_id: plan.plan_id,
        wallet_id: w.wallet.wallet_id,
        correlation_id: randomUUID(),
      });

      const cancelled = await w.billing.cancelSubscription({
        subscription_id: result.subscription.subscription_id,
        reason: "owner asked to stop",
        correlation_id: randomUUID(),
      });
      expect(cancelled.subscription.status).toBe("cancelled");
      expect(cancelled.subscription.cancel_reason).toBe("owner asked to stop");
      expect(cancelled.voided_period_id).toBeNull();

      const during = await w.billing.checkEntitlement({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        feature_key: "support.priority",
      });
      expect(during.allowed).toBe(true);

      // Past the end of the paid period, the sweep must expire it rather than
      // renew it, and must not take another 5000.
      w.clock.advance(40 * DAY);
      const sweep = await w.billing.renewDuePeriods(randomUUID());
      expect(sweep.renewed).toHaveLength(0);
      expect(sweep.expired).toContain(result.subscription.subscription_id);
      expect((await w.money.balance(w.wallet.wallet_id)).available_minor).toBe(95_000);

      const after = await w.billing.checkEntitlement({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        feature_key: "support.priority",
      });
      expect(after.allowed).toBe(false);
      expect(after.reason).toBe("subscription_expired");
    } finally {
      await w.close();
    }
  });

  it("voids an unpaid period when the subscription is cancelled", async () => {
    const w = await world({ funding: 0 });
    try {
      const plan = await activePlan(w.billing);
      const result = await w.billing.subscribe({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        plan_id: plan.plan_id,
        wallet_id: w.wallet.wallet_id,
        correlation_id: randomUUID(),
      });
      const cancelled = await w.billing.cancelSubscription({
        subscription_id: result.subscription.subscription_id,
        reason: "never paid",
        correlation_id: randomUUID(),
      });
      expect(cancelled.voided_period_id).toBe(result.period.period_id);

      const reread = await w.billing.getSubscription(result.subscription.subscription_id);
      expect(reread.periods[0]?.status).toBe("voided");

      // An unpaid cancelled subscription entitles nothing: there is no paid
      // coverage to run out.
      const decision = await w.billing.checkEntitlement({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        feature_key: "support.priority",
      });
      expect(decision.allowed).toBe(false);
    } finally {
      await w.close();
    }
  });

  it("renews an active subscription once the period ends and charges the new one", async () => {
    const w = await world();
    try {
      const plan = await activePlan(w.billing);
      const result = await w.billing.subscribe({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        plan_id: plan.plan_id,
        wallet_id: w.wallet.wallet_id,
        correlation_id: randomUUID(),
      });

      w.clock.advance(40 * DAY);
      const sweep = await w.billing.renewDuePeriods(randomUUID());
      expect(sweep.renewed).toHaveLength(1);
      expect(sweep.expired).toHaveLength(0);
      expect((await w.money.balance(w.wallet.wallet_id)).available_minor).toBe(90_000);

      const reread = await w.billing.getSubscription(result.subscription.subscription_id);
      expect(reread.subscription.status).toBe("active");
      expect(reread.periods).toHaveLength(2);
      expect(reread.periods.filter((p) => p.status === "settled")).toHaveLength(2);

      // The new period starts where the old one ended: no gap in coverage and
      // no overlap to argue about.
      const ordered = [...reread.periods].sort((a, b) => a.sequence - b.sequence);
      expect(ordered[1]?.starts_at).toBe(ordered[0]?.ends_at);

      // Quota is per period, so the fresh period starts with a fresh count.
      const decision = await w.billing.checkEntitlement({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        feature_key: "shipments.monthly",
      });
      expect(decision.used).toBe(0);
      expect(decision.remaining).toBe(3);
    } finally {
      await w.close();
    }
  });

  it("does not abort a renewal sweep because one owner cannot pay", async () => {
    // A sweep that throws on the first empty wallet would leave every later
    // subscription unrenewed, which turns one customer's billing problem into
    // an outage for everyone behind them in the list.
    const w = await world();
    try {
      const plan = await activePlan(w.billing);
      const poorOrganization = await new OrganizationService(
        w.store.organization,
        w.store.audit,
        w.clock,
        w.store.boundary,
      ).create({ name: "Broke Co", country_code: "SA", correlation_id: randomUUID() });
      const poorWallet = await w.money.createWallet({
        owner_type: "organization",
        owner_id: poorOrganization.organization_id,
        currency: "SAR",
        correlation_id: randomUUID(),
      });
      await w.money.credit({
        wallet_id: poorWallet.wallet.wallet_id,
        amount_minor: 5_000,
        business_reference: `top-up:${randomUUID()}`,
        correlation_id: randomUUID(),
      });

      const poor = await w.billing.subscribe({
        owner_type: "organization",
        owner_id: poorOrganization.organization_id,
        plan_id: plan.plan_id,
        wallet_id: poorWallet.wallet.wallet_id,
        correlation_id: randomUUID(),
      });
      const rich = await w.billing.subscribe({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        plan_id: plan.plan_id,
        wallet_id: w.wallet.wallet_id,
        correlation_id: randomUUID(),
      });
      expect(poor.charge.collected).toBe(true);
      expect(rich.charge.collected).toBe(true);

      w.clock.advance(40 * DAY);
      const sweep = await w.billing.renewDuePeriods(randomUUID());

      // The funded one renewed; the empty one is recorded as uncollectible
      // rather than having stopped the sweep.
      expect(sweep.uncollectible).toHaveLength(1);
      const poorPeriods = (await w.billing.getSubscription(poor.subscription.subscription_id))
        .periods;
      expect(poorPeriods.map((p) => p.period_id)).toContain(sweep.uncollectible[0]);
      expect(sweep.renewed.map((p) => p.subscription_id)).toContain(
        rich.subscription.subscription_id,
      );
      expect(
        (await w.billing.getSubscription(poor.subscription.subscription_id)).subscription.status,
      ).toBe("past_due");
      expect(
        (await w.billing.getSubscription(rich.subscription.subscription_id)).subscription.status,
      ).toBe("active");
    } finally {
      await w.close();
    }
  });

  it("reports why nothing is entitled when the owner has no subscription at all", async () => {
    // A refusal has to say which kind of refusal it is. "No subscription" and
    // "subscribed but unpaid" lead to different answers for the customer, and
    // neither is the same as a missing role, which is `POST /v1/access/check`.
    const w = await world();
    try {
      const decision = await w.billing.checkEntitlement({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        feature_key: "shipments.monthly",
      });
      expect(decision).toMatchObject({
        allowed: false,
        reason: "no_subscription",
        subscription_id: null,
      });
    } finally {
      await w.close();
    }
  });

  it("refuses a feature the plan does not grant", async () => {
    const w = await world();
    try {
      const plan = await activePlan(w.billing);
      await w.billing.subscribe({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        plan_id: plan.plan_id,
        wallet_id: w.wallet.wallet_id,
        correlation_id: randomUUID(),
      });
      const decision = await w.billing.checkEntitlement({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        feature_key: "something.else",
      });
      expect(decision.reason).toBe("not_in_plan");
      expect(decision.allowed).toBe(false);
    } finally {
      await w.close();
    }
  });

  it("emits one event per business fact and nothing for a draft plan", async () => {
    const w = await world();
    try {
      const plan = await activePlan(w.billing);
      const result = await w.billing.subscribe({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        plan_id: plan.plan_id,
        wallet_id: w.wallet.wallet_id,
        correlation_id: randomUUID(),
      });
      await w.billing.recordUsage({
        subscription_id: result.subscription.subscription_id,
        feature_key: "shipments.monthly",
        quantity: 1,
        usage_reference: "shipment-1",
        correlation_id: randomUUID(),
      });
      await w.billing.cancelSubscription({
        subscription_id: result.subscription.subscription_id,
        reason: "done",
        correlation_id: randomUUID(),
      });

      const pending = await w.store.outbox.byStatus("pending");
      const types = pending.map((e) => e.event.event_type);
      expect(types).toContain("core.subscription.created");
      expect(types).toContain("core.subscription.period_settled");
      expect(types).toContain("core.subscription.cancelled");
      // Usage is high-volume bookkeeping with no consumer outside CORE, and an
      // event stream is for business facts (ADR 0009).
      expect(types.filter((t) => t.includes("usage"))).toHaveLength(0);
      // A draft plan's terms can still change, so nothing outside CORE can
      // act on them and nothing is published.
      expect(types.filter((t) => t.includes("plan"))).toHaveLength(0);

      const subscriptionEvents = pending
        .map((e) => e.event)
        .filter((e) => e.event_type.startsWith("core.subscription."));
      for (const event of subscriptionEvents) {
        expect(event.entity_type).toBe("subscription");
        expect(event.entity_id).toBe(result.subscription.subscription_id);
      }
    } finally {
      await w.close();
    }
  });

  it("records an audit entry for a refused collection even though nothing was charged", async () => {
    // B-9: the evidence that CORE refused must not roll back with the thing
    // it refused. A collection that failed is exactly the case someone will
    // later ask about.
    const w = await world({ funding: 0 });
    try {
      const plan = await activePlan(w.billing);
      const result = await w.billing.subscribe({
        owner_type: "organization",
        owner_id: w.organization.organization_id,
        plan_id: plan.plan_id,
        wallet_id: w.wallet.wallet_id,
        correlation_id: randomUUID(),
      });
      const entries = await w.store.audit.entries();
      const uncollectible = entries.filter((e) => e.action.includes("uncollectible"));
      expect(uncollectible).toHaveLength(1);
      expect(uncollectible[0]?.entity_id).toBe(result.period.period_id);
    } finally {
      await w.close();
    }
  });
});
