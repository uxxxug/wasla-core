import type { AuditLog } from "../../platform/audit/audit.js";
import type { Clock } from "../../platform/clock.js";
import { conflict, invalid, notFound, CoreError } from "../../platform/errors.js";
import { makeEvent } from "../../platform/eventing/envelope.js";
import type { OutboxStore } from "../../platform/eventing/outbox.js";
import { withTransaction, type UnitOfWork } from "../../platform/eventing/unit-of-work.js";
import { assertId, newId } from "../../platform/ids.js";
import type { TransactionBoundary } from "../../platform/persistence/transaction.js";
import { normalizeCurrency } from "../money/domain.js";
import type { MoneyService } from "../money/service.js";
import {
  advanceInterval,
  decideEntitlement,
  periodChargeReference,
  type BillingInterval,
  type EntitlementDecision,
  type Plan,
  type PlanGrant,
  type Subscription,
  type SubscriptionOwnerType,
  type SubscriptionPeriod,
  type UsageRecord,
} from "./domain.js";
import type { SubscriptionRepository } from "./repository.js";

const PRODUCER = "wasla-core";

export interface ChargeResult {
  period: SubscriptionPeriod;
  /** False when the charge was attempted and refused, not when it was a retry. */
  collected: boolean;
  reason: string | null;
}

/**
 * Subscriptions, plans, periods, usage and entitlement (ADR 0013).
 *
 * Two decisions shape everything here and are worth stating once:
 *
 *   - Entitlement is never stored. It is computed from the subscription's
 *     status, the plan's grants and the usage recorded against the current
 *     period. A table of entitlement rows would be a second source of truth
 *     for something already fully determined, and the settlement cycle
 *     established the cost of that: state that can drift from what it
 *     summarises is state nobody can reconcile.
 *
 *   - A period charge is an ordinary payment authorization, not a second money
 *     path. The money module already makes capture exactly-once against a
 *     unique business reference, and reusing it means a subscription charge is
 *     reconcilable against the same ledger as everything else.
 */
export class SubscriptionService {
  constructor(
    private readonly repo: SubscriptionRepository,
    private readonly money: MoneyService,
    private readonly outbox: OutboxStore,
    private readonly boundary: TransactionBoundary,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
  ) {}

  private get tx() {
    return { boundary: this.boundary, outbox: this.outbox, audit: this.audit };
  }

  // ── plans ───────────────────────────────────────────────────────────────

  /**
   * Creates a plan as a **draft**, with its grants.
   *
   * Draft rather than immediately offerable because a plan's terms freeze the
   * moment it becomes active — they have to, since periods are priced from
   * them and settled history may not be re-described. Activation is therefore
   * a separate, explicit act: the operator confirms the terms before they stop
   * being changeable.
   */
  async createPlan(input: {
    code: string;
    name: string;
    currency: string;
    amount_minor: number;
    billing_interval: BillingInterval;
    interval_count?: number;
    grants: ReadonlyArray<{ feature_key: string; limit_value: number | null }>;
    correlation_id: string;
  }): Promise<{ plan: Plan; grants: readonly PlanGrant[] }> {
    const code = input.code.trim();
    if (code.length === 0) throw invalid("code is required");
    if (input.name.trim().length === 0) throw invalid("name is required");
    if (!Number.isSafeInteger(input.amount_minor) || input.amount_minor < 0) {
      // Zero is allowed: a free tier is still a plan with grants and periods.
      // Negative is not a price. ADR 0012 leaves the rate itself to the
      // operator, so this is the only judgement CORE makes about the number.
      throw invalid("amount_minor must be a non-negative integer");
    }
    const intervalCount = input.interval_count ?? 1;
    if (!Number.isSafeInteger(intervalCount) || intervalCount <= 0) {
      throw invalid("interval_count must be a positive integer");
    }
    if (await this.repo.findPlanByCode(code)) throw conflict("plan code already exists");

    const seen = new Set<string>();
    for (const grant of input.grants) {
      const key = grant.feature_key.trim();
      if (key.length === 0) throw invalid("feature_key is required");
      if (seen.has(key)) throw invalid(`feature_key ${key} appears twice`);
      seen.add(key);
      if (grant.limit_value !== null && (!Number.isSafeInteger(grant.limit_value) || grant.limit_value < 0)) {
        throw invalid("limit_value must be null or a non-negative integer");
      }
    }

    const plan: Plan = {
      plan_id: newId(),
      code,
      name: input.name.trim(),
      currency: normalizeCurrency(input.currency),
      amount_minor: input.amount_minor,
      billing_interval: input.billing_interval,
      interval_count: intervalCount,
      status: "draft",
      created_at: this.clock.now().toISOString(),
      activated_at: null,
      retired_at: null,
    };
    const grants: PlanGrant[] = input.grants.map((grant) => ({
      plan_id: plan.plan_id,
      feature_key: grant.feature_key.trim(),
      limit_value: grant.limit_value,
    }));

    await withTransaction(this.tx, async (uow) => {
      uow.stage(async (scope) => {
        await this.repo.insertPlan(plan, scope);
        for (const grant of grants) await this.repo.insertGrant(grant, scope);
      });
      // No event. A draft plan is not a business fact yet — nothing outside
      // CORE can act on terms that are still changeable (ADR 0009).
      uow.audit({
        actor_type: "system",
        actor_id: null,
        action: "plan.created",
        entity_type: "plan",
        entity_id: plan.plan_id,
        correlation_id: input.correlation_id,
        metadata: { code: plan.code, grants: grants.length },
      });
    });

    return { plan, grants };
  }

