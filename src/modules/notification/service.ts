import type { Clock } from "../../platform/clock.js";
import type { AuditLog } from "../../platform/audit/audit.js";
import type { EventEnvelope } from "../../platform/eventing/envelope.js";
import { invalid, notFound } from "../../platform/errors.js";
import { assertId } from "../../platform/ids.js";
import { NO_SCOPE, type TransactionScope } from "../../platform/persistence/transaction.js";
import {
  carriesTenantScope,
  isReceivableChannel,
  notificationView,
  organizationScope,
  renderMessage,
  type Notification,
  type NotificationChannelType,
  type NotificationMessage,
  type NotificationRecipient,
  type NotificationStatus,
  type NotificationView,
} from "./domain.js";
import type { ChannelDirectory, NotificationChannel } from "./ports.js";
import type { NotificationStore } from "./repository.js";

// ───────────────────────────── recipient configuration ─────────────────────────────

export interface RegisterRecipientInput {
  /** null registers a platform-wide recipient: every tenant's events. */
  organization_id: string | null;
  event_type: string;
  identity_id: string;
  channel: string;
  correlation_id: string;
}

/**
 * Who is notified about what.
 *
 * Configuration rather than code, so that "operations is told about failed
 * fulfillments on Telegram" can change without a deploy and without an address
 * ever appearing in the repository.
 */
