/**
 * Mutual exclusion for replay runs.
 *
 * Two replays over overlapping scopes would each publish the same events, and
 * while the inbox stops the *effect* from happening twice, nothing stops the two
 * runs from interleaving into a journal nobody can read, or from both reporting
 * "applied" for work only one of them did. Auditability is the reason this lock
 * exists at all: a replay whose report cannot be trusted is worse than a replay
 * that was refused.
 *
 * The lock is deliberately advisory and session-scoped rather than a row in a
 * table. B-24 is the open blocker about lease expiry being uncountable for the
 * existing workers, and adding a `replay_run` table with a `claimed_at` would be
 * exactly that blocker again in a new place — plus a schema change this
 * milestone is not allowed to make. A Postgres advisory lock has the property a
 * lease column does not: it is released by the database when the connection
 * dies, so a crashed replay never leaves a lock nobody can clear.
 */
import type { PostgresPool } from "../persistence/backends.js";

/** Held for the duration of a run; releasing it is the caller's obligation. */
export interface ReplayLease {
  release(): Promise<void>;
}

export interface ReplayLock {
  /** `null` when another run holds it. Never blocks, never queues. */
  acquire(): Promise<ReplayLease | null>;
}

/**
 * In-process lock.
 *
 * Correct for the in-memory backend, where the store lives in this process and
 * there is nothing else to exclude. It is **not** a distributed lock: two
 * processes each hold their own instance and both succeed. That is stated here
 * because it would otherwise look like protection it cannot give — on Postgres
 * the advisory lock below is the one that counts.
 */
export class InProcessReplayLock implements ReplayLock {
  private held = false;

  async acquire(): Promise<ReplayLease | null> {
    if (this.held) return null;
    this.held = true;
    return {
      release: async () => {
        this.held = false;
      },
    };
  }
}

/**
 * A fixed key, so every replay in the deployment contends for the same lock.
 *
 * Arbitrary but stable: changing it would let an old and a new build replay at
 * the same time, each believing it holds exclusivity.
 */
const REPLAY_LOCK_KEY = 8_147_321;

/**
 * A second key, so a queue revival (B-27) and a replay do not exclude each other.
 *
 * They touch different tables and cause different effects: a replay publishes
 * inbound events to consumers, a revival returns dead `outbox` and
 * `event_delivery` rows to `pending` for the workers to pick up. Sharing one key
 * would mean an operator reviving a dead delivery is refused because somebody is
 * replaying yesterday's inbound events, which is exclusion bought for nothing.
 * Two revivals still exclude each other, for the reason above the replay key:
 * interleaved runs produce a journal nobody can read.
 */
export const REVIVAL_LOCK_KEY = 8_147_322;

/**
 * Cluster-wide lock via `pg_try_advisory_lock`.
 *
 * Session-scoped, so it is taken on a dedicated client held for the whole run
 * and released when the run ends or the connection drops — not tied to a
 * transaction, because a replay is many transactions (one per event) and a
 * transaction-scoped lock would evaporate after the first one.
 */
export class PgAdvisoryReplayLock implements ReplayLock {
  constructor(
    private readonly pool: PostgresPool,
    private readonly key: number = REPLAY_LOCK_KEY,
  ) {}

  async acquire(): Promise<ReplayLease | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_lock($1) as locked",
        [this.key],
      );
      if (!result.rows[0]?.locked) {
        client.release();
        return null;
      }
    } catch (error) {
      client.release();
      throw error;
    }
    return {
      release: async () => {
        try {
          await client.query("select pg_advisory_unlock($1)", [this.key]);
        } finally {
          // Releasing the connection would drop the lock anyway; the explicit
          // unlock keeps a pooled connection clean for its next user.
          client.release();
        }
      },
    };
  }
}
