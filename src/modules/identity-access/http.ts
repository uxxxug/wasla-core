import { unauthenticated } from "../../platform/errors.js";
import { AUTHENTICATED, anonymous } from "../../platform/http/authentication.js";
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

/**
 * The authenticated caller the router already established.
 *
 * There is no second authentication here, and no second read of
 * `authorization`. Until milestone 30 every handler that needed a caller
 * authenticated one itself, which made authentication a property of a function
 * body: 28 registrations answered `400` about the body to a caller with no
 * credential at all, and the two fulfillment reads answered `404` for an
 * unknown identifier and `401` for a real one. The router now authenticates
 * before it parses anything, so by the time a handler runs the question is
 * already answered — and answering it twice would let the two answers differ.
 */
export function currentPrincipal(
  ctx: RequestContext<AuthenticatedPrincipal>,
): AuthenticatedPrincipal {
  // Unreachable on a route that declared `AUTHENTICATED`: the router refuses
  // the request before the handler exists. Reachable only if a route declares
  // itself anonymous and then asks who the caller is, which is a contradiction
  // in the registration, and is refused rather than guessed.
  if (ctx.principal === null) throw unauthenticated("missing bearer token");
  return ctx.principal;
}

export async function requirePrincipal(
  ctx: RequestContext<AuthenticatedPrincipal>,
  identity: IdentityService,
  permission: Permission,
  organizationId?: string,
): Promise<AuthenticatedPrincipal> {
  const actor = currentPrincipal(ctx);
  await identity.authorize(actor, permission, organizationId);
  return actor;
}

export function registerIdentityRoutes(
  router: Router<AuthenticatedPrincipal>,
  identity: IdentityService,
): void {
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
    // An unknown caller has to be able to appear: this is where a person who
    // has never spoken to CORE becomes a principal, so requiring a credential
    // here would mean no credential could ever be obtained.
    anonymous("the entry point: a caller with no identity yet asks for one"),
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
    // The login surface: a caller presenting no token is exactly who asks for
    // one. That this route will mint a token for *any* `principal_id` it is
    // given is B-39, and it is open — an authentication requirement here would
    // not close it and would break every caller obtaining its first session, so
    // it stays recorded as the blocker it is rather than being half-answered
    // here. `tests/anonymous-privilege-escalation.test.ts` holds it visible.
    anonymous("the login surface: this is how a credential is obtained (B-39)"),
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
  router.get("/v1/sessions/current", [], AUTHENTICATED, async (ctx) => {
    return { status: 200, body: currentPrincipal(ctx) };
  });

  router.post(
    "/v1/sessions/revoke",
    objectBody({ name: "session_id", kind: "text", required: true }),
    // That this route revokes any named session without a credential is B-40,
    // and it is open. Declaring `AUTHENTICATED` here would change the refusal a
    // caller sees without deciding whose session a principal may end — the
    // question B-40 actually records — and would silently flip the gate that
    // keeps the blocker visible. It stays declared, open and named.
    anonymous("revocation takes no credential today (B-40)"),
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
    AUTHENTICATED,
    async (ctx) => {
    const actor = currentPrincipal(ctx);
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
    AUTHENTICATED,
    async (ctx) => {
    const roles = [...ctx.input.strings("roles")] as Role[];
    // Authenticated and authorized **on the organization being granted into**,
    // which this route required neither of until milestone 29 measured it. With
    // nothing at all — no token, no session, no membership — three ordinary calls
    // were a full escalation: `POST /v1/identities` makes a principal (anonymous
    // by design, since an unknown caller has to be able to appear), this route
    // granted that principal `org_admin` in **any organization id the caller
    // could name**, and `POST /v1/sessions` minted a bearer token for it. The
    // resulting token read another tenant's organization and answered 200.
    //
    // `organization.write` scoped to the target organization is the permission
    // that already means "may change who this organization is": `platform_admin`
    // holds it everywhere and `org_admin` holds it inside its own tenant, so an
    // administrator can add a colleague and nobody can add themselves. The first
    // membership of a brand-new organization is therefore a `platform_admin`
    // action, which is the same shape `POST /v1/organizations` already has.
    await requirePrincipal(
      ctx,
      identity,
      "organization.write",
      ctx.input.requiredText("organization_id"),
    );
    const membership = await identity.grantMembership({
      principal_id: ctx.input.requiredText("principal_id"),
      organization_id: ctx.input.requiredText("organization_id"),
      roles,
      correlation_id: ctx.correlation_id,
    });
    return { status: 201, body: membership };
  });
}
