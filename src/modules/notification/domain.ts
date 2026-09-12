/**
 * Notifications: telling a person something CORE already committed.
 *
 * The distinction from `src/platform/eventing/delivery.ts` is the whole reason
 * this module exists. That layer delivers events to systems — a signed HTTP
 * POST to an endpoint MOVE or MARKET operates, whose receiver is expected to
 * parse an envelope and deduplicate on `event_id`. A person is not that. A
 * person is reached on a channel (ADR 0016: Telegram is a channel, never an
 * identity), and what reaches them is a rendered message, not an envelope.
 *
 * Three rules this file exists to enforce:
 *
 *  1. A message body is rendered from named event fields. Never from a
 *     serialisation of an internal record: that would publish CORE's storage
 *     shape to a person's phone and make every refactor a visible change.
 *  2. Only events that mean something to a human are notifiable, and the set is
 *     closed. `notifiableTemplate` returns null for everything else.
 *  3. `financial_decision_required` is never rendered as a settlement. It means
 *     CORE does not know what happens to the money (blocker B-20, decisions
 *     D-1…D-6). A message saying "refunded" while that is true would be CORE
 *     inventing an answer nobody has given, on the one channel where the
 *     recipient will believe it.
 */

/** Channels a person can be reached on. */
export type NotificationChannelType = "telegram" | "email" | "phone";

/**
 * Deliberately not `identity-access`'s `ChannelType`.
 *
 * That type answers "how did this identity reach us", and includes `web` and
 * `partner_api` — a browser session and an API credential are ways in, with no
 * address to send anything back to. Importing it here would also cross a
 * module boundary (ADR 0017). The overlap is the three channels that can carry
 * an outbound message, and `RECEIVABLE_CHANNELS` is asserted against identity's
 * list in the tests so a divergence is caught rather than assumed away.
 */
export const RECEIVABLE_CHANNELS: readonly NotificationChannelType[] = [
  "telegram",
  "email",
  "phone",
];

export const isReceivableChannel = (value: string): value is NotificationChannelType =>
  (RECEIVABLE_CHANNELS as readonly string[]).includes(value);

/**
 * Who gets told what. Configuration, not policy inside code.
 *
 * `organization_id` null means platform-wide: every event of this type,
 * whichever tenant produced it. That is how an operations team is configured.
 * Set means one tenant only.
 *
 * There is no per-customer routing here, and its absence is a recorded external
 * dependency (D-7), not an oversight: CORE holds an opaque
 * `market_order_reference` for a fulfillment and no identity for the person who
 * placed the order. MARKET owns that mapping. Guessing it would send a
 * stranger's order status to whoever CORE happened to have on file.
 */
export interface NotificationRecipient {
  recipient_id: string;
  organization_id: string | null;
  event_type: string;
  identity_id: string;
  channel: NotificationChannelType;
  active: boolean;
  created_at: string;
}

/**
 * Delivery state of one message to one recipient.
 *
 *  pending    — queued, or waiting out a backoff before the next attempt.
 *  processing — a worker holds a lease on it right now.
 *  accepted   — the channel took it and did not confirm it arrived.
 *  delivered  — the channel confirmed it arrived.
 *  failed     — terminal: rejected outright, or out of attempts.
 *
 * `accepted` and `delivered` are separate because most providers only offer the
 * first. Collapsing them would make CORE report a delivery it was never told
 * about — the exact claim an operator would rely on when a customer says they
 * received nothing. A provider that later confirms arrival can move a row from
 * `accepted` to `delivered`; CORE has no provider callback path today, so that
 * transition is not reachable yet and is recorded as dependency D-8 rather than
 * faked by a timer.
 *
 * There is no separate `retrying` status. A retrying notification is `pending`
 * with `attempts > 0`, because a status that only differs by "has been tried"
 * duplicates a counter that is already there — and two sources for one fact
 * eventually disagree. The read model derives it; see `notificationView`.
 */
export type NotificationStatus = "pending" | "processing" | "accepted" | "delivered" | "failed";

export const TERMINAL_STATUSES: readonly NotificationStatus[] = ["delivered", "failed"];

export interface Notification {
  notification_id: string;
  event_id: string;
  recipient_id: string;
  organization_id: string | null;
  channel: NotificationChannelType;
  /**
   * Frozen at fan-out. See migration 0012 for why it is not re-resolved, and
   * why it is null only on a notification that was born `failed` because the
   * recipient had no verified link left on that channel.
   */
  address: string | null;
  template: NotificationTemplate;
  subject: string | null;
  body: string;
  /** Named event facts, for a channel adapter that renders its own layout. */
  data: Record<string, string | number | boolean>;
  idempotency_key: string;
  status: NotificationStatus;
  attempts: number;
  last_error: string | null;
  provider_message_id: string | null;
  claim_token: string | null;
  claimed_at: string | null;
  next_attempt_at: string;
  created_at: string;
  accepted_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
}

