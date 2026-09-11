import type { ChannelType, Identity, IdentityLink, Membership, Principal, Session } from "./domain.js";

export interface IdentityRepository {
  insertIdentity(identity: Identity): void;
  getIdentity(identityId: string): Identity | undefined;
  updateIdentity(identity: Identity): void;
  listIdentities(): Identity[];

  insertLink(link: IdentityLink): void;
  findLink(channelType: ChannelType, externalId: string): IdentityLink | undefined;
  listLinksForIdentity(identityId: string): IdentityLink[];

  insertPrincipal(principal: Principal): void;
  getPrincipal(principalId: string): Principal | undefined;
  findPrincipalByIdentity(identityId: string): Principal | undefined;

  insertSession(session: Session): void;
  getSessionByTokenHash(tokenHash: string): Session | undefined;
  getSession(sessionId: string): Session | undefined;
  updateSession(session: Session): void;

  insertMembership(membership: Membership): void;
  listMemberships(principalId: string): Membership[];
  findMembership(principalId: string, organizationId: string): Membership | undefined;
}
