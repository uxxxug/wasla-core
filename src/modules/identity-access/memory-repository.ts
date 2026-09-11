import type { ChannelType, Identity, IdentityLink, Membership, Principal, Session } from "./domain.js";
import type { IdentityRepository } from "./ports.js";

/**
 * Reference implementation of the identity repository.
 * The Postgres adapter (db/migrations/0001_core_foundation.sql) implements the
 * same port; tests run against this one so they need no database.
 */
export class InMemoryIdentityRepository implements IdentityRepository {
  private identities = new Map<string, Identity>();
  private links = new Map<string, IdentityLink>();
  private principals = new Map<string, Principal>();
  private sessions = new Map<string, Session>();
  private memberships = new Map<string, Membership>();

  private linkKey(channelType: ChannelType, externalId: string) {
    return `${channelType}::${externalId}`;
  }

  insertIdentity(identity: Identity): void {
    this.identities.set(identity.identity_id, identity);
  }
  getIdentity(identityId: string): Identity | undefined {
    return this.identities.get(identityId);
  }
  updateIdentity(identity: Identity): void {
    this.identities.set(identity.identity_id, identity);
  }
  listIdentities(): Identity[] {
    return [...this.identities.values()];
  }

  insertLink(link: IdentityLink): void {
    const key = this.linkKey(link.channel_type, link.external_id);
    if (this.links.has(key)) {
      throw new Error(`identity link already exists: ${key}`);
    }
    this.links.set(key, link);
  }
  findLink(channelType: ChannelType, externalId: string): IdentityLink | undefined {
    return this.links.get(this.linkKey(channelType, externalId));
  }
  listLinksForIdentity(identityId: string): IdentityLink[] {
    return [...this.links.values()].filter((l) => l.identity_id === identityId);
  }

  insertPrincipal(principal: Principal): void {
    this.principals.set(principal.principal_id, principal);
  }
  getPrincipal(principalId: string): Principal | undefined {
    return this.principals.get(principalId);
  }
  findPrincipalByIdentity(identityId: string): Principal | undefined {
    return [...this.principals.values()].find((p) => p.identity_id === identityId);
  }

  insertSession(session: Session): void {
    this.sessions.set(session.session_id, session);
  }
  getSessionByTokenHash(tokenHash: string): Session | undefined {
    return [...this.sessions.values()].find((s) => s.token_hash === tokenHash);
  }
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }
  updateSession(session: Session): void {
    this.sessions.set(session.session_id, session);
  }

  insertMembership(membership: Membership): void {
    this.memberships.set(membership.membership_id, membership);
  }
  listMemberships(principalId: string): Membership[] {
    return [...this.memberships.values()].filter((m) => m.principal_id === principalId);
  }
  findMembership(principalId: string, organizationId: string): Membership | undefined {
    return [...this.memberships.values()].find(
      (m) => m.principal_id === principalId && m.organization_id === organizationId,
    );
  }
}
