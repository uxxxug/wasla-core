import type { Pool } from "pg";
import { iso, isoRequired, runner, type Queryable } from "../../platform/persistence/postgres.js";
import type { TransactionScope } from "../../platform/persistence/transaction.js";
import type {
  BillingInterval,
  Plan,
  PlanGrant,
  PlanStatus,
  Subscription,
  SubscriptionOwnerType,
  SubscriptionPeriod,
  SubscriptionStatus,
  UsageRecord,
} from "./domain.js";
import type { SubscriptionRepository } from "./repository.js";

/**
 * `currency` is `char(3)`, which Postgres returns blank-padded, and
 * `amount_minor` / `limit_value` / `quantity` are `bigint`, which the driver
 * returns as a string to avoid silently losing precision. Both are normalised
 * on the way out, in one place, so no caller has to remember either.
 */
function currency(value: string): string {
  return value.trim();
}

function bigint(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`value ${String(value)} exceeds the safe integer range`);
  }
  return parsed;
}

function nullableBigint(value: unknown): number | null {
  return value === null || value === undefined ? null : bigint(value);
}

export class PgSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly pool: Pool) {}

  private db(scope?: TransactionScope): Queryable {
    return runner(this.pool, scope);
  }

  // ── plans ───────────────────────────────────────────────────────────────

  async insertPlan(plan: Plan, scope?: TransactionScope): Promise<void> {
    await this.db(scope).query(
      `INSERT INTO plan (
         plan_id, code, name, currency, amount_minor, billing_interval,
         interval_count, status, created_at, activated_at, retired_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        plan.plan_id,
        plan.code,
        plan.name,
        plan.currency,
        plan.amount_minor,
        plan.billing_interval,
        plan.interval_count,
        plan.status,
        plan.created_at,
        plan.activated_at,
        plan.retired_at,
      ],
    );
  }

  async updatePlan(plan: Plan, scope?: TransactionScope): Promise<void> {
    await this.db(scope).query(
      `UPDATE plan SET code = $2, name = $3, currency = $4, amount_minor = $5,
         billing_interval = $6, interval_count = $7, status = $8,
         activated_at = $9, retired_at = $10
       WHERE plan_id = $1`,
      [
        plan.plan_id,
        plan.code,
        plan.name,
        plan.currency,
        plan.amount_minor,
        plan.billing_interval,
        plan.interval_count,
        plan.status,
        plan.activated_at,
        plan.retired_at,
      ],
    );
  }

  private toPlan(row: Record<string, unknown>): Plan {
    return {
      plan_id: row.plan_id as string,
      code: row.code as string,
      name: row.name as string,
      currency: currency(row.currency as string),
      amount_minor: bigint(row.amount_minor),
      billing_interval: row.billing_interval as BillingInterval,
      interval_count: Number(row.interval_count),
      status: row.status as PlanStatus,
      created_at: isoRequired(row.created_at as Date),
      activated_at: iso(row.activated_at as Date | null),
      retired_at: iso(row.retired_at as Date | null),
    };
  }

  async getPlan(planId: string): Promise<Plan | undefined> {
    const result = await this.db().query(`SELECT * FROM plan WHERE plan_id = $1`, [planId]);
    const row = result.rows[0];
    return row ? this.toPlan(row) : undefined;
  }

  async findPlanByCode(code: string): Promise<Plan | undefined> {
    const result = await this.db().query(`SELECT * FROM plan WHERE code = $1`, [code]);
    const row = result.rows[0];
    return row ? this.toPlan(row) : undefined;
  }

  async listPlans(status?: PlanStatus): Promise<readonly Plan[]> {
    const result = status
      ? await this.db().query(`SELECT * FROM plan WHERE status = $1 ORDER BY code COLLATE "C"`, [status])
      : await this.db().query(`SELECT * FROM plan ORDER BY code COLLATE "C"`);
    return result.rows.map((row) => this.toPlan(row));
  }

  // ── grants ──────────────────────────────────────────────────────────────

  async insertGrant(grant: PlanGrant, scope?: TransactionScope): Promise<void> {
    await this.db(scope).query(
      `INSERT INTO plan_grant (plan_id, feature_key, limit_value) VALUES ($1,$2,$3)`,
      [grant.plan_id, grant.feature_key, grant.limit_value],
    );
  }

  private toGrant(row: Record<string, unknown>): PlanGrant {
    return {
      plan_id: row.plan_id as string,
      feature_key: row.feature_key as string,
      limit_value: nullableBigint(row.limit_value),
    };
  }

  async listGrants(planId: string): Promise<readonly PlanGrant[]> {
    const result = await this.db().query(
      `SELECT * FROM plan_grant WHERE plan_id = $1 ORDER BY feature_key COLLATE "C"`,
      [planId],
    );
    return result.rows.map((row) => this.toGrant(row));
  }

  async findGrant(planId: string, featureKey: string): Promise<PlanGrant | undefined> {
    const result = await this.db().query(
      `SELECT * FROM plan_grant WHERE plan_id = $1 AND feature_key = $2`,
      [planId, featureKey],
    );
    const row = result.rows[0];
    return row ? this.toGrant(row) : undefined;
  }

  // ── subscriptions ───────────────────────────────────────────────────────

  async insertSubscription(subscription: Subscription, scope?: TransactionScope): Promise<void> {
    await this.db(scope).query(
      `INSERT INTO subscription (
         subscription_id, owner_type, owner_id, plan_id, wallet_id, status,
         created_at, cancelled_at, cancel_reason, ended_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        subscription.subscription_id,
        subscription.owner_type,
        subscription.owner_id,
        subscription.plan_id,
        subscription.wallet_id,
        subscription.status,
        subscription.created_at,
        subscription.cancelled_at,
        subscription.cancel_reason,
        subscription.ended_at,
      ],
    );
  }

  async updateSubscription(subscription: Subscription, scope?: TransactionScope): Promise<void> {
    await this.db(scope).query(
      `UPDATE subscription SET status = $2, cancelled_at = $3, cancel_reason = $4, ended_at = $5
       WHERE subscription_id = $1`,
      [
        subscription.subscription_id,
        subscription.status,
        subscription.cancelled_at,
        subscription.cancel_reason,
        subscription.ended_at,
      ],
    );
  }

  private toSubscription(row: Record<string, unknown>): Subscription {
    return {
      subscription_id: row.subscription_id as string,
      owner_type: row.owner_type as SubscriptionOwnerType,
      owner_id: row.owner_id as string,
      plan_id: row.plan_id as string,
      wallet_id: row.wallet_id as string,
      status: row.status as SubscriptionStatus,
      created_at: isoRequired(row.created_at as Date),
      cancelled_at: iso(row.cancelled_at as Date | null),
      cancel_reason: (row.cancel_reason as string | null) ?? null,
      ended_at: iso(row.ended_at as Date | null),
    };
  }

  async getSubscription(subscriptionId: string): Promise<Subscription | undefined> {
    const result = await this.db().query(`SELECT * FROM subscription WHERE subscription_id = $1`, [
      subscriptionId,
    ]);
    const row = result.rows[0];
    return row ? this.toSubscription(row) : undefined;
  }

  async listSubscriptionsForOwner(
    ownerType: SubscriptionOwnerType,
    ownerId: string,
  ): Promise<readonly Subscription[]> {
    const result = await this.db().query(
      `SELECT * FROM subscription WHERE owner_type = $1 AND owner_id = $2 ORDER BY created_at, subscription_id`,
      [ownerType, ownerId],
    );
    return result.rows.map((row) => this.toSubscription(row));
  }

  async listSubscriptionsByStatus(
    statuses: readonly SubscriptionStatus[],
  ): Promise<readonly Subscription[]> {
    const result = await this.db().query(
      `SELECT * FROM subscription WHERE status = ANY($1::text[]) ORDER BY created_at, subscription_id`,
      [[...statuses]],
    );
    return result.rows.map((row) => this.toSubscription(row));
  }

  // ── periods ─────────────────────────────────────────────────────────────

  async insertPeriod(period: SubscriptionPeriod, scope?: TransactionScope): Promise<void> {
    await this.db(scope).query(
      `INSERT INTO subscription_period (
         period_id, subscription_id, sequence, starts_at, ends_at, currency,
         amount_minor, status, authorization_id, created_at, settled_at,
         uncollectible_reason
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        period.period_id,
        period.subscription_id,
        period.sequence,
        period.starts_at,
        period.ends_at,
        period.currency,
        period.amount_minor,
        period.status,
        period.authorization_id,
        period.created_at,
        period.settled_at,
        period.uncollectible_reason,
      ],
    );
  }

  async updatePeriod(period: SubscriptionPeriod, scope?: TransactionScope): Promise<void> {
    await this.db(scope).query(
      `UPDATE subscription_period SET status = $2, authorization_id = $3, settled_at = $4,
         uncollectible_reason = $5
       WHERE period_id = $1`,
      [
        period.period_id,
        period.status,
        period.authorization_id,
        period.settled_at,
        period.uncollectible_reason,
      ],
    );
  }

  private toPeriod(row: Record<string, unknown>): SubscriptionPeriod {
    return {
      period_id: row.period_id as string,
      subscription_id: row.subscription_id as string,
      sequence: Number(row.sequence),
      starts_at: isoRequired(row.starts_at as Date),
      ends_at: isoRequired(row.ends_at as Date),
      currency: currency(row.currency as string),
      amount_minor: bigint(row.amount_minor),
      status: row.status as SubscriptionPeriod["status"],
      authorization_id: (row.authorization_id as string | null) ?? null,
      created_at: isoRequired(row.created_at as Date),
      settled_at: iso(row.settled_at as Date | null),
      uncollectible_reason: (row.uncollectible_reason as string | null) ?? null,
    };
  }

  async getPeriod(periodId: string): Promise<SubscriptionPeriod | undefined> {
    const result = await this.db().query(`SELECT * FROM subscription_period WHERE period_id = $1`, [
      periodId,
    ]);
    const row = result.rows[0];
    return row ? this.toPeriod(row) : undefined;
  }

  async listPeriods(subscriptionId: string): Promise<readonly SubscriptionPeriod[]> {
    const result = await this.db().query(
      `SELECT * FROM subscription_period WHERE subscription_id = $1 ORDER BY sequence`,
      [subscriptionId],
    );
    return result.rows.map((row) => this.toPeriod(row));
  }

  /**
   * Half-open, matching the exclusion constraint the schema uses. Written as
   * the same range predicate rather than two comparisons so the query and the
   * constraint cannot disagree about the boundary instant.
   */
  async findPeriodCovering(subscriptionId: string, at: Date): Promise<SubscriptionPeriod | undefined> {
    const result = await this.db().query(
      `SELECT * FROM subscription_period
       WHERE subscription_id = $1 AND tstzrange(starts_at, ends_at, '[)') @> $2::timestamptz`,
      [subscriptionId, at.toISOString()],
    );
    const row = result.rows[0];
    return row ? this.toPeriod(row) : undefined;
  }

  async latestPeriod(subscriptionId: string): Promise<SubscriptionPeriod | undefined> {
    const result = await this.db().query(
      `SELECT * FROM subscription_period WHERE subscription_id = $1
       ORDER BY sequence DESC LIMIT 1`,
      [subscriptionId],
    );
    const row = result.rows[0];
    return row ? this.toPeriod(row) : undefined;
  }

  // ── usage ───────────────────────────────────────────────────────────────

  async insertUsage(usage: UsageRecord, scope?: TransactionScope): Promise<void> {
    await this.db(scope).query(
      `INSERT INTO usage_record (
         usage_id, period_id, feature_key, quantity, usage_reference,
         recorded_at, correlation_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        usage.usage_id,
        usage.period_id,
        usage.feature_key,
        usage.quantity,
        usage.usage_reference,
        usage.recorded_at,
        usage.correlation_id,
      ],
    );
  }

  private toUsage(row: Record<string, unknown>): UsageRecord {
    return {
      usage_id: row.usage_id as string,
      period_id: row.period_id as string,
      feature_key: row.feature_key as string,
      quantity: bigint(row.quantity),
      usage_reference: row.usage_reference as string,
      recorded_at: isoRequired(row.recorded_at as Date),
      correlation_id: (row.correlation_id as string | null) ?? null,
    };
  }

  async findUsageByReference(
    periodId: string,
    featureKey: string,
    reference: string,
  ): Promise<UsageRecord | undefined> {
    const result = await this.db().query(
      `SELECT * FROM usage_record
       WHERE period_id = $1 AND feature_key = $2 AND usage_reference = $3`,
      [periodId, featureKey, reference],
    );
    const row = result.rows[0];
    return row ? this.toUsage(row) : undefined;
  }

  /** Summed in the database so counting a busy period does not load it. */
  async usageTotal(periodId: string, featureKey: string): Promise<number> {
    const result = await this.db().query(
      `SELECT COALESCE(SUM(quantity), 0) AS total FROM usage_record
       WHERE period_id = $1 AND feature_key = $2`,
      [periodId, featureKey],
    );
    return bigint(result.rows[0]?.total ?? 0);
  }

  async listUsage(periodId: string): Promise<readonly UsageRecord[]> {
    const result = await this.db().query(
      `SELECT * FROM usage_record WHERE period_id = $1 ORDER BY recorded_at, usage_id`,
      [periodId],
    );
    return result.rows.map((row) => this.toUsage(row));
  }
}