export class NotificationRecipientRegistry {
  constructor(
    private readonly store: NotificationStore,
    private readonly directory: ChannelDirectory,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {}

  async register(input: RegisterRecipientInput): Promise<NotificationRecipient> {
    if (!input.event_type.startsWith("core.")) {
      // Same rule as `SubscriptionRegistry`: CORE may only be asked to relay
      // what CORE produced. A recipient for `move.*` would turn configuration
      // into a way of reading another system's inbound traffic.
      throw invalid("only core.* events can be notified on");
    }
    if (!isReceivableChannel(input.channel)) {
      throw invalid("channel must be one of telegram, email, phone");
    }
    assertId("identity_id", input.identity_id);
    if (input.organization_id !== null) {
      assertId("organization_id", input.organization_id);
      // Refused at configuration time rather than at fan-out time. A tenant
      // scope on an event that does not name its tenant is a recipient that
      // matches nothing, for ever, with no error anywhere — the failure mode
      // that gets discovered by a customer, not by an operator. See
      // TENANT_SCOPED_EVENT_TYPES and blocker B-23.
      if (!carriesTenantScope(input.event_type)) {
        throw invalid(
          `${input.event_type} does not carry an organization, so it cannot be scoped to one; ` +
            `register a platform-wide recipient (organization_id: null) instead`,
        );
      }
    }

    // Refused rather than stored: a recipient CORE has no verified way to reach
    // would look configured, produce a `failed` notification for every matching
    // event, and be discovered only when somebody asks why nobody was told. An
    // unverified link is also not somewhere CORE may send anything — nobody has
    // checked that the address belongs to that identity.
    const address = await this.directory.verifiedAddress(input.identity_id, input.channel);
    if (!address) {
      throw invalid(`identity has no verified ${input.channel} link`);
    }

    const existing = await this.store.findRecipient(
      input.organization_id,
      input.event_type,
      input.identity_id,
      input.channel,
    );
    if (existing) {
      // Idempotent in the only safe sense: the same registration returns the
      // same recipient. Reactivating a deactivated one here would silently undo
      // somebody's decision to stop notifying this person.
      return existing;
    }

    const recipient: NotificationRecipient = {
      recipient_id: this.newId(),
      organization_id: input.organization_id,
      event_type: input.event_type,
      identity_id: input.identity_id,
      channel: input.channel,
      active: true,
      created_at: this.clock.now().toISOString(),
    };
    await this.store.insertRecipient(recipient);
    await this.audit.record({
      actor_type: "system",
      actor_id: null,
      action: "notification.recipient.registered",
      entity_type: "notification_recipient",
      entity_id: recipient.recipient_id,
      correlation_id: input.correlation_id,
      // No address. The audit trail records that a channel was configured for
      // an identity, which is the decision; the address itself is personal data
      // that belongs on the link and nowhere else.
      metadata: {
        organization_id: recipient.organization_id,
        event_type: recipient.event_type,
        identity_id: recipient.identity_id,
        channel: recipient.channel,
      },
    });
    return recipient;
  }

  async list(organizationId?: string | null): Promise<NotificationRecipient[]> {
    return await this.store.listRecipients(organizationId);
  }

  async setActive(recipientId: string, active: boolean, correlationId: string): Promise<NotificationRecipient> {
    const existing = await this.store.getRecipient(recipientId);
    if (!existing) throw notFound("notification recipient not found");
    await this.store.setRecipientActive(recipientId, active);
    await this.audit.record({
      actor_type: "system",
      actor_id: null,
      action: active ? "notification.recipient.activated" : "notification.recipient.deactivated",
      entity_type: "notification_recipient",
      entity_id: recipientId,
      correlation_id: correlationId,
      metadata: { event_type: existing.event_type, channel: existing.channel },
    });
    return { ...existing, active };
  }
}

// ───────────────────────────── fan-out ─────────────────────────────

export interface NotificationFanOutResult {
  queued: number;
  already_queued: number;
  unroutable: number;
}

/**
 * Turns one published event into one notification per configured recipient.
 *
 * Runs on the caller's scope, so queueing the notifications and marking the
 * outbox row published commit together. This is the point the whole module
 * hangs on:
 *
 *  - No notification can exist for state that rolled back, because the rows are
 *    written in the transaction that publishes the event, and that event was
 *    itself written in the transaction that changed the state.
 *  - No committed state can lose its notification, because if the fan-out or
 *    the commit fails the outbox row stays pending and the relay tries again.
 *  - A repeated relay costs nothing: (event_id, recipient_id) is unique, so the
 *    second attempt queues nothing rather than messaging somebody twice.
 *
 * Nothing here talks to a provider. Sending inside this transaction would put a
 * third-party network call on the path of a database commit — the transaction
 * would be held open across a timeout, and a message that was already sent
 * could still be rolled back. The outbox is the commit point; the channel is
 * somebody else's problem, later, in `NotificationDispatcher`.
 */
export class NotificationFanOut {
  constructor(
    private readonly store: NotificationStore,
    private readonly directory: ChannelDirectory,
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {}

  async queueFor(
    event: EventEnvelope,
    scope: TransactionScope = NO_SCOPE,
  ): Promise<NotificationFanOutResult> {
    const result: NotificationFanOutResult = { queued: 0, already_queued: 0, unroutable: 0 };
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    // Rendered first: most events are not notifiable, and an event nobody is
    // messaged about should not cost a recipient lookup on every relay.
    const rendered = renderMessage(event.event_type, payload);
    if (!rendered) return result;

    const organizationId = organizationScope(payload);
    const recipients = await this.store.recipientsFor(event.event_type, organizationId);
    const now = this.clock.now().toISOString();

    for (const recipient of recipients) {
      const address = await this.directory.verifiedAddress(recipient.identity_id, recipient.channel);
      const unroutable = address === null;
      const queued = await this.store.queue(
        {
          notification_id: this.newId(),
          event_id: event.event_id,
          recipient_id: recipient.recipient_id,
          organization_id: organizationId,
          channel: recipient.channel,
          address,
          template: rendered.template,
          subject: rendered.subject,
          body: rendered.body,
          data: rendered.data,
          // (event, recipient) and nothing else. Stable across attempts,
          // reproducible from the row, and derived from the two facts that
          // define the message rather than from a clock or a counter — either
          // of which would produce a new key on a retry and defeat the point.
          idempotency_key: `${event.event_id}:${recipient.recipient_id}`,
          status: unroutable ? "failed" : "pending",
          attempts: 0,
          last_error: unroutable ? `no verified ${recipient.channel} link for recipient` : null,
          provider_message_id: null,
          claim_token: null,
          claimed_at: null,
          next_attempt_at: now,
          created_at: now,
          accepted_at: null,
          delivered_at: null,
          failed_at: unroutable ? now : null,
        },
        scope,
      );
      if (!queued) result.already_queued += 1;
      else if (unroutable) result.unroutable += 1;
      else result.queued += 1;
    }
    return result;
  }
}

// ───────────────────────────── dispatcher ─────────────────────────────

export interface DispatchResult {
  accepted: number;
  delivered: number;
  retrying: number;
  failed: number;
  /** Rows whose lease expired and were returned to the queue this run. */
  reclaimed: number;
  /** Acknowledgements rejected because the claim had already been taken away. */
  fenced: number;
}

const MAX_ERROR_LENGTH = 500;
const SECRETISH = /(?:authorization|token|secret|password|api[_-]?key)\s*[=:]\s*\S+/gi;
/** `Authorization: Bearer <token>` has no delimiter after the scheme. */
const BEARER = /bearer\s+\S+/gi;

/**
 * What a channel error is allowed to leave behind.
 *
 * Provider errors routinely quote the request, which means they quote the
 * credential and the recipient's address. `last_error` is read by operators and
 * copied into tickets, so the address is replaced with a marker (it is already
 * on the row, in the column that is supposed to hold it) and anything shaped
 * like a credential is redacted. Truncated because an operator needs the first
 * line, not a provider's stack trace.
 */
export function sanitiseChannelError(reason: string, address: string | null): string {
  let text = reason
    .replace(BEARER, "Bearer [redacted]")
    .replace(SECRETISH, (match) => `${match.split(/[=:]/)[0]}=[redacted]`);
  if (address) text = text.split(address).join("[address]");
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
}

/**
 * Drains due notifications over their channels.
 *
 * A sibling of `OutboxPublisher`, `InboundDispatcher` and `DeliveryWorker`, with
 * one difference that matters: it claims by writing, not by reading. See
 * `NotificationStore` and blocker B-22.
 *
 * The delivery semantics CORE can actually offer, stated rather than implied:
 *
 *  - **At most one attempt in flight.** The claim leases the row and fences its
 *    acknowledgement with a token, so two workers cannot send the same message
 *    concurrently, and a stalled worker cannot report a result after its work
 *    was taken over.
 *  - **At least once overall.** A crash between a provider accepting a message
 *    and CORE recording that fact leaves the row leased; the lease expires, the
 *    row returns to `pending`, and it is sent again. The alternative — record
 *    first, send after — loses messages instead of repeating them, and for a
 *    notification a repeat is an annoyance while a loss is a failure.
 *  - **Effectively once, when the provider cooperates.** Every attempt carries
 *    the same `idempotency_key`. A provider that honours it collapses the
 *    repeat. CORE does not assume any provider does, does not claim
 *    exactly-once, and models the semantics it has instead (docs/notifications.md).
 */
export class NotificationDispatcher {
  private readonly channels = new Map<NotificationChannelType, NotificationChannel>();

  constructor(
    private readonly store: NotificationStore,
    channels: readonly NotificationChannel[],
    private readonly clock: Clock,
    private readonly maxAttempts = 6,
    private readonly baseBackoffMs = 1000,
    /**
     * How long a claim is honoured before another worker may take the row.
     * Must exceed the slowest channel attempt, or a worker still waiting on a
     * provider will have its row reclaimed and the message sent twice.
     */
    private readonly leaseMs = 30_000,
  ) {
    for (const channel of channels) this.channels.set(channel.channel, channel);
  }

  async drainOnce(limit = 100): Promise<DispatchResult> {
    const result: DispatchResult = {
      accepted: 0,
      delivered: 0,
      retrying: 0,
      failed: 0,
      reclaimed: 0,
      fenced: 0,
    };
    const now = this.clock.now();
    // Recovery first, so a restart picks up what the previous process abandoned
    // before it starts adding work of its own.
    result.reclaimed = await this.store.reclaimExpired(now, this.maxAttempts, limit);
    const claimed = await this.store.claimDue(now, limit, this.leaseMs);

    for (const notification of claimed) {
      const token = notification.claim_token;
      const channel = this.channels.get(notification.channel);
      if (!channel) {
        // Treated as retryable, not permanent: a missing adapter is a
        // deployment state, and the next deploy can fix it. Attempt exhaustion
        // still ends it, so it cannot retry forever.
        await this.retry(notification, token, "channel_adapter_not_configured", null, now, result);
        continue;
      }
      if (notification.address === null) {
        // Should be unreachable: a row without an address is created `failed`
        // and never becomes claimable. Handled rather than asserted, because a
        // dispatcher that throws here would stop draining every other message.
        if (await this.store.markFailed(notification.notification_id, token, "no address on notification", now, null)) {
          result.failed += 1;
        } else result.fenced += 1;
        continue;
      }

      const message: NotificationMessage = {
        notification_id: notification.notification_id,
        channel: notification.channel,
        address: notification.address,
        template: notification.template,
        subject: notification.subject,
        body: notification.body,
        data: notification.data,
        idempotency_key: notification.idempotency_key,
        // `attempts` was already incremented by the claim, so this is the
        // number of this attempt.
        attempt: notification.attempts,
      };

      let outcome;
      try {
        outcome = await channel.send(message);
      } catch (err) {
        // An adapter that throws has told us nothing about the message. Unknown
        // is not the same as refused, so it is retryable.
        const reason = sanitiseChannelError(
          err instanceof Error ? err.message : String(err),
          notification.address,
        );
        await this.retry(notification, token, `channel_threw: ${reason}`, null, now, result);
        continue;
      }

      const providerId = outcome.provider_message_id ?? null;
      switch (outcome.outcome) {
        case "delivered":
          if (await this.store.markDelivered(notification.notification_id, token, providerId, now)) {
            result.delivered += 1;
          } else result.fenced += 1;
          break;
        case "accepted":
          if (await this.store.markAccepted(notification.notification_id, token, providerId, now)) {
            result.accepted += 1;
          } else result.fenced += 1;
          break;
        case "retryable":
          await this.retry(
            notification,
            token,
            sanitiseChannelError(outcome.reason, notification.address),
            outcome.retry_after_ms ?? null,
            now,
            result,
            providerId,
          );
          break;
        case "permanent":
          // Understood and refused. Repeating identical bytes cannot change the
          // answer, so it stops here and stays visible to an operator.
          if (
            await this.store.markFailed(
              notification.notification_id,
              token,
              `permanent: ${sanitiseChannelError(outcome.reason, notification.address)}`,
              now,
              providerId,
            )
          ) {
            result.failed += 1;
          } else result.fenced += 1;
          break;
      }
    }
    return result;
  }