  /** Freezes the plan's terms and makes it subscribable. */
  async activatePlan(input: { plan_id: string; correlation_id: string }): Promise<Plan> {
    assertId("plan_id", input.plan_id);
    const plan = await this.requirePlan(input.plan_id);
    if (plan.status === "active") return plan;
    if (plan.status === "retired") throw conflict("plan is retired");
    const grants = await this.repo.listGrants(plan.plan_id);
    if (grants.length === 0) {
      // A plan granting nothing would produce subscriptions that entitle
      // nothing while still being billed.
      throw conflict("plan grants nothing and cannot be activated");
    }
    const updated: Plan = { ...plan, status: "active", activated_at: this.clock.now().toISOString() };
    await withTransaction(this.tx, async (uow) => {
      uow.stage((scope) => this.repo.updatePlan(updated, scope));
      uow.audit({
        actor_type: "system",
        actor_id: null,
        action: "plan.activated",
        entity_type: "plan",
        entity_id: plan.plan_id,
        correlation_id: input.correlation_id,
        metadata: { code: plan.code, amount_minor: plan.amount_minor, currency: plan.currency },
      });
    });
    return updated;
  }

  /**
   * Stops the plan being offered. Existing subscriptions keep running on it,
   * because they were sold those terms and there is no policy for moving them.
   */
  async retirePlan(input: { plan_id: string; correlation_id: string }): Promise<Plan> {
    assertId("plan_id", input.plan_id);
    const plan = await this.requirePlan(input.plan_id);
    if (plan.status === "retired") return plan;
    if (plan.status === "draft") throw conflict("a draft plan was never offered and cannot be retired");
    const updated: Plan = { ...plan, status: "retired", retired_at: this.clock.now().toISOString() };
    await withTransaction(this.tx, async (uow) => {
      uow.stage((scope) => this.repo.updatePlan(updated, scope));
      uow.audit({
        actor_type: "system",
        actor_id: null,
        action: "plan.retired",
        entity_type: "plan",
        entity_id: plan.plan_id,
        correlation_id: input.correlation_id,
        metadata: { code: plan.code },
      });
    });
    return updated;
  }

  async listPlans(status?: Plan["status"]): Promise<readonly Plan[]> {
    return this.repo.listPlans(status);
  }

  async getPlan(planId: string): Promise<{ plan: Plan; grants: readonly PlanGrant[] }> {
    assertId("plan_id", planId);
    const plan = await this.requirePlan(planId);
    return { plan, grants: await this.repo.listGrants(planId) };
  }

  // ── subscriptions ───────────────────────────────────────────────────────

