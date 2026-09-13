/**
 * Anonymous privilege escalation — measured, closed where CORE owns the answer,
 * and recorded where it does not (milestone 29).
 *
 * Found by measuring the refusal surface after milestone 28: a scan for routes
 * whose handler never calls `requirePrincipal`, `bearer()` or
 * `identity.authenticate` returned five, and one of them was
 * `POST /v1/memberships` — the route that decides who a tenant's administrators
 * are.
 *
 * Measured on `main` at `a5ab512`, with **no credential of any kind**, against the
 * real router:
 *
 *   POST /v1/identities   { channel_type: "phone", external_id: … }  → 201, a new principal
 *   POST /v1/memberships  { principal_id, organization_id: <any>, roles: ["org_admin"] }
 *                                                                    → 201 GRANTED
 *   POST /v1/sessions     { principal_id, channel_type: "phone" }    → 201, a bearer token
 *   GET  /v1/sessions/current                                        → org_admin, 7 permissions
 *   GET  /v1/organizations/<somebody else's org>                     → 200, their record
 *
 * Three ordinary calls, no token at the start, full `org_admin` over an
 * organization the caller had nothing to do with at the end.
 *
 * **What this file closes.** The middle step. `POST /v1/memberships` now requires
 * `organization.write` on the organization being granted into, which is the
 * permission that already means "may change who this organization is":
 * `platform_admin` holds it everywhere, `org_admin` inside its own tenant. So an
 * administrator can add a colleague and nobody can add themselves.
 *
 * **What it deliberately does not close, and asserts as still reachable.**
 * `POST /v1/sessions` mints a bearer token for **any** `principal_id` with no
 * proof that the caller controls that principal's channel account. Requiring one
 * means deciding what proof is — an OTP to the channel, a service credential held
 * by the channel adapter, or a signed assertion — and that is an owner decision
 * about the login flow, not a coordination detail CORE may invent. It is recorded
 * as **B-39** with the fail-closed direction written down, and the case below
 * asserts the current behaviour so the gap is measured evidence in the suite
 * rather than a sentence in a document that could quietly stop being true. When
 * B-39 is answered, this case is the one that must be changed, on purpose.
 */