  /**
   * Schedules the next attempt, or gives up.
   *
   * Exponential from the attempt already spent, unless the provider asked for a
   * specific delay — a `retry_after_ms` is the provider telling us when it will
   * accept traffic again, and ignoring it in favour of our own arithmetic is how
   * a rate limit becomes a longer rate limit.
   */
  private async retry(
    notification: Notification,
    token: string,
    reason: string,
    retryAfterMs: number | null,
    now: Date,
    result: DispatchResult,
    providerId: string | null = null,
  ): Promise<void> {
    if (notification.attempts >= this.maxAttempts) {
      if (
        await this.store.markFailed(
          notification.notification_id,
          token,
          `attempts_exhausted after ${notification.attempts}: ${reason}`,
          now,
          providerId,
        )
      ) {
        result.failed += 1;
      } else result.fenced += 1;
      return;
    }
    const delay = retryAfterMs ?? this.baseBackoffMs * 2 ** (notification.attempts - 1);
    if (
      await this.store.markRetrying(
        notification.notification_id,
        token,
        reason,
        new Date(now.getTime() + delay),
        providerId,
      )
    ) {
      result.retrying += 1;
    } else result.fenced += 1;
  }
}

// ───────────────────────────── reads ─────────────────────────────

/**
 * Operator reads.
 *
 * Separate from the registry because configuration and observation are
 * different jobs with different authorisation, and because a status page asking
 * for counts should not be able to register a recipient by accident.
 */
export class NotificationReadService {
  constructor(private readonly store: NotificationStore) {}

  async list(filter: {
    organization_id?: string | null;
    status?: NotificationStatus;
    limit?: number;
  }): Promise<NotificationView[]> {
    return (await this.store.list(filter)).map(notificationView);
  }

  async get(notificationId: string): Promise<NotificationView> {
    const row = await this.store.get(notificationId);
    if (!row) throw notFound("notification not found");
    return notificationView(row);
  }

  async forEvent(eventId: string): Promise<NotificationView[]> {
    return (await this.store.forEvent(eventId)).map(notificationView);
  }

  /** pending / processing / accepted / delivered / failed, plus derived retrying. */
  async counts(organizationId?: string | null): Promise<Record<string, number>> {
    return await this.store.counts(organizationId);
  }
}
