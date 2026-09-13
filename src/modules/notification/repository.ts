import {
  journalMapWrite,
  NO_SCOPE,
  type TransactionScope,
} from "../../platform/persistence/transaction.js";
import type {
  Notification,
  NotificationRecipient,
  NotificationStatus,
} from "./domain.js";
import { putRow } from "../../platform/persistence/row-rules.js";

/** Result of one claim: the row as the worker now owns it, with its token. */
export interface ClaimedNotification extends Notification {
  claim_token: string;
}

/**
 * Storage for notifications.
 *
 * The claim/acknowledge shape is the part that matters, and it is not the shape
 * `DeliveryStore` uses. `DeliveryStore.claimDue` only *reads* due rows, so two
 * workers polling together both get the same rows and both send — for a webhook
 * that is a duplicate POST, for a channel it is the same SMS twice. Recorded as
 * blocker B-22 and fixed for the existing workers in the same change.
 *
 * Here a claim is a write:
 *
 *  1. `claimDue` flips the row to `processing`, stamps a fresh `claim_token`,
 *     increments `attempts` and pushes `next_attempt_at` out by the lease. A
 *     second worker running the identical statement sees no rows.
 *  2. Every acknowledgement carries that token and matches on it. A worker that
 *     stalled past its lease, and whose row was reclaimed and retried, holds a
 *     stale token: its late `markDelivered` matches nothing and is dropped
 *     instead of overwriting the newer attempt's result. That is the fence.
 *  3. `attempts` is incremented at claim time, not at acknowledgement. A worker
 *     that dies mid-attempt has still spent one, so a process that crashes on
 *     every attempt cannot loop forever.
 */
export interface NotificationStore {
  insertRecipient(recipient: NotificationRecipient, scope?: TransactionScope): Promise<void>;
  getRecipient(recipientId: string): Promise<NotificationRecipient | undefined>;
  findRecipient(
    organizationId: string | null,
    eventType: string,
    identityId: string,
    channel: string,
  ): Promise<NotificationRecipient | undefined>;
  /**
   * Active recipients for this event type: the platform-wide ones plus the ones
   * scoped to this tenant. The fan-out list.
   */
  recipientsFor(eventType: string, organizationId: string | null): Promise<NotificationRecipient[]>;
  listRecipients(organizationId?: string | null): Promise<NotificationRecipient[]>;
  setRecipientActive(recipientId: string, active: boolean): Promise<void>;

  /**
   * Queues one notification. Returns false when this (event, recipient) pair is
   * already queued — which is what makes re-running the fan-out free, and what
   * turns a redelivered outbox event into no extra message.
   */
  queue(notification: Notification, scope?: TransactionScope): Promise<boolean>;

  /** Atomically leases up to `limit` due rows. See the interface note. */
  claimDue(now: Date, limit: number, leaseMs: number): Promise<ClaimedNotification[]>;

  /**
   * Returns rows whose lease expired to `pending`, or to `failed` when they are
   * out of attempts. This is crash recovery: a worker that died holding a claim
   * leaves a `processing` row nobody will ever acknowledge.
   */
  reclaimExpired(now: Date, maxAttempts: number, limit: number): Promise<number>;

  /** All four acknowledgements are token-fenced and return false when fenced. */
  markAccepted(
    notificationId: string,
    token: string,
    providerMessageId: string | null,
    at: Date,
  ): Promise<boolean>;
  markDelivered(
    notificationId: string,
    token: string,
    providerMessageId: string | null,
    at: Date,
  ): Promise<boolean>;
  markRetrying(
    notificationId: string,
    token: string,
    reason: string,
    nextAttemptAt: Date,
    providerMessageId: string | null,
  ): Promise<boolean>;
  markFailed(
    notificationId: string,
    token: string,
    reason: string,
    at: Date,
    providerMessageId: string | null,
  ): Promise<boolean>;

  get(notificationId: string): Promise<Notification | undefined>;
  forEvent(eventId: string): Promise<Notification[]>;
  byStatus(status: NotificationStatus, organizationId?: string | null): Promise<Notification[]>;
  list(filter?: {
    organization_id?: string | null;
    status?: NotificationStatus;
    limit?: number;
  }): Promise<Notification[]>;
  counts(organizationId?: string | null): Promise<Record<string, number>>;
}

/**
 * Reference backend.
 *
 * Every mutation here is synchronous from read to write, with no `await` in
 * between, for the reason recorded on `InMemoryMoneyRepository`: an await is a
 * yield point, and a yield point between a check and a write is a race the
 * Postgres backend would not have. A memory backend that is more permissive
 * than production certifies bugs (B-12).
 */
export class InMemoryNotificationStore implements NotificationStore {
  private recipients = new Map<string, NotificationRecipient>();
  private notifications = new Map<string, Notification>();
  private tokens = 0;

