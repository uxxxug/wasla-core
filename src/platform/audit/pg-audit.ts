import type { Clock } from "../clock.js";
import { newId } from "../ids.js";
import { isoRequired, runner, type Queryable } from "../persistence/postgres.js";
import { NO_SCOPE, type TransactionScope } from "../persistence/transaction.js";
import { scrub, type AuditEntry, type AuditLog } from "./audit.js";

interface AuditRow {
  audit_id: string;
  occurred_at: Date;
  actor_type: AuditEntry["actor_type"];
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  correlation_id: string;
  metadata: Record<string, unknown> | null;
}

const toEntry = (row: AuditRow): AuditEntry => ({
  audit_id: row.audit_id,
  occurred_at: isoRequired(row.occurred_at),
  actor_type: row.actor_type,
  actor_id: row.actor_id,
  action: row.action,
  entity_type: row.entity_type,
  entity_id: row.entity_id,
  correlation_id: row.correlation_id,
  metadata: row.metadata ?? {},
});

const COLUMNS = `audit_id, occurred_at, actor_type, actor_id, action, entity_type,
  entity_id, correlation_id, metadata`;

/**
 * Durable audit trail. Append-only: there is no update and no delete, and the
 * schema grants nothing that would allow one.
 *
 * `record` accepts a scope and uses it when given. Most callers do not pass
 * one today (B-9), which means an audit entry can outlive a rolled-back
 * command. Accepting the scope here is what makes fixing that a change to the
 * callers rather than to this adapter.
 *
 * Metadata is scrubbed with the same function the in-memory log uses, so a
 * credential cannot reach the table through this path either.
 */
export class PgAuditLog implements AuditLog {
  constructor(
    private readonly pool: Queryable,
    private readonly clock: Clock,
  ) {}

  async record(
    entry: Omit<AuditEntry, "audit_id" | "occurred_at">,
    scope: TransactionScope = NO_SCOPE,
  ): Promise<AuditEntry> {
    const full: AuditEntry = {
      ...entry,
      metadata: scrub(entry.metadata),
      audit_id: newId(),
      occurred_at: this.clock.now().toISOString(),
    };
    await runner(this.pool, scope).query(
      `insert into audit_entry (${COLUMNS}) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        full.audit_id,
        full.occurred_at,
        full.actor_type,
        full.actor_id,
        full.action,
        full.entity_type,
        full.entity_id,
        full.correlation_id,
        JSON.stringify(full.metadata),
      ],
    );
    return full;
  }

  async entries(): Promise<readonly AuditEntry[]> {
    const result = await this.pool.query<AuditRow>(
      `select ${COLUMNS} from audit_entry order by occurred_at, audit_id`,
    );
    return result.rows.map(toEntry);
  }

  async forEntity(entityType: string, entityId: string): Promise<AuditEntry[]> {
    const result = await this.pool.query<AuditRow>(
      `select ${COLUMNS} from audit_entry
       where entity_type = $1 and entity_id = $2
       order by occurred_at, audit_id`,
      [entityType, entityId],
    );
    return result.rows.map(toEntry);
  }
}
