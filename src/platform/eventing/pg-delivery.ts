import { iso, isoRequired, runner, type Queryable } from "../persistence/postgres.js";
import { NO_SCOPE, type TransactionScope } from "../persistence/transaction.js";
import type { Clock } from "../clock.js";
import { tallyRows, type CountRow } from "./queue-counts.js";
import type {
  DeliveryStatus,
  DeliveryStore,
  EventDelivery,
  EventSubscription,
} from "./delivery.js";
import { newClaimToken, type Fence } from "./fencing.js";
import type { ReclaimOutcome } from "./reclaim.js";

interface SubscriptionRow {
  subscription_id: string;
  subscriber: string;
  event_type: string;
  endpoint_url: string;
  signing_secret: string;
  active: boolean;
  created_at: Date;
}

interface DeliveryRow {
  delivery_id: string;
  event_id: string;
  subscription_id: string;
  status: DeliveryStatus;
  attempts: number;
  last_error: string | null;
  last_status: number | null;
  next_attempt_at: Date;
  created_at: Date;
  delivered_at: Date | null;
  claimed_at: Date | null;
  reclaims: number;
  claim_token: string | null;
}

const toSubscription = (row: SubscriptionRow): EventSubscription => ({
  subscription_id: row.subscription_id,
  subscriber: row.subscriber,
  event_type: row.event_type,
  endpoint_url: row.endpoint_url,
  signing_secret: row.signing_secret,
  active: row.active,
  created_at: isoRequired(row.created_at),
});

const toDelivery = (row: DeliveryRow): EventDelivery => ({
  delivery_id: row.delivery_id,
  event_id: row.event_id,
  subscription_id: row.subscription_id,
  status: row.status,
  attempts: row.attempts,
  last_error: row.last_error,
  // integer column, but the driver can hand back a string for some numerics.
  last_status: row.last_status === null ? null : Number(row.last_status),
  next_attempt_at: isoRequired(row.next_attempt_at),
  created_at: isoRequired(row.created_at),
  delivered_at: row.delivered_at === null ? null : isoRequired(row.delivered_at),
  claimed_at: iso(row.claimed_at),
  reclaims: row.reclaims,
  claim_token: row.claim_token,
});

const SUB_COLUMNS = `subscription_id, subscriber, event_type, endpoint_url,
  signing_secret, active, created_at`;
/** The insert list. Positional, so `claimed_at` stays out of it: a newly queued
 * delivery is by definition unclaimed and the column defaults to null. */
const DEL_COLUMNS = `delivery_id, event_id, subscription_id, status, attempts,
  last_error, last_status, next_attempt_at, created_at, delivered_at`;

/**
 * Everything a read returns, including the claim (B-24), its budget (B-25) and the
 * token that fences it (B-26).
 */
const DEL_SELECT_COLUMNS = `${DEL_COLUMNS}, claimed_at, reclaims, claim_token`;

export class PgDeliveryStore implements DeliveryStore {
  constructor(
    private readonly pool: Queryable,
    private readonly clock: Clock,
  ) {}

