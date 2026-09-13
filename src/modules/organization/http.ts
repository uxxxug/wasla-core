import { objectBody } from "../../platform/http/body.js";
import type { Router } from "../../platform/http/router.js";
import { requirePrincipal } from "../identity-access/http.js";
import type { IdentityService } from "../identity-access/service.js";
import type { OrganizationService } from "./service.js";

export function registerOrganizationRoutes(
  router: Router,
  organizations: OrganizationService,
  identity: IdentityService,
): void {
  router.post(
    "/v1/organizations",
    objectBody(
      { name: "name", kind: "text", required: true },
      { name: "country_code", kind: "text", required: true },
    ),
    async (ctx) => {
    await requirePrincipal(ctx, identity, "organization.write");
    const organization = organizations.create({
      name: ctx.input.requiredText("name"),
      country_code: ctx.input.requiredText("country_code"),
      correlation_id: ctx.correlation_id,
    });
    return { status: 201, body: organization };
  });

  router.get("/v1/organizations/:organization_id", [], async (ctx) => {
    const organizationId = ctx.params["organization_id"]!;
    await requirePrincipal(ctx, identity, "organization.read", organizationId);
    return { status: 200, body: organizations.require(organizationId) };
  });
}