  /**
   * Subscribes an owner to a plan and opens the first period.
   *
   * The subscription and its first period commit together, and the charge is a
   * separate unit of work on purpose. If the charge were in the same
   * transaction, a wallet that could not pay would roll the subscription away
   * entirely and there would be nothing left to retry against — the owner
   * would have to be signed up again and nobody would know an attempt had ever
   * been made. So the commitment is recorded first and its collection is a
   * distinct, repeatable step.
   */
  async subscribe(input: {
    owner_type: SubscriptionOwnerType;
    owner_id: string;
    plan_id: string;
    wallet_id: string;
    starts_at?: Date | string;
    correlation_id: string;
  }): Promise<{ subscription: Subscription; period: SubscriptionPeriod; charge: ChargeResult }> {
    assertId("owner_id", input.owner_id);
    assertId("plan_id", input.plan_id);
    assertId("wallet_id", input.wallet_id);

    const plan = await this.requirePlan(input.plan_id);
    if (plan.status !== "active") throw conflict(`plan is ${plan.status} and cannot be subscribed to`);

    // The wallet has to exist and match the plan's currency. Checked here as
    // well as by the database trigger, so the caller gets a refusal naming the
    // currencies instead of a constraint violation.
    const wallet = await this.money.getWallet(input.wallet_id);
    if (!wallet) throw notFound("wallet not found");
    if (wallet.currency !== plan.currency) {
      throw invalid(`plan is priced in ${plan.currency} but the wallet holds ${wallet.currency}`);
    }
    if (wallet.owner_type !== input.owner_type || wallet.owner_id !== input.owner_id) {
      // Otherwise one tenant's subscription could be billed to another's
      // wallet, which no amount of later reconciliation could untangle.
      throw invalid("wallet belongs to a different owner");
    }

    // One live subscription per owner per plan. A second one would bill twice
    // for overlapping coverage and make "the" current period ambiguous, which
    // is the same defect the period exclusion constraint prevents one level
    // down.
    const existing = await this.repo.listSubscriptionsForOwner(input.owner_type, input.owner_id);
    const live = existing.find(
      (item) => item.plan_id === plan.plan_id && (item.status === "active" || item.status === "past_due"),
    );
    if (live) throw conflict("owner already has a live subscription to this plan");

    const startsAt = input.starts_at ? new Date(input.starts_at) : this.clock.now();
    if (Number.isNaN(startsAt.getTime())) throw invalid("starts_at is not a valid instant");

    const subscription: Subscription = {
      subscription_id: newId(),
      owner_type: input.owner_type,
      owner_id: input.owner_id,
      plan_id: plan.plan_id,
      wallet_id: input.wallet_id,
      status: "active",
      created_at: this.clock.now().toISOString(),
      cancelled_at: null,
      cancel_reason: null,
      ended_at: null,
    };
    const period = this.buildPeriod(subscription, plan, 1, startsAt);

    await withTransaction(this.tx, async (uow) => {
      uow.stage(async (scope) => {
        await this.repo.insertSubscription(subscription, scope);
        await this.repo.insertPeriod(period, scope);
      });
      uow.emit(
        makeEvent({
          event_type: "core.subscription.created",
          entity_type: "subscription",
          entity_id: subscription.subscription_id,
          version: 1,
          producer: PRODUCER,
          occurred_at: this.clock.now(),
          correlation_id: input.correlation_id,
          payload: {
            subscription_id: subscription.subscription_id,
            owner_type: subscription.owner_type,
            owner_id: subscription.owner_id,
            plan_id: plan.plan_id,
            plan_code: plan.code,
            period_id: period.period_id,
            period_starts_at: period.starts_at,
            period_ends_at: period.ends_at,
            currency: period.currency,
            amount_minor: period.amount_minor,
          },
        }),
      );
      uow.audit({
        actor_type: "system",
        actor_id: null,
        action: "subscription.created",
          entity_type: "subscription",
        entity_id: subscription.subscription_id,
        correlation_id: input.correlation_id,
        metadata: { plan_code: plan.code, period_id: period.period_id },
      });
    });

    const charge = await this.chargePeriod({
      period_id: period.period_id,
      correlation_id: input.correlation_id,
    });
    const settled = await this.repo.getSubscription(subscription.subscription_id);
    return { subscription: settled ?? subscription, period: charge.period, charge };
  }

