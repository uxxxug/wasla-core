import { createHmac, timingSafeEqual } from "node:crypto";
import type { Clock } from "../clock.js";
import type { ReferenceKeys } from "../persistence/reference-keys.js";
import { invalid } from "../errors.js";
import { NO_WORKER_METRICS, type WorkerMetrics } from "../observability/worker-metrics.js";
import { journalMapWrite, NO_SCOPE, type TransactionScope } from "../persistence/transaction.js";
import type { EventEnvelope } from "./envelope.js";
import { isFenced, newClaimToken, type Fence } from "./fencing.js";
import { tallyByStatus } from "./queue-counts.js";
import {
  compareRevivalPosition,
  matchesDeliveryRevival,
  type DeliveryRevivalSelection,
} from "./revival.js";
import {
  DEFAULT_MAX_RECLAIMS,
  reclaimedError,
  reclaimExhausted,
  reclaimExhaustedError,
  type ReclaimOutcome,
} from "./reclaim.js";
import { putRow } from "../persistence/row-rules.js";
import { inDueOrder } from "./queue-order.js";

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
  /**
   * How many times a worker claimed this delivery and never came back (B-25).
   *
   * Its own budget, separate from `attempts`, because an abandonment is not an
   * observed failure: `attempts` counts responses the subscriber actually gave and
   * drives the retry backoff, and this counts attempts nobody saw end. It is what
   * bounds a delivery whose payload kills the worker rather than the subscriber.
   */
  reclaims: number;
  /**
   * The token identifying the claim currently held on this delivery (B-26).
   *
   * Stamped by `claimDue`, cleared by every acknowledgement and by recovery. The
   * damage it prevents is the most concrete of the three queues: a worker that
   * stalls past its lease, is reclaimed, and then reports the response it
   * eventually received would overwrite the newer attempt's `last_status` and
   * `delivered_at` — the row would carry a response code from a request nobody is
   * waiting on any more.
   */
  claim_token: string | null;
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
   *
   * It does charge `reclaims`, and dead-letters the delivery once `maxReclaims`
   * recoveries have been used (B-25). Without that limit a delivery whose payload
   * kills the worker — rather than one the subscriber rejects — has no attempt
   * limit at all and is retried for ever.
   */
  reclaimExpired(now: Date, maxReclaims: number, limit?: number): Promise<ReclaimOutcome>;
  /**
   * The three acknowledgements are token-fenced (B-26) and return false when the
   * call was refused: the delivery is held by a different claim, or by none. The
   * worker passes the `claim_token` it was given by `claimDue`.
   */
  markDelivered(deliveryId: string, fence: Fence, status: number): Promise<boolean>;
  markFailed(
    deliveryId: string,
    fence: Fence,
    error: string,
    status: number | null,
    nextAttemptAt: Date,
  ): Promise<boolean>;
  markDead(
    deliveryId: string,
    fence: Fence,
    error: string,
    status: number | null,
  ): Promise<boolean>;
  /**
   * Stops a delivery because CORE has been told not to send to this subscriber
   * any more, rather than because sending failed (B-28).
   *
   * Lands in `dead`, which is the only state that means "no further automatic
   * attempt, visible to an operator, recoverable only when a human acts" — exactly
   * what a suppressed delivery is. B-25 set the precedent: its new route to `dead`
   * reused the status and distinguished itself by `last_error` and its own count,
   * rather than adding a fourth status, a migration and a wider check constraint.
   *
   * Separate from `markDead` for one reason: it must **not** charge an attempt. No
   * request was made, so incrementing `attempts` would record a failure that never
   * happened, inflate the backoff of a later attempt, and — since a revival
   * preserves `attempts` (B-27) — could hand back a row that is already at
   * `maxAttempts` without anything ever having been sent. `last_status` stays null
   * for the same reason: there was no response to record.
   */
  markSuppressed(deliveryId: string, fence: Fence, reason: string): Promise<boolean>;
  byStatus(status: DeliveryStatus): Promise<EventDelivery[]>;
  /**
   * A scoped page of **dead** deliveries, in `(created_at, delivery_id)` order
   * (B-27). Filtered, bounded and resumable, for the same reasons as
   * `OutboxStore.selectDead`.
   */
  selectDead(selection: DeliveryRevivalSelection): Promise<EventDelivery[]>;
  /**
   * Returns one dead delivery to the pending pool so the worker POSTs it again
   * (B-27). False when the row is not dead.
   *
   * `delivered_at` is not touched, and cannot be: it is null on a dead row, and
   * `event_delivery_delivered_at_check` ties it to `status = 'delivered'`, so the
   * database itself refuses a revival that tried to claim a delivery had happened.
   */
  revive(deliveryId: string, now: Date): Promise<boolean>;
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
  constructor(
    private readonly clock: Clock,
    keys?: ReferenceKeys,
  ) {
    keys?.attach("event_subscription", this.subscriptions);
    keys?.attach("event_delivery", this.deliveries);
  }

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
    putRow("event_subscription", this.subscriptions, subscription.subscription_id, subscription);
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
    putRow("event_subscription", this.subscriptions, subscriptionId, { ...existing, active });
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
    putRow("event_delivery", this.deliveries, delivery.delivery_id, delivery);
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
    const candidates = [...this.deliveries.values()].filter(
      (d) => d.status === "pending" && d.claimed_at === null && new Date(d.next_attempt_at) <= now,
    );
    // Due order with an explicit tiebreak, shared with Postgres (milestone 21).
    const due = inDueOrder(candidates, (row) => row.created_at).slice(0, limit);
    // The claimed rows, not the pre-claim ones: Postgres returns the updated
    // rows and the two backends must not disagree about what a claim returns
    // (B-12).
    const claimed: EventDelivery[] = [];
    // One token per call, not per row, matching Postgres, where a batch claim is
    // one statement. See `InMemoryOutbox.claimDue` for why that is equivalent.
    const token = newClaimToken();
    for (const delivery of due) {
      const next: EventDelivery = {
        ...delivery,
        next_attempt_at: new Date(now.getTime() + leaseMs).toISOString(),
        claimed_at: now.toISOString(),
        claim_token: token,
      };
      putRow("event_delivery", this.deliveries, delivery.delivery_id, next);
      claimed.push(next);
    }
    return claimed;
  }

  /** See `DeliveryStore.reclaimExpired`. */
  async reclaimExpired(now: Date, maxReclaims: number, limit = 100): Promise<ReclaimOutcome> {
    const outcome: ReclaimOutcome = { reclaimed: 0, dead: 0 };
    // Due order (milestone 21): `limit` makes the order a selection.
    for (const delivery of inDueOrder(this.deliveries.values(), (row) => row.created_at)) {
      if (outcome.reclaimed + outcome.dead >= limit) break;
      if (delivery.status !== "pending" || delivery.claimed_at === null) continue;
      if (new Date(delivery.next_attempt_at).getTime() > now.getTime()) continue;
      const reclaims = delivery.reclaims + 1;
      const exhausted = reclaimExhausted(delivery.reclaims, maxReclaims);
      putRow("event_delivery", this.deliveries, delivery.delivery_id, {
        ...delivery,
        reclaims,
        status: exhausted ? "dead" : delivery.status,
        claimed_at: null,
        // Taking the claim away invalidates its token (B-26).
        claim_token: null,
        // Due immediately: it already waited out a whole lease for a worker that
        // never came back. Left where it is once dead, the same as `markDead`
        // leaves it.
        next_attempt_at: exhausted ? delivery.next_attempt_at : now.toISOString(),
        last_error: exhausted
          ? reclaimExhaustedError(reclaims, delivery.attempts)
          : reclaimedError(reclaims, delivery.attempts),
      });
      if (exhausted) outcome.dead += 1;
      else outcome.reclaimed += 1;
    }
    return outcome;
  }

  async markDelivered(deliveryId: string, fence: Fence, status: number): Promise<boolean> {
    const existing = this.deliveries.get(deliveryId);
    // Checked and written with no await in between, so the two backends race the
    // same way (B-12).
    if (!existing || isFenced(existing.claim_token, fence)) return false;
    putRow("event_delivery", this.deliveries, deliveryId, {
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
      claim_token: null,
    });
    return true;
  }

  async markFailed(
    deliveryId: string,
    fence: Fence,
    error: string,
    status: number | null,
    nextAttemptAt: Date,
  ): Promise<boolean> {
    const existing = this.deliveries.get(deliveryId);
    if (!existing || isFenced(existing.claim_token, fence)) return false;
    putRow("event_delivery", this.deliveries, deliveryId, {
      ...existing,
      attempts: existing.attempts + 1,
      last_error: error,
      last_status: status,
      next_attempt_at: nextAttemptAt.toISOString(),
      // The claim is over. `next_attempt_at` goes back to meaning a retry
      // schedule, which it can only do once nobody holds the row.
      claimed_at: null,
      claim_token: null,
    });
    return true;
  }

  async markDead(
    deliveryId: string,
    fence: Fence,
    error: string,
    status: number | null,
  ): Promise<boolean> {
    const existing = this.deliveries.get(deliveryId);
    if (!existing || isFenced(existing.claim_token, fence)) return false;
    putRow("event_delivery", this.deliveries, deliveryId, {
      ...existing,
      status: "dead",
      attempts: existing.attempts + 1,
      last_error: error,
      last_status: status,
      claimed_at: null,
      claim_token: null,
    });
    return true;
  }

  /** See `DeliveryStore.markSuppressed`. */
  async markSuppressed(deliveryId: string, fence: Fence, reason: string): Promise<boolean> {
    const existing = this.deliveries.get(deliveryId);
    if (!existing || isFenced(existing.claim_token, fence)) return false;
    putRow("event_delivery", this.deliveries, deliveryId, {
      ...existing,
      status: "dead",
      // `attempts` and `last_status` deliberately untouched: nothing was sent.
      last_error: reason,
      claimed_at: null,
      claim_token: null,
    });
    return true;
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

  /** See `DeliveryStore.selectDead`. */
  async selectDead(selection: DeliveryRevivalSelection): Promise<EventDelivery[]> {
    return [...this.deliveries.values()]
      .filter((delivery) => matchesDeliveryRevival(delivery, selection))
      .sort((a, b) =>
        compareRevivalPosition(
          { primary: a.created_at, secondary: a.delivery_id },
          { primary: b.created_at, secondary: b.delivery_id },
        ),
      )
      .slice(0, selection.limit);
  }

  /** See `DeliveryStore.revive`. */
  async revive(deliveryId: string, now: Date): Promise<boolean> {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery || delivery.status !== "dead") return false;
    putRow("event_delivery", this.deliveries, deliveryId, {
      ...delivery,
      status: "pending",
      next_attempt_at: now.toISOString(),
      claimed_at: null,
      claim_token: null,
      reclaims: 0,
    });
    return true;
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
          reclaims: 0,
          claim_token: null,
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
  /**
   * Deliveries dead-lettered because they have now been abandoned more times than
   * `maxReclaims` allows (B-25). Separate from `dead`, which counts deliveries the
   * subscriber refused `maxAttempts` times: one is a fact about the subscriber, this
   * is a fact about the delivery itself — no response was ever received.
   */
  reclaim_exhausted: number;
  /**
   * Acknowledgements the store refused because this worker no longer held the
   * claim (B-26). It stalled past its lease, recovery gave the delivery to
   * somebody else, and its own result is now stale: recording it would overwrite a
   * newer attempt's outcome. Non-zero here means leases are too short for how long
   * this worker actually takes, not that a subscriber misbehaved.
   */
  fenced: number;
  /**
   * Deliveries stopped because their subscription is no longer active (B-28).
   * Separate from `dead`, which is a fact about the subscriber's answers, and from
   * `reclaim_exhausted`, which is a fact about this worker: this is a fact about a
   * decision an operator took. Nothing was sent and no attempt was charged.
   */
  suppressed: number;
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
    /**
     * How many abandonments one delivery is allowed before it is dead-lettered
     * instead of recovered (B-25). Last, so no existing positional caller moves.
     */
    private readonly maxReclaims = DEFAULT_MAX_RECLAIMS,
  ) {}

  async drainOnce(limit = 100): Promise<DeliveryWorkerResult> {
    const now = this.clock.now();
    const result: DeliveryWorkerResult = {
      delivered: 0,
      failed: 0,
      dead: 0,
      reclaimed: 0,
      reclaim_exhausted: 0,
      fenced: 0,
      suppressed: 0,
    };
    // Recovery first, so a restart picks up what the previous process abandoned
    // before it starts adding work of its own. This is the only place an expired
    // lease is directly observable for this worker: the delivery was claimed by
    // some process that never acknowledged it (B-24). Before `claimed_at` existed
    // the row simply became due again and the death of a worker mid-request was
    // indistinguishable from a subscriber that asked to be retried.
    //
    // A recovery charges its own budget rather than `attempts` (B-25); when that
    // budget runs out the delivery is dead-lettered and reported as
    // `failed_permanent`, not as `reclaimed`, because the recovery is what stopped.
    // The subscriber may have received some of those abandoned attempts — nothing
    // here knows, which is the whole reason CORE requires subscribers to be
    // idempotent on `event_id`.
    const reclaim = await this.store.reclaimExpired(now, this.maxReclaims, limit);
    result.reclaimed = reclaim.reclaimed;
    result.reclaim_exhausted = reclaim.dead;
    this.metrics.outcome("reclaimed", reclaim.reclaimed);
    this.metrics.outcome("failed_permanent", reclaim.dead);
    const due = await this.store.claimDue(now, limit);
    this.metrics.claimed(due.length);

    for (const delivery of due) {
      const stop = this.metrics.startItem();
      const subscription = await this.store.getSubscription(delivery.subscription_id);
      if (subscription && !subscription.active) {
        // B-28: fan-out only ever queues a delivery for an active subscription, so
        // deactivating one is how an operator stops CORE sending to a subscriber —
        // the only control there is. Until this check existed the queue kept
        // draining afterwards: rows already pending were still claimed, signed and
        // POSTed, for up to `maxAttempts` spread over hours of backoff. An operator
        // switching off a compromised or leaking endpoint got "stop queueing new
        // work", not "stop sending", which is not a defensible reading of a
        // security control.
        //
        // Checked here rather than swept when the subscription is deactivated,
        // because a sweep cannot close the race it would leave behind: fan-out
        // reads the active subscriptions, the deactivation commits, and then
        // fan-out queues its row. Deciding at the moment of sending is the only
        // place that sees the current answer. It costs nothing — the subscription
        // was already being read here for its endpoint and secret.
        //
        // Dead-lettered rather than left pending. Skipping without a write would
        // leave rows that are claimed and released on every drain for ever, absent
        // from the `retrying` reading and counted as ordinary backlog. `dead` says
        // the true thing — no further automatic attempt until a human acts — and
        // since B-27 the way back is one journalled command: reactivate the
        // subscription, then `npm run revive --queue event-delivery`. Revival
        // refuses while the subscription is still inactive, so the two halves
        // cannot contradict each other.
        const applied = await this.store.markSuppressed(
          delivery.delivery_id,
          delivery.claim_token,
          `subscription ${delivery.subscription_id} is not active; delivery suppressed`,
        );
        if (applied) {
          result.suppressed += 1;
          // No outcome of its own in the metric vocabulary: from a queue's point of
          // view this delivery ended permanently without being delivered, which is
          // what `failed_permanent` already means. `reclaim_exhausted` is reported
          // the same way, and the worker result carries the distinction for anyone
          // who needs it.
          this.metrics.outcome("failed_permanent");
        } else {
          this.countFenced(result);
        }
        stop();
        continue;
      }
      const record = await this.outbox.get(delivery.event_id);
      const event = record?.event;
      if (!subscription || !event) {
        // Neither is recoverable by waiting: a delivery whose subscription or
        // event has gone cannot be built, let alone sent.
        const applied = await this.store.markDead(
          delivery.delivery_id,
          delivery.claim_token,
          subscription ? "event no longer in the outbox" : "subscription no longer exists",
          null,
        );
        if (applied) {
          result.dead += 1;
          this.metrics.outcome("failed_permanent");
        } else {
          this.countFenced(result);
        }
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
        const applied = await this.store.markDelivered(
          delivery.delivery_id,
          delivery.claim_token,
          response.status as number,
        );
        // The subscriber did receive this. The refusal only discards our record of
        // it, because the row now belongs to a later attempt that will send again —
        // which is exactly why subscribers must dedupe on `event_id`.
        if (applied) {
          result.delivered += 1;
          this.metrics.outcome("completed");
        } else {
          this.countFenced(result);
        }
        stop();
        continue;
      }

      const reason = response.error ?? `endpoint responded ${response.status}`;
      const attempts = delivery.attempts + 1;
      if (!isRetryable(response.status)) {
        // Rejected, not unwell. Repeating identical bytes cannot change the
        // answer, so stop and leave the row for an operator to see.
        const applied = await this.store.markDead(
          delivery.delivery_id,
          delivery.claim_token,
          reason,
          response.status,
        );
        if (applied) {
          result.dead += 1;
          this.metrics.outcome("failed_permanent");
        } else this.countFenced(result);
      } else if (attempts >= this.maxAttempts) {
        const applied = await this.store.markDead(
          delivery.delivery_id,
          delivery.claim_token,
          reason,
          response.status,
        );
        if (applied) {
          result.dead += 1;
          this.metrics.outcome("failed_permanent");
        } else this.countFenced(result);
      } else {
        const applied = await this.store.markFailed(
          delivery.delivery_id,
          delivery.claim_token,
          reason,
          response.status,
          new Date(now.getTime() + this.baseBackoffMs * 2 ** delivery.attempts),
        );
        if (applied) {
          result.failed += 1;
          this.metrics.outcome("retried");
        } else this.countFenced(result);
      }
      stop();
    }
    return result;
  }

  /**
   * One place, so the count and the metric can never drift apart — five call
   * sites in this loop each have to report the same refusal (B-26).
   */
  private countFenced(result: DeliveryWorkerResult): void {
    result.fenced += 1;
    this.metrics.outcome("fenced");
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