import { describe, expect, it } from "vitest";
import { createCoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { memoryPersistence } from "../src/platform/persistence/backends.js";

async function fixture() {
  const clock = new FixedClock(new Date("2026-06-01T00:00:00.000Z"));
  const core = createCoreApp({ clock, persistence: memoryPersistence(clock), rateLimit: false });
  // A tenant with an administrator, established in process — the escalation this
  // file is about is what an outsider can do to it over HTTP.
  const victim = await core.organization.create({
    name: "Victim Org",
    country_code: "SA",
    correlation_id: "escalation-test",
  });
  const admin = await core.identity.registerIdentity({
    channel_type: "web",
    external_id: "victim-admin",
    correlation_id: "escalation-test",
  });
  await core.identity.grantMembership({
    principal_id: admin.principal.principal_id,
    organization_id: victim.organization_id,
    roles: ["platform_admin"],
    correlation_id: "escalation-test",
  });
  const session = await core.identity.issueSession({
    principal_id: admin.principal.principal_id,
    channel_type: "web",
    correlation_id: "escalation-test",
  });
  return { core, organizationId: victim.organization_id, adminToken: session.token };
}

async function outsider(core: Awaited<ReturnType<typeof fixture>>["core"], reference: string) {
  const created = await core.router.handle({
    method: "POST",
    url: "/v1/identities",
    headers: {},
    body: { channel_type: "phone", external_id: reference },
  });
  expect(created.status).toBe(201);
  return (created.body as { principal_id: string }).principal_id;
}

describe("anonymous privilege escalation", () => {
  it("refuses an unauthenticated membership grant", async () => {
    const { core, organizationId } = await fixture();
    const principalId = await outsider(core, "+966500000001");
    const granted = await core.router.handle({
      method: "POST",
      url: "/v1/memberships",
      headers: {},
      body: { principal_id: principalId, organization_id: organizationId, roles: ["org_admin"] },
    });
    expect(granted.status).toBe(401);
    expect((granted.body as { code: string }).code).toBe("unauthenticated");
  });

  it("refuses a membership grant from a principal without organization.write", async () => {
    const { core, organizationId } = await fixture();
    const principalId = await outsider(core, "+966500000002");
    // A real session, honestly obtained for a principal with no membership at all.
    const session = await core.identity.issueSession({
      principal_id: principalId,
      channel_type: "phone",
      correlation_id: "escalation-test",
    });
    const granted = await core.router.handle({
      method: "POST",
      url: "/v1/memberships",
      headers: { authorization: `Bearer ${session.token}` },
      body: { principal_id: principalId, organization_id: organizationId, roles: ["org_admin"] },
    });
    expect(granted.status).toBe(403);
  });

  it("still lets an administrator add a member to their own organization", async () => {
    const { core, organizationId, adminToken } = await fixture();
    const principalId = await outsider(core, "+966500000003");
    const granted = await core.router.handle({
      method: "POST",
      url: "/v1/memberships",
      headers: { authorization: `Bearer ${adminToken}` },
      body: { principal_id: principalId, organization_id: organizationId, roles: ["org_member"] },
    });
    expect(granted.status).toBe(201);
    expect((granted.body as { roles: string[] }).roles).toEqual(["org_member"]);
  });

  it("refuses an org_admin granting a membership into a different organization", async () => {
    const { core, adminToken } = await fixture();
    const other = await core.organization.create({
      name: "Another Org",
      country_code: "SA",
      correlation_id: "escalation-test",
    });
    const principalId = await outsider(core, "+966500000004");
    const orgAdminSession = await (async () => {
      const insider = await outsider(core, "+966500000005");
      // Made an org_admin of `other` by the platform administrator, so the token is
      // legitimate — the question is whether it reaches beyond its own tenant.
      const grant = await core.router.handle({
        method: "POST",
        url: "/v1/memberships",
        headers: { authorization: `Bearer ${adminToken}` },
        body: { principal_id: insider, organization_id: other.organization_id, roles: ["org_admin"] },
      });
      expect(grant.status).toBe(201);
      return core.identity.issueSession({
        principal_id: insider,
        channel_type: "phone",
        correlation_id: "escalation-test",
      });
    })();
    const third = await core.organization.create({
      name: "Third Org",
      country_code: "SA",
      correlation_id: "escalation-test",
    });
    const crossTenant = await core.router.handle({
      method: "POST",
      url: "/v1/memberships",
      headers: { authorization: `Bearer ${orgAdminSession.token}` },
      body: { principal_id: principalId, organization_id: third.organization_id, roles: ["org_admin"] },
    });
    expect(crossTenant.status).toBe(403);
  });

  it("the whole escalation chain now stops at the grant", async () => {
    const { core, organizationId } = await fixture();
    const principalId = await outsider(core, "+966500000006");
    const granted = await core.router.handle({
      method: "POST",
      url: "/v1/memberships",
      headers: {},
      body: { principal_id: principalId, organization_id: organizationId, roles: ["org_admin"] },
    });
    expect(granted.status).toBe(401);
    // The token the outsider can still obtain for their own principal (B-39) holds
    // nothing, which is what makes the grant the load-bearing step.
    const session = await core.identity.issueSession({
      principal_id: principalId,
      channel_type: "phone",
      correlation_id: "escalation-test",
    });
    const who = await core.router.handle({
      method: "GET",
      url: "/v1/sessions/current",
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(who.status).toBe(200);
    expect((who.body as { roles: string[]; organization_ids: string[] }).roles).toEqual([]);
    expect((who.body as { organization_ids: string[] }).organization_ids).toEqual([]);
    const read = await core.router.handle({
      method: "GET",
      url: `/v1/organizations/${organizationId}`,
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(read.status).toBe(403);
  });

  it("records B-39: a session is still minted for any principal without proof of possession", async () => {
    const { core, organizationId, adminToken } = await fixture();
    // The administrator's own principal id, which is not a secret: it appears in
    // `GET /v1/sessions/current`, in every membership answer, and in audit reads.
    const current = await core.router.handle({
      method: "GET",
      url: "/v1/sessions/current",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const adminPrincipalId = (current.body as { principal_id: string }).principal_id;
    const minted = await core.router.handle({
      method: "POST",
      url: "/v1/sessions",
      headers: {},
      body: { principal_id: adminPrincipalId, channel_type: "phone" },
    });
    // Asserted as it currently is, deliberately: this is the open half of the
    // escalation, it is B-39, and the honest place for it is a failing-if-it-changes
    // measurement rather than prose. Closing B-39 means changing this expectation
    // on purpose, in the cycle that decides what proof of possession is.
    expect(minted.status).toBe(201);
    const impersonated = (minted.body as { access_token: string }).access_token;
    const read = await core.router.handle({
      method: "GET",
      url: `/v1/organizations/${organizationId}`,
      headers: { authorization: `Bearer ${impersonated}` },
    });
    expect(read.status).toBe(200);
  });
});