/** Closed set. Adding one is a code change with a test, by design. */
export type NotificationTemplate =
  | "fulfillment_dispatched"
  | "fulfillment_completed"
  | "fulfillment_failed"
  | "fulfillment_cancelled"
  | "subscription_past_due";

/**
 * The message as a channel adapter receives it.
 *
 * A published contract (contracts/notifications/notification-message.v1.schema.json)
 * rather than "whatever the row happens to hold", so that replacing a fake
 * adapter with a real provider is an adapter change and nothing else.
 */
export interface NotificationMessage {
  notification_id: string;
  channel: NotificationChannelType;
  address: string;
  template: NotificationTemplate;
  subject: string | null;
  body: string;
  data: Record<string, string | number | boolean>;
  /**
   * Stable across every attempt of this notification. Handed to the provider so
   * that a provider which honours idempotency keys collapses a repeat CORE was
   * forced into by a crash. CORE does not assume any provider does.
   */
  idempotency_key: string;
  /** 1 for the first attempt. Lets an adapter log, not decide.  */
  attempt: number;
}

/** What a notification looks like to an operator, with `retrying` derived. */
export interface NotificationView extends Omit<Notification, "claim_token"> {
  /** `pending` with attempts already spent. Derived, never stored. */
  retrying: boolean;
}

export function notificationView(notification: Notification): NotificationView {
  const { claim_token: _token, ...rest } = notification;
  return { ...rest, retrying: notification.status === "pending" && notification.attempts > 0 };
}

// ───────────────────────────── rendering ─────────────────────────────

/** Event payload fields this module reads. Nothing else is touched. */
interface KnownPayload {
  fulfillment_id?: unknown;
  order_reference?: unknown;
  organization_id?: unknown;
  outcome?: unknown;
  reason?: unknown;
  settlement_state?: unknown;
  financial_decision_required?: unknown;
  subscription_id?: unknown;
  owner_type?: unknown;
  owner_id?: unknown;
  period_id?: unknown;
  currency?: unknown;
  amount_minor?: unknown;
}

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/**
 * Which template an event maps to, or null when nobody should be messaged.
 *
 * The set is small on purpose. `core.payment.captured`, `core.money.credited`
 * and the rest are ledger facts a person did not ask to hear about, and a
 * notification for every emitted event is how a channel becomes noise that
 * recipients mute — after which the one that mattered is also muted.
 *
 * `core.fulfillment.completed` carries `outcome`, so one event type maps to two
 * templates: work that finished and work that failed are not the same message.
 */
export function notifiableTemplate(
  eventType: string,
  payload: Record<string, unknown>,
): NotificationTemplate | null {
  const known = payload as KnownPayload;
  switch (eventType) {
    case "core.fulfillment.dispatched":
      return "fulfillment_dispatched";
    case "core.fulfillment.completed":
      return known.outcome === "failed" ? "fulfillment_failed" : "fulfillment_completed";
    case "core.fulfillment.cancelled":
      return "fulfillment_cancelled";
    case "core.subscription.past_due":
      return "subscription_past_due";
    default:
      return null;
  }
}

/**
 * The tenant an event belongs to, or null when CORE cannot say from the payload
 * alone.
 *
 * Explicit and payload-only. The alternative — loading the fulfillment to find
 * its organization — would reach into another module's storage (ADR 0017) and
 * would make a notification's tenant depend on state that may have changed
 * since the event was committed.
 *
 * A null scope is not an error: it means only platform-wide recipients match.
 */
/**
 * Event types whose payload actually names a tenant.
 *
 * Every notifiable event now does. This list used to exclude the three
 * fulfillment lifecycle events, and the exclusion was not a preference: their
 * payloads carried the fulfillment, the order reference and the settlement
 * facts and no organization, so a recipient scoped to one tenant could never
 * match a dispatch or a closure. `NotificationRecipientRegistry` refused such a
 * registration rather than accept it and quietly notify nobody — a loud refusal
 * standing in for the missing field.
 *
 * The field now exists. `core.fulfillment.dispatched`, `.completed` and
 * `.cancelled` state `organization_id`, published in their v1 schemas, so the
 * refusal has nothing left to protect against and closure notifications can be
 * scoped to a tenant like every other kind (blocker B-23, resolved).
 *
 * The list is still an explicit list rather than "assume every event has one".
 * A future event type that omits the field would then be silently mis-scoped,
 * which is exactly the failure this list was created to make impossible; being
 * added here is a decision somebody makes once, per event type.
 */
export const TENANT_SCOPED_EVENT_TYPES: readonly string[] = [
  "core.fulfillment.created",
  "core.fulfillment.dispatched",
  "core.fulfillment.completed",
  "core.fulfillment.cancelled",
  "core.subscription.created",
  "core.subscription.renewed",
  "core.subscription.past_due",
  "core.subscription.cancelled",
  "core.subscription.expired",
  "core.subscription.period_settled",
];

export const carriesTenantScope = (eventType: string): boolean =>
  TENANT_SCOPED_EVENT_TYPES.includes(eventType);

export function organizationScope(payload: Record<string, unknown>): string | null {
  const known = payload as KnownPayload;
  const direct = str(known.organization_id);
  if (direct) return direct;
  // Subscriptions name their owner rather than an organization, because a
  // subscription can be owned by an identity.
  if (known.owner_type === "organization") return str(known.owner_id);
  return null;
}

export interface RenderedMessage {
  template: NotificationTemplate;
  subject: string;
  body: string;
  data: Record<string, string | number | boolean>;
}

/**
 * Renders the message.
 *
 * Every field read is named. Every string is written here rather than composed
 * from whatever the payload contains, so a new payload field cannot leak into a
 * person's inbox without somebody deciding it should.
 *
 * The financial wording is the sensitive part. Three cases, and the difference
 * between them is the difference between a fact and a guess:
 *
 *  - `financial_decision_required: true` — CORE holds money whose fate nobody
 *    has decided (D-1…D-6). The message says a review is open and says nothing
 *    about a refund. `decision_required` is not `settled`.
 *  - a settlement state CORE recognises — reported in CORE's own vocabulary,
 *    because `released` genuinely means no money moved and `captured` genuinely
 *    means it did.
 *  - anything else, including an absent state — no money sentence at all.
 *    Silence is the only honest option when CORE does not know.
 */
export function renderMessage(
  eventType: string,
  payload: Record<string, unknown>,
): RenderedMessage | null {
  const template = notifiableTemplate(eventType, payload);
  if (!template) return null;
  const known = payload as KnownPayload;
  const reference = str(known.order_reference) ?? str(known.fulfillment_id) ?? "";
  const data: Record<string, string | number | boolean> = {};
  if (reference) data.reference = reference;

  switch (template) {
    case "fulfillment_dispatched":
      return {
        template,
        subject: "Your request is on its way",
        body: `Request ${reference} has been assigned and is now in progress.`,
        data,
      };
    case "fulfillment_completed":
      return {
        template,
        subject: "Your request is complete",
        body: `Request ${reference} has been completed.${moneySentence(known, data)}`,
        data,
      };
    case "fulfillment_failed":
      return {
        template,
        subject: "Your request could not be completed",
        body:
          `Request ${reference} could not be completed` +
          `${reasonClause(known, data)}.${moneySentence(known, data)}`,
        data,
      };
    case "fulfillment_cancelled":
      return {
        template,
        subject: "Your request was cancelled",
        body:
          `Request ${reference} was cancelled` +
          `${reasonClause(known, data)}.${moneySentence(known, data)}`,
        data,
      };
    case "subscription_past_due": {
      const subscription = str(known.subscription_id) ?? "";
      if (subscription) data.subscription_id = subscription;
      const period = str(known.period_id);
      if (period) data.period_id = period;
      const currency = str(known.currency);
      const amount = typeof known.amount_minor === "number" ? known.amount_minor : null;
      // The amount is stated in minor units with its currency, exactly as the
      // ledger holds it. No division, no formatting guess: CORE does not know
      // the recipient's locale, and a wrong decimal point in a payment demand
      // is worse than an unglamorous number.
      if (currency) data.currency = currency;
      if (amount !== null) data.amount_minor = amount;
      const owed = currency && amount !== null ? ` Amount due: ${amount} ${currency} (minor units).` : "";
      const reason = str(known.reason);
      if (reason) data.reason = reason;
      return {
        template,
        subject: "Payment for your subscription did not go through",
        body:
          `Subscription ${subscription} is past due and access may be limited until it is paid.` +
          owed,
        data,
      };
    }
  }
}

function reasonClause(payload: KnownPayload, data: Record<string, string | number | boolean>): string {
  const reason = str(payload.reason);
  if (!reason) return "";
  data.reason = reason;
  // The code, not a prose translation of it. A closure reason is an operational
  // identifier that support can look up; rewriting it into friendly language
  // here would produce two vocabularies for one fact.
  return ` (reason: ${reason})`;
}

/**
 * The money sentence, or nothing.
 *
 * Never says refunded, never says settled, never says an amount moved, unless
 * CORE's own `settlement_state` says so. See `renderMessage` for why.
 */
function moneySentence(
  payload: KnownPayload,
  data: Record<string, string | number | boolean>,
): string {
  const decisionRequired = payload.financial_decision_required === true;
  const state = str(payload.settlement_state);
  if (state) data.settlement_state = state;
  data.financial_decision_required = decisionRequired;
  if (decisionRequired) {
    // Deliberately not "you will be refunded". CORE does not know that, and
    // this module is not where it gets decided (B-20 / D-1…D-6).
    return " A payment amount is held pending review; no refund or charge has been decided yet.";
  }
  switch (state) {
    case "released":
      return " No payment was taken.";
    case "captured":
      return " The authorised payment was charged.";
    default:
      // `none`, `unsettled`, `partially_captured` without a decision, an
      // unrecognised value, or nothing at all: no claim.
      return "";
  }
}
