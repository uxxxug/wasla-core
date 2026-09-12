import { iso, isoRequired, runner, type Queryable } from "../persistence/postgres.js";
import { NO_SCOPE, type TransactionScope } from "../persistence/transaction.js";
import type { Clock } from "../clock.js";
import { tallyRows } from "./queue-counts.js";
import type {
  DeliveryStatus,
  DeliveryStore,
  EventDelivery,
  EventSubscription,
} from "./delivery.js";

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
});

const SUB_COLUMNS = `subscription_id, subscriber, event_type, endpoint_url,
  signing_secret, active, created_at`;
const DEL_COLUMNS = `delivery_id, event_id, subscription_id, status, attempts,
  last_error, last_status, next_attempt_at, created_at, delivered_at`;

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
   * column, so an abandoned claim comes back by the same clock that schedules
   * retries — one timer, one truth. A worker that dies mid-attempt costs one
   * lease of delay, which is the same trade every retry in CORE already makes.
   */
  async claimDue(now: Date, limit: number, leaseMs = 30_000): Promise<EventDelivery[]> {
    const result = await this.pool.query<DeliveryRow>(
      `update event_delivery set next_attempt_at = $1::timestamptz + ($3::bigint * interval '1 millisecond')
       where delivery_id in (
         select delivery_id from event_delivery
         where status = 'pending' and next_attempt_at <= $1
         order by next_attempt_at, created_at
         limit $2
         for update skip locked
       )
       returning ${DEL_COLUMNS}`,
      [iso(now), limit, String(leaseMs)],
    );
    return result.rows.map(toDelivery);
  }

  async markDelivered(deliveryId: string, status: number): Promise<void> {
    await this.pool.query(
      `update event_delivery
       set status = 'delivered', attempts = attempts + 1, last_error = null,
           last_status = $2, delivered_at = $3
       where delivery_id = $1`,
      [deliveryId, status, this.clock.now().toISOString()],
    );
  }

  async markFailed(
    deliveryId: string,
    error: string,
    status: number | null,
    nextAttemptAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `update event_delivery
       set attempts = attempts + 1, last_error = $2, last_status = $3, next_attempt_at = $4
       where delivery_id = $1`,
      [deliveryId, error, status, iso(nextAttemptAt)],
    );
  }

  async markDead(deliveryId: string, error: string, status: number | null): Promise<void> {
    await this.pool.query(
      `update event_delivery
       set status = 'dead', attempts = attempts + 1, last_error = $2, last_status = $3
       where delivery_id = $1`,
      [deliveryId, error, status],
    );
  }

  async counts(): Promise<Record<string, number>> {
    const result = await this.pool.query<{ status: DeliveryStatus; total: string; retrying: string }>(
      `select status,
              count(*) as total,
              count(*) filter (where status = 'pending' and attempts > 0) as retrying
       from event_delivery group by status`,
    );
    return tallyRows(result.rows, ["pending", "delivered", "dead"]);
  }

  async byStatus(status: DeliveryStatus): Promise<EventDelivery[]> {
    const result = await this.pool.query<DeliveryRow>(
      `select ${DEL_COLUMNS} from event_delivery where status = $1 order by created_at`,
      [status],
    );
    return result.rows.map(toDelivery);
  }

  async forEvent(eventId: string): Promise<EventDelivery[]> {
    const result = await this.pool.query<DeliveryRow>(
      `select ${DEL_COLUMNS} from event_delivery where event_id = $1 order by created_at`,
      [eventId],
    );
    return result.rows.map(toDelivery);
  }

  async all(): Promise<EventDelivery[]> {
    const result = await this.pool.query<DeliveryRow>(
      `select ${DEL_COLUMNS} from event_delivery order by created_at`,
    );
    return result.rows.map(toDelivery);
  }
}
