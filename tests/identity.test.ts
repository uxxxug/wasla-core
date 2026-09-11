import { testId } from "./support/ids.js";
import { describe, expect, it } from "vitest";
import { createCoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";

function app() {
  const clock = new FixedClock();
  return { ...createCoreApp({ clock }), clock };
}

describe("identity registration", () => {
  it("creates an identity, principal and link, and emits exactly one event", async () => {
    const core = app();
    const result = await core.identity.registerIdentity({
      channel_type: "telegram",
      external_id: "tg-1001",
      correlation_id: "corr-1",
    });

    expect(result.created).toBe(true);
    expect(result.identity.status).toBe("active");
    expect(result.identity.canonical_identity_id).toBeNull();

    const events = await core.outbox.all();
    expect(events).toHaveLength(1);
    expect(events[0]!.event.event_type).toBe("core.identity.verified");
    expect(events[0]!.event.correlation_id).toBe("corr-1");
    expect(events[0]!.event.entity_id).toBe(result.identity.identity_id);
    expect(events[0]!.status).toBe("pending");
  });

  it("is idempotent for a repeated channel account and emits no second event", async () => {
    const core = app();
    const first = await core.identity.registerIdentity({
      channel_type: "telegram",
      external_id: "tg-1001",
      correlation_id: "corr-1",
    });
    const second = await core.identity.registerIdentity({
      channel_type: "telegram",
      external_id: "tg-1001",
      correlation_id: "corr-2",
    });

    expect(second.created).toBe(false);
    expect(second.identity.identity_id).toBe(first.identity.identity_id);
    expect(second.principal.principal_id).toBe(first.principal.principal_id);
    expect(await core.outbox.all()).toHaveLength(1);
  });

  it("never merges two identities automatically", async () => {
    const core = app();
    const a = await core.identity.registerIdentity({
      channel_type: "telegram",
      external_id: "tg-1",
      display_name: "Same Person",
      correlation_id: "c",
    });
    const b = await core.identity.registerIdentity({
      channel_type: "phone",
      external_id: "+966500000000",
      display_name: "Same Person",
      correlation_id: "c",
    });
    expect(a.identity.identity_id).not.toBe(b.identity.identity_id);
    expect(a.identity.canonical_identity_id).toBeNull();
    expect(b.identity.canonical_identity_id).toBeNull();
  });

  it("rejects an empty external_id", async () => {
    const core = app();
    await expect(
      core.identity.registerIdentity({ channel_type: "web", external_id: "  ", correlation_id: "c" }),
    ).rejects.toThrow(/external_id/);
  });
});

describe("sessions and authentication", () => {
  it("issues a token that authenticates, and never stores it in plaintext", async () => {
    const core = app();
    const registered = await core.identity.registerIdentity({
      channel_type: "web",
      external_id: "u-1",
      correlation_id: "c",
    });
    const { session, token } = await core.identity.issueSession({
      principal_id: registered.principal.principal_id,
      channel_type: "web",
      correlation_id: "c",
    });

    expect(session.token_hash).not.toBe(token);
    const actor = await core.identity.authenticate(token);
    expect(actor.principal_id).toBe(registered.principal.principal_id);
    expect(actor.session_id).toBe(session.session_id);
  });

  it("rejects unknown, revoked and expired tokens", async () => {
    const core = app();
    const registered = await core.identity.registerIdentity({
      channel_type: "web",
      external_id: "u-2",
      correlation_id: "c",
    });
    const { session, token } = await core.identity.issueSession({
      principal_id: registered.principal.principal_id,
      channel_type: "web",
      correlation_id: "c",
    });

    await expect(core.identity.authenticate("not-a-token")).rejects.toThrow(/unknown session token/);

    core.clock.advance(13 * 60 * 60 * 1000);
    await expect(core.identity.authenticate(token)).rejects.toThrow(/expired or revoked/);

    await core.identity.revokeSession(session.session_id, "c");
    await expect(core.identity.authenticate(token)).rejects.toThrow();
  });
});

describe("authorization and tenant isolation", () => {
  it("grants only permissions implied by roles", async () => {
    const core = app();
    const registered = await core.identity.registerIdentity({
      channel_type: "web",
      external_id: "member",
      correlation_id: "c",
    });
    await core.identity.grantMembership({
      principal_id: registered.principal.principal_id,
      organization_id: testId("org-1"),
      roles: ["org_member"],
      correlation_id: "c",
    });
    const { token } = await core.identity.issueSession({
      principal_id: registered.principal.principal_id,
      channel_type: "web",
      correlation_id: "c",
    });
    const actor = await core.identity.authenticate(token);

    expect(() => core.identity.authorize(actor, "organization.read", testId("org-1"))).not.toThrow();
    expect(() => core.identity.authorize(actor, "organization.write", testId("org-1"))).toThrow(/missing permission/);
  });

  it("blocks access to an organization the principal does not belong to", async () => {
    const core = app();
    const registered = await core.identity.registerIdentity({
      channel_type: "web",
      external_id: "admin-of-org-1",
      correlation_id: "c",
    });
    await core.identity.grantMembership({
      principal_id: registered.principal.principal_id,
      organization_id: testId("org-1"),
      roles: ["org_admin"],
      correlation_id: "c",
    });
    const { token } = await core.identity.issueSession({
      principal_id: registered.principal.principal_id,
      channel_type: "web",
      correlation_id: "c",
    });
    const actor = await core.identity.authenticate(token);

    expect(() => core.identity.authorize(actor, "organization.read", testId("org-2"))).toThrow(/not a member/);
  });
});