  async insertRecipient(
    recipient: NotificationRecipient,
    scope: TransactionScope = NO_SCOPE,
  ): Promise<void> {
    for (const existing of this.recipients.values()) {
      if (
        existing.organization_id === recipient.organization_id &&
        existing.event_type === recipient.event_type &&
        existing.identity_id === recipient.identity_id &&
        existing.channel === recipient.channel &&
        existing.recipient_id !== recipient.recipient_id
      ) {
        throw new Error(
          'duplicate key value violates unique constraint "notification_recipient_organization_id_event_type_identity_id_channel_key"',
        );
      }
    }
    journalMapWrite(scope, this.recipients, recipient.recipient_id);
    putRow("notification_recipient", this.recipients, recipient.recipient_id, recipient);
  }

  async getRecipient(recipientId: string): Promise<NotificationRecipient | undefined> {
    return this.recipients.get(recipientId);
  }

  async findRecipient(
    organizationId: string | null,
    eventType: string,
    identityId: string,
    channel: string,
  ): Promise<NotificationRecipient | undefined> {
    return [...this.recipients.values()].find(
      (r) =>
        r.organization_id === organizationId &&
        r.event_type === eventType &&
        r.identity_id === identityId &&
        r.channel === channel,
    );
  }

  async recipientsFor(
    eventType: string,
    organizationId: string | null,
  ): Promise<NotificationRecipient[]> {
    return [...this.recipients.values()].filter(
      (r) =>
        r.active &&
        r.event_type === eventType &&
        // Platform-wide recipients match every tenant; scoped ones only their
        // own. An event with no tenant scope reaches the platform-wide list
        // only, which is why `organizationScope` returning null is not silent
        // data loss but a narrower audience.
        (r.organization_id === null || r.organization_id === organizationId),
    );
  }

  async listRecipients(organizationId?: string | null): Promise<NotificationRecipient[]> {
    const all = [...this.recipients.values()];
    return organizationId === undefined
      ? all
      : all.filter((r) => r.organization_id === organizationId);
  }

  async setRecipientActive(recipientId: string, active: boolean): Promise<void> {
    const existing = this.recipients.get(recipientId);
    if (!existing) return;
    putRow("notification_recipient", this.recipients, recipientId, { ...existing, active });
  }

  async queue(notification: Notification, scope: TransactionScope = NO_SCOPE): Promise<boolean> {
    // Two rules, two outcomes, because Postgres treats them differently and a
    // reference store that flattened them would hide a real bug.
    //
    // `PgNotificationStore.queue` inserts with `on conflict (event_id,
    // recipient_id) do nothing`, so a repeat of that pair is absorbed and
    // reported as `false` — the relay replaying one event is expected. Nothing
    // absorbs `notification_idempotency_key_key`, so the same key on a
    // different message raises. That case is not a retry: it is two messages
    // claiming one identity, and swallowing it would drop the second silently.
    for (const existing of this.notifications.values()) {
      if (
        existing.event_id === notification.event_id &&
        existing.recipient_id === notification.recipient_id
      ) {
        return false;
      }
    }
    for (const existing of this.notifications.values()) {
      if (existing.idempotency_key === notification.idempotency_key) {
        throw new Error(
          'duplicate key value violates unique constraint "notification_idempotency_key_key"',
        );
      }
    }
    journalMapWrite(scope, this.notifications, notification.notification_id);
    putRow("notification", this.notifications, notification.notification_id, notification);
    return true;
  }

  async claimDue(now: Date, limit: number, leaseMs: number): Promise<ClaimedNotification[]> {
    const due = [...this.notifications.values()]
      .filter((n) => n.status === "pending" && new Date(n.next_attempt_at) <= now)
      .sort((a, b) => a.next_attempt_at.localeCompare(b.next_attempt_at))
      .slice(0, limit);
    const claimed: ClaimedNotification[] = [];
    for (const notification of due) {
      // Written before returning, in the same synchronous stretch as the read.
      // This is the whole difference from `InMemoryDeliveryStore.claimDue`,
      // which hands the same rows to every concurrent caller (B-22).
      const token = `mem-claim-${++this.tokens}`;
      const leased: Notification = {
        ...notification,
        status: "processing",
        attempts: notification.attempts + 1,
        claim_token: token,
        claimed_at: now.toISOString(),
        next_attempt_at: new Date(now.getTime() + leaseMs).toISOString(),
      };
      putRow("notification", this.notifications, notification.notification_id, leased);
      claimed.push({ ...leased, claim_token: token });
    }
    return claimed;
  }

