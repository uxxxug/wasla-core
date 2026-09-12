import { createHmac, timingSafeEqual } from "node:crypto";
import type { Clock } from "../clock.js";
import { invalid } from "../errors.js";
import { NO_WORKER_METRICS, type WorkerMetrics } from "../observability/worker-metrics.js";
import { journalMapWrite, NO_SCOPE, type TransactionScope } from "../persistence/transaction.js";
import type { EventEnvelope } from "./envelope.js";
import { tallyByStatus } from "./queue-counts.js";

export interface EventSubscription {
  subscription_id: string;
  subscriber: string;
  event_type: string;
  endpoint_url: string;
  signing_secret: string;
  active: boolean;
  created_at: string;
}

/** What a subscription looks like once it leaves the module. No secret. */
export type PublicSubscription = Omit<EventSubscription, "signing_secret">;

export const redactSubscription = (s: EventSubscription): PublicSubscription => {
  const { signing_secret: _secret, ...rest } = s;
  return rest;
};

export type DeliveryStatus = "pending" | "delivered" | "dead";

export interface EventDelivery {
  delivery_id: string;
  event_id: string;
  subscription_id: string;
  status: DeliveryStatus;
  attempts: number;
  last_error: string | null;
  last_status: number | null;
  next_attempt_at: string;
  created_at: string;
  delivered_at: string | null;
  /**
   * When a worker claimed this delivery, or null when nobody holds it (B-24).
   *
   * While it is null, `next_attempt_at` is a retry schedule; while it is set,
   * `next_attempt_at` is a lease expiry. Without the distinction a delivery held
   * by a worker that died was indistinguishable from one waiting to be retried,
   * so an abandoned claim could not be counted and nothing could answer "which
   * deliveries are stuck".
   */
  claimed_at: string | null;
}

export interface DeliveryStore {
  insertSubscription(subscription: EventSubscription, scope?: TransactionScope): Promise<void>;
  getSubscription(subscriptionId: string): Promise<EventSubscription | undefined>;
  findSubscription(subscriber: string, eventType: string): Promise<EventSubscription | undefined>;
  /** Active subscriptions for this event type. The fan-out list. */
  subscriptionsFor(eventType: string): Promise<EventSubscription[]>;
  listSubscriptions(): Promise<EventSubscription[]>;
  setSubscriptionActive(subscriptionId: string, active: boolean): Promise<void>;

  /**
   * Queues one delivery. Returns false when this (event, subscription) was
   * already queued, which is what makes re-running the fan-out free.
   */
  queue(delivery: EventDelivery, scope?: TransactionScope): Promise<boolean>;
  /** Leases due deliveries so two workers cannot send the same one (B-22). */
  claimDue(now: Date, limit: number, leaseMs?: number): Promise<EventDelivery[]>;
  /**
   * Returns deliveries whose lease ran out to the pending pool and reports how
   * many (B-24). The only thing that frees a delivery abandoned by a dead
   * worker, because `claimDue` refuses claimed rows. Does not touch `attempts`:
   * an abandoned attempt was never observed to fail, and charging it against the
   * retry budget would let a rolling deploy dead-letter healthy deliveries.
   *
   * Nothing here re-sends. A delivery whose worker died mid-request may have
   * reached the subscriber, which is why every CORE webhook carries the event id
   * and subscribers are required to be idempotent (see `docs/outbound-delivery.md`).
   */
  reclaimExpired(now: Date, limit?: number): Promise<number>;
  markDelivered(deliveryId: string, status: number): Promise<void>;
  markFailed(
    deliveryId: string,
    error: string,
    status: number | null,
    nextAttemptAt: Date,
  ): Promise<void>;
  markDead(deliveryId: string, error: string, status: number | null): Promise<void>;
  byStatus(status: DeliveryStatus): Promise<EventDelivery[]>;
  /**
   * Row counts by status, plus `retrying` (pending with an attempt already
   * spent). One aggregate query rather than a list, because the caller is a
   * gauge sampler and fetching every pending row to take its `length` is how a
   * readiness probe becomes a table scan.
   *
   * Also reports `in_flight` and `abandoned`: pending deliveries a worker is
   * holding, split by whether the lease has run out (B-24).
   *
   * All three are derived here, at read time, from the same rows: none is a
   * status any row carries, and none must become a second store competing with
   * the queue for the truth. They are subsets of `pending`, not additions to it.
   */
  counts(): Promise<Record<string, number>>;
  forEvent(eventId: string): Promise<EventDelivery[]>;
  all(): Promise<EventDelivery[]>;
}

