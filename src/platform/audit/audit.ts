import type { Clock } from "../clock.js";
import { newId } from "../ids.js";

/**
 * Append-only audit trail. Every state-changing action in CORE writes one entry.
 * Entries are never updated or deleted.
 */
export interface AuditEntry {
  audit_id: string;
  occurred_at: string;
  actor_type: "principal" | "system" | "service";
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  correlation_id: string;
  metadata: Record<string, unknown>;
}

export interface AuditLog {
  record(entry: Omit<AuditEntry, "audit_id" | "occurred_at">): AuditEntry;
  entries(): readonly AuditEntry[];
  forEntity(entityType: string, entityId: string): AuditEntry[];
}

const SENSITIVE = /token|secret|password|authorization|api[_-]?key/i;

/** Metadata is scrubbed before it is stored — no credentials in the audit trail. */
export function scrub(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    out[key] = SENSITIVE.test(key) ? "[redacted]" : value;
  }
  return out;
}

export class InMemoryAuditLog implements AuditLog {
  private log: AuditEntry[] = [];
  constructor(private readonly clock: Clock) {}

  record(entry: Omit<AuditEntry, "audit_id" | "occurred_at">): AuditEntry {
    const full: AuditEntry = {
      ...entry,
      metadata: scrub(entry.metadata),
      audit_id: newId(),
      occurred_at: this.clock.now().toISOString(),
    };
    this.log.push(full);
    return full;
  }

  entries(): readonly AuditEntry[] {
    return this.log;
  }

  forEntity(entityType: string, entityId: string): AuditEntry[] {
    return this.log.filter((e) => e.entity_type === entityType && e.entity_id === entityId);
  }
}
