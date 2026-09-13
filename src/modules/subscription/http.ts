import { invalid } from "../../platform/errors.js";
import type { RequestContext, Router } from "../../platform/http/router.js";
import { requirePrincipal } from "../identity-access/http.js";
import type { IdentityService } from "../identity-access/service.js";
import type { BillingInterval, SubscriptionOwnerType } from "./domain.js";
import type { SubscriptionService } from "./service.js";

/** The plan statuses `GET /v1/plans` may be filtered by. */
const PLAN_STATUSES = ["draft", "active", "retired"] as const;

function objectBody(ctx: RequestContext): Record<string, unknown> {
  if (typeof ctx.body !== "object" || ctx.body === null) throw invalid("JSON object body required");
  return ctx.body as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw invalid(`${key} is required`);
  return value;
}

function requiredInteger(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== "number") throw invalid(`${key} is required`);
  return value;
}

function ownerType(value: string): SubscriptionOwnerType {
  if (value !== "identity" && value !== "organization") throw invalid("unsupported owner_type");
  return value;
}

function billingInterval(value: string): BillingInterval {
  if (value !== "day" && value !== "week" && value !== "month" && value !== "year") {
    throw invalid("billing_interval must be day, week, month or year");
  }
  return value;
}

/**
 * Grants arrive as a list, and `limit_value` must be `null` explicitly.
 *
 * An omitted limit is refused rather than defaulted, because the two things it
 * could mean — "granted without a quota" and "a quota of nothing" — are
 * opposites. Guessing either one would silently decide what a plan sells.
 */
function grants(input: Record<string, unknown>): Array<{ feature_key: string; limit_value: number | null }> {
  const raw = input["grants"];
  if (!Array.isArray(raw) || raw.length === 0) throw invalid("grants must be a non-empty array");
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) throw invalid(`grants[${index}] must be an object`);
    const grant = entry as Record<string, unknown>;
    const featureKey = requiredString(grant, "feature_key");
    if (!("limit_value" in grant)) {
      throw invalid(`grants[${index}].limit_value is required; use null for an unmetered grant`);
    }
    const limit = grant["limit_value"];
    if (limit !== null && typeof limit !== "number") {
      throw invalid(`grants[${index}].limit_value must be a number or null`);
    }
    return { feature_key: featureKey, limit_value: limit as number | null };
  });
}

/**
 * CORE's own management surface for plans and subscriptions.
 *
 * Note what is deliberately absent: there is no entitlement-check endpoint.
 * ADR 0008 closes the list of synchronous paths between systems and the ADR
 * register requires a new ADR before any new one is written. An endpoint that
 * MARKET or MOVE would call on every request is exactly that, so
 * `SubscriptionService.checkEntitlement` is implemented and tested but reachable
 * only in-process, and the endpoint is recorded as a blocked decision in
 * ROADMAP.md. The routes below are operator and tenant management, the same
 * class as `/v1/wallets`, not a product integration path.
 */
