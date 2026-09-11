import type { Clock } from "../../platform/clock.js";
import type { AuditLog } from "../../platform/audit/audit.js";
import { invalid, notFound } from "../../platform/errors.js";
import { newId } from "../../platform/ids.js";
import type { Organization } from "./domain.js";

export interface OrganizationRepository {
  insert(organization: Organization): void;
  get(organizationId: string): Organization | undefined;
  list(): Organization[];
}

export class InMemoryOrganizationRepository implements OrganizationRepository {
  private rows = new Map<string, Organization>();
  insert(organization: Organization): void {
    this.rows.set(organization.organization_id, organization);
  }
  get(organizationId: string): Organization | undefined {
    return this.rows.get(organizationId);
  }
  list(): Organization[] {
    return [...this.rows.values()];
  }
}

export class OrganizationService {
  constructor(
    private readonly repo: OrganizationRepository,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
  ) {}

  create(input: {
    name: string;
    country_code: string;
    correlation_id: string;
    source_system?: string;
    legacy_id?: string | null;
  }): Organization {
    if (!input.name.trim()) throw invalid("name is required");
    if (!/^[A-Z]{2}$/.test(input.country_code)) throw invalid("country_code must be ISO 3166-1 alpha-2");
    const now = this.clock.now().toISOString();
    const organization: Organization = {
      organization_id: newId(),
      name: input.name.trim(),
      status: "active",
      country_code: input.country_code,
      created_at: now,
      updated_at: now,
      source_system: input.source_system ?? "wasla-core",
      legacy_id: input.legacy_id ?? null,
    };
    this.repo.insert(organization);
    this.audit.record({
      actor_type: "system",
      actor_id: null,
      action: "organization.created",
      entity_type: "organization",
      entity_id: organization.organization_id,
      correlation_id: input.correlation_id,
      metadata: { country_code: organization.country_code },
    });
    return organization;
  }

  require(organizationId: string): Organization {
    const organization = this.repo.get(organizationId);
    if (!organization) throw notFound("organization not found");
    return organization;
  }
}
