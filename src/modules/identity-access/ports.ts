import type { TransactionScope } from "../../platform/persistence/transaction.js";
import type { ChannelType, Identity, IdentityLink, Membership, Principal, Session } from "./domain.js";

export interface IdentityRepository {
  insertIdentity(identity: Identity, scope: TransactionScope): Promise<void>;
  getIdentity(identityId: string): Promise<Identity | undefined>;
  updateIdentity(identity: Identity, scope: TransactionScope): Promise<void>;
  listIdentities(): Promise<Identity[]>;

  insertLink(link: IdentityLink, scope: TransactionScope): Promise<void>;
  findLink(channelType: ChannelType, externalId: string): Promise<IdentityLink | undefined>;
  listLinksForIdentity(identityId: string): Promise<IdentityLink[]>;

  insertPrincipal(principal: Principal, scope: TransactionScope): Promise<void>;
  getPrincipal(principalId: string): Promise<Principal | undefined>;
  findPrincipalByIdentity(identityId: string): Promise<Principal | undefined>;

  insertSession(session: Session, scope: TransactionScope): Promise<void>;
  getSessionByTokenHash(tokenHash: string): Promise<Session | undefined>;
  getSession(sessionId: string): Promise<Session | undefined>;
  updateSession(session: Session, scope: TransactionScope): Promise<void>;

  insertMembership(membership: Membership, scope: TransactionScope): Promise<void>;
  listMemberships(principalId: string): Promise<Membership[]>;
  findMembership(principalId: string, organizationId: string): Promise<Membership | undefined>;
}