export function registerSubscriptionRoutes(
  router: Router,
  billing: SubscriptionService,
  identity: IdentityService,
): void {
  router.post("/v1/plans", async (ctx) => {
    await requirePrincipal(ctx, identity, "subscription.write");
    const input = objectBody(ctx);
    const result = await billing.createPlan({
      code: requiredString(input, "code"),
      name: requiredString(input, "name"),
      currency: requiredString(input, "currency"),
      amount_minor: requiredInteger(input, "amount_minor"),
      billing_interval: billingInterval(requiredString(input, "billing_interval")),
      ...(typeof input["interval_count"] === "number"
        ? { interval_count: input["interval_count"] }
        : {}),
      grants: grants(input),
      correlation_id: ctx.correlation_id,
    });
    return { status: 201, body: { ...result.plan, grants: result.grants } };
  });

  router.get("/v1/plans", [{ name: "status", kind: "enum", values: PLAN_STATUSES }], async (ctx) => {
    await requirePrincipal(ctx, identity, "subscription.read");
    const status = ctx.selection.text("status") as (typeof PLAN_STATUSES)[number] | undefined;
    return { status: 200, body: { plans: await billing.listPlans(status) } };
  });

  router.get("/v1/plans/:plan_id", [], async (ctx) => {
    await requirePrincipal(ctx, identity, "subscription.read");
    const result = await billing.getPlan(ctx.params["plan_id"] ?? "");
    return { status: 200, body: { ...result.plan, grants: result.grants } };
  });

  router.post("/v1/plans/:plan_id/activate", async (ctx) => {
    await requirePrincipal(ctx, identity, "subscription.write");
    return {
      status: 200,
      body: await billing.activatePlan({
        plan_id: ctx.params["plan_id"] ?? "",
        correlation_id: ctx.correlation_id,
      }),
    };
  });

  router.post("/v1/plans/:plan_id/retire", async (ctx) => {
    await requirePrincipal(ctx, identity, "subscription.write");
    return {
      status: 200,
      body: await billing.retirePlan({
        plan_id: ctx.params["plan_id"] ?? "",
        correlation_id: ctx.correlation_id,
      }),
    };
  });

  router.post("/v1/subscriptions", async (ctx) => {
    await requirePrincipal(ctx, identity, "subscription.write");
    const input = objectBody(ctx);
    const result = await billing.subscribe({
      owner_type: ownerType(requiredString(input, "owner_type")),
      owner_id: requiredString(input, "owner_id"),
      plan_id: requiredString(input, "plan_id"),
      wallet_id: requiredString(input, "wallet_id"),
      ...(typeof input["starts_at"] === "string" ? { starts_at: input["starts_at"] } : {}),
      correlation_id: ctx.correlation_id,
    });
    // 201 either way. A first charge that could not be collected still created
    // the subscription, and reporting that as a failure would invite the
    // caller to retry the signup and produce a second one.
    return {
      status: 201,
      body: {
        ...result.subscription,
        current_period: result.period,
        collected: result.charge.collected,
        uncollectible_reason: result.charge.reason,
      },
    };
  });

  router.get("/v1/subscriptions/:subscription_id", [], async (ctx) => {
    await requirePrincipal(ctx, identity, "subscription.read");
    const result = await billing.getSubscription(ctx.params["subscription_id"] ?? "");
    return { status: 200, body: { ...result.subscription, periods: result.periods } };
  });

  router.post("/v1/subscriptions/:subscription_id/cancel", async (ctx) => {
    await requirePrincipal(ctx, identity, "subscription.write");
    const input = objectBody(ctx);
    const result = await billing.cancelSubscription({
      subscription_id: ctx.params["subscription_id"] ?? "",
      reason: requiredString(input, "reason"),
      correlation_id: ctx.correlation_id,
    });
    return {
      status: 200,
      body: { ...result.subscription, voided_period_id: result.voided_period_id },
    };
  });

  router.post("/v1/subscriptions/:subscription_id/usage", async (ctx) => {
    await requirePrincipal(ctx, identity, "subscription.write");
    const input = objectBody(ctx);
    const result = await billing.recordUsage({
      subscription_id: ctx.params["subscription_id"] ?? "",
      feature_key: requiredString(input, "feature_key"),
      quantity: requiredInteger(input, "quantity"),
      usage_reference: requiredString(input, "usage_reference"),
      ...(typeof input["at"] === "string" ? { at: input["at"] } : {}),
      correlation_id: ctx.correlation_id,
    });
    // 200 on a replay, 201 on a first write, so a reporter can tell whether
    // its retry was the one that counted without having to compare totals.
    return { status: result.recorded ? 201 : 200, body: result.usage };
  });

  router.post("/v1/subscription-periods/:period_id/collect", async (ctx) => {
    await requirePrincipal(ctx, identity, "subscription.write");
    const result = await billing.chargePeriod({
      period_id: ctx.params["period_id"] ?? "",
      correlation_id: ctx.correlation_id,
    });
    // A refused collection is a recorded outcome, not a transport failure, so
    // it is a 200 carrying `collected: false` rather than a 4xx. The caller
    // asked CORE to attempt a collection and CORE did.
    return {
      status: 200,
      body: { ...result.period, collected: result.collected, reason: result.reason },
    };
  });
}
