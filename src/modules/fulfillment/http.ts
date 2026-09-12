import { invalid } from "../../platform/errors.js";
import type { Router } from "../../platform/http/router.js";
import { requirePrincipal } from "../identity-access/http.js";
import type { IdentityService } from "../identity-access/service.js";
import type { Fulfillment } from "./domain.js";
import type { FulfillmentService } from "./service.js";

/**
 * Adds the derived money disposition to a read.
 *
 * It is computed, not stored, so the response cannot disagree with the two
 * states it is derived from. It is additive: `settlement_state` keeps its
 * meaning and position for existing consumers.
 */
function withDisposition(
  fulfillment: FulfillmentService,
  record: Fulfillment,
): Fulfillment & { financial_disposition: string } {
  return { ...record, financial_disposition: fulfillment.disposition(record) };
}

export function registerFulfillmentRoutes(
  router: Router,
  fulfillment: FulfillmentService,
  identity: IdentityService,
): void {
  // Registered before the parameterised route so it is never read as an id.
  // Reconciliation read: execution state versus money state. An empty list is
  // the invariant CORE is expected to hold.
  router.get("/v1/fulfillments/reconciliation/inconsistent", async (ctx) => {
    const organizationId = ctx.query.get("organization_id") ?? "";
    if (!organizationId) throw invalid("organization_id is required");
    await requirePrincipal(ctx, identity, "fulfillment.read", organizationId);
    const items = await fulfillment.listFinanciallyInconsistent(organizationId);
    return {
      status: 200,
      body: {
        count: items.length,
        items: items.map((item) => withDisposition(fulfillment, item)),
      },
    };
  });

  // Reconciliation read: money moved for work that did not complete, and CORE
  // has not been told what should happen to it. A non-empty list here is not a
  // CORE defect — it is the queue waiting on the decision B-20 records as
  // unmade, and it is kept apart from the defect queue so an operator can tell
  // a business question from an incident.
  router.get("/v1/fulfillments/reconciliation/pending-financial-decision", async (ctx) => {
    const organizationId = ctx.query.get("organization_id") ?? "";
    if (!organizationId) throw invalid("organization_id is required");
    await requirePrincipal(ctx, identity, "fulfillment.read", organizationId);
    const items = await fulfillment.listPendingFinancialDecision(organizationId);
    return {
      status: 200,
      body: {
        count: items.length,
        items: items.map((item) => withDisposition(fulfillment, item)),
      },
    };
  });

  router.get("/v1/fulfillments/:fulfillment_id", async (ctx) => {
    const record = await fulfillment.require(ctx.params["fulfillment_id"] ?? "");
    await requirePrincipal(ctx, identity, "fulfillment.read", record.organization_id);
    return { status: 200, body: withDisposition(fulfillment, record) };
  });

  // Cancel before execution closes. Idempotent: cancelling twice returns the
  // same cancelled fulfillment.
  router.post("/v1/fulfillments/:fulfillment_id/cancel", async (ctx) => {
    const record = await fulfillment.require(ctx.params["fulfillment_id"] ?? "");
    await requirePrincipal(ctx, identity, "fulfillment.request", record.organization_id);
    const input = (ctx.body ?? {}) as Record<string, unknown>;
    const cancelled = await fulfillment.cancel({
      fulfillment_id: record.fulfillment_id,
      reason: typeof input["reason"] === "string" ? input["reason"] : "",
      correlation_id: ctx.correlation_id,
    });
    return { status: 200, body: cancelled };
  });
}