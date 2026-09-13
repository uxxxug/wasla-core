import { foreignKeyRefusal, type ReferenceKeys } from "../../platform/persistence/reference-keys.js";
import {
  journalMapWrite,
  journalOf,
  type TransactionScope,
} from "../../platform/persistence/transaction.js";
import type {
  Plan,
  PlanGrant,
  PlanStatus,
  Subscription,
  SubscriptionOwnerType,
  SubscriptionPeriod,
  SubscriptionStatus,
  UsageRecord,
} from "./domain.js";
import { putRow } from "../../platform/persistence/row-rules.js";
import { orderedBy } from "../../platform/persistence/list-order.js";

export interface SubscriptionRepository {
  insertPlan(plan: Plan, scope: TransactionScope): Promise<void>;
  updatePlan(plan: Plan, scope: TransactionScope): Promise<void>;
  getPlan(planId: string): Promise<Plan | undefined>;
  findPlanByCode(code: string): Promise<Plan | undefined>;
  listPlans(status?: PlanStatus): Promise<readonly Plan[]>;

  insertGrant(grant: PlanGrant, scope: TransactionScope): Promise<void>;
  listGrants(planId: string): Promise<readonly PlanGrant[]>;
  findGrant(planId: string, featureKey: string): Promise<PlanGrant | undefined>;

  insertSubscription(subscription: Subscription, scope: TransactionScope): Promise<void>;
  updateSubscription(subscription: Subscription, scope: TransactionScope): Promise<void>;
  getSubscription(subscriptionId: string): Promise<Subscription | undefined>;
  listSubscriptionsForOwner(
    ownerType: SubscriptionOwnerType,
    ownerId: string,
  ): Promise<readonly Subscription[]>;
  listSubscriptionsByStatus(statuses: readonly SubscriptionStatus[]): Promise<readonly Subscription[]>;

  insertPeriod(period: SubscriptionPeriod, scope: TransactionScope): Promise<void>;
  updatePeriod(period: SubscriptionPeriod, scope: TransactionScope): Promise<void>;
  getPeriod(periodId: string): Promise<SubscriptionPeriod | undefined>;
  listPeriods(subscriptionId: string): Promise<readonly SubscriptionPeriod[]>;
  /** The period whose half-open window contains `at`, if any. */
  findPeriodCovering(subscriptionId: string, at: Date): Promise<SubscriptionPeriod | undefined>;
  /** Highest sequence, which is what a renewal continues from. */
  latestPeriod(subscriptionId: string): Promise<SubscriptionPeriod | undefined>;

  insertUsage(usage: UsageRecord, scope: TransactionScope): Promise<void>;
  findUsageByReference(
    periodId: string,
    featureKey: string,
    reference: string,
  ): Promise<UsageRecord | undefined>;
  /** Summed in the store so a large period does not have to be loaded to count it. */
  usageTotal(periodId: string, featureKey: string): Promise<number>;
  listUsage(periodId: string): Promise<readonly UsageRecord[]>;
}

/**
 * The reference subscription store.
 *
 * Like the money store, it re-states the uniqueness and the CHECK constraints
 * the schema declares rather than only primary keys. That redundancy is the
 * point: a memory backend more permissive than Postgres certifies bugs the
 * real database would have refused (B-12), and the standing rule is that no
 * difference between the two backends may hide behind the tests.
 */
export class InMemorySubscriptionRepository implements SubscriptionRepository {
  /**
   * How a settled period is compared against the money that settled it.
   *
   * Migration 0010 gives Postgres a deferred constraint trigger for this. The
   * memory backend has no view of the money store, so the reader is injected
   * by the composition root instead of the difference being documented and
   * left in place — an unenforced invariant on one backend is an invariant the
   * tests would certify as held. Optional only so a bare store is still
   * constructible in isolation; when it is absent the check is skipped and the
   * `memoryPersistence` bundle always supplies it.
   */
  constructor(
    private readonly capturedAmount?: (
      authorizationId: string,
    ) => { captured_minor: number; currency: string } | undefined,
    keys?: ReferenceKeys,
  ) {
    // Field initializers run before this body, so the maps below already exist.
    keys?.attach("plan", this.plans);
    keys?.attach("plan_grant", this.grants);
    keys?.attach("subscription", this.subscriptions);
    keys?.attach("subscription_period", this.periods);
    keys?.attach("usage_record", this.usage);
  }

