import {
  journalMapWrite,
  NO_SCOPE,
  type TransactionScope,
} from "../../platform/persistence/transaction.js";
import type { Clock } from "../../platform/clock.js";
import type { AuditLog } from "../../platform/audit/audit.js";
import { invalid, notFound } from "../../platform/errors.js";
import { newId } from "../../platform/ids.js";
import type { Organization } from "./domain.js";

export interface OrganizationRepository {
  insert(organization: Organization, scope: TransactionScope): Promise<void>;
  get(organizationId: string): Promise<Organization | undefined>;
  list(): Promise<Organization[]>;
}

export class InMemoryOrganizationRepository implements OrganizationRepository {
  private rows = new Map<string, Organization>();
  async insert(organization: Organization, scope?: TransactionScope): Promise<void> {
    journalMapWrite(scope, this.rows, organization.organization_id);
    this.rows.set(organization.organization_id, organization);
  }
  async get(organizationId: string): Promise<Organization | undefined> {
    return this.rows.get(organizationId);
  }
  async list(): Promise<Organization[]> {
    return [...this.rows.values()];
  }
}

export class OrganizationService {
  constructor(
    private readonly repo: OrganizationRepository,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
  ) {}

  async create(input: {
    name: string;
    country_code: string;
    correlation_id: string;
    source_system?: string;
    legacy_id?: string | null;
  }): Promise<Organization> {
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
    await this.repo.insert(organization, NO_SCOPE);
    await this.audit.record({
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

  async require(organizationId: string): Promise<Organization> {
    const organization = await this.repo.get(organizationId);
    if (!organization) throw notFound("organization not found");
    return organization;
  }
}
