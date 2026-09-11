import {
  journalMapWrite,
  type TransactionScope,
} from "../../platform/persistence/transaction.js";
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

  async insertIdentity(identity: Identity, _scope?: TransactionScope): Promise<void> {
    journalMapWrite(_scope, this.identities, identity.identity_id);
    this.identities.set(identity.identity_id, identity);
  }
  async getIdentity(identityId: string): Promise<Identity | undefined> {
    return this.identities.get(identityId);
  }
  async updateIdentity(identity: Identity, _scope?: TransactionScope): Promise<void> {
    journalMapWrite(_scope, this.identities, identity.identity_id);
    this.identities.set(identity.identity_id, identity);
  }
  async listIdentities(): Promise<Identity[]> {
    return [...this.identities.values()];
  }

  async insertLink(link: IdentityLink, _scope?: TransactionScope): Promise<void> {
    const key = this.linkKey(link.channel_type, link.external_id);
    if (this.links.has(key)) {
      throw new Error(`identity link already exists: ${key}`);
    }
    journalMapWrite(_scope, this.links, key);
    this.links.set(key, link);
  }
  async findLink(channelType: ChannelType, externalId: string): Promise<IdentityLink | undefined> {
    return this.links.get(this.linkKey(channelType, externalId));
  }
  async listLinksForIdentity(identityId: string): Promise<IdentityLink[]> {
    return [...this.links.values()].filter((l) => l.identity_id === identityId);
  }

  async insertPrincipal(principal: Principal, _scope?: TransactionScope): Promise<void> {
    journalMapWrite(_scope, this.principals, principal.principal_id);
    this.principals.set(principal.principal_id, principal);
  }
  async getPrincipal(principalId: string): Promise<Principal | undefined> {
    return this.principals.get(principalId);
  }
  async findPrincipalByIdentity(identityId: string): Promise<Principal | undefined> {
    return [...this.principals.values()].find((p) => p.identity_id === identityId);
  }

  async insertSession(session: Session, _scope?: TransactionScope): Promise<void> {
    journalMapWrite(_scope, this.sessions, session.session_id);
    this.sessions.set(session.session_id, session);
  }
  async getSessionByTokenHash(tokenHash: string): Promise<Session | undefined> {
    return [...this.sessions.values()].find((s) => s.token_hash === tokenHash);
  }
  async getSession(sessionId: string): Promise<Session | undefined> {
    return this.sessions.get(sessionId);
  }
  async updateSession(session: Session, _scope?: TransactionScope): Promise<void> {
    journalMapWrite(_scope, this.sessions, session.session_id);
    this.sessions.set(session.session_id, session);
  }

  async insertMembership(membership: Membership, _scope?: TransactionScope): Promise<void> {
    journalMapWrite(_scope, this.memberships, membership.membership_id);
    this.memberships.set(membership.membership_id, membership);
  }
  async listMemberships(principalId: string): Promise<Membership[]> {
    return [...this.memberships.values()].filter((m) => m.principal_id === principalId);
  }
  async findMembership(principalId: string, organizationId: string): Promise<Membership | undefined> {
    return [...this.memberships.values()].find(
      (m) => m.principal_id === principalId && m.organization_id === organizationId,
    );
  }
}
