import { randomUUID } from "node:crypto";
import { iso, isoRequired, runner, type Queryable } from "../../platform/persistence/postgres.js";
import { NO_SCOPE, type TransactionScope } from "../../platform/persistence/transaction.js";
import type {
  Notification,
  NotificationChannelType,
  NotificationRecipient,
  NotificationStatus,
  NotificationTemplate,
} from "./domain.js";
import type { ClaimedNotification, NotificationStore } from "./repository.js";

interface RecipientRow {
  recipient_id: string;
  organization_id: string | null;
  event_type: string;
  identity_id: string;
  channel: NotificationChannelType;
  active: boolean;
  created_at: Date;
}

interface NotificationRow {
  notification_id: string;
  event_id: string;
  recipient_id: string;
  organization_id: string | null;
  channel: NotificationChannelType;
  address: string;
  template: NotificationTemplate;
  subject: string | null;
  body: string;
  data: Record<string, string | number | boolean>;
  idempotency_key: string;
  status: NotificationStatus;
  attempts: number;
  last_error: string | null;
  provider_message_id: string | null;
  claim_token: string | null;
  claimed_at: Date | null;
  next_attempt_at: Date;
  created_at: Date;
  accepted_at: Date | null;
  delivered_at: Date | null;
  failed_at: Date | null;
}

const toRecipient = (row: RecipientRow): NotificationRecipient => ({
  recipient_id: row.recipient_id,
  organization_id: row.organization_id,
  event_type: row.event_type,
  identity_id: row.identity_id,
  channel: row.channel,
  active: row.active,
  created_at: isoRequired(row.created_at),
});

const toNotification = (row: NotificationRow): Notification => ({
  notification_id: row.notification_id,
  event_id: row.event_id,
  recipient_id: row.recipient_id,
  organization_id: row.organization_id,
  channel: row.channel,
  address: row.address,
  template: row.template,
  subject: row.subject,
  body: row.body,
  data: row.data ?? {},
  idempotency_key: row.idempotency_key,
  status: row.status,
  attempts: Number(row.attempts),
  last_error: row.last_error,
  provider_message_id: row.provider_message_id,
  claim_token: row.claim_token,
  claimed_at: row.claimed_at === null ? null : isoRequired(row.claimed_at),
  next_attempt_at: isoRequired(row.next_attempt_at),
  created_at: isoRequired(row.created_at),
  accepted_at: row.accepted_at === null ? null : isoRequired(row.accepted_at),
  delivered_at: row.delivered_at === null ? null : isoRequired(row.delivered_at),
  failed_at: row.failed_at === null ? null : isoRequired(row.failed_at),
});

const RECIPIENT_COLUMNS = `recipient_id, organization_id, event_type, identity_id,
  channel, active, created_at`;
const COLUMNS = `notification_id, event_id, recipient_id, organization_id, channel,
  address, template, subject, body, data, idempotency_key, status, attempts,
  last_error, provider_message_id, claim_token, claimed_at, next_attempt_at,
  created_at, accepted_at, delivered_at, failed_at`;

export class PgNotificationStore implements NotificationStore {
  constructor(private readonly pool: Queryable) {}

