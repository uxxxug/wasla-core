import type { ReferenceKeys } from "../../platform/persistence/reference-keys.js";
import {
  journalMapWrite,
  type TransactionScope,
} from "../../platform/persistence/transaction.js";
import type { ChannelType, Identity, IdentityLink, Membership, Principal, Session } from "./domain.js";
import type { IdentityRepository } from "./ports.js";
import { putRow } from "../../platform/persistence/row-rules.js";

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

  /**
   * `identity` and `principal` are parents of five keys between them, and the
   * `session` registration is what made `session_principal_id_fkey` checkable
   * at all: sessions used to be written with a bare `map.set`.
   */
  constructor(keys?: ReferenceKeys) {
    keys?.attach("identity", this.identities);
    keys?.attach("identity_link", this.links);
    keys?.attach("principal", this.principals);
    keys?.attach("session", this.sessions);
    keys?.attach("membership", this.memberships);
  }

  private linkKey(channelType: ChannelType, externalId: string) {
    return `${channelType}::${externalId}`;
  }

  /**
   * The wording Postgres uses, so a caller cannot tell the two backends apart.
   *
   * Every refusal below quotes the schema rule that would have refused it, which
   * is what makes a reference-store green mean the same thing as a database
   * green (B-12). A message that only says "already exists" leaves the reader
   * guessing which rule fired and lets the rule be renamed without a test
   * noticing.
   */
  private duplicate(constraint: string): Error {
    return new Error(`duplicate key value violates unique constraint "${constraint}"`);
  }

  /**
   * `identity_legacy_idx`: one row per (source_system, legacy_id), and only
   * where `legacy_id` is not null, because an identity CORE created itself has
   * no legacy record to be a second copy of.
   */
  private assertIdentityLegacyFree(identity: Identity): void {
    if (identity.legacy_id === null) return;
    for (const existing of this.identities.values()) {
      if (existing.identity_id === identity.identity_id) continue;
      if (
        existing.legacy_id === identity.legacy_id &&
        existing.source_system === identity.source_system
      ) {
        throw this.duplicate("identity_legacy_idx");
      }
    }
  }

  async insertIdentity(identity: Identity, _scope?: TransactionScope): Promise<void> {
    this.assertIdentityLegacyFree(identity);
    journalMapWrite(_scope, this.identities, identity.identity_id);
    putRow("identity", this.identities, identity.identity_id, identity);
  }
  async getIdentity(identityId: string): Promise<Identity | undefined> {
    return this.identities.get(identityId);
  }
  async updateIdentity(identity: Identity, _scope?: TransactionScope): Promise<void> {
    this.assertIdentityLegacyFree(identity);
    journalMapWrite(_scope, this.identities, identity.identity_id);
    putRow("identity", this.identities, identity.identity_id, identity);
  }
  async listIdentities(): Promise<Identity[]> {
    return [...this.identities.values()];
  }

  async insertLink(link: IdentityLink, _scope?: TransactionScope): Promise<void> {
    const key = this.linkKey(link.channel_type, link.external_id);
    if (this.links.has(key)) {
      throw this.duplicate("identity_link_channel_type_external_id_key");
    }
    journalMapWrite(_scope, this.links, key);
    putRow("identity_link", this.links, key, link);
  }
  async findLink(channelType: ChannelType, externalId: string): Promise<IdentityLink | undefined> {
    return this.links.get(this.linkKey(channelType, externalId));
  }
  async listLinksForIdentity(identityId: string): Promise<IdentityLink[]> {
    return [...this.links.values()].filter((l) => l.identity_id === identityId);
  }

  async insertPrincipal(principal: Principal, _scope?: TransactionScope): Promise<void> {
    for (const existing of this.principals.values()) {
      if (existing.principal_id === principal.principal_id) continue;
      // Two principals for one identity would make an authorization answer
      // depend on which row a query happened to reach first.
      if (existing.identity_id === principal.identity_id) {
        throw this.duplicate("principal_identity_id_key");
      }
      if (principal.service_name !== null && existing.service_name === principal.service_name) {
        throw this.duplicate("principal_service_name_key");
      }
    }
    journalMapWrite(_scope, this.principals, principal.principal_id);
    putRow("principal", this.principals, principal.principal_id, principal);
  }
  async getPrincipal(principalId: string): Promise<Principal | undefined> {
    return this.principals.get(principalId);
  }
  async findPrincipalByIdentity(identityId: string): Promise<Principal | undefined> {
    return [...this.principals.values()].find((p) => p.identity_id === identityId);
  }

  async insertSession(session: Session, _scope?: TransactionScope): Promise<void> {
    for (const existing of this.sessions.values()) {
      // One bearer token resolving to two sessions is one credential with two
      // sets of rights, so the token hash is unique for every session ever
      // issued, revoked or not.
      if (existing.session_id !== session.session_id && existing.token_hash === session.token_hash) {
        throw this.duplicate("session_token_hash_key");
      }
    }
    journalMapWrite(_scope, this.sessions, session.session_id);
    // `session_principal_id_fkey`: a session is a set of rights, and one naming
    // a principal that does not exist is a bearer token resolving to rights
    // nobody was granted. Postgres has always refused it; until this cycle the
    // reference store wrote sessions with a bare `map.set`, so it did not.
    putRow("session", this.sessions, session.session_id, session);
  }
  async getSessionByTokenHash(tokenHash: string): Promise<Session | undefined> {
    return [...this.sessions.values()].find((s) => s.token_hash === tokenHash);
  }
  async getSession(sessionId: string): Promise<Session | undefined> {
    return this.sessions.get(sessionId);
  }
  async updateSession(session: Session, _scope?: TransactionScope): Promise<void> {
    journalMapWrite(_scope, this.sessions, session.session_id);
    putRow("session", this.sessions, session.session_id, session);
  }

  async insertMembership(membership: Membership, _scope?: TransactionScope): Promise<void> {
    for (const existing of this.memberships.values()) {
      if (existing.membership_id === membership.membership_id) continue;
      // Roles live in one row per pair, so a second row is a second answer to
      // "what may this principal do here".
      if (
        existing.principal_id === membership.principal_id &&
        existing.organization_id === membership.organization_id
      ) {
        throw this.duplicate("membership_principal_id_organization_id_key");
      }
    }
    journalMapWrite(_scope, this.memberships, membership.membership_id);
    putRow("membership", this.memberships, membership.membership_id, membership);
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
