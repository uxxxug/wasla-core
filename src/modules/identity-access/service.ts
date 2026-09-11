import type { TransactionBoundary } from "../../platform/persistence/transaction.js";
import type { Clock } from "../../platform/clock.js";
import { conflict, forbidden, invalid, notFound, unauthenticated } from "../../platform/errors.js";
import { assertId, hashToken, newId, newToken } from "../../platform/ids.js";
import type { AuditLog } from "../../platform/audit/audit.js";
import { makeEvent } from "../../platform/eventing/envelope.js";
import type { OutboxStore } from "../../platform/eventing/outbox.js";
import { withTransaction } from "../../platform/eventing/unit-of-work.js";
import {
  type ChannelType,
  type Identity,
  type Membership,
  type Permission,
  type Principal,
  type Role,
  type Session,
  isSessionActive,
  permissionsForRoles,
} from "./domain.js";
import type { IdentityRepository } from "./ports.js";

const PRODUCER = "wasla-core";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface AuthenticatedPrincipal {
  principal_id: string;
  identity_id: string;
  session_id: string;
  organization_ids: string[];
  roles: Role[];
  permissions: Permission[];
}

export interface RegisterIdentityInput {
  channel_type: ChannelType;
  external_id: string;
  display_name?: string | null;
  correlation_id: string;
  source_system?: string;
  legacy_id?: string | null;
}

export interface RegisterIdentityResult {
  identity: Identity;
  principal: Principal;
  created: boolean;
}