  async reclaimExpired(now: Date, maxAttempts: number, limit: number): Promise<number> {
    const expired = [...this.notifications.values()]
      .filter((n) => n.status === "processing" && new Date(n.next_attempt_at) <= now)
      .slice(0, limit);
    for (const notification of expired) {
      const exhausted = notification.attempts >= maxAttempts;
      putRow("notification", this.notifications, notification.notification_id, {
        ...notification,
        status: exhausted ? "failed" : "pending",
        claim_token: null,
        claimed_at: null,
        last_error: exhausted
          ? `attempts_exhausted after abandoned attempt ${notification.attempts}`
          : `abandoned attempt ${notification.attempts} reclaimed`,
        failed_at: exhausted ? now.toISOString() : null,
      });
    }
    return expired.length;
  }

  /** Token match, or nothing happens. The fence. */
  private fenced(notificationId: string, token: string): Notification | null {
    const existing = this.notifications.get(notificationId);
    if (!existing || existing.status !== "processing" || existing.claim_token !== token) return null;
    return existing;
  }

  async markAccepted(
    notificationId: string,
    token: string,
    providerMessageId: string | null,
    at: Date,
  ): Promise<boolean> {
    const existing = this.fenced(notificationId, token);
    if (!existing) return false;
    putRow("notification", this.notifications, notificationId, {
      ...existing,
      status: "accepted",
      claim_token: null,
      claimed_at: null,
      last_error: null,
      provider_message_id: providerMessageId,
      accepted_at: at.toISOString(),
    });
    return true;
  }

  async markDelivered(
    notificationId: string,
    token: string,
    providerMessageId: string | null,
    at: Date,
  ): Promise<boolean> {
    const existing = this.fenced(notificationId, token);
    if (!existing) return false;
    putRow("notification", this.notifications, notificationId, {
      ...existing,
      status: "delivered",
      claim_token: null,
      claimed_at: null,
      last_error: null,
      provider_message_id: providerMessageId,
      accepted_at: existing.accepted_at ?? at.toISOString(),
      delivered_at: at.toISOString(),
    });
    return true;
  }

  async markRetrying(
    notificationId: string,
    token: string,
    reason: string,
    nextAttemptAt: Date,
    providerMessageId: string | null,
  ): Promise<boolean> {
    const existing = this.fenced(notificationId, token);
    if (!existing) return false;
    putRow("notification", this.notifications, notificationId, {
      ...existing,
      status: "pending",
      claim_token: null,
      claimed_at: null,
      last_error: reason,
      provider_message_id: providerMessageId ?? existing.provider_message_id,
      next_attempt_at: nextAttemptAt.toISOString(),
    });
    return true;
  }

  async markFailed(
    notificationId: string,
    token: string,
    reason: string,
    at: Date,
    providerMessageId: string | null,
  ): Promise<boolean> {
    const existing = this.fenced(notificationId, token);
    if (!existing) return false;
    putRow("notification", this.notifications, notificationId, {
      ...existing,
      status: "failed",
      claim_token: null,
      claimed_at: null,
      last_error: reason,
      provider_message_id: providerMessageId ?? existing.provider_message_id,
      failed_at: at.toISOString(),
    });
    return true;
  }

  async get(notificationId: string): Promise<Notification | undefined> {
    return this.notifications.get(notificationId);
  }

  async forEvent(eventId: string): Promise<Notification[]> {
    return [...this.notifications.values()].filter((n) => n.event_id === eventId);
  }

  async byStatus(
    status: NotificationStatus,
    organizationId?: string | null,
  ): Promise<Notification[]> {
    return [...this.notifications.values()].filter(
      (n) =>
        n.status === status &&
        (organizationId === undefined || n.organization_id === organizationId),
    );
  }

  async list(
    filter: { organization_id?: string | null; status?: NotificationStatus; limit?: number } = {},
  ): Promise<Notification[]> {
    let rows = [...this.notifications.values()];
    if (filter.organization_id !== undefined) {
      rows = rows.filter((n) => n.organization_id === filter.organization_id);
    }
    if (filter.status) rows = rows.filter((n) => n.status === filter.status);
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return rows.slice(0, filter.limit ?? 100);
  }

  async counts(organizationId?: string | null): Promise<Record<string, number>> {
    const rows =
      organizationId === undefined
        ? [...this.notifications.values()]
        : [...this.notifications.values()].filter((n) => n.organization_id === organizationId);
    const counts: Record<string, number> = {
      pending: 0,
      processing: 0,
      accepted: 0,
      delivered: 0,
      failed: 0,
      retrying: 0,
    };
    for (const row of rows) {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
      // Derived, not stored: see `NotificationStatus`.
      if (row.status === "pending" && row.attempts > 0) {
        counts["retrying"] = (counts["retrying"] ?? 0) + 1;
      }
    }
    return counts;
  }
}
