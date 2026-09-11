/**
 * Organization / Tenancy (ADR 0004).
 * Organization IS the tenant. The model is deliberately flat: no hierarchy is
 * introduced until a real requirement forces it.
 *
 * Stores (MARKET) and Fleets (MOVE) live in the product that owns them and
 * reference an organization_id issued here. CORE does not model them.
 */
export type OrganizationStatus = "active" | "suspended";

export interface Organization {
  organization_id: string;
  name: string;
  status: OrganizationStatus;
  country_code: string;
  created_at: string;
  updated_at: string;
  source_system: string;
  legacy_id: string | null;
}
