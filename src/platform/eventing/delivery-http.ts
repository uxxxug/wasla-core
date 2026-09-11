import { invalid, notFound } from "../errors.js";
import type { Router } from "../http/router.js";
import { requirePrincipal } from "../../modules/identity-access/http.js";
import type { IdentityService } from "../../modules/identity-access/service.js";
import type { SubscriptionRegistry } from "./delivery.js";

const str = (input: Record<string, unknown>, key: string): string => {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw invalid(`${key} is required`);
  return value;
};

export function registerDeliveryRoutes(
  router: Router,
  registry: SubscriptionRegistry,
  identity: IdentityService,
): void {
  // Operator-only, deliberately: an endpoint CORE will sign payloads for is
  // infrastructure configuration, not something a tenant may add.
  router.post("/v1/event-subscriptions", async (ctx) => {
    await requirePrincipal(ctx, identity, "organization.write");
    const input = (ctx.body ?? {}) as Record<string, unknown>;
    const created = await registry.register({
      subscriber: str(input, "subscriber"),
      event_type: str(input, "event_type"),
      endpoint_url: str(input, "endpoint_url"),
      signing_secret: str(input, "signing_secret"),
    });
    // The secret is never echoed, not even to the caller that just sent it.
    // A response body is the easiest place for a secret to end up in a log.
    return { status: 201, body: created };
  });

  router.get("/v1/event-subscriptions", async (ctx) => {
    await requirePrincipal(ctx, identity, "organization.read");
    const items = await registry.list();
    return { status: 200, body: { count: items.length, items } };
  });

  // Pausing a subscriber stops the fan-out queueing new work for it. Deliveries
  // already queued stay queued: they were promised, and dropping them silently
  // would be worse than delivering them late.
  router.post("/v1/event-subscriptions/:subscription_id/deactivate", async (ctx) => {
    await requirePrincipal(ctx, identity, "organization.write");
    const id = ctx.params["subscription_id"] ?? "";
    const items = await registry.list();
    if (!items.some((s) => s.subscription_id === id)) throw notFound("subscription not found");
    await registry.setActive(id, false);
    return { status: 200, body: { subscription_id: id, active: false } };
  });

  router.post("/v1/event-subscriptions/:subscription_id/activate", async (ctx) => {
    await requirePrincipal(ctx, identity, "organization.write");
    const id = ctx.params["subscription_id"] ?? "";
    const items = await registry.list();
    if (!items.some((s) => s.subscription_id === id)) throw notFound("subscription not found");
    await registry.setActive(id, true);
    return { status: 200, body: { subscription_id: id, active: true } };
  });

  // What CORE has promised to deliver and has not. An empty list is the
  // invariant an operator should expect to see.
  router.get("/v1/event-deliveries/undelivered", async (ctx) => {
    await requirePrincipal(ctx, identity, "organization.read");
    const items = await registry.undelivered();
    return { status: 200, body: { count: items.length, items } };
  });
}
