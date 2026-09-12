import type { Pool } from "pg";
import { iso, isoRequired, runner, type Queryable } from "../../platform/persistence/postgres.js";
import type { TransactionScope } from "../../platform/persistence/transaction.js";
import {
  REPUTATION_SIGNAL_KINDS,
  type ReputationKindGroup,
  type ReputationSignal,
  type ReputationSignalKind,
  type ReputationSubject,
  type ReputationSubjectType,
} from "./domain.js";
import type {
  ReputationRepository,
  RetractionOutcome,
  SignalInsertOutcome,
} from "./repository.js";

/**
 * `count(*)` and `sum(...)` come back as strings, because the driver refuses to
 * lose precision on a `bigint` silently. Normalised in one place so no caller
 * has to remember, and refused rather than truncated if a total ever exceeds
 * what a JavaScript integer can hold exactly.
 */
function bigint(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`value ${String(value)} exceeds the safe integer range`);
  }
  return parsed;
}

const KIND_ORDER: readonly string[] = REPUTATION_SIGNAL_KINDS;

export class PgReputationRepository implements ReputationRepository {
  constructor(private readonly pool: Pool) {}

  private db(scope?: TransactionScope): Queryable {
    return runner(this.pool, scope);
  }

  /**
   * `on conflict do nothing` rather than a preceding existence check: the unique
   * constraint is the exactly-once guarantee, and only the write can decide
   * which of two concurrent copies of the same report arrived first.
   */
  async insertIfAbsent(
    signal: ReputationSignal,
    scope?: TransactionScope,
  ): Promise<SignalInsertOutcome> {
    const result = await this.db(scope).query(
      `INSERT INTO reputation_signal (
         reputation_signal_id, organization_id, subject_type, subject_id,
         signal_kind, rating_value, source_system, source_reference,
         occurred_at, recorded_at, correlation_id, retracted_at, retraction_reason
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (organization_id, source_system, source_reference) DO NOTHING`,
      [
        signal.reputation_signal_id,
        signal.organization_id,
        signal.subject_type,
        signal.subject_id,
        signal.signal_kind,
        signal.rating_value,
        signal.source_system,
        signal.source_reference,
        signal.occurred_at,
        signal.recorded_at,
        signal.correlation_id,
        signal.retracted_at,
        signal.retraction_reason,
      ],
    );
    return (result.rowCount ?? 0) > 0 ? "inserted" : "duplicate_source_reference";
  }

  /**
   * The marker write, conditional in the statement.
   *
   * `retracted_at is null` in the `where` is what makes the retraction
   * single-valued under concurrency: the second of two concurrent retractions
   * updates nothing and is reported as `stale`. The append-only trigger refuses
   * it as well, but a refusal that throws would make an ordinary redelivery look
   * like a failure, so the condition is stated here too.
   */
  async retractIfStanding(
    input: {
      organization_id: string;
      source_system: string;
      source_reference: string;
      retracted_at: string;
      reason: string;
    },
    scope?: TransactionScope,
  ): Promise<RetractionOutcome> {
    const result = await this.db(scope).query(
      `UPDATE reputation_signal
          SET retracted_at = $4, retraction_reason = $5
        WHERE organization_id = $1
          AND source_system = $2
          AND source_reference = $3
          AND retracted_at IS NULL`,
      [
        input.organization_id,
        input.source_system,
        input.source_reference,
        input.retracted_at,
        input.reason,
      ],
    );
    return (result.rowCount ?? 0) > 0 ? "applied" : "stale";
  }

  async findBySource(
    organizationId: string,
    sourceSystem: string,
    sourceReference: string,
  ): Promise<ReputationSignal | undefined> {
    const result = await this.db().query(
      `SELECT * FROM reputation_signal
        WHERE organization_id = $1 AND source_system = $2 AND source_reference = $3`,
      [organizationId, sourceSystem, sourceReference],
    );
    const row = result.rows[0];
    return row ? this.toSignal(row) : undefined;
  }

  async get(signalId: string): Promise<ReputationSignal | undefined> {
    const result = await this.db().query(
      `SELECT * FROM reputation_signal WHERE reputation_signal_id = $1`,
      [signalId],
    );
    const row = result.rows[0];
    return row ? this.toSignal(row) : undefined;
  }

  async listForSubject(
    subject: ReputationSubject,
    limit: number,
  ): Promise<readonly ReputationSignal[]> {
    const result = await this.db().query(
      `SELECT * FROM reputation_signal
        WHERE organization_id = $1 AND subject_type = $2 AND subject_id = $3
        ORDER BY recorded_at DESC, reputation_signal_id DESC
        LIMIT $4`,
      [subject.organization_id, subject.subject_type, subject.subject_id, limit],
    );
    return result.rows.map((row) => this.toSignal(row));
  }

  /**
   * The grouped read. One row per kind actually present, computed by the
   * database, so a subject with a long history costs the same as a short one to
   * summarise. `filter (where retracted_at is null)` is what keeps a withdrawn
   * signal out of every total except its own count.
   */
  async groupsForSubject(
    subject: ReputationSubject,
  ): Promise<readonly ReputationKindGroup[]> {
    const result = await this.db().query(
      `SELECT signal_kind,
              count(*) FILTER (WHERE retracted_at IS NULL)      AS standing_count,
              count(*) FILTER (WHERE retracted_at IS NOT NULL)  AS retracted_count,
              count(rating_value) FILTER (WHERE retracted_at IS NULL) AS rating_count,
              COALESCE(sum(rating_value) FILTER (WHERE retracted_at IS NULL), 0) AS rating_sum,
              min(recorded_at) AS first_recorded_at,
              max(recorded_at) AS last_recorded_at
         FROM reputation_signal
        WHERE organization_id = $1 AND subject_type = $2 AND subject_id = $3
        GROUP BY signal_kind`,
      [subject.organization_id, subject.subject_type, subject.subject_id],
    );
    return result.rows
      .map((row) => ({
        signal_kind: row["signal_kind"] as ReputationSignalKind,
        standing_count: bigint(row["standing_count"]),
        retracted_count: bigint(row["retracted_count"]),
        rating_count: bigint(row["rating_count"]),
        rating_sum: bigint(row["rating_sum"]),
        first_recorded_at: isoRequired(row["first_recorded_at"] as Date),
        last_recorded_at: isoRequired(row["last_recorded_at"] as Date),
      }))
      // Sorted into the declared kind order rather than left in whatever order
      // the group-by produced, so the two backends return identical rows and a
      // conformance test can compare them directly.
      .sort(
        (a, b) => KIND_ORDER.indexOf(a.signal_kind) - KIND_ORDER.indexOf(b.signal_kind),
      );
  }

  private toSignal(row: Record<string, unknown>): ReputationSignal {
    return {
      reputation_signal_id: row["reputation_signal_id"] as string,
      organization_id: row["organization_id"] as string,
      subject_type: row["subject_type"] as ReputationSubjectType,
      subject_id: row["subject_id"] as string,
      signal_kind: row["signal_kind"] as ReputationSignalKind,
      rating_value: row["rating_value"] === null ? null : Number(row["rating_value"]),
      source_system: row["source_system"] as string,
      source_reference: row["source_reference"] as string,
      occurred_at: isoRequired(row["occurred_at"] as Date),
      recorded_at: isoRequired(row["recorded_at"] as Date),
      correlation_id: row["correlation_id"] as string,
      retracted_at: iso(row["retracted_at"] as Date | null),
      retraction_reason: (row["retraction_reason"] as string | null) ?? null,
    };
  }
}