export class InMemoryDeliveryStore implements DeliveryStore {
  private subscriptions = new Map<string, EventSubscription>();
  private deliveries = new Map<string, EventDelivery>();

  /**
   * The clock is required, not optional. `counts()` has to cut the claimed rows
   * at a point in time, and `markDelivered` has to stamp one; a store that read
   * the wall clock while the worker beside it read a test clock would report
   * different things than Postgres for the same rows, which is exactly the
   * backend divergence B-12 is about.
   */
  constructor(private readonly clock: Clock) {}

  async insertSubscription(
    subscription: EventSubscription,
    scope: TransactionScope = NO_SCOPE,
  ): Promise<void> {
    // UNIQUE (subscriber, event_type). Synchronous, for the reason recorded on
    // InMemoryMoneyRepository: an await between the check and the write is
    // enough to lose the race (B-12).
    for (const existing of this.subscriptions.values()) {
      if (
        existing.subscriber === subscription.subscriber &&
        existing.event_type === subscription.event_type &&
        existing.subscription_id !== subscription.subscription_id
      ) {
        throw new Error(
          'duplicate key value violates unique constraint "event_subscription_subscriber_event_type_key"',
        );
      }
    }
    journalMapWrite(scope, this.subscriptions, subscription.subscription_id);
    this.subscriptions.set(subscription.subscription_id, subscription);
  }

  async getSubscription(subscriptionId: string): Promise<EventSubscription | undefined> {
    return this.subscriptions.get(subscriptionId);
  }

  async findSubscription(
    subscriber: string,
    eventType: string,
  ): Promise<EventSubscription | undefined> {
    return [...this.subscriptions.values()].find(
      (s) => s.subscriber === subscriber && s.event_type === eventType,
    );
  }

  async subscriptionsFor(eventType: string): Promise<EventSubscription[]> {
    return [...this.subscriptions.values()].filter((s) => s.active && s.event_type === eventType);
  }

  async listSubscriptions(): Promise<EventSubscription[]> {
    return [...this.subscriptions.values()];
  }

  async setSubscriptionActive(subscriptionId: string, active: boolean): Promise<void> {
    const existing = this.subscriptions.get(subscriptionId);
    if (!existing) return;
    this.subscriptions.set(subscriptionId, { ...existing, active });
  }

  async queue(delivery: EventDelivery, scope: TransactionScope = NO_SCOPE): Promise<boolean> {
    // UNIQUE (event_id, subscription_id), checked synchronously.
    for (const existing of this.deliveries.values()) {
      if (
        existing.event_id === delivery.event_id &&
        existing.subscription_id === delivery.subscription_id
      ) {
        return false;
      }
    }
    journalMapWrite(scope, this.deliveries, delivery.delivery_id);
    this.deliveries.set(delivery.delivery_id, delivery);
    return true;
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
    const due = [...this.deliveries.values()]
      .filter((d) => d.status === "pending" && d.claimed_at === null && new Date(d.next_attempt_at) <= now)
      .sort((a, b) => a.next_attempt_at.localeCompare(b.next_attempt_at))
      .slice(0, limit);
    // The claimed rows, not the pre-claim ones: Postgres returns the updated
    // rows and the two backends must not disagree about what a claim returns
    // (B-12).
    const claimed: EventDelivery[] = [];
    for (const delivery of due) {
      const next: EventDelivery = {
        ...delivery,
        next_attempt_at: new Date(now.getTime() + leaseMs).toISOString(),
        claimed_at: now.toISOString(),
      };
      this.deliveries.set(delivery.delivery_id, next);
      claimed.push(next);
    }
    return claimed;
  }

  /** See `DeliveryStore.reclaimExpired`. */
  async reclaimExpired(now: Date, limit = 100): Promise<number> {
    let reclaimed = 0;
    for (const delivery of this.deliveries.values()) {
      if (reclaimed >= limit) break;
      if (delivery.status !== "pending" || delivery.claimed_at === null) continue;
      if (new Date(delivery.next_attempt_at).getTime() > now.getTime()) continue;
      this.deliveries.set(delivery.delivery_id, {
        ...delivery,
        claimed_at: null,
        // Due immediately: it already waited out a whole lease for a worker that
        // never came back.
        next_attempt_at: now.toISOString(),
        last_error: `abandoned claim reclaimed after attempt ${delivery.attempts}`,
      });
      reclaimed += 1;
    }
    return reclaimed;
  }

