import {
  journalMapWrite,
  type TransactionBoundary,
  type TransactionScope,
} from "../../platform/persistence/transaction.js";
import { withTransaction } from "../../platform/eventing/unit-of-work.js";
import type { Clock } from "../../platform/clock.js";
import type { AuditLog } from "../../platform/audit/audit.js";
import { invalid, notFound } from "../../platform/errors.js";
import { newId } from "../../platform/ids.js";
import type { Organization } from "./domain.js";
import { putRow } from "../../platform/persistence/row-rules.js";

export interface OrganizationRepository {
  insert(organization: Organization, scope: TransactionScope): Promise<void>;
  get(organizationId: string): Promise<Organization | undefined>;
  list(): Promise<Organization[]>;
}

export class InMemoryOrganizationRepository implements OrganizationRepository {
  private rows = new Map<string, Organization>();
  /**
   * `organization_legacy_idx`: one row per (source_system, legacy_id) where a
   * legacy id exists. Two rows for one imported organization would split its
   * memberships and money across two ids that the source system considers one.
   */
  async insert(organization: Organization, scope?: TransactionScope): Promise<void> {
    if (organization.legacy_id !== null) {
      for (const existing of this.rows.values()) {
        if (existing.organization_id === organization.organization_id) continue;
        if (
          existing.legacy_id === organization.legacy_id &&
          existing.source_system === organization.source_system
        ) {
          throw new Error(
            'duplicate key value violates unique constraint "organization_legacy_idx"',
          );
        }
      }
    }
    journalMapWrite(scope, this.rows, organization.organization_id);
    putRow("organization", this.rows, organization.organization_id, organization);
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
    private readonly boundary: TransactionBoundary,
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
    // No event: tenancy is read through the API, not published (ADR 0009).
    // The transaction exists for the audit entry — a tenant that exists with
    // no record of being created is the gap B-9 was about.
    await withTransaction({ boundary: this.boundary, audit: this.audit }, (uow) => {
      uow.stage((scope) => this.repo.insert(organization, scope));
      uow.audit({
        actor_type: "system",
        actor_id: null,
        action: "organization.created",
        entity_type: "organization",
        entity_id: organization.organization_id,
        correlation_id: input.correlation_id,
        metadata: { country_code: organization.country_code },
      });
    });
    return organization;
  }

  async require(organizationId: string): Promise<Organization> {
    const organization = await this.repo.get(organizationId);
    if (!organization) throw notFound("organization not found");
    return organization;
  }
}
