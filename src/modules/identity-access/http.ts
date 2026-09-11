import { invalid, unauthenticated } from "../../platform/errors.js";
import type { RequestContext, Router } from "../../platform/http/router.js";
import type { ChannelType, Permission, Role } from "./domain.js";
import type { AuthenticatedPrincipal, IdentityService } from "./service.js";

const CHANNELS: readonly ChannelType[] = ["telegram", "phone", "email", "web", "partner_api"];
const ROLES: readonly Role[] = [
  "platform_admin",
  "org_admin",
  "org_member",
  "support_agent",
  "service",
];

function body(ctx: RequestContext): Record<string, unknown> {
  if (typeof ctx.body !== "object" || ctx.body === null) throw invalid("JSON object body required");
  return ctx.body as Record<string, unknown>;
}

function str(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || !value.trim()) throw invalid(`${key} is required`);
  return value;
}

function channel(source: Record<string, unknown>): ChannelType {
  const value = str(source, "channel_type");
  if (!CHANNELS.includes(value as ChannelType)) throw invalid("unsupported channel_type", { value });
  return value as ChannelType;
}

export function bearer(ctx: RequestContext): string {
  const header = ctx.headers["authorization"];
  const raw = Array.isArray(header) ? header[0] : header;
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
  router.post("/v1/identities", async (ctx) => {
    const input = body(ctx);
    const result = await identity.registerIdentity({
      channel_type: channel(input),
      external_id: str(input, "external_id"),
      display_name: typeof input["display_name"] === "string" ? input["display_name"] : null,
      correlation_id: ctx.correlation_id,
      source_system: typeof input["source_system"] === "string" ? input["source_system"] : undefined,
      legacy_id: typeof input["legacy_id"] === "string" ? input["legacy_id"] : null,
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
  router.post("/v1/sessions", async (ctx) => {
    const input = body(ctx);
    const { session, token } = await identity.issueSession({
      principal_id: str(input, "principal_id"),
      channel_type: channel(input),
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
  router.get("/v1/sessions/current", async (ctx) => {
    const actor = await identity.authenticate(bearer(ctx));
    return { status: 200, body: actor };
  });

  router.post("/v1/sessions/revoke", async (ctx) => {
    const input = body(ctx);
    identity.revokeSession(str(input, "session_id"), ctx.correlation_id);
    return { status: 204, body: null };
  });

  // Service-to-service authorization probe used by MOVE and MARKET.
  router.post("/v1/access/check", async (ctx) => {
    const input = body(ctx);
    const actor = await identity.authenticate(bearer(ctx));
    const permission = str(input, "permission") as Permission;
    const organizationId =
      typeof input["organization_id"] === "string" ? input["organization_id"] : undefined;
    try {
      await identity.authorize(actor, permission, organizationId);
      return { status: 200, body: { allowed: true, principal_id: actor.principal_id } };
    } catch {
      return { status: 200, body: { allowed: false, principal_id: actor.principal_id } };
    }
  });

  router.post("/v1/memberships", async (ctx) => {
    const input = body(ctx);
    const rawRoles = input["roles"];
    if (!Array.isArray(rawRoles) || rawRoles.length === 0) throw invalid("roles is required");
    const roles = rawRoles.map((role) => {
      if (typeof role !== "string" || !ROLES.includes(role as Role)) {
        throw invalid("unsupported role", { role });
      }
      return role as Role;
    });
    const membership = await identity.grantMembership({
      principal_id: str(input, "principal_id"),
      organization_id: str(input, "organization_id"),
      roles,
      correlation_id: ctx.correlation_id,
    });
    return { status: 201, body: membership };
  });
}
