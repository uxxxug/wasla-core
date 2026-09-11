import { invalid } from "../../platform/errors.js";
import type { Router } from "../../platform/http/router.js";
import { requirePrincipal } from "../identity-access/http.js";
import type { IdentityService } from "../identity-access/service.js";
import type { FulfillmentService } from "./service.js";

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
    return { status: 200, body: { count: items.length, items } };
  });

  router.get("/v1/fulfillments/:fulfillment_id", async (ctx) => {
    const record = await fulfillment.require(ctx.params["fulfillment_id"] ?? "");
    await requirePrincipal(ctx, identity, "fulfillment.read", record.organization_id);
    return { status: 200, body: record };
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