/**
 * Identity & Access domain (ADR 0003 — CORE is the source of truth for identity).
 *
 * Deliberate separations:
 *  - Identity      : the person/system that exists once in WASLA.
 *  - IdentityLink  : how that identity reaches us on a channel (Telegram, phone, email).
 *                    A channel account is NEVER the identity itself.
 *  - Principal     : the acting subject in a security decision.
 *  - Session       : an authenticated, expiring binding of a principal to a client.
 *  - Membership    : principal ↔ organization, carrying roles.
 */

export type IdentityStatus = "active" | "suspended" | "merged";

export interface Identity {
  identity_id: string;
  status: IdentityStatus;
  /** Set only when this identity was explicitly merged into another. Never automatic. */
  canonical_identity_id: string | null;
  display_name: string | null;
  created_at: string;
  updated_at: string;
  source_system: string;
  legacy_id: string | null;
}

export type ChannelType = "telegram" | "phone" | "email" | "web" | "partner_api";

export interface IdentityLink {
  identity_link_id: string;
  identity_id: string;
  channel_type: ChannelType;
  /** Identifier as issued by the channel. Unique per (channel_type, external_id). */
  external_id: string;
  verified_at: string | null;
  created_at: string;
}

export interface Principal {
  principal_id: string;
  identity_id: string;
  created_at: string;
  /**
   * Set only when this principal *is* an external system rather than a person.
   * It is the answer to "who is calling", and it comes from the credential, so
   * no request may claim it. `null` for every human principal.
   */
  service_name: string | null;
}

export interface Session {
  session_id: string;
  principal_id: string;
  token_hash: string;
  channel_type: ChannelType;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}

/** Roles are CORE-level. Product-specific capability lives in the product. */
export type Role = "platform_admin" | "org_admin" | "org_member" | "support_agent" | "service";

export interface Membership {
  membership_id: string;
  principal_id: string;
  organization_id: string;
  roles: Role[];
  created_at: string;
}

export type Permission =
  | "identity.read"
  | "identity.write"
  | "organization.read"
  | "organization.write"
  | "fulfillment.request"
  | "fulfillment.read"
  | "money.authorize"
  | "support.act"
  | "events.submit"
  // Plans and their prices are operator territory; reading a subscription is
  // not. Split into two so a tenant can see what it is paying for without
  // also being able to publish a plan or collect a charge. The names are
  // CORE's own capabilities, not product features — a plan's `feature_key` is
  // opaque data and never becomes a permission (ADR 0018).
  | "subscription.read"
  | "subscription.write";

/**
 * Role → permission mapping is data, not branching logic scattered in handlers
 * (ADR 0018: no product-specific logic in CORE).
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  platform_admin: [
    "identity.read",
    "identity.write",
    "organization.read",
    "organization.write",
    "fulfillment.request",
    "fulfillment.read",
    "money.authorize",
    "support.act",
    "events.submit",
    "subscription.read",
    "subscription.write",
  ],
  org_admin: [
    "identity.read",
    "organization.read",
    "organization.write",
    "fulfillment.request",
    "fulfillment.read",
    "subscription.read",
  ],
  org_member: ["organization.read", "fulfillment.read"],
  // A support agent has to be able to see why a subscription was refused —
  // that is the whole reason an entitlement decision carries a reason rather
  // than a bare boolean.
  support_agent: [
    "identity.read",
    "organization.read",
    "fulfillment.read",
    "support.act",
    "subscription.read",
  ],
  // A service caller exists to feed CORE events; submitting them is the point.
  service: ["fulfillment.request", "fulfillment.read", "identity.read", "events.submit"],
};

export function permissionsForRoles(roles: readonly Role[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) out.add(permission);
  }
  return out;
}

export function isSessionActive(session: Session, now: Date): boolean {
  if (session.revoked_at !== null) return false;
  return new Date(session.expires_at).getTime() > now.getTime();
}
