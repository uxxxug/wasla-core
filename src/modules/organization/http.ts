import { invalid } from "../../platform/errors.js";
import type { Router } from "../../platform/http/router.js";
import { requirePrincipal } from "../identity-access/http.js";
import type { IdentityService } from "../identity-access/service.js";
import type { OrganizationService } from "./service.js";

export function registerOrganizationRoutes(
  router: Router,
  organizations: OrganizationService,
  identity: IdentityService,
): void {
  router.post("/v1/organizations", (ctx) => {
    requirePrincipal(ctx, identity, "organization.write");
    if (typeof ctx.body !== "object" || ctx.body === null) throw invalid("JSON object body required");
    const input = ctx.body as Record<string, unknown>;
    const name = input["name"];
    const country = input["country_code"];
    if (typeof name !== "string") throw invalid("name is required");
    if (typeof country !== "string") throw invalid("country_code is required");
    const organization = organizations.create({
      name,
      country_code: country,
      correlation_id: ctx.correlation_id,
    });
    return { status: 201, body: organization };
  });

  router.get("/v1/organizations/:organization_id", (ctx) => {
    const organizationId = ctx.params["organization_id"]!;
    requirePrincipal(ctx, identity, "organization.read", organizationId);
    return { status: 200, body: organizations.require(organizationId) };
  });
}
