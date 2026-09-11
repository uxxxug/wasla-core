import type { Router } from "../../platform/http/router.js";
import { requirePrincipal } from "../identity-access/http.js";
import type { IdentityService } from "../identity-access/service.js";
import type { FulfillmentService } from "./service.js";

export function registerFulfillmentRoutes(
  router: Router,
  fulfillment: FulfillmentService,
  identity: IdentityService,
): void {
  router.get("/v1/fulfillments/:fulfillment_id", (ctx) => {
    const record = fulfillment.require(ctx.params["fulfillment_id"] ?? "");
    requirePrincipal(ctx, identity, "fulfillment.read", record.organization_id);
    return { status: 200, body: record };
  });

  // Cancel before execution closes. Idempotent: cancelling twice returns the
  // same cancelled fulfillment.
  router.post("/v1/fulfillments/:fulfillment_id/cancel", async (ctx) => {
    const record = fulfillment.require(ctx.params["fulfillment_id"] ?? "");
    requirePrincipal(ctx, identity, "fulfillment.request", record.organization_id);
    const input = (ctx.body ?? {}) as Record<string, unknown>;
    const cancelled = await fulfillment.cancel({
      fulfillment_id: record.fulfillment_id,
      reason: typeof input["reason"] === "string" ? input["reason"] : "",
      correlation_id: ctx.correlation_id,
    });
    return { status: 200, body: cancelled };
  });
}