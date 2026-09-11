/**
 * Subscriptions, plans, periods and entitlement (ADR 0013).
 *
 * The ADR text is the project's decision record and is not restated in this
 * repository, so this module is derived from the constraints that ARE here:
 * docs/data-ownership.md puts Plan, Subscription, Period, Entitlement and
 * Usage in CORE; ADR 0012 forbids fixing any rate; ADR 0018 forbids
 * product-specific logic in CORE. Everything that is policy rather than
 * structure is recorded as a blocker in ROADMAP.md instead of being settled
 * here by whichever answer was easiest to write.
 */

export type BillingInterval = "day" | "week" | "month" | "year";
export type PlanStatus = "draft" | "active" | "retired";
export type SubscriptionOwnerType = "identity" | "organization";
export type SubscriptionStatus = "active" | "past_due" | "cancelled" | "expired";
export type PeriodStatus = "pending" | "settled" | "uncollectible" | "voided";

/**
 * What is offered, at a price the operator configured.
 *
 * CORE has no opinion about the number. ADR 0012 / B-4 leaves regulatory
 * pricing policy undecided, so the engine is rule-driven and the rate is data.
 */
export interface Plan {
  plan_id: string;
  /** Stable key the operator and the other systems refer to. */
  code: string;
  name: string;
  currency: string;
  amount_minor: number;
  billing_interval: BillingInterval;
  interval_count: number;
  status: PlanStatus;
  created_at: string;
  activated_at: string | null;
  retired_at: string | null;
}

/**
 * What a plan grants, as a row.
 *
 * A column per feature would put MARKET's and MOVE's product vocabulary into
 * CORE's schema and need a migration whenever a product changed its mind —
 * the god-service drift ADR 0018 exists to prevent. CORE stores an opaque key
 * and a number and never interprets either.
 */
export interface PlanGrant {
  plan_id: string;
  feature_key: string;
  /**
   * `null` means granted but not metered. `0` means explicitly none.
   * These are different statements and must stay distinguishable: collapsing
   * them would make a revoked quota read as an unlimited one.
   */
  limit_value: number | null;
}

export interface Subscription {
  subscription_id: string;
  owner_type: SubscriptionOwnerType;
  owner_id: string;
  plan_id: string;
  /** Which wallet pays. Same owner shape as a wallet, deliberately. */
  wallet_id: string;
  status: SubscriptionStatus;
  created_at: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
  /** When coverage stops. For a cancellation, the end of the paid period. */
  ended_at: string | null;
}

export interface SubscriptionPeriod {
  period_id: string;
  subscription_id: string;
  sequence: number;
  starts_at: string;
  ends_at: string;
  /**
   * Copied from the plan when the period is created, not read through it.
   * This row is the invoice: what was charged has to be recorded on the thing
   * charged, or retiring a plan would take the price of settled history with
   * it.
   */
  currency: string;
  amount_minor: number;
  status: PeriodStatus;
  /** Non-null exactly when a non-zero amount settled. */
  authorization_id: string | null;
  created_at: string;
  settled_at: string | null;
  uncollectible_reason: string | null;
}

export interface UsageRecord {
  usage_id: string;
  period_id: string;
  feature_key: string;
  quantity: number;
  /** The reporter's idempotency key: what makes at-least-once count once. */
  usage_reference: string;
  recorded_at: string;
  correlation_id: string | null;
}

/**
 * Why an entitlement question was answered the way it was.
 *
 * `/v1/access/check` returns a bare boolean, and that is right for a
 * permission: a missing permission has exactly one remedy. An entitlement
 * refusal has several — pay the outstanding period, move to a larger plan,
 * wait for the next period — so a boolean would leave a support agent unable
 * to say which. Same argument as keeping `cancelled` and `expired` apart.
 */
export type EntitlementReason =
  | "granted"
  | "no_subscription"
  | "subscription_past_due"
  | "subscription_expired"
  | "no_current_period"
  | "period_unpaid"
  | "not_in_plan"
  | "limit_exhausted";

export interface EntitlementDecision {
  allowed: boolean;
  reason: EntitlementReason;
  feature_key: string;
  subscription_id: string | null;
  period_id: string | null;
  /** `null` means the grant is not metered. */
  limit_value: number | null;
  used: number;
  /** `null` means the grant is not metered. */
  remaining: number | null;
}

/** Half-open: a period covers its start instant and not its end instant. */
export function periodCovers(period: SubscriptionPeriod, at: Date): boolean {
  const instant = at.getTime();
  return instant >= Date.parse(period.starts_at) && instant < Date.parse(period.ends_at);
}

/**
 * Whether a period has been paid for.
 *
 * Derived from the period's own status rather than stored a second time, and
 * `uncollectible` is deliberately not paid: a charge that was attempted and
 * refused is unpaid time.
 */
export function periodIsPaid(period: SubscriptionPeriod): boolean {
  return period.status === "settled";
}

/**
 * The end of a billing interval that starts at `from`.
 *
 * Calendar arithmetic, not fixed milliseconds, because a month is not 30 days
 * and a year is not 365 — billing on the 15th has to stay on the 15th. Month
 * and year addition clamps to the last day of the target month, so a period
 * starting 31 January ends 28 February rather than rolling into March. Clamping
 * is the usual billing convention and, more importantly, it is total: every
 * start date has exactly one answer, so two runs can never disagree about when
 * a period ends.
 */
export function advanceInterval(from: Date, interval: BillingInterval, count: number): Date {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("interval_count must be a positive integer");
  }
  if (interval === "day" || interval === "week") {
    const days = (interval === "day" ? 1 : 7) * count;
    return new Date(from.getTime() + days * 86_400_000);
  }

  const months = interval === "month" ? count : count * 12;
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth() + months;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  // Day 0 of the following month is the last day of this one.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(from.getUTCDate(), lastDay),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

/**
 * The entitlement answer, computed from what is already true.
 *
 * There is no entitlement table on purpose. An entitlement is fully determined
 * by the subscription's status, what its plan grants and how much of the
 * current period has been used, and the settlement cycle established what a
 * second copy of a derivable fact costs: state that can drift from what it
 * summarises is a liability nobody can reconcile. CORE owns entitlement by
 * being the only place that can answer it, not by keeping rows about it.
 *
 * `past_due` does not entitle. That is a recorded default, not a decision this
 * code is entitled to make — no grace policy exists (see ROADMAP.md). It is
 * the conservative direction because it is the reversible one: an operator can
 * grant grace after the fact, but service already given cannot be taken back.
 */
export function decideEntitlement(input: {
  feature_key: string;
  quantity: number;
  subscription: Subscription | undefined;
  period: SubscriptionPeriod | undefined;
  grant: PlanGrant | undefined;
  used: number;
}): EntitlementDecision {
  const base = {
    feature_key: input.feature_key,
    subscription_id: input.subscription?.subscription_id ?? null,
    period_id: input.period?.period_id ?? null,
    limit_value: input.grant?.limit_value ?? null,
    used: input.used,
    remaining: null as number | null,
  };

  if (!input.subscription) {
    return { ...base, allowed: false, reason: "no_subscription", limit_value: null };
  }
  if (input.subscription.status === "past_due") {
    return { ...base, allowed: false, reason: "subscription_past_due" };
  }
  if (input.subscription.status === "expired") {
    return { ...base, allowed: false, reason: "subscription_expired" };
  }
  // `cancelled` still entitles while a paid period covers the instant. The
  // owner asked to stop renewing; they did not ask for a refund of time they
  // already paid for, and CORE has no proration policy to apply if they had.
  if (!input.period) {
    return { ...base, allowed: false, reason: "no_current_period" };
  }
  if (!periodIsPaid(input.period)) {
    return { ...base, allowed: false, reason: "period_unpaid" };
  }
  if (!input.grant) {
    return { ...base, allowed: false, reason: "not_in_plan", limit_value: null };
  }

  // Not metered: granted, and there is no remaining to report.
  if (input.grant.limit_value === null) {
    return { ...base, allowed: true, reason: "granted", limit_value: null, remaining: null };
  }

  // `remaining` reports the state of the quota, not the state it would be in
  // if the asked-for quantity were consumed. Netting the request out of it
  // would make the same period report a different remaining to two callers
  // asking about different quantities, and nothing here consumes anything —
  // only `recordUsage` does. The verdict answers the request; the counters
  // describe the period.
  const remaining = Math.max(input.grant.limit_value - input.used, 0);
  if (input.quantity > input.grant.limit_value - input.used) {
    return { ...base, allowed: false, reason: "limit_exhausted", remaining };
  }
  return { ...base, allowed: true, reason: "granted", remaining };
}

/**
 * The hold that pays for a period, keyed on the period itself.
 *
 * Derived rather than random so that a crash between taking the hold and
 * capturing it cannot produce a second hold on retry: the reference is UNIQUE
 * on `payment_authorization`, so the retry finds the one that already exists.
 * Same mechanism that makes capture exactly-once.
 */
export function periodChargeReference(periodId: string): string {
  return `subscription-period:${periodId}`;
}