  async insertRecipient(
    recipient: NotificationRecipient,
    scope: TransactionScope = NO_SCOPE,
  ): Promise<void> {
    await runner(this.pool, scope).query(
      `insert into notification_recipient (${RECIPIENT_COLUMNS}) values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        recipient.recipient_id,
        recipient.organization_id,
        recipient.event_type,
        recipient.identity_id,
        recipient.channel,
        recipient.active,
        recipient.created_at,
      ],
    );
  }

  async getRecipient(recipientId: string): Promise<NotificationRecipient | undefined> {
    const result = await this.pool.query<RecipientRow>(
      `select ${RECIPIENT_COLUMNS} from notification_recipient where recipient_id = $1`,
      [recipientId],
    );
    const row = result.rows[0];
    return row ? toRecipient(row) : undefined;
  }

  async findRecipient(
    organizationId: string | null,
    eventType: string,
    identityId: string,
    channel: string,
  ): Promise<NotificationRecipient | undefined> {
    // `is not distinct from` rather than `=`: organization_id is nullable, and
    // `null = null` is null, so `=` would never find a platform-wide recipient
    // and the registry would create a second one on every call.
    const result = await this.pool.query<RecipientRow>(
      `select ${RECIPIENT_COLUMNS} from notification_recipient
       where organization_id is not distinct from $1
         and event_type = $2 and identity_id = $3 and channel = $4`,
      [organizationId, eventType, identityId, channel],
    );
    const row = result.rows[0];
    return row ? toRecipient(row) : undefined;
  }

  async recipientsFor(
    eventType: string,
    organizationId: string | null,
  ): Promise<NotificationRecipient[]> {
    const result = await this.pool.query<RecipientRow>(
      `select ${RECIPIENT_COLUMNS} from notification_recipient
       where active and event_type = $1
         and (organization_id is null or organization_id = $2)
       order by created_at, recipient_id`,
      [eventType, organizationId],
    );
    return result.rows.map(toRecipient);
  }

  async listRecipients(organizationId?: string | null): Promise<NotificationRecipient[]> {
    if (organizationId === undefined) {
      const all = await this.pool.query<RecipientRow>(
        `select ${RECIPIENT_COLUMNS} from notification_recipient order by created_at, recipient_id`,
      );
      return all.rows.map(toRecipient);
    }
    const result = await this.pool.query<RecipientRow>(
      `select ${RECIPIENT_COLUMNS} from notification_recipient
       where organization_id is not distinct from $1
       order by created_at, recipient_id`,
      [organizationId],
    );
    return result.rows.map(toRecipient);
  }

  async setRecipientActive(recipientId: string, active: boolean): Promise<void> {
    await this.pool.query(`update notification_recipient set active = $2 where recipient_id = $1`, [
      recipientId,
      active,
    ]);
  }

  async queue(notification: Notification, scope: TransactionScope = NO_SCOPE): Promise<boolean> {
    const result = await runner(this.pool, scope).query(
      `insert into notification (${COLUMNS})
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       on conflict (event_id, recipient_id) do nothing`,
      [
        notification.notification_id,
        notification.event_id,
        notification.recipient_id,
        notification.organization_id,
        notification.channel,
        notification.address,
        notification.template,
        notification.subject,
        notification.body,
        JSON.stringify(notification.data),
        notification.idempotency_key,
        notification.status,
        notification.attempts,
        notification.last_error,
        notification.provider_message_id,
        notification.claim_token,
        notification.claimed_at,
        notification.next_attempt_at,
        notification.created_at,
        notification.accepted_at,
        notification.delivered_at,
        notification.failed_at,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Atomic claim.
   *
   * `for update skip locked` inside an `update ... returning`, not on its own.
   * On its own — which is what `PgOutbox`, `PgIngress` and `PgDeliveryStore`
   * did before this change — the statement runs in its own implicit
   * transaction, so the row locks are released the instant it returns and two
   * workers polling together both receive the same rows. Measured: two pools
   * claiming five due rows each returned five rows each, all five shared
   * (blocker B-22).
   *
   * Wrapping the select in an update makes the visible effect of the claim
   * durable: the row leaves `pending`, so the second worker's identical
   * statement finds nothing. `next_attempt_at` doubles as the lease expiry, so
   * an abandoned claim becomes visible again by the same clock that schedules
   * retries rather than by a second timer that can disagree with the first.
   */
  async claimDue(now: Date, limit: number, leaseMs: number): Promise<ClaimedNotification[]> {
    const result = await this.pool.query<NotificationRow>(
      // The batch is returned in the order it was claimed.
      //
      // Milestone 22: the selection below has always been ordered, but
      // `update ... returning` hands rows back in whatever order it updated
      // them — a heap scan — so the worker processed the batch in storage
      // order while the reference backend processed it in due order. The two
      // agreed only while rows were inserted in the order they came due. The
      // rank is carried out of the selection because the update overwrites
      // `next_attempt_at` with the lease expiry, so the due order cannot be
      // recovered afterwards.
      `with due as (
         select notification_id from notification
         where status = 'pending' and next_attempt_at <= $1
         order by next_attempt_at, created_at, notification_id
         limit $2
         for update skip locked
       ),
       ranked as (
         select d.notification_id as due_id,
                row_number() over (order by n.next_attempt_at, n.created_at, n.notification_id) as due_rank
         from due d join notification n on n.notification_id = d.notification_id
       ),
       claimed as (
         update notification set
           status = 'processing',
           attempts = attempts + 1,
           claim_token = $4,
           claimed_at = $1,
           next_attempt_at = $1::timestamptz + ($3::bigint * interval '1 millisecond')
         from ranked r
         where notification.notification_id = r.due_id
         returning r.due_rank as due_rank, ${COLUMNS}
       )
       select ${COLUMNS} from claimed order by due_rank`,
      [iso(now), limit, String(leaseMs), `pg-${randomUUID()}`],
    );
    return result.rows.map((row) => {
      const notification = toNotification(row);
      // Non-null by construction: the update above set it.
      return { ...notification, claim_token: notification.claim_token as string };
    });
  }

  async reclaimExpired(now: Date, maxAttempts: number, limit: number): Promise<number> {
    const result = await this.pool.query(
      `update notification n set
         status = case when n.attempts >= $3 then 'failed' else 'pending' end,
         claim_token = null,
         claimed_at = null,
         last_error = case when n.attempts >= $3
           then 'attempts_exhausted after abandoned attempt ' || n.attempts
           else 'abandoned attempt ' || n.attempts || ' reclaimed' end,
         failed_at = case when n.attempts >= $3 then $1::timestamptz else null end
       where n.notification_id in (
         select notification_id from notification
         where status = 'processing' and next_attempt_at <= $1
         -- Two keys: with a limit, ordering by next_attempt_at alone is not a
         -- total order over rows abandoned in the same millisecond, so which
         -- claims a recovery run freed was left to the plan (milestone 22).
         order by next_attempt_at, created_at, notification_id
         limit $2
         for update skip locked
       )`,
      [iso(now), limit, maxAttempts],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Every acknowledgement matches on the claim token as well as the id, and on
   * `status = 'processing'`. A worker whose lease expired holds a token that is
   * no longer on the row, so its update matches nothing and returns false —
   * the result of the attempt that replaced it survives. Without the token a
   * late `markDelivered` from a stalled worker would mark a row delivered that
   * a live worker is still sending, and the row would report a success the
   * provider never confirmed.
   */
  async markAccepted(
    notificationId: string,
    token: string,
    providerMessageId: string | null,
    at: Date,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `update notification set status = 'accepted', claim_token = null, claimed_at = null,
         last_error = null, provider_message_id = $3, accepted_at = $4
       where notification_id = $1 and claim_token = $2 and status = 'processing'`,
      [notificationId, token, providerMessageId, iso(at)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markDelivered(
    notificationId: string,
    token: string,
    providerMessageId: string | null,
    at: Date,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `update notification set status = 'delivered', claim_token = null, claimed_at = null,
         last_error = null, provider_message_id = $3,
         accepted_at = coalesce(accepted_at, $4), delivered_at = $4
       where notification_id = $1 and claim_token = $2 and status = 'processing'`,
      [notificationId, token, providerMessageId, iso(at)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markRetrying(
    notificationId: string,
    token: string,
    reason: string,
    nextAttemptAt: Date,
    providerMessageId: string | null,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `update notification set status = 'pending', claim_token = null, claimed_at = null,
         last_error = $3, next_attempt_at = $4,
         provider_message_id = coalesce($5, provider_message_id)
       where notification_id = $1 and claim_token = $2 and status = 'processing'`,
      [notificationId, token, reason, iso(nextAttemptAt), providerMessageId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markFailed(
    notificationId: string,
    token: string,
    reason: string,
    at: Date,
    providerMessageId: string | null,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `update notification set status = 'failed', claim_token = null, claimed_at = null,
         last_error = $3, failed_at = $4,
         provider_message_id = coalesce($5, provider_message_id)
       where notification_id = $1 and claim_token = $2 and status = 'processing'`,
      [notificationId, token, reason, iso(at), providerMessageId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async get(notificationId: string): Promise<Notification | undefined> {
    const result = await this.pool.query<NotificationRow>(
      `select ${COLUMNS} from notification where notification_id = $1`,
      [notificationId],
    );
    const row = result.rows[0];
    return row ? toNotification(row) : undefined;
  }

  async forEvent(eventId: string): Promise<Notification[]> {
    const result = await this.pool.query<NotificationRow>(
      `select ${COLUMNS} from notification where event_id = $1 order by created_at, notification_id`,
      [eventId],
    );
    return result.rows.map(toNotification);
  }

  async byStatus(
    status: NotificationStatus,
    organizationId?: string | null,
  ): Promise<Notification[]> {
    if (organizationId === undefined) {
      const all = await this.pool.query<NotificationRow>(
        `select ${COLUMNS} from notification where status = $1 order by created_at, notification_id`,
        [status],
      );
      return all.rows.map(toNotification);
    }
    const result = await this.pool.query<NotificationRow>(
      `select ${COLUMNS} from notification
       where status = $1 and organization_id is not distinct from $2
       order by created_at, notification_id`,
      [status, organizationId],
    );
    return result.rows.map(toNotification);
  }

  async list(
    filter: { organization_id?: string | null; status?: NotificationStatus; limit?: number } = {},
  ): Promise<Notification[]> {
    const result = await this.pool.query<NotificationRow>(
      `select ${COLUMNS} from notification
       where ($1::boolean or organization_id is not distinct from $2)
         and ($3::text is null or status = $3)
       -- Total, and with a limit that matters: newest first, then by id, so a
       -- page is not decided by the plan when two rows share a timestamp.
       order by created_at desc, notification_id desc
       limit $4`,
      [
        filter.organization_id === undefined,
        filter.organization_id ?? null,
        filter.status ?? null,
        filter.limit ?? 100,
      ],
    );
    return result.rows.map(toNotification);
  }

  async counts(organizationId?: string | null): Promise<Record<string, number>> {
    const result = await this.pool.query<{ status: NotificationStatus; retrying: string; total: string }>(
      `select status,
              count(*) as total,
              count(*) filter (where status = 'pending' and attempts > 0) as retrying
       from notification
       where ($1::boolean or organization_id is not distinct from $2)
       group by status`,
      [organizationId === undefined, organizationId ?? null],
    );
    const counts: Record<string, number> = {
      pending: 0,
      processing: 0,
      accepted: 0,
      delivered: 0,
      failed: 0,
      retrying: 0,
    };
    for (const row of result.rows) {
      counts[row.status] = Number(row.total);
      counts["retrying"] = (counts["retrying"] ?? 0) + Number(row.retrying);
    }
    return counts;
  }
}
