import { unauthenticated } from "../../platform/errors.js";
import { objectBody } from "../../platform/http/body.js";
import type { RequestContext, Router } from "../../platform/http/router.js";
import { CHANNEL_TYPES } from "./domain.js";
import type { ChannelType, Permission, Role } from "./domain.js";
import type { AuthenticatedPrincipal, IdentityService } from "./service.js";

const CHANNELS: readonly ChannelType[] = CHANNEL_TYPES;
const ROLES: readonly Role[] = [
  "platform_admin",
  "org_admin",
  "org_member",
  "support_agent",
  "service",
];


export function bearer(ctx: RequestContext): string {
  // One declared read. The `Array.isArray(header) ? header[0]` this replaced
  // chose one of two credentials without saying so; a repeated `authorization`
  // is now refused at the edge by `parseHeaders`, and what arrives here is a
  // single bounded value whose *validity* is still this module's question.
  const raw = ctx.headers.value("authorization");
  if (!raw || !raw.startsWith("Bearer ")) throw unauthenticated("missing bearer token");
  return raw.slice("Bearer ".length);
}

export async function requirePrincipal(
  ctx: RequestContext,
  identity: IdentityService,
  permission: Permission,
  organizationId?: string,
): Promise<AuthenticatedPrincipal> {
  const actor = await identity.authenticate(bearer(ctx));
  await identity.authorize(actor, permission, organizationId);
  return actor;
}

export function registerIdentityRoutes(router: Router, identity: IdentityService): void {
  // Resolve-or-create an identity from a channel account. Idempotent by design.
  router.post(
    "/v1/identities",
    objectBody(
      { name: "channel_type", kind: "enum", values: CHANNELS, required: true },
      { name: "external_id", kind: "text", required: true },
      { name: "display_name", kind: "nullable_text" },
      { name: "source_system", kind: "text" },
      { name: "legacy_id", kind: "nullable_text" },
    ),
    async (ctx) => {
    const sourceSystem = ctx.input.text("source_system");
    const result = await identity.registerIdentity({
      channel_type: ctx.input.requiredText("channel_type") as ChannelType,
      external_id: ctx.input.requiredText("external_id"),
      display_name: ctx.input.text("display_name") ?? null,
      correlation_id: ctx.correlation_id,
      ...(typeof sourceSystem === "string" ? { source_system: sourceSystem } : {}),
      legacy_id: ctx.input.text("legacy_id") ?? null,
    });
    return {
      status: result.created ? 201 : 200,
      body: {
        identity_id: result.identity.identity_id,
        principal_id: result.principal.principal_id,
        status: result.identity.status,
        created: result.created,
      },
    };
  });

  // Issue a session for an existing principal.
  router.post(
    "/v1/sessions",
    objectBody(
      { name: "principal_id", kind: "text", required: true },
      { name: "channel_type", kind: "enum", values: CHANNELS, required: true },
    ),
    async (ctx) => {
    const { session, token } = await identity.issueSession({
      principal_id: ctx.input.requiredText("principal_id"),
      channel_type: ctx.input.requiredText("channel_type") as ChannelType,
      correlation_id: ctx.correlation_id,
    });
    return {
      status: 201,
      body: {
        session_id: session.session_id,
        access_token: token,
        expires_at: session.expires_at,
        token_type: "Bearer",
      },
    };
  });

  // Verify the caller's own session. Returns principal, org membership and permissions.
  router.get("/v1/sessions/current", [], async (ctx) => {
    const actor = await identity.authenticate(bearer(ctx));
    return { status: 200, body: actor };
  });

  router.post(
    "/v1/sessions/revoke",
    objectBody({ name: "session_id", kind: "text", required: true }),
    async (ctx) => {
    identity.revokeSession(ctx.input.requiredText("session_id"), ctx.correlation_id);
    return { status: 204, body: null };
  });

  // Service-to-service authorization probe used by MOVE and MARKET.
  router.post(
    "/v1/access/check",
    objectBody(
      { name: "permission", kind: "text", required: true },
      { name: "organization_id", kind: "text" },
    ),
    async (ctx) => {
    const actor = await identity.authenticate(bearer(ctx));
    const permission = ctx.input.requiredText("permission") as Permission;
    const organizationId = ctx.input.text("organization_id") ?? undefined;
    try {
      await identity.authorize(actor, permission, organizationId);
      return { status: 200, body: { allowed: true, principal_id: actor.principal_id } };
    } catch {
      return { status: 200, body: { allowed: false, principal_id: actor.principal_id } };
    }
  });

  router.post(
    "/v1/memberships",
    objectBody(
      { name: "principal_id", kind: "text", required: true },
      { name: "organization_id", kind: "text", required: true },
      { name: "roles", kind: "enum_list", values: ROLES, required: true, minItems: 1 },
    ),
    async (ctx) => {
    const roles = [...ctx.input.strings("roles")] as Role[];
    const membership = await identity.grantMembership({
      principal_id: ctx.input.requiredText("principal_id"),
      organization_id: ctx.input.requiredText("organization_id"),
      roles,
      correlation_id: ctx.correlation_id,
    });
    return { status: 201, body: membership };
  });
}