  private buildPeriod(
    subscription: Subscription,
    plan: Plan,
    sequence: number,
    startsAt: Date,
  ): SubscriptionPeriod {
    return {
      period_id: newId(),
      subscription_id: subscription.subscription_id,
      sequence,
      starts_at: startsAt.toISOString(),
      ends_at: advanceInterval(startsAt, plan.billing_interval, plan.interval_count).toISOString(),
      // Copied from the plan, not read through it: this row is the invoice.
      currency: plan.currency,
      amount_minor: plan.amount_minor,
      status: "pending",
      authorization_id: null,
      created_at: this.clock.now().toISOString(),
      settled_at: null,
      uncollectible_reason: null,
    };
  }

  /**
   * Collects a period.
   *
   * Idempotent, and the idempotency lookup comes **first** — before any
   * reasoning about the amount. That ordering is not stylistic: a settled
   * period has nothing left to collect, so considering the amount ahead of the
   * retry check would turn a retry into "collect zero" and refuse it as
   * malformed. The settlement cycle learned this the hard way.
   *
   * A refused collection is a business outcome, not an exception. It returns
   * `collected: false` rather than throwing, so a renewal sweep over many
   * subscriptions is not aborted by the first empty wallet, and so the reason
   * is recorded on the period instead of being carried away in a stack trace.
   */
  async chargePeriod(input: { period_id: string; correlation_id: string }): Promise<ChargeResult> {
    assertId("period_id", input.period_id);
    const period = await this.requirePeriod(input.period_id);

    if (period.status === "settled") return { period, collected: true, reason: null };
    if (period.status === "voided") throw conflict("period was voided and cannot be collected");

    const subscription = await this.requireSubscription(period.subscription_id);

    // Nothing owed, nothing to move. A free plan's period settles with no
    // authorization at all, which is exactly what the schema says a
    // zero-amount settled period looks like.
    if (period.amount_minor === 0) {
      return this.settlePeriod(period, subscription, null, input.correlation_id);
    }

    let authorizationId: string;
    try {
      // The reference is derived from the period, so a crash between this
      // transaction and the capture below cannot produce a second hold: the
      // retry finds the one that already exists.
      const authorization = await this.money.authorize({
        wallet_id: subscription.wallet_id,
        amount_minor: period.amount_minor,
        business_reference: periodChargeReference(period.period_id),
        correlation_id: input.correlation_id,
      });
      authorizationId = authorization.authorization_id;
    } catch (error) {
      if (error instanceof CoreError && (error.code === "conflict" || error.code === "not_found")) {
        return this.markUncollectible(period, subscription, error.message, input.correlation_id);
      }
      throw error;
    }

    try {
      return await this.settlePeriod(period, subscription, authorizationId, input.correlation_id);
    } catch (error) {
      if (error instanceof CoreError && error.code === "conflict") {
        return this.markUncollectible(period, subscription, error.message, input.correlation_id);
      }
      throw error;
    }
  }

  /**
   * Marks the period settled and the money captured in **one** transaction.
   *
   * `captureWithin` enlists in this unit of work rather than opening its own,
   * so the ledger movement and the billing record either both land or neither
   * does. A period that reads `settled` with no capture behind it, or a capture
   * with no period explaining it, is the one thing a billing system may never
   * produce.
   */
  private async settlePeriod(
    period: SubscriptionPeriod,
    subscription: Subscription,
    authorizationId: string | null,
    correlationId: string,
  ): Promise<ChargeResult> {
    const now = this.clock.now();
    const settled: SubscriptionPeriod = {
      ...period,
      status: "settled",
      authorization_id: authorizationId,
      settled_at: now.toISOString(),
      uncollectible_reason: null,
    };
    // Collecting clears past_due, and only past_due: a cancelled subscription
    // paying its final period does not become active again.
    const revived: Subscription | null =
      subscription.status === "past_due" ? { ...subscription, status: "active" } : null;

    await withTransaction(this.tx, async (uow) => {
      if (authorizationId) {
        await this.money.captureWithin(uow as UnitOfWork, {
          authorization_id: authorizationId,
          correlation_id: correlationId,
        });
      }
      uow.stage(async (scope) => {
        await this.repo.updatePeriod(settled, scope);
        if (revived) await this.repo.updateSubscription(revived, scope);
      });
      uow.emit(
        makeEvent({
          event_type: "core.subscription.period_settled",
          entity_type: "subscription",
          entity_id: settled.subscription_id,
          version: 1,
          producer: PRODUCER,
          occurred_at: now,
          correlation_id: correlationId,
          payload: {
            subscription_id: subscription.subscription_id,
            period_id: settled.period_id,
            sequence: settled.sequence,
            period_starts_at: settled.starts_at,
            period_ends_at: settled.ends_at,
            currency: settled.currency,
            amount_minor: settled.amount_minor,
            authorization_id: authorizationId,
          },
        }),
      );
      uow.audit({
        actor_type: "system",
        actor_id: null,
        action: "subscription.period_settled",
        entity_type: "subscription_period",
        entity_id: settled.period_id,
        correlation_id: correlationId,
        metadata: {
          subscription_id: subscription.subscription_id,
          amount_minor: settled.amount_minor,
          authorization_id: authorizationId,
        },
      });
    });

    return { period: settled, collected: true, reason: null };
  }

