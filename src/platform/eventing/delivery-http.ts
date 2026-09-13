import { notFound } from "../errors.js";
import { NO_BODY, objectBody } from "../http/body.js";
import type { Router } from "../http/router.js";
import { requirePrincipal } from "../../modules/identity-access/http.js";
import type { IdentityService } from "../../modules/identity-access/service.js";
import type { SubscriptionRegistry } from "./delivery.js";

export function registerDeliveryRoutes(
  router: Router,
  registry: SubscriptionRegistry,
  identity: IdentityService,
): void {
  // Operator-only, deliberately: an endpoint CORE will sign payloads for is
  // infrastructure configuration, not something a tenant may add.
  router.post(
    "/v1/event-subscriptions",
    objectBody(
      { name: "subscriber", kind: "text", required: true },
      { name: "event_type", kind: "text", required: true },
      { name: "endpoint_url", kind: "text", required: true },
      { name: "signing_secret", kind: "text", required: true },
    ),
    async (ctx) => {
    await requirePrincipal(ctx, identity, "organization.write");
    const created = await registry.register({
      subscriber: ctx.input.requiredText("subscriber"),
      event_type: ctx.input.requiredText("event_type"),
      endpoint_url: ctx.input.requiredText("endpoint_url"),
      signing_secret: ctx.input.requiredText("signing_secret"),
    });
    // The secret is never echoed, not even to the caller that just sent it.
    // A response body is the easiest place for a secret to end up in a log.
    return { status: 201, body: created };
  });

  router.get("/v1/event-subscriptions", [], async (ctx) => {
    await requirePrincipal(ctx, identity, "organization.read");
    const items = await registry.list();
    return { status: 200, body: { count: items.length, items } };
  });

  // Pausing a subscriber stops the fan-out queueing new work for it. Deliveries
  // already queued stay queued: they were promised, and dropping them silently
  // would be worse than delivering them late.
  router.post("/v1/event-subscriptions/:subscription_id/deactivate", NO_BODY, async (ctx) => {
    await requirePrincipal(ctx, identity, "organization.write");
    const id = ctx.params["subscription_id"] ?? "";
    const items = await registry.list();
    if (!items.some((s) => s.subscription_id === id)) throw notFound("subscription not found");
    await registry.setActive(id, false);
    return { status: 200, body: { subscription_id: id, active: false } };
  });

  router.post("/v1/event-subscriptions/:subscription_id/activate", NO_BODY, async (ctx) => {
    await requirePrincipal(ctx, identity, "organization.write");
    const id = ctx.params["subscription_id"] ?? "";
    const items = await registry.list();
    if (!items.some((s) => s.subscription_id === id)) throw notFound("subscription not found");
    await registry.setActive(id, true);
    return { status: 200, body: { subscription_id: id, active: true } };
  });

  // What CORE has promised to deliver and has not. An empty list is the
  // invariant an operator should expect to see.
  router.get("/v1/event-deliveries/undelivered", [], async (ctx) => {
    await requirePrincipal(ctx, identity, "organization.read");
    const items = await registry.undelivered();
    return { status: 200, body: { count: items.length, items } };
  });
}
