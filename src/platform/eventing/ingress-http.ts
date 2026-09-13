import { opaqueBody } from "../http/body.js";
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
  router.post(
    "/v1/events",
    // The one opaque body in CORE. An envelope is validated against the published
    // event contracts by `normalize.ts` — restating its properties as a field
    // list here would be a second, weaker copy of `contracts/events/*`, and the
    // two would drift. Milestone 25's gate names this route, so a second opaque
    // body cannot appear without the gate reporting it.
    opaqueBody("the event envelope is validated against contracts/events by normalize.ts"),
    async (ctx) => {
    const actor = await requirePrincipal(ctx, identity, "events.submit");
    // The caller comes from the credential, never from the request body.
    const result = await ingress.submit(actor.service_name, ctx.input.raw());
    return { status: 202, body: result };
  });
}