  /**
   * Records that a period could not be collected.
   *
   * Its own transaction, because the attempt it describes was refused — there
   * is no successful mutation to attach it to, and rolling it back with the
   * failed charge would erase the only evidence of why the subscription is
   * past due (B-9).
   */
  private async markUncollectible(
    period: SubscriptionPeriod,
    subscription: Subscription,
    reason: string,
    correlationId: string,
  ): Promise<ChargeResult> {
    const now = this.clock.now();
    const updated: SubscriptionPeriod = {
      ...period,
      status: "uncollectible",
      authorization_id: null,
      settled_at: null,
      uncollectible_reason: reason,
    };
    // A cancelled or expired subscription is not made past_due by a failed
    // collection; it has already stopped, and overwriting its status would
    // lose why it stopped.
    const pastDue: Subscription | null =
      subscription.status === "active" ? { ...subscription, status: "past_due" } : null;

    await withTransaction(this.tx, async (uow) => {
      uow.stage(async (scope) => {
        await this.repo.updatePeriod(updated, scope);
        if (pastDue) await this.repo.updateSubscription(pastDue, scope);
      });
      uow.emit(
        makeEvent({
          event_type: "core.subscription.past_due",
          entity_type: "subscription",
          entity_id: subscription.subscription_id,
          version: 1,
          producer: PRODUCER,
          occurred_at: now,
          correlation_id: correlationId,
          payload: {
            subscription_id: subscription.subscription_id,
            owner_type: subscription.owner_type,
            owner_id: subscription.owner_id,
            period_id: updated.period_id,
            currency: updated.currency,
            amount_minor: updated.amount_minor,
            reason,
          },
        }),
      );
      uow.audit({
        actor_type: "system",
        actor_id: null,
        action: "subscription.period_uncollectible",
        entity_type: "subscription_period",
        entity_id: updated.period_id,
        correlation_id: correlationId,
        metadata: { subscription_id: subscription.subscription_id, reason },
      });
    });

    return { period: updated, collected: false, reason };
  }

