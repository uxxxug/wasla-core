import { invalid } from "../errors.js";
import type { Router } from "../http/router.js";
import { requirePrincipal } from "../../modules/identity-access/http.js";
import type { IdentityService } from "../../modules/identity-access/service.js";
import type { EventIngress } from "./ingress.js";

export function registerIngressRoutes(
  router: Router,
  ingress: EventIngress,
  identity: IdentityService,
): void {
  // The edge MARKET and MOVE push into. Answers 202, not 200: CORE has taken
  // durable responsibility for the event but has not processed it yet, and
  // saying 200 would overstate what has happened.
  router.post("/v1/events", async (ctx) => {
    const actor = await requirePrincipal(ctx, identity, "events.submit");
    if (!ctx.body || typeof ctx.body !== "object") throw invalid("an event envelope is required");
    // The caller comes from the credential, never from the request body.
    const result = await ingress.submit(actor.service_name, ctx.body);
    return { status: 202, body: result };
  });
}