  private plans = new Map<string, Plan>();
  private grants = new Map<string, PlanGrant>();
  private subscriptions = new Map<string, Subscription>();
  private periods = new Map<string, SubscriptionPeriod>();
  private usage = new Map<string, UsageRecord>();

  private grantKey(planId: string, featureKey: string): string {
    return `${planId}::${featureKey}`;
  }

  /**
   * `plan.code` is UNIQUE. Checked synchronously — no `await` between the scan
   * and the `set`, because an `await` there is enough to lose the race even in
   * a single-threaded runtime (B-12).
   */
  private planCodeClash(plan: Plan): boolean {
    for (const existing of this.plans.values()) {
      if (existing.code === plan.code && existing.plan_id !== plan.plan_id) return true;
    }
    return false;
  }

  private assertPlanShape(plan: Plan): void {
    if (!/^[A-Z]{3}$/.test(plan.currency)) {
      throw new Error('new row violates check constraint "plan_currency_format"');
    }
    if (plan.amount_minor < 0 || !Number.isInteger(plan.amount_minor)) {
      throw new Error('new row violates check constraint "plan_amount_non_negative"');
    }
    if (!Number.isInteger(plan.interval_count) || plan.interval_count <= 0) {
      throw new Error('new row violates check constraint "plan_interval_count_positive"');
    }
    const timestampsAgree =
      plan.status === "draft"
        ? plan.activated_at === null && plan.retired_at === null
        : plan.status === "active"
          ? plan.activated_at !== null && plan.retired_at === null
          : plan.activated_at !== null && plan.retired_at !== null;
    if (!timestampsAgree) {
      throw new Error('new row violates check constraint "plan_status_timestamps"');
    }
  }

  async insertPlan(plan: Plan, scope?: TransactionScope): Promise<void> {
    this.assertPlanShape(plan);
    if (this.planCodeClash(plan)) {
      throw new Error('duplicate key value violates unique constraint "plan_code_key"');
    }
    journalMapWrite(scope, this.plans, plan.plan_id);
    putRow("plan", this.plans, plan.plan_id, plan);
  }

  /**
   * The `plan_terms_immutable` trigger from migration 0010 now lives in
   * `TRANSITION_RULES` and is applied by `putRow`, which reads the row this one
   * replaces out of the same map. It was restated here until the trigger-parity
   * cycle; the three refusals it raised are unchanged, they are simply declared
   * once for both this store and any other write that reaches the `plan` table.
   */
  async updatePlan(plan: Plan, scope?: TransactionScope): Promise<void> {
    this.assertPlanShape(plan);
    journalMapWrite(scope, this.plans, plan.plan_id);
    putRow("plan", this.plans, plan.plan_id, plan);
  }

  async getPlan(planId: string): Promise<Plan | undefined> {
    return this.plans.get(planId);
  }
  async findPlanByCode(code: string): Promise<Plan | undefined> {
    return [...this.plans.values()].find((plan) => plan.code === code);
  }
  async listPlans(status?: PlanStatus): Promise<readonly Plan[]> {
    const all = [...this.plans.values()];
    // By code, as the SQL does (milestone 22). `code` is unique, so it is total.
    return orderedBy(status ? all.filter((plan) => plan.status === status) : all, (plan) => plan.code);
  }

  /**
   * The `plan_grant_immutable` trigger — grants freeze with the plan — is a
   * `TRANSITION_RULE` as of the trigger-parity cycle, read from the registered
   * `plan` map rather than from this store's own field, so the rule holds for
   * any writer of the table and not only for this method.
   */
  async insertGrant(grant: PlanGrant, scope?: TransactionScope): Promise<void> {
    const key = this.grantKey(grant.plan_id, grant.feature_key);
    if (this.grants.has(key)) {
      throw new Error('duplicate key value violates unique constraint "plan_grant_pkey"');
    }
    journalMapWrite(scope, this.grants, key);
    // `plan_grant_feature_key_present`, `plan_grant_limit_non_negative` and
    // `plan_grant_plan_id_fkey`, all from the rules tables rather than restated
    // here: until this cycle this row was written with a bare `map.set`, so its
    // two CHECKs were a second copy of the schema and its foreign key had no
    // copy at all.
    putRow("plan_grant", this.grants, key, grant);
  }

  async listGrants(planId: string): Promise<readonly PlanGrant[]> {
    return orderedBy(
      [...this.grants.values()].filter((grant) => grant.plan_id === planId),
      (grant) => grant.feature_key,
    );
  }
  async findGrant(planId: string, featureKey: string): Promise<PlanGrant | undefined> {
    return this.grants.get(this.grantKey(planId, featureKey));
  }

  private assertSubscriptionShape(subscription: Subscription): void {
    if ((subscription.status === "cancelled") !== (subscription.cancelled_at !== null)) {
      throw new Error('new row violates check constraint "subscription_cancel_fields"');
    }
    if (
      subscription.status === "cancelled" &&
      (subscription.cancel_reason === null || subscription.cancel_reason.trim().length === 0)
    ) {
      throw new Error('new row violates check constraint "subscription_cancel_reason_required"');
    }
    if (
      subscription.status !== "cancelled" &&
      subscription.status !== "expired" &&
      subscription.ended_at !== null
    ) {
      throw new Error('new row violates check constraint "subscription_ended_fields"');
    }
  }

  async insertSubscription(subscription: Subscription, scope?: TransactionScope): Promise<void> {
    this.assertSubscriptionShape(subscription);
    journalMapWrite(scope, this.subscriptions, subscription.subscription_id);
    putRow("subscription", this.subscriptions, subscription.subscription_id, subscription);
  }
  async updateSubscription(subscription: Subscription, scope?: TransactionScope): Promise<void> {
    this.assertSubscriptionShape(subscription);
    journalMapWrite(scope, this.subscriptions, subscription.subscription_id);
    putRow("subscription", this.subscriptions, subscription.subscription_id, subscription);
  }
  async getSubscription(subscriptionId: string): Promise<Subscription | undefined> {
    return this.subscriptions.get(subscriptionId);
  }
  async listSubscriptionsForOwner(
    ownerType: SubscriptionOwnerType,
    ownerId: string,
  ): Promise<readonly Subscription[]> {
    return orderedBy(
      [...this.subscriptions.values()].filter(
        (item) => item.owner_type === ownerType && item.owner_id === ownerId,
      ),
      (item) => item.created_at,
      (item) => item.subscription_id,
    );
  }
  async listSubscriptionsByStatus(
    statuses: readonly SubscriptionStatus[],
  ): Promise<readonly Subscription[]> {
    return orderedBy(
      [...this.subscriptions.values()].filter((item) => statuses.includes(item.status)),
      (item) => item.created_at,
      (item) => item.subscription_id,
    );
  }

  /**
   * The EXCLUDE constraint from migration 0010, restated.
   *
   * Two periods of one subscription covering the same instant would bill the
   * owner twice for it and give entitlement two different answers. Synchronous
   * for the same reason as every other check here.
   */
  private periodOverlapClash(period: SubscriptionPeriod): SubscriptionPeriod | undefined {
    const start = Date.parse(period.starts_at);
    const end = Date.parse(period.ends_at);
    for (const existing of this.periods.values()) {
      if (existing.subscription_id !== period.subscription_id) continue;
      if (existing.period_id === period.period_id) continue;
      // Half-open ranges overlap iff each starts before the other ends.
      if (start < Date.parse(existing.ends_at) && Date.parse(existing.starts_at) < end) {
        return existing;
      }
    }
    return undefined;
  }

  /** The partial UNIQUE index: one hold settles one period. */
  private authorizationClash(period: SubscriptionPeriod): boolean {
    if (!period.authorization_id) return false;
    for (const existing of this.periods.values()) {
      if (
        existing.authorization_id === period.authorization_id &&
        existing.period_id !== period.period_id
      ) {
        return true;
      }
    }
    return false;
  }