  /**
   * Cancels a subscription.
   *
   * Coverage runs to the end of the period already paid for; there is no
   * proration, because no proration policy exists and inventing one here would
   * silently decide how much revenue is given back (recorded as a blocker in
   * ROADMAP.md). A period that was never collected is voided instead, since
   * nothing was paid for and leaving it collectible would bill someone after
   * they left.
   */
  async cancelSubscription(input: {
    subscription_id: string;
    reason: string;
    correlation_id: string;
  }): Promise<{ subscription: Subscription; voided_period_id: string | null }> {
    assertId("subscription_id", input.subscription_id);
    const reason = input.reason.trim();
    if (reason.length === 0) throw invalid("reason is required");
    const subscription = await this.requireSubscription(input.subscription_id);
    if (subscription.status === "cancelled") {
      return { subscription, voided_period_id: null };
    }
    if (subscription.status === "expired") throw conflict("subscription has already expired");

    const now = this.clock.now();
    const current = await this.repo.findPeriodCovering(subscription.subscription_id, now);
    const voidable = current && current.status !== "settled" ? current : undefined;

    const updated: Subscription = {
      ...subscription,
      status: "cancelled",
      cancelled_at: now.toISOString(),
      cancel_reason: reason,
      // Paid time is honoured; unpaid time ends now.
      ended_at: voidable ? now.toISOString() : (current?.ends_at ?? now.toISOString()),
    };
    const voided: SubscriptionPeriod | null = voidable
      ? {
          ...voidable,
          status: "voided",
          authorization_id: null,
          settled_at: null,
          uncollectible_reason: null,
        }
      : null;

    await withTransaction(this.tx, async (uow) => {
      uow.stage(async (scope) => {
        await this.repo.updateSubscription(updated, scope);
        if (voided) await this.repo.updatePeriod(voided, scope);
      });
      uow.emit(
        makeEvent({
          event_type: "core.subscription.cancelled",
          entity_type: "subscription",
          entity_id: subscription.subscription_id,
          version: 1,
          producer: PRODUCER,
          occurred_at: now,
          correlation_id: input.correlation_id,
          payload: {
            subscription_id: subscription.subscription_id,
            owner_type: subscription.owner_type,
            owner_id: subscription.owner_id,
            plan_id: subscription.plan_id,
            reason,
            coverage_ends_at: updated.ended_at,
            voided_period_id: voided?.period_id ?? null,
          },
        }),
      );
      uow.audit({
        actor_type: "system",
        actor_id: null,
        action: "subscription.cancelled",
          entity_type: "subscription",
        entity_id: subscription.subscription_id,
        correlation_id: input.correlation_id,
        metadata: { reason, coverage_ends_at: updated.ended_at },
      });
    });

    return { subscription: updated, voided_period_id: voided?.period_id ?? null };
  }

  /**
   * Opens and collects the next period for every subscription whose current
   * one has ended, and expires the cancelled ones.
   *
   * Driven by a sweep rather than a timer per subscription for the same reason
   * hold expiry is: the work has to be idempotent and restartable, and a sweep
   * that can be run twice with the same result needs no scheduler state. A
   * collection that fails leaves the subscription `past_due` and the sweep
   * continues, so one empty wallet cannot stop everyone else's renewal.
   */
  async renewDuePeriods(correlationId: string): Promise<{
    renewed: readonly SubscriptionPeriod[];
    expired: readonly string[];
    uncollectible: readonly string[];
  }> {
    const now = this.clock.now();
    const candidates = await this.repo.listSubscriptionsByStatus([
      "active",
      "past_due",
      "cancelled",
    ]);
    const renewed: SubscriptionPeriod[] = [];
    const expired: string[] = [];
    const uncollectible: string[] = [];

    for (const subscription of candidates) {
      const latest = await this.repo.latestPeriod(subscription.subscription_id);
      if (!latest) continue;
      // Still inside the current period: nothing due.
      if (Date.parse(latest.ends_at) > now.getTime()) continue;

      if (subscription.status === "cancelled") {
        await this.expireSubscription(subscription, correlationId);
        expired.push(subscription.subscription_id);
        continue;
      }

      const plan = await this.repo.getPlan(subscription.plan_id);
      if (!plan) continue;
      // The next period starts exactly where the last one ended, so renewal
      // never leaves a gap of uncovered-but-unbilled time, and never overlaps.
      const next = this.buildPeriod(
        subscription,
        plan,
        latest.sequence + 1,
        new Date(latest.ends_at),
      );

      await withTransaction(this.tx, async (uow) => {
        uow.stage((scope) => this.repo.insertPeriod(next, scope));
        uow.emit(
          makeEvent({
            event_type: "core.subscription.renewed",
            entity_type: "subscription",
            entity_id: next.subscription_id,
            version: 1,
            producer: PRODUCER,
            occurred_at: now,
            correlation_id: correlationId,
            payload: {
              subscription_id: subscription.subscription_id,
              period_id: next.period_id,
              sequence: next.sequence,
              period_starts_at: next.starts_at,
              period_ends_at: next.ends_at,
              currency: next.currency,
              amount_minor: next.amount_minor,
            },
          }),
        );
        uow.audit({
          actor_type: "system",
          actor_id: null,
          action: "subscription.renewed",
          entity_type: "subscription_period",
          entity_id: next.period_id,
          correlation_id: correlationId,
          metadata: { subscription_id: subscription.subscription_id, sequence: next.sequence },
        });
      });

      const charge = await this.chargePeriod({
        period_id: next.period_id,
        correlation_id: correlationId,
      });
      renewed.push(charge.period);
      if (!charge.collected) uncollectible.push(next.period_id);
    }

    return { renewed, expired, uncollectible };
  }

  private async expireSubscription(subscription: Subscription, correlationId: string): Promise<void> {
    const now = this.clock.now();
    const updated: Subscription = {
      ...subscription,
      status: "expired",
      // `cancelled_at` has to go, because the CHECK ties it to the cancelled
      // status. The cancellation is not lost: `cancel_reason` and `ended_at`
      // both survive, and the audit trail holds when it was asked for.
      cancelled_at: null,
      ended_at: subscription.ended_at ?? now.toISOString(),
    };
    await withTransaction(this.tx, async (uow) => {
      uow.stage((scope) => this.repo.updateSubscription(updated, scope));
      uow.emit(
        makeEvent({
          event_type: "core.subscription.expired",
          entity_type: "subscription",
          entity_id: subscription.subscription_id,
          version: 1,
          producer: PRODUCER,
          occurred_at: now,
          correlation_id: correlationId,
          payload: {
            subscription_id: subscription.subscription_id,
            owner_type: subscription.owner_type,
            owner_id: subscription.owner_id,
            plan_id: subscription.plan_id,
            ended_at: updated.ended_at,
          },
        }),
      );
      uow.audit({
        actor_type: "system",
        actor_id: null,
        action: "subscription.expired",
          entity_type: "subscription",
        entity_id: subscription.subscription_id,
        correlation_id: correlationId,
        metadata: { ended_at: updated.ended_at },
      });
    });
  }

  // ── usage ───────────────────────────────────────────────────────────────

  /**
   * Records metered consumption against whichever period covers the instant.
   *
   * Idempotent on `(period, feature_key, usage_reference)`. Usage arrives from
   * another system over an at-least-once channel, so the same consumption will
   * be reported more than once; the unique key is what makes it count once,
   * exactly as the ledger's unique business reference does for money.
   *
   * No event is emitted. Usage is high-volume and nothing outside CORE
   * consumes it, and an outbox row per reported unit would make the outbox the
   * system's busiest table for no consumer's benefit (ADR 0009: events carry
   * business facts).
   */
  async recordUsage(input: {
    subscription_id: string;
    feature_key: string;
    quantity: number;
    usage_reference: string;
    at?: Date | string;
    correlation_id: string;
  }): Promise<{ usage: UsageRecord; recorded: boolean }> {
    assertId("subscription_id", input.subscription_id);
    const featureKey = input.feature_key.trim();
    if (featureKey.length === 0) throw invalid("feature_key is required");
    const reference = input.usage_reference.trim();
    if (reference.length === 0) throw invalid("usage_reference is required");
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
      throw invalid("quantity must be a positive integer");
    }

    const subscription = await this.requireSubscription(input.subscription_id);
    const at = input.at ? new Date(input.at) : this.clock.now();
    if (Number.isNaN(at.getTime())) throw invalid("at is not a valid instant");
    const period = await this.repo.findPeriodCovering(subscription.subscription_id, at);
    if (!period) throw conflict("no period covers that instant");
    if (period.status === "voided") throw conflict("period was voided and cannot accrue usage");

    const existing = await this.repo.findUsageByReference(period.period_id, featureKey, reference);
    if (existing) return { usage: existing, recorded: false };

    const usage: UsageRecord = {
      usage_id: newId(),
      period_id: period.period_id,
      feature_key: featureKey,
      quantity: input.quantity,
      usage_reference: reference,
      recorded_at: at.toISOString(),
      correlation_id: input.correlation_id,
    };

    // Usage is recorded even past its limit, and the entitlement check is what
    // refuses further work. Silently dropping consumption that exceeded a
    // quota would leave the record of what was actually consumed incomplete,
    // and that record is the only defensible basis for a bill or a dispute.
    await withTransaction(this.tx, async (uow) => {
      uow.stage((scope) => this.repo.insertUsage(usage, scope));
      uow.audit({
        actor_type: "system",
        actor_id: null,
        action: "subscription.usage_recorded",
        entity_type: "usage_record",
        entity_id: usage.usage_id,
        correlation_id: input.correlation_id,
        metadata: {
          subscription_id: subscription.subscription_id,
          period_id: period.period_id,
          feature_key: featureKey,
          quantity: input.quantity,
        },
      });
    });

    return { usage, recorded: true };
  }

  // ── entitlement ─────────────────────────────────────────────────────────

  /**
   * Answers whether an owner may use a feature right now.
   *
   * Derived every time, from the subscription, the plan's grants and the usage
   * recorded against the covering period. Nothing about this answer is stored,
   * so there is nothing that can disagree with the facts it is computed from.
   *
   * Reachable only in-process: CORE exposes no HTTP entitlement check. ADR 0008
   * closes the list of synchronous paths between systems and the ADR register
   * states that any new one requires a new ADR before the code is written. An
   * endpoint MARKET or MOVE would call on every request is exactly such a path,
   * so it is recorded as a blocker in ROADMAP.md rather than added here.
   */
  async checkEntitlement(input: {
    owner_type: SubscriptionOwnerType;
    owner_id: string;
    feature_key: string;
    quantity?: number;
    at?: Date | string;
  }): Promise<EntitlementDecision> {
    assertId("owner_id", input.owner_id);
    const featureKey = input.feature_key.trim();
    if (featureKey.length === 0) throw invalid("feature_key is required");
    const quantity = input.quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw invalid("quantity must be a positive integer");
    }
    const at = input.at ? new Date(input.at) : this.clock.now();
    if (Number.isNaN(at.getTime())) throw invalid("at is not a valid instant");

    const subscriptions = await this.repo.listSubscriptionsForOwner(input.owner_type, input.owner_id);

    // An owner may hold several subscriptions, and the most favourable answer
    // is the right one: a feature granted by any plan they pay for is granted.
    // Iterating in a fixed order and taking the first allowance keeps the
    // answer stable rather than dependent on row order.
    const ordered = [...subscriptions].sort((a, b) => a.created_at.localeCompare(b.created_at));
    let best: EntitlementDecision | undefined;

    for (const subscription of ordered) {
      const period = await this.repo.findPeriodCovering(subscription.subscription_id, at);
      const grant = await this.repo.findGrant(subscription.plan_id, featureKey);
      const used = period ? await this.repo.usageTotal(period.period_id, featureKey) : 0;
      const decision = decideEntitlement({
        feature_key: featureKey,
        quantity,
        subscription,
        period,
        grant,
        used,
      });
      if (decision.allowed) return decision;
      // Keep the most informative refusal: one that found the feature in a
      // plan explains more than one that never saw it.
      if (!best || (best.reason === "not_in_plan" && decision.reason !== "not_in_plan")) {
        best = decision;
      }
    }

    return (
      best ??
      decideEntitlement({
        feature_key: featureKey,
        quantity,
        subscription: undefined,
        period: undefined,
        grant: undefined,
        used: 0,
      })
    );
  }

  // ── reads ───────────────────────────────────────────────────────────────

  async getSubscription(subscriptionId: string): Promise<{
    subscription: Subscription;
    periods: readonly SubscriptionPeriod[];
  }> {
    assertId("subscription_id", subscriptionId);
    const subscription = await this.requireSubscription(subscriptionId);
    return { subscription, periods: await this.repo.listPeriods(subscriptionId) };
  }

  async listSubscriptionsForOwner(
    ownerType: SubscriptionOwnerType,
    ownerId: string,
  ): Promise<readonly Subscription[]> {
    assertId("owner_id", ownerId);
    return this.repo.listSubscriptionsForOwner(ownerType, ownerId);
  }

  private async requirePlan(planId: string): Promise<Plan> {
    const plan = await this.repo.getPlan(planId);
    if (!plan) throw notFound("plan not found");
    return plan;
  }

  private async requireSubscription(subscriptionId: string): Promise<Subscription> {
    const subscription = await this.repo.getSubscription(subscriptionId);
    if (!subscription) throw notFound("subscription not found");
    return subscription;
  }

  private async requirePeriod(periodId: string): Promise<SubscriptionPeriod> {
    const period = await this.repo.getPeriod(periodId);
    if (!period) throw notFound("subscription period not found");
    return period;
  }
}
