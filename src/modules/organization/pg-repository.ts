import { isoRequired, runner, type Queryable } from "../../platform/persistence/postgres.js";
import { NO_SCOPE, type TransactionScope } from "../../platform/persistence/transaction.js";
import type { Organization, OrganizationStatus } from "./domain.js";
import type { OrganizationRepository } from "./service.js";

interface OrganizationRow {
  organization_id: string;
  name: string;
  status: OrganizationStatus;
  country_code: string;
  created_at: Date;
  updated_at: Date;
  source_system: string;
  legacy_id: string | null;
}

const COLUMNS = `organization_id, name, status, country_code, created_at, updated_at,
  source_system, legacy_id`;

/**
 * `country_code` is `char(2)`, so Postgres blank-pads anything shorter. Trim on
 * the way out, otherwise a value written as "SA" comes back as "SA" but a
 * hypothetical one-character value would come back padded and compare unequal.
 */
const toOrganization = (row: OrganizationRow): Organization => ({
  organization_id: row.organization_id,
  name: row.name,
  status: row.status,
  country_code: row.country_code.trim(),
  created_at: isoRequired(row.created_at),
  updated_at: isoRequired(row.updated_at),
  source_system: row.source_system,
  legacy_id: row.legacy_id,
});

/** Postgres adapter for the organization port. */
export class PgOrganizationRepository implements OrganizationRepository {
  constructor(private readonly pool: Queryable) {}

  async insert(organization: Organization, scope: TransactionScope = NO_SCOPE): Promise<void> {
    await runner(this.pool, scope).query(
      `insert into organization (${COLUMNS}) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        organization.organization_id,
        organization.name,
        organization.status,
        organization.country_code,
        organization.created_at,
        organization.updated_at,
        organization.source_system,
        organization.legacy_id,
      ],
    );
  }

  async get(organizationId: string): Promise<Organization | undefined> {
    const result = await this.pool.query<OrganizationRow>(
      `select ${COLUMNS} from organization where organization_id = $1`,
      [organizationId],
    );
    const row = result.rows[0];
    return row ? toOrganization(row) : undefined;
  }

  async list(): Promise<Organization[]> {
    const result = await this.pool.query<OrganizationRow>(
      `select ${COLUMNS} from organization order by created_at, organization_id`,
    );
    return result.rows.map(toOrganization);
  }
}