  async markDelivered(deliveryId: string, status: number): Promise<void> {
    const existing = this.deliveries.get(deliveryId);
    if (!existing) return;
    this.deliveries.set(deliveryId, {
      ...existing,
      status: "delivered",
      attempts: existing.attempts + 1,
      last_error: null,
      last_status: status,
      // The clock, not `next_attempt_at`. Since B-22 put the lease on
      // `next_attempt_at`, reading it here stamped `delivered_at` one whole
      // lease into the future — a delivery that had just succeeded claimed to
      // have been delivered thirty seconds from now, and only on this backend.
      // Postgres always used its clock here (B-12).
      delivered_at: this.clock.now().toISOString(),
      claimed_at: null,
    });
  }

  async markFailed(
    deliveryId: string,
    error: string,
    status: number | null,
    nextAttemptAt: Date,
  ): Promise<void> {
    const existing = this.deliveries.get(deliveryId);
    if (!existing) return;
    this.deliveries.set(deliveryId, {
      ...existing,
      attempts: existing.attempts + 1,
      last_error: error,
      last_status: status,
      next_attempt_at: nextAttemptAt.toISOString(),
      // The claim is over. `next_attempt_at` goes back to meaning a retry
      // schedule, which it can only do once nobody holds the row.
      claimed_at: null,
    });
  }

  async markDead(deliveryId: string, error: string, status: number | null): Promise<void> {
    const existing = this.deliveries.get(deliveryId);
    if (!existing) return;
    this.deliveries.set(deliveryId, {
      ...existing,
      status: "dead",
      attempts: existing.attempts + 1,
      last_error: error,
      last_status: status,
      claimed_at: null,
    });
  }

  async counts(): Promise<Record<string, number>> {
    return tallyByStatus(
      [...this.deliveries.values()],
      ["pending", "delivered", "dead"],
      this.clock.now(),
    );
  }

  async byStatus(status: DeliveryStatus): Promise<EventDelivery[]> {
    return [...this.deliveries.values()].filter((d) => d.status === status);
  }

  async forEvent(eventId: string): Promise<EventDelivery[]> {
    return [...this.deliveries.values()].filter((d) => d.event_id === eventId);
  }

  async all(): Promise<EventDelivery[]> {
    return [...this.deliveries.values()];
  }
}

// ───────────────────────────── transport ─────────────────────────────

export interface TransportRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeout_ms: number;
}

export interface TransportResponse {
  /** HTTP status, or null when no response arrived at all. */
  status: number | null;
  error?: string;
}

/**
 * The only thing in CORE that talks to a network CORE does not own.
 *
 * It is a port so that nothing in the delivery logic imports an HTTP client,
 * and so the tests can exercise timeouts, 5xx and 4xx without a server. The
 * adapter is the only place a real socket is opened.
 */
export interface EventTransport {
  send(request: TransportRequest): Promise<TransportResponse>;
}

export const SIGNATURE_HEADER = "x-wasla-signature";
export const EVENT_ID_HEADER = "x-wasla-event-id";
export const DELIVERY_ATTEMPT_HEADER = "x-wasla-delivery-attempt";

/**
 * HMAC-SHA256 over the exact bytes that will be sent.
 *
 * Over the body, not over selected fields: a receiver that verifies a
 * reconstruction of the payload is verifying its own parse, not what CORE
 * sent. The prefix names the algorithm so it can be rotated without the
 * receiver having to guess.
 */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Provided so a receiver's implementation has a reference to compare against. */
