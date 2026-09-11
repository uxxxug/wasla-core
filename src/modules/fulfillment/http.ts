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
}