  private assertPeriodShape(period: SubscriptionPeriod): void {
    if (!Number.isInteger(period.sequence) || period.sequence <= 0) {
      throw new Error('new row violates check constraint "subscription_period_sequence_positive"');
    }
    if (Date.parse(period.ends_at) <= Date.parse(period.starts_at)) {
      throw new Error('new row violates check constraint "subscription_period_ordered"');
    }
    if (!/^[A-Z]{3}$/.test(period.currency)) {
      throw new Error('new row violates check constraint "subscription_period_currency_format"');
    }
    if (period.amount_minor < 0 || !Number.isInteger(period.amount_minor)) {
      throw new Error('new row violates check constraint "subscription_period_amount_non_negative"');
    }
    if (period.status === "settled") {
      // A settled period has a hold if and only if money was actually owed.
      if (period.settled_at === null) {
        throw new Error('new row violates check constraint "subscription_period_settlement_fields"');
      }
      if ((period.amount_minor === 0) !== (period.authorization_id === null)) {
        throw new Error('new row violates check constraint "subscription_period_settlement_fields"');
      }
    } else {
      if (period.settled_at !== null) {
        throw new Error('new row violates check constraint "subscription_period_settlement_fields"');
      }
      if (period.authorization_id !== null) {
        throw new Error(
          'new row violates check constraint "subscription_period_authorization_only_when_settled"',
        );
      }
    }
    const uncollectible =
      period.uncollectible_reason !== null && period.uncollectible_reason.trim().length > 0;
    if ((period.status === "uncollectible") !== uncollectible) {
      throw new Error('new row violates check constraint "subscription_period_uncollectible_reason"');
    }
  }

  private writePeriod(period: SubscriptionPeriod, scope?: TransactionScope): void {
    this.assertPeriodShape(period);
    if (this.periodOverlapClash(period)) {
      throw new Error(
        'conflicting key value violates exclusion constraint "subscription_period_no_overlap"',
      );
    }
    for (const existing of this.periods.values()) {
      if (
        existing.subscription_id === period.subscription_id &&
        existing.sequence === period.sequence &&
        existing.period_id !== period.period_id
      ) {
        throw new Error(
          'duplicate key value violates unique constraint "subscription_period_sequence_unique"',
        );
      }
    }
    if (this.authorizationClash(period)) {
      throw new Error(
        'duplicate key value violates unique constraint "subscription_period_authorization_unique"',
      );
    }
    journalMapWrite(scope, this.periods, period.period_id);
    putRow("subscription_period", this.periods, period.period_id, period);
    this.deferMoneyAgreement(scope, period.period_id);
  }

  /**
   * The `subscription_period_money_agrees` trigger from migration 0010.
   *
   * Deferred for the same reason Postgres defers it: the period row and the
   * capture are written in one transaction and either order is legitimate, so
   * an eager check would reject a state the transaction was about to make
   * consistent. Outside a transaction there is nothing to defer to and the
   * check runs immediately, which is what autocommit does.
   */
  private deferMoneyAgreement(scope: TransactionScope | undefined, periodId: string): void {
    if (!this.capturedAmount) return;
    const check = () => this.assertMoneyAgreement(periodId);
    const journal = journalOf(scope);
    if (journal) journal.defer(`subscription-period:${periodId}`, check);
    else check();
  }

  private assertMoneyAgreement(periodId: string): void {
    const period = this.periods.get(periodId);
    if (!period || period.status !== "settled" || !period.authorization_id) return;
    const snapshot = this.capturedAmount?.(period.authorization_id);
    if (!snapshot) {
      throw new Error(
        `period ${periodId} is settled against authorization ${period.authorization_id} which does not exist`,
      );
    }
    if (snapshot.captured_minor !== period.amount_minor) {
      throw new Error(
        `period ${periodId} is settled for ${period.amount_minor} but authorization ${period.authorization_id} captured ${snapshot.captured_minor}`,
      );
    }
    if (snapshot.currency !== period.currency) {
      throw new Error(
        `period ${periodId} is priced in ${period.currency} but was settled in ${snapshot.currency}`,
      );
    }
  }

  async insertPeriod(period: SubscriptionPeriod, scope?: TransactionScope): Promise<void> {
    this.writePeriod(period, scope);
  }
  async updatePeriod(period: SubscriptionPeriod, scope?: TransactionScope): Promise<void> {
    this.writePeriod(period, scope);
  }
  async getPeriod(periodId: string): Promise<SubscriptionPeriod | undefined> {
    return this.periods.get(periodId);
  }
  async listPeriods(subscriptionId: string): Promise<readonly SubscriptionPeriod[]> {
    return [...this.periods.values()]
      .filter((period) => period.subscription_id === subscriptionId)
      .sort((a, b) => a.sequence - b.sequence);
  }
  async findPeriodCovering(subscriptionId: string, at: Date): Promise<SubscriptionPeriod | undefined> {
    const instant = at.getTime();
    return [...this.periods.values()].find(
      (period) =>
        period.subscription_id === subscriptionId &&
        instant >= Date.parse(period.starts_at) &&
        instant < Date.parse(period.ends_at),
    );
  }
  async latestPeriod(subscriptionId: string): Promise<SubscriptionPeriod | undefined> {
    return [...this.periods.values()]
      .filter((period) => period.subscription_id === subscriptionId)
      .sort((a, b) => b.sequence - a.sequence)[0];
  }

  /**
   * The `usage_record_append_only` and `usage_record_within_period` triggers,
   * and the UNIQUE (period_id, feature_key, usage_reference) key.
   *
   * There is no `updateUsage` or `deleteUsage` on the port at all, which is
   * the strongest form of the append-only rule: the operation cannot be
   * expressed, so no backend has to refuse it. That is recorded as this
   * trigger's exemption in `TRIGGER_INVENTORY`, where the parity suite asserts
   * the absence rather than trusting this sentence.
   */
  async insertUsage(usage: UsageRecord, scope?: TransactionScope): Promise<void> {
    const period = this.periods.get(usage.period_id);
    if (!period) {
      // `putRow` below enforces this key from the declaration, and it is also
      // checked here because everything between the two reads the period: a
      // usage record is compared against the window it falls in, and an absent
      // period leaves nothing to compare against. The wording comes from the
      // declaration so there is still one copy of it.
      throw new Error(foreignKeyRefusal("usage_record", "usage_record_period_id_fkey"));
    }
    const at = Date.parse(usage.recorded_at);
    // An unparseable instant has to be refused rather than compared: NaN makes
    // every comparison below false, so the window check would silently pass
    // and the memory backend would accept a row Postgres refuses for being
    // null. That is exactly the class of backend difference the rule forbids.
    if (Number.isNaN(at)) {
      throw new Error('null value in column "recorded_at" violates not-null constraint');
    }
    // The voided-period and window refusals of `usage_record_within_period`
    // are declared in `TRANSITION_RULES` and raised by `putRow` below. Only
    // the unparseable-instant case stays here, because it is not the trigger's
    // refusal: Postgres refuses that row for a null `recorded_at`.
    for (const existing of this.usage.values()) {
      if (
        existing.period_id === usage.period_id &&
        existing.feature_key === usage.feature_key &&
        existing.usage_reference === usage.usage_reference &&
        existing.usage_id !== usage.usage_id
      ) {
        throw new Error('duplicate key value violates unique constraint "usage_record_once"');
      }
    }
    journalMapWrite(scope, this.usage, usage.usage_id);
    // The three `usage_record` CHECKs and the period key, from the rules tables.
    putRow("usage_record", this.usage, usage.usage_id, usage);
  }

  async findUsageByReference(
    periodId: string,
    featureKey: string,
    reference: string,
  ): Promise<UsageRecord | undefined> {
    return [...this.usage.values()].find(
      (item) =>
        item.period_id === periodId &&
        item.feature_key === featureKey &&
        item.usage_reference === reference,
    );
  }
  async usageTotal(periodId: string, featureKey: string): Promise<number> {
    let total = 0;
    for (const item of this.usage.values()) {
      if (item.period_id === periodId && item.feature_key === featureKey) total += item.quantity;
    }
    return total;
  }
  async listUsage(periodId: string): Promise<readonly UsageRecord[]> {
    return orderedBy(
      [...this.usage.values()].filter((item) => item.period_id === periodId),
      (item) => item.recorded_at,
      (item) => item.usage_id,
    );
  }
}