export function verifyBody(secret: string, body: string, signature: string): boolean {
  const expected = Buffer.from(signBody(secret, body));
  const given = Buffer.from(signature);
  // Length check first: timingSafeEqual throws on a length mismatch, and an
  // early return on length leaks nothing an attacker cannot already measure.
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Whether a failed attempt is worth repeating.
 *
 * The distinction matters more than the backoff does. A 5xx, a timeout or a
 * refused connection says the receiver is unwell and will probably recover, so
 * retrying is the whole point. A 400 or a 422 says the receiver understood the
 * request and rejected it — sending the identical bytes again cannot produce a
 * different answer, so retrying only delays someone noticing.
 *
 * 408 and 429 are the exceptions among 4xx: both explicitly ask to be retried.
 */
export function isRetryable(status: number | null): boolean {
  if (status === null) return true; // no response: timeout, DNS, refused
  if (status === 408 || status === 429) return true;
  if (status >= 400 && status < 500) return false;
  return true;
}

export const isSuccess = (status: number | null): boolean =>
  status !== null && status >= 200 && status < 300;

// ───────────────────────────── fan-out ─────────────────────────────

export interface DeliveryFanOutResult {
  queued: number;
  already_queued: number;
}

/**
 * Turns one published event into one delivery row per interested subscriber.
 *
 * Runs on the caller's scope so that queueing the deliveries and marking the
 * outbox row published commit together. If they were two transactions, a crash
 * between them would leave an event marked published that no subscriber will
 * ever be sent — the dual-write problem the outbox exists to prevent, moved
 * one step downstream.
 *
 * Fan-out happens at relay time rather than at emit time, so an endpoint added
 * today is used by the next event rather than by a subscription list captured
 * when the event was written. The consequence is deliberate: a subscription
 * created after an event was relayed does not receive it. Back-filling is a
 * replay operation, and replay is an explicit decision, not a side effect of
 * configuration.
 */
export class DeliveryFanOut {
  constructor(
    private readonly store: DeliveryStore,
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {}

  async queueFor(
    event: EventEnvelope,
    scope: TransactionScope = NO_SCOPE,
  ): Promise<DeliveryFanOutResult> {
    const subscriptions = await this.store.subscriptionsFor(event.event_type);
    const now = this.clock.now().toISOString();
    const result: DeliveryFanOutResult = { queued: 0, already_queued: 0 };
    for (const subscription of subscriptions) {
      const queued = await this.store.queue(
        {
          delivery_id: this.newId(),
          event_id: event.event_id,
          subscription_id: subscription.subscription_id,
          status: "pending",
          attempts: 0,
          last_error: null,
          last_status: null,
          next_attempt_at: now,
          created_at: now,
          delivered_at: null,
          claimed_at: null,
        },
        scope,
      );
      if (queued) result.queued += 1;
      else result.already_queued += 1;
    }
    return result;
  }
}

// ───────────────────────────── worker ─────────────────────────────

export interface DeliveryWorkerResult {
  delivered: number;
  failed: number;
  dead: number;
  /** Deliveries a previous process claimed and never acknowledged (B-24). */
  reclaimed: number;
}

/**
 * Drains due deliveries over the transport.
 *
 * A sibling of `OutboxPublisher` and `InboundDispatcher`, and the same shape
 * for the same reason: the durable row is the source of truth, the attempt is
 * out-of-band, and a crash mid-attempt costs at most a repeat.
 *
 * CORE cannot promise the receiver sees the event once. It can only promise it
 * keeps trying and never silently stops, so delivery is at-least-once and the
 * receiver must deduplicate on `event_id` — which is why that id travels in a
 * header as well as the body.
 */
export class DeliveryWorker {
  constructor(
    private readonly store: DeliveryStore,
    private readonly outbox: { get(eventId: string): Promise<{ event: EventEnvelope } | undefined> },
    private readonly transport: EventTransport,
    private readonly clock: Clock,
    private readonly maxAttempts = 8,
    private readonly baseBackoffMs = 1000,
    private readonly timeoutMs = 5000,
    private readonly metrics: WorkerMetrics = NO_WORKER_METRICS,
  ) {}

  async drainOnce(limit = 100): Promise<DeliveryWorkerResult> {
    const now = this.clock.now();
    const result: DeliveryWorkerResult = { delivered: 0, failed: 0, dead: 0, reclaimed: 0 };
    // Recovery first, so a restart picks up what the previous process abandoned
    // before it starts adding work of its own. This is the only place an expired
    // lease is directly observable for this worker: the delivery was claimed by
    // some process that never acknowledged it (B-24). Before `claimed_at` existed
    // the row simply became due again and the death of a worker mid-request was
    // indistinguishable from a subscriber that asked to be retried.
    result.reclaimed = await this.store.reclaimExpired(now, limit);
    this.metrics.outcome("reclaimed", result.reclaimed);
    const due = await this.store.claimDue(now, limit);
    this.metrics.claimed(due.length);

    for (const delivery of due) {
      const stop = this.metrics.startItem();
      const subscription = await this.store.getSubscription(delivery.subscription_id);
      const record = await this.outbox.get(delivery.event_id);
      const event = record?.event;
      if (!subscription || !event) {
        // Neither is recoverable by waiting: a delivery whose subscription or
        // event has gone cannot be built, let alone sent.
        await this.store.markDead(
          delivery.delivery_id,
          subscription ? "event no longer in the outbox" : "subscription no longer exists",
          null,
        );
        result.dead += 1;
        this.metrics.outcome("failed_permanent");
        stop();
        continue;
      }

      const body = JSON.stringify(event);
      const response = await this.transport.send({
        url: subscription.endpoint_url,
        body,
        headers: {
          "content-type": "application/json",
          [SIGNATURE_HEADER]: signBody(subscription.signing_secret, body),
          // The receiver's idempotency key, in a header so it can dedupe
          // before parsing the body.
          [EVENT_ID_HEADER]: event.event_id,
          [DELIVERY_ATTEMPT_HEADER]: String(delivery.attempts + 1),
        },
        timeout_ms: this.timeoutMs,
      });

      if (isSuccess(response.status)) {
        await this.store.markDelivered(delivery.delivery_id, response.status as number);
        result.delivered += 1;
        this.metrics.outcome("completed");
        stop();
        continue;
      }

      const reason = response.error ?? `endpoint responded ${response.status}`;
      const attempts = delivery.attempts + 1;
      if (!isRetryable(response.status)) {
        // Rejected, not unwell. Repeating identical bytes cannot change the
        // answer, so stop and leave the row for an operator to see.
        await this.store.markDead(delivery.delivery_id, reason, response.status);
        result.dead += 1;
        this.metrics.outcome("failed_permanent");
      } else if (attempts >= this.maxAttempts) {
        await this.store.markDead(delivery.delivery_id, reason, response.status);
        result.dead += 1;
        this.metrics.outcome("failed_permanent");
      } else {
        await this.store.markFailed(
          delivery.delivery_id,
          reason,
          response.status,
          new Date(now.getTime() + this.baseBackoffMs * 2 ** delivery.attempts),
        );
        result.failed += 1;
        this.metrics.outcome("retried");
      }
      stop();
    }
    return result;
  }
}

// ───────────────────────────── registration ─────────────────────────────

export interface RegisterSubscriptionInput {
  subscriber: string;
  event_type: string;
  endpoint_url: string;
  signing_secret: string;
}

/**
 * Subscription management.
 *
 * Only CORE-produced event types may be subscribed to. Allowing a subscription
 * to `market.*` or `move.*` would let one external system be handed another's
 * inbound traffic by configuration alone, which is the boundary `EventIngress`
 * spends its whole existence defending.
 */
export class SubscriptionRegistry {
  constructor(
    private readonly store: DeliveryStore,
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {}

  async register(input: RegisterSubscriptionInput): Promise<PublicSubscription> {
    if (!input.subscriber.trim()) throw invalid("subscriber is required");
    if (!input.event_type.startsWith("core.")) {
      throw invalid("only core.* events may be subscribed to");
    }
    if (!/^https:\/\//.test(input.endpoint_url)) {
      // Plain HTTP would put the signature and the payload on the wire in
      // clear; the signature proves origin, not confidentiality.
      throw invalid("endpoint_url must be https");
    }
    if (input.signing_secret.length < 32) {
      throw invalid("signing_secret must be at least 32 characters");
    }

    const existing = await this.store.findSubscription(input.subscriber, input.event_type);
    if (existing) {
      // Idempotent in the only sense that is safe: the same registration
      // returns the same subscription. Changing an endpoint or a secret is a
      // separate, deliberate act — silently rotating a secret here would
      // break every in-flight delivery without anyone asking for it.
      return redactSubscription(existing);
    }

    const subscription: EventSubscription = {
      subscription_id: this.newId(),
      subscriber: input.subscriber,
      event_type: input.event_type,
      endpoint_url: input.endpoint_url,
      signing_secret: input.signing_secret,
      active: true,
      created_at: this.clock.now().toISOString(),
    };
    await this.store.insertSubscription(subscription);
    return redactSubscription(subscription);
  }

  async list(): Promise<PublicSubscription[]> {
    return (await this.store.listSubscriptions()).map(redactSubscription);
  }

  async setActive(subscriptionId: string, active: boolean): Promise<void> {
    await this.store.setSubscriptionActive(subscriptionId, active);
  }

  /** Operator view of what is stuck. Never includes a secret. */
  async undelivered(): Promise<EventDelivery[]> {
    const pending = await this.store.byStatus("pending");
    const dead = await this.store.byStatus("dead");
    return [...pending, ...dead];
  }
}