export class IdentityService {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly outbox: OutboxStore,
    private readonly boundary: TransactionBoundary,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
  ) {}

  /**
   * Resolve-or-create by channel link. Idempotent: calling twice with the same
   * (channel_type, external_id) returns the same identity and emits no second event.
   * It never merges two existing identities — that is an explicit, gated operation.
   */
  async registerIdentity(input: RegisterIdentityInput): Promise<RegisterIdentityResult> {
    if (!input.external_id.trim()) throw invalid("external_id is required");
    if (!input.correlation_id.trim()) throw invalid("correlation_id is required");

    const existingLink = await this.repo.findLink(input.channel_type, input.external_id);
    if (existingLink) {
      const identity = await this.repo.getIdentity(existingLink.identity_id);
      if (!identity) throw notFound("identity referenced by link does not exist");
      const principal = await this.repo.findPrincipalByIdentity(identity.identity_id);
      if (!principal) throw notFound("principal for identity does not exist");
      return { identity, principal, created: false };
    }

    const now = this.clock.now();
    const identity: Identity = {
      identity_id: newId(),
      status: "active",
      canonical_identity_id: null,
      display_name: input.display_name ?? null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      source_system: input.source_system ?? PRODUCER,
      legacy_id: input.legacy_id ?? null,
    };
    const principal: Principal = {
      principal_id: newId(),
      identity_id: identity.identity_id,
      created_at: now.toISOString(),
    };
    const link = {
      identity_link_id: newId(),
      identity_id: identity.identity_id,
      channel_type: input.channel_type,
      external_id: input.external_id,
      verified_at: now.toISOString(),
      created_at: now.toISOString(),
    };

    await withTransaction(this.tx, async (uow) => {
      uow.stage(async (scope) => {
        await this.repo.insertIdentity(identity, scope);
        await this.repo.insertPrincipal(principal, scope);
        await this.repo.insertLink(link, scope);
      });
      uow.emit(
        makeEvent({
          event_type: "core.identity.verified",
          version: 1,
          producer: PRODUCER,
          occurred_at: now,
          correlation_id: input.correlation_id,
          entity_type: "identity",
          entity_id: identity.identity_id,
          payload: {
            identity_id: identity.identity_id,
            principal_id: principal.principal_id,
            channel_type: input.channel_type,
            verified_at: now.toISOString(),
          },
        }),
      );
      uow.audit({
        actor_type: "system",
        actor_id: null,
        action: "identity.registered",
        entity_type: "identity",
        entity_id: identity.identity_id,
        correlation_id: input.correlation_id,
        metadata: { channel_type: input.channel_type },
      });
    });

    return { identity, principal, created: true };
  }

  /** Boundary, outbox and audit log — the three things a commit needs. */
  private get tx() {
    return { boundary: this.boundary, outbox: this.outbox, audit: this.audit };
  }

  /** Issues an opaque session token. Only its hash is persisted. */
  async issueSession(input: {
    principal_id: string;
    channel_type: ChannelType;
    correlation_id: string;
  }): Promise<{ session: Session; token: string }> {
    assertId("principal_id", input.principal_id);
    const principal = await this.repo.getPrincipal(input.principal_id);
    if (!principal) throw notFound("principal not found");
    const identity = await this.repo.getIdentity(principal.identity_id);
    if (!identity) throw notFound("identity not found");
    if (identity.status !== "active") throw forbidden("identity is not active");

    const now = this.clock.now();
    const token = newToken();
    const session: Session = {
      session_id: newId(),
      principal_id: principal.principal_id,
      token_hash: hashToken(token),
      channel_type: input.channel_type,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      revoked_at: null,
    };
    // No event is emitted, but the row and its audit entry still have to
    // commit together: a session that exists with no record of being issued
    // is exactly the gap an access review would be looking for.
    await withTransaction(this.tx, (uow) => {
      uow.stage((scope) => this.repo.insertSession(session, scope));
      uow.audit({
        actor_type: "principal",
        actor_id: principal.principal_id,
        action: "session.issued",
        entity_type: "session",
        entity_id: session.session_id,
        correlation_id: input.correlation_id,
        metadata: { channel_type: input.channel_type },
      });
    });
    return { session, token };
  }

  async revokeSession(sessionId: string, correlationId: string): Promise<void> {
    assertId("session_id", sessionId);
    const session = await this.repo.getSession(sessionId);
    if (!session) throw notFound("session not found");
    if (session.revoked_at !== null) return;
    // A copy, not an in-place edit. Mutating the stored object would make the
    // change visible before the commit and leave the journal nothing to
    // restore, because the pre-image and the new value would be one object.
    const revoked: Session = { ...session, revoked_at: this.clock.now().toISOString() };
    await withTransaction(this.tx, (uow) => {
      uow.stage((scope) => this.repo.updateSession(revoked, scope));
      uow.audit({
        actor_type: "principal",
        actor_id: revoked.principal_id,
        action: "session.revoked",
        entity_type: "session",
        entity_id: revoked.session_id,
        correlation_id: correlationId,
        metadata: {},
      });
    });
  }

  /** Authenticates a bearer token and resolves the acting principal. */
  async authenticate(token: string): Promise<AuthenticatedPrincipal> {
    if (!token) throw unauthenticated();
    const session = await this.repo.getSessionByTokenHash(hashToken(token));
    if (!session) throw unauthenticated("unknown session token");
    if (!isSessionActive(session, this.clock.now())) throw unauthenticated("session expired or revoked");

    const principal = await this.repo.getPrincipal(session.principal_id);
    if (!principal) throw unauthenticated("principal no longer exists");
    const identity = await this.repo.getIdentity(principal.identity_id);
    if (!identity || identity.status !== "active") throw forbidden("identity is not active");

    const memberships = await this.repo.listMemberships(principal.principal_id);
    const roles = [...new Set(memberships.flatMap((m) => m.roles))];
    return {
      principal_id: principal.principal_id,
      identity_id: identity.identity_id,
      session_id: session.session_id,
      organization_ids: memberships.map((m) => m.organization_id),
      roles,
      permissions: [...permissionsForRoles(roles)],
    };
  }

  async grantMembership(input: {
    principal_id: string;
    organization_id: string;
    roles: Role[];
    correlation_id: string;
  }): Promise<Membership> {
    assertId("principal_id", input.principal_id);
    assertId("organization_id", input.organization_id);
    if (!await this.repo.getPrincipal(input.principal_id)) throw notFound("principal not found");
    if (await this.repo.findMembership(input.principal_id, input.organization_id)) {
      throw conflict("membership already exists");
    }
    const membership: Membership = {
      membership_id: newId(),
      principal_id: input.principal_id,
      organization_id: input.organization_id,
      roles: input.roles,
      created_at: this.clock.now().toISOString(),
    };
    // Membership is an authorization fact. The grant and the record of who
    // granted it commit together or not at all.
    await withTransaction(this.tx, (uow) => {
      uow.stage((scope) => this.repo.insertMembership(membership, scope));
      uow.audit({
        actor_type: "system",
        actor_id: null,
        action: "membership.granted",
        entity_type: "membership",
        entity_id: membership.membership_id,
        correlation_id: input.correlation_id,
        metadata: { organization_id: input.organization_id, roles: input.roles },
      });
    });
    return membership;
  }

  /**
   * Authorization check. Tenant isolation is enforced here: a permission is only
   * granted inside an organization the principal belongs to.
   */
  authorize(
    actor: AuthenticatedPrincipal,
    permission: Permission,
    organizationId?: string,
  ): void {
    if (!actor.permissions.includes(permission)) {
      throw forbidden("missing permission", { permission });
    }
    if (organizationId !== undefined && !actor.organization_ids.includes(organizationId)) {
      if (!actor.roles.includes("platform_admin")) {
        throw forbidden("principal is not a member of this organization", {
          organization_id: organizationId,
        });
      }
    }
  }
}
