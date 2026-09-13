import { testId } from "./support/ids.js";
import { describe, expect, it } from "vitest";
import { coreWithTenants } from "./support/app.js";
import { FixedClock } from "../src/platform/clock.js";

async function bootstrapAdmin() {
  const core = await coreWithTenants(new FixedClock(), [testId("org-root"), testId("org-a")]);
  const registered = await core.identity.registerIdentity({
    channel_type: "web",
    external_id: "root-admin",
    correlation_id: "bootstrap",
  });
  await core.identity.grantMembership({
    principal_id: registered.principal.principal_id,
    organization_id: testId("org-root"),
    roles: ["platform_admin"],
    correlation_id: "bootstrap",
  });
  const { token } = await core.identity.issueSession({
    principal_id: registered.principal.principal_id,
    channel_type: "web",
    correlation_id: "bootstrap",
  });
  return { core, token };
}

describe("HTTP surface", () => {
  it("exposes health and readiness", async () => {
    const core = await coreWithTenants(new FixedClock(), [testId("org-root"), testId("org-a")]);
    expect((await core.router.handle({ method: "GET", url: "/health" })).status).toBe(200);
    const ready = await core.router.handle({ method: "GET", url: "/ready" });
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: "ready" });
  });

  it("registers an identity over HTTP and is idempotent", async () => {
    const core = await coreWithTenants(new FixedClock(), [testId("org-root"), testId("org-a")]);
    const first = await core.router.handle({
      method: "POST",
      url: "/v1/identities",
      body: { channel_type: "telegram", external_id: "tg-77" },
    });
    expect(first.status).toBe(201);

    const second = await core.router.handle({
      method: "POST",
      url: "/v1/identities",
      body: { channel_type: "telegram", external_id: "tg-77" },
    });
    expect(second.status).toBe(200);
    expect((second.body as { identity_id: string }).identity_id).toBe(
      (first.body as { identity_id: string }).identity_id,
    );
  });

  it("returns the canonical error shape with a correlation id", async () => {
    const core = await coreWithTenants(new FixedClock(), [testId("org-root"), testId("org-a")]);
    const res = await core.router.handle({
      method: "POST",
      url: "/v1/identities",
      body: { channel_type: "carrier-pigeon", external_id: "x" },
      headers: { "x-correlation-id": "corr-abc" },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: "invalid_request",
      retryable: false,
      correlation_id: "corr-abc",
    });
    expect(res.headers?.["x-correlation-id"]).toBe("corr-abc");
  });

  it("rejects unauthenticated and wrongly-scoped calls", async () => {
    const { core, token } = await bootstrapAdmin();

    const anonymous = await core.router.handle({
      method: "POST",
      url: "/v1/organizations",
      body: { name: "Acme", country_code: "SA" },
    });
    expect(anonymous.status).toBe(401);

    const forged = await core.router.handle({
      method: "POST",
      url: "/v1/organizations",
      body: { name: "Acme", country_code: "SA" },
      headers: { authorization: "Bearer forged-token" },
    });
    expect(forged.status).toBe(401);

    const allowed = await core.router.handle({
      method: "POST",
      url: "/v1/organizations",
      body: { name: "Acme", country_code: "SA" },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(allowed.status).toBe(201);
  });

  it("enforces tenant isolation on organization reads", async () => {
    const core = await coreWithTenants(new FixedClock(), [testId("org-root"), testId("org-a")]);
    const owner = await core.identity.registerIdentity({
      channel_type: "web",
      external_id: "owner",
      correlation_id: "c",
    });
    await core.identity.grantMembership({
      principal_id: owner.principal.principal_id,
      organization_id: testId("org-a"),
      roles: ["org_admin"],
      correlation_id: "c",
    });
    const ownerSession = await core.identity.issueSession({
      principal_id: owner.principal.principal_id,
      channel_type: "web",
      correlation_id: "c",
    });

    const organization = await core.organization.create({
      name: "Other Org",
      country_code: "SA",
      correlation_id: "c",
    });

    const res = await core.router.handle({
      method: "GET",
      url: `/v1/organizations/${organization.organization_id}`,
      headers: { authorization: `Bearer ${ownerSession.token}` },
    });
    expect(res.status).toBe(403);
  });

  it("never echoes the session token back on verification", async () => {
    const { core, token } = await bootstrapAdmin();
    const res = await core.router.handle({
      method: "GET",
      url: "/v1/sessions/current",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(token);
  });

  it("returns 404 in the canonical error shape for unknown routes", async () => {
    const core = await coreWithTenants(new FixedClock(), [testId("org-root"), testId("org-a")]);
    const res = await core.router.handle({ method: "GET", url: "/v1/nope" });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "not_found" });
  });
});

describe("audit trail", () => {
  it("records every state change and redacts sensitive metadata", async () => {
    const { core } = await bootstrapAdmin();
    const actions = (await core.audit.entries()).map((e) => e.action);
    expect(actions).toContain("identity.registered");
    expect(actions).toContain("membership.granted");
    expect(actions).toContain("session.issued");
    for (const entry of await core.audit.entries()) {
      expect(JSON.stringify(entry.metadata)).not.toMatch(/Bearer /);
    }
  });
});