  async insertSubscription(
    subscription: EventSubscription,
    scope: TransactionScope = NO_SCOPE,
  ): Promise<void> {
    await runner(this.pool, scope).query(
      `insert into event_subscription (${SUB_COLUMNS}) values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        subscription.subscription_id,
        subscription.subscriber,
        subscription.event_type,
        subscription.endpoint_url,
        subscription.signing_secret,
        subscription.active,
        subscription.created_at,
      ],
    );
  }

  async getSubscription(subscriptionId: string): Promise<EventSubscription | undefined> {
    const result = await this.pool.query<SubscriptionRow>(
      `select ${SUB_COLUMNS} from event_subscription where subscription_id = $1`,
      [subscriptionId],
    );
    const row = result.rows[0];
    return row ? toSubscription(row) : undefined;
  }

  async findSubscription(
    subscriber: string,
    eventType: string,
  ): Promise<EventSubscription | undefined> {
    const result = await this.pool.query<SubscriptionRow>(
      `select ${SUB_COLUMNS} from event_subscription
       where subscriber = $1 and event_type = $2`,
      [subscriber, eventType],
    );
    const row = result.rows[0];
    return row ? toSubscription(row) : undefined;
  }

  async subscriptionsFor(eventType: string): Promise<EventSubscription[]> {
    const result = await this.pool.query<SubscriptionRow>(
      `select ${SUB_COLUMNS} from event_subscription
       where event_type = $1 and active
       order by subscriber`,
      [eventType],
    );
    return result.rows.map(toSubscription);
  }

  async listSubscriptions(): Promise<EventSubscription[]> {
    const result = await this.pool.query<SubscriptionRow>(
      `select ${SUB_COLUMNS} from event_subscription order by subscriber, event_type`,
    );
    return result.rows.map(toSubscription);
  }

  async setSubscriptionActive(subscriptionId: string, active: boolean): Promise<void> {
    await this.pool.query(`update event_subscription set active = $2 where subscription_id = $1`, [
      subscriptionId,
      active,
    ]);
  }

  /**
   * `on conflict do nothing` plus `rowCount` is what makes re-running the
   * fan-out free. A read followed by an insert would let two relays queue the
   * same delivery twice, which is the shape of bug B-12 was.
   */
  async queue(delivery: EventDelivery, scope: TransactionScope = NO_SCOPE): Promise<boolean> {
    const result = await runner(this.pool, scope).query(
      `insert into event_delivery (${DEL_COLUMNS}) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (event_id, subscription_id) do nothing`,
      [
        delivery.delivery_id,
        delivery.event_id,
        delivery.subscription_id,
        delivery.status,
        delivery.attempts,
        delivery.last_error,
        delivery.last_status,
        delivery.next_attempt_at,
        delivery.created_at,
        delivery.delivered_at,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Leases up to `limit` due records.
   *
   * The lease is the fix for blocker B-22. Before it, this method only *read*
   * due rows — on Postgres with `for update skip locked` in its own implicit
   * transaction, so the locks were gone the moment the statement returned, and
   * two workers polling together both received the same rows and both did the
   * work. Measured on a real database: two pools claiming five due rows each
   * got five rows each, all five shared.
   *
   * Claiming now writes: `next_attempt_at` moves out by the lease, so the row
   * is not due again until then and a second worker's identical query does not
   * see it. `next_attempt_at` doubles as the lease expiry rather than a new
   * column, so the lease and the retry schedule are read off one timer.
   *
   * B-24 added the missing half: `claimed_at` says which of the two meanings
   * `next_attempt_at` currently carries, and this query takes only rows where it
   * is null. A delivery held by a worker that died is therefore no longer
   * silently re-served when its lease runs out — `reclaimExpired` frees it, and
   * counts it, which is what makes a dying worker visible instead of merely slow.
   */
  async claimDue(now: Date, limit: number, leaseMs = 30_000): Promise<EventDelivery[]> {
    const result = await this.pool.query<DeliveryRow>(
      `update event_delivery set next_attempt_at = $1::timestamptz + ($3::bigint * interval '1 millisecond'),
                                 claimed_at = $1,
                                 claim_token = $4
       where delivery_id in (
         select delivery_id from event_delivery
         where status = 'pending' and claimed_at is null and next_attempt_at <= $1
         order by next_attempt_at, created_at
         limit $2
         for update skip locked
       )
       returning ${DEL_SELECT_COLUMNS}`,
      // One token for the batch; see `PgOutbox.claimDue` for why per-row would
      // cost one statement per row and refuse nothing extra.
      [iso(now), limit, String(leaseMs), newClaimToken()],
    );
    return result.rows.map(toDelivery);
  }

  /**
   * See `DeliveryStore.reclaimExpired`. One statement, two outcomes (B-25): every
   * `reclaims` on the right-hand side reads the pre-update value, so the increment
   * and the CASEs that branch on it agree, and two workers cannot each read the
   * same remaining budget from a separate select.
   *
   * `last_status` is deliberately left alone on both branches. No response was
   * received — that is what an abandoned claim means — and writing one would
   * invent a subscriber reply that never happened.
   */
  async reclaimExpired(now: Date, maxReclaims: number, limit = 100): Promise<ReclaimOutcome> {
    const result = await this.pool.query<{ status: DeliveryStatus }>(
      `update event_delivery
          set reclaims = reclaims + 1,
              claimed_at = null,
              -- The token dies with the claim, which is what makes a late
              -- acknowledgement from the previous holder refusable (B-26).
              claim_token = null,
              status = case when reclaims + 1 > $3 then 'dead' else status end,
              next_attempt_at = case when reclaims + 1 > $3 then next_attempt_at else $1 end,
              last_error = case when reclaims + 1 > $3
                then 'reclaim limit exceeded: abandoned ' || (reclaims + 1) || ' times after attempt ' || attempts
                else 'abandoned claim ' || (reclaims + 1) || ' reclaimed after attempt ' || attempts end
       where delivery_id in (
         select delivery_id from event_delivery
         where status = 'pending' and claimed_at is not null and next_attempt_at <= $1
         order by next_attempt_at
         limit $2
         for update skip locked
       )
       returning status`,
      [iso(now), limit, maxReclaims],
    );
    const dead = result.rows.filter((row) => row.status === "dead").length;
    return { reclaimed: result.rows.length - dead, dead };
  }

  /**
   * Fenced on `claim_token` (B-26). `$2::text is null` is the `UNFENCED` case, kept
   * for symmetry with the other two queues; no CORE caller passes it here, because
   * every acknowledgement of a delivery comes from the worker that claimed it.
   */
  async markDelivered(deliveryId: string, fence: Fence, status: number): Promise<boolean> {
    const result = await this.pool.query(
      `update event_delivery
       set status = 'delivered', attempts = attempts + 1, last_error = null,
           last_status = $3, delivered_at = $4, claimed_at = null, claim_token = null
       where delivery_id = $1 and ($2::text is null or claim_token = $2)
       returning delivery_id`,
      [deliveryId, fence, status, this.clock.now().toISOString()],
    );
    return result.rows.length === 1;
  }

  async markFailed(
    deliveryId: string,
    fence: Fence,
    error: string,
    status: number | null,
    nextAttemptAt: Date,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `update event_delivery
       -- Clearing the claim is what puts next_attempt_at back to meaning a retry
       -- schedule; leaving it set would make the retry look like a lease.
       set attempts = attempts + 1, last_error = $3, last_status = $4, next_attempt_at = $5,
           claimed_at = null, claim_token = null
       where delivery_id = $1 and ($2::text is null or claim_token = $2)
       returning delivery_id`,
      [deliveryId, fence, error, status, iso(nextAttemptAt)],
    );
    return result.rows.length === 1;
  }

  async markDead(
    deliveryId: string,
    fence: Fence,
    error: string,
    status: number | null,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `update event_delivery
       set status = 'dead', attempts = attempts + 1, last_error = $3, last_status = $4,
           claimed_at = null, claim_token = null
       where delivery_id = $1 and ($2::text is null or claim_token = $2)
       returning delivery_id`,
      [deliveryId, fence, error, status],
    );
    return result.rows.length === 1;
  }

  async counts(): Promise<Record<string, number>> {
    const result = await this.pool.query<CountRow>(
      `select status,
              count(*) as total,
              count(*) filter (where status = 'pending' and attempts > 0) as retrying,
              count(*) filter (where status = 'pending' and claimed_at is not null
                                 and next_attempt_at > $1) as in_flight,
              count(*) filter (where status = 'pending' and claimed_at is not null
                                 and next_attempt_at <= $1) as abandoned
       from event_delivery group by status`,
      [iso(this.clock.now())],
    );
    return tallyRows(result.rows, ["pending", "delivered", "dead"]);
  }

  async byStatus(status: DeliveryStatus): Promise<EventDelivery[]> {
    const result = await this.pool.query<DeliveryRow>(
      `select ${DEL_SELECT_COLUMNS} from event_delivery where status = $1 order by created_at`,
      [status],
    );
    return result.rows.map(toDelivery);
  }

  async forEvent(eventId: string): Promise<EventDelivery[]> {
    const result = await this.pool.query<DeliveryRow>(
      `select ${DEL_SELECT_COLUMNS} from event_delivery where event_id = $1 order by created_at`,
      [eventId],
    );
    return result.rows.map(toDelivery);
  }

  async all(): Promise<EventDelivery[]> {
    const result = await this.pool.query<DeliveryRow>(
      `select ${DEL_SELECT_COLUMNS} from event_delivery order by created_at`,
    );
    return result.rows.map(toDelivery);
  }
}
