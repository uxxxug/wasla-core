import type { Clock } from "../clock.js";
import { forbidden, invalid } from "../errors.js";
import {
  journalMapWrite,
  NO_SCOPE,
  type TransactionScope,
} from "../persistence/transaction.js";
import type { EventEnvelope } from "./envelope.js";
import { isValidEnvelope } from "./envelope.js";
import { normalizableEventTypes, normalizeOrThrow } from "./normalize.js";
import { tallyByStatus } from "./queue-counts.js";
import {
  reclaimedError,
  reclaimExhausted,
  reclaimExhaustedError,
  type ReclaimOutcome,
} from "./reclaim.js";

export type InboundStatus = "pending" | "processed" | "dead";

export interface InboundRecord {
  event: EventEnvelope;
  status: InboundStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  /**
   * When CORE accepted the event, by CORE's clock.
   *
   * The column has existed since migration 0007 but was not surfaced, so
   * nothing above the store could order events by the one timestamp CORE
   * actually controls. Replay needs it for both scope ("everything received
   * that afternoon") and order (see `select`), and an operator needs it to tell
   * a late event from an old one.
   */
  received_at: string;
  /**
   * When a dispatcher claimed this row, or null when nobody holds it (B-24).
   *
   * While it is null, `next_attempt_at` is a retry schedule; while it is set,
   * `next_attempt_at` is a lease expiry. Without the distinction a row held by a
   * dispatcher that died was indistinguishable from a row waiting to be retried,
   * so an abandoned claim could not be counted and nothing could answer "what is
   * stuck".
   */
  claimed_at: string | null;
  /**
   * How many times a dispatcher claimed this row and never came back (B-25).
   *
   * Its own budget, separate from `attempts`, because an abandonment is not an
   * observed failure: `attempts` drives the retry backoff and `retrying`, and
   * this drives only the limit that stops an event whose payload kills every
   * dispatcher that reads it from being recovered for ever.
   */
  reclaims: number;
}

/**
 * A bounded, auditable slice of the inbound history.
 *
 * Every field narrows; a scope that narrows nothing is refused by the caller
 * (`ReplayService`), because "replay everything" is not an operation anyone can
 * review before it runs. `limit` is required for the same reason.
 */
export interface InboundSelection {
  event_ids?: readonly string[];
  event_types?: readonly string[];
  producer?: string;
  statuses?: readonly InboundStatus[];
  received_from?: string;
  received_to?: string;
  occurred_from?: string;
  occurred_to?: string;
  /** Resume cursor: strictly after this position in the store's total order. */
  after?: { received_at: string; event_id: string };
  limit: number;
}

/**
 * Durable store for events that arrived from outside CORE.
 *
 * The inbound mirror of `OutboxStore`, and it exists for the same reason. The
 * outbox stops a state change and its event from being two writes that can
 * disagree; this stops an accepted event and its processing from being one
 * request that can disappear.
 */
export interface InboundEventStore {
  /**
   * Records an arriving event. Returns `true` when this is the first time
   * CORE has seen this `event_id`, `false` when it is a redelivery.
   *
   * MUST be able to run inside a caller's transaction, which is how ingress
   * commits the receipt before answering the producer.
   */
  accept(event: EventEnvelope, scope?: TransactionScope): Promise<boolean>;
  get(eventId: string): Promise<InboundRecord | undefined>;
  /** Leases due records so two dispatchers cannot claim the same work (B-22). */
  claimDue(now: Date, limit: number, leaseMs?: number): Promise<InboundRecord[]>;
  /**
   * Returns rows whose lease ran out to the pending pool and reports how many
   * (B-24). The only thing that frees a row abandoned by a dead dispatcher,
   * because `claimDue` refuses claimed rows. Does not touch `attempts`: an
   * abandoned attempt was never observed to fail, and charging it against the
   * retry budget would let a rolling deploy dead-letter healthy events.
   *
   * It does charge `reclaims`, which is that budget's own counter, and
   * dead-letters the row once `maxReclaims` recoveries have been used (B-25).
   * Without the limit an event that kills whatever dispatcher reads it is
   * recovered and re-claimed for ever, and a dead-letter — the one state that
   * summons an operator, and the one replay selects by default — is never reached.
   */
  reclaimExpired(now: Date, maxReclaims: number, limit?: number): Promise<ReclaimOutcome>;
  markProcessed(eventId: string): Promise<void>;
  markFailed(eventId: string, error: string, nextAttemptAt: Date): Promise<void>;
  markDead(eventId: string, error: string): Promise<void>;
  byStatus(status: InboundStatus): Promise<InboundRecord[]>;
  all(): Promise<InboundRecord[]>;
  /**
   * Row counts by status, plus `retrying` (pending with an attempt already
   * spent). One aggregate query rather than a list, because the caller is a
   * gauge sampler and fetching every pending row to take its `length` is how a
   * readiness probe becomes a table scan.
   *
   * Also reports `in_flight` and `abandoned`: pending rows a dispatcher is
   * holding, split by whether the lease has run out (B-24).
   *
   * All three are derived here, at read time, from the same rows: none is a
   * status any row carries, and none must become a second store competing with
   * the queue for the truth. They are subsets of `pending`, not additions to it.
   */
  counts(): Promise<Record<string, number>>;
  /**
   * Rows matching a selection, in the store's total order: `received_at`, then
   * `event_id` as the tiebreak.
   *
   * The order is part of the contract, not an accident of the query plan. Two
   * events received in the same millisecond need a deterministic tiebreak or a
   * resumed replay could skip one and repeat another, and `event_id` is the only
   * field guaranteed unique. `occurred_at` is deliberately not the sort key:
   * it is the producer's clock, it is not monotonic across producers, and
   * ordering by it would let a producer with a skewed clock reorder CORE's
   * history retroactively.
   */
  select(selection: InboundSelection): Promise<InboundRecord[]>;
}

/** Shared ordering, so both backends sort identically. */
export function compareInboundPosition(a: InboundRecord, b: InboundRecord): number {
  return (
    a.received_at.localeCompare(b.received_at) || a.event.event_id.localeCompare(b.event.event_id)
  );
}

/** Shared filtering, so both backends admit exactly the same rows. */
export function matchesSelection(record: InboundRecord, selection: InboundSelection): boolean {
  const { event } = record;
  if (selection.event_ids && !selection.event_ids.includes(event.event_id)) return false;
  if (selection.event_types && !selection.event_types.includes(event.event_type)) return false;
  if (selection.producer !== undefined && event.producer !== selection.producer) return false;
  if (selection.statuses && !selection.statuses.includes(record.status)) return false;
  if (selection.received_from !== undefined && record.received_at < selection.received_from) {
    return false;
  }
  if (selection.received_to !== undefined && record.received_at > selection.received_to) {
    return false;
  }
  if (selection.occurred_from !== undefined && event.occurred_at < selection.occurred_from) {
    return false;
  }
  if (selection.occurred_to !== undefined && event.occurred_at > selection.occurred_to) return false;
  if (selection.after) {
    const after = selection.after;
    const position =
      record.received_at.localeCompare(after.received_at) ||
      event.event_id.localeCompare(after.event_id);
    if (position <= 0) return false;
  }
  return true;
}

export class InMemoryInboundEventStore implements InboundEventStore {
  private records = new Map<string, InboundRecord>();
  constructor(private readonly clock: Clock) {}

  async accept(event: EventEnvelope, scope: TransactionScope = NO_SCOPE): Promise<boolean> {
    // Synchronous check-then-write, deliberately. An `await` in between would
    // let two simultaneous redeliveries of the same event both be treated as
    // first arrivals — the same race that made the money store double spend.
    if (this.records.has(event.event_id)) return false;
    journalMapWrite(scope, this.records, event.event_id);
    const now = this.clock.now().toISOString();
    this.records.set(event.event_id, {
      event,
      status: "pending",
      attempts: 0,
      reclaims: 0,
      last_error: null,
      next_attempt_at: now,
      received_at: now,
      claimed_at: null,
    });
    return true;
  }

  async get(eventId: string): Promise<InboundRecord | undefined> {
    return this.records.get(eventId);
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
   * is null. A row held by a dispatcher that died is therefore no longer
   * silently re-served when its lease runs out — `reclaimExpired` frees it, and
   * counts it, which is what makes a dying dispatcher visible instead of slow.
   */
  async claimDue(now: Date, limit: number, leaseMs = 30_000): Promise<InboundRecord[]> {
    const due = [...this.records.values()]
      .filter((r) => r.status === "pending" && r.claimed_at === null && new Date(r.next_attempt_at) <= now)
      .sort((a, b) => a.next_attempt_at.localeCompare(b.next_attempt_at))
      .slice(0, limit);
    // The claimed records, not the pre-claim ones: Postgres returns the updated
    // rows and the two backends must not disagree about what a claim returns
    // (B-12).
    const claimed: InboundRecord[] = [];
    for (const record of due) {
      const next: InboundRecord = {
        ...record,
        next_attempt_at: new Date(now.getTime() + leaseMs).toISOString(),
        claimed_at: now.toISOString(),
      };
      this.records.set(record.event.event_id, next);
      claimed.push(next);
    }
    return claimed;
  }

  /** See `InboundEventStore.reclaimExpired`. */
  async reclaimExpired(now: Date, maxReclaims: number, limit = 100): Promise<ReclaimOutcome> {
    const outcome: ReclaimOutcome = { reclaimed: 0, dead: 0 };
    for (const record of this.records.values()) {
      if (outcome.reclaimed + outcome.dead >= limit) break;
      if (record.status !== "pending" || record.claimed_at === null) continue;
      if (new Date(record.next_attempt_at).getTime() > now.getTime()) continue;
      const reclaims = record.reclaims + 1;
      const exhausted = reclaimExhausted(record.reclaims, maxReclaims);
      this.records.set(record.event.event_id, {
        ...record,
        reclaims,
        status: exhausted ? "dead" : record.status,
        claimed_at: null,
        // Due immediately: the row already waited out a whole lease for a
        // dispatcher that never came back. Left where it is once dead, the same
        // as `markDead` leaves it.
        next_attempt_at: exhausted ? record.next_attempt_at : now.toISOString(),
        last_error: exhausted
          ? reclaimExhaustedError(reclaims, record.attempts)
          : reclaimedError(reclaims, record.attempts),
      });
      if (exhausted) outcome.dead += 1;
      else outcome.reclaimed += 1;
    }
    return outcome;
  }

  async markProcessed(eventId: string): Promise<void> {
    const record = this.records.get(eventId);
    if (!record) return;
    this.records.set(eventId, { ...record, status: "processed", last_error: null, claimed_at: null });
  }

  async markFailed(eventId: string, error: string, nextAttemptAt: Date): Promise<void> {
    const record = this.records.get(eventId);
    if (!record) return;
    this.records.set(eventId, {
      ...record,
      attempts: record.attempts + 1,
      last_error: error,
      next_attempt_at: nextAttemptAt.toISOString(),
      // The claim is over. `next_attempt_at` goes back to meaning a retry
      // schedule, which it can only do once nobody holds the row.
      claimed_at: null,
    });
  }

  async markDead(eventId: string, error: string): Promise<void> {
    const record = this.records.get(eventId);
    if (!record) return;
    this.records.set(eventId, {
      ...record,
      status: "dead",
      attempts: record.attempts + 1,
      last_error: error,
      claimed_at: null,
    });
  }

  async byStatus(status: InboundStatus): Promise<InboundRecord[]> {
    return [...this.records.values()].filter((r) => r.status === status);
  }

  async all(): Promise<InboundRecord[]> {
    return [...this.records.values()];
  }

  async counts(): Promise<Record<string, number>> {
    return tallyByStatus(
      [...this.records.values()],
      ["pending", "processed", "dead"],
      this.clock.now(),
    );
  }

  async select(selection: InboundSelection): Promise<InboundRecord[]> {
    return [...this.records.values()]
      .filter((record) => matchesSelection(record, selection))
      .sort(compareInboundPosition)
      .slice(0, selection.limit);
  }
}

/**
 * Which producer is allowed to assert which events.
 *
 * This is a trust boundary, not a formality. An external caller that could
 * submit a `core.*` event would be forging CORE's own facts — announcing a
 * capture that never happened, or a fulfillment CORE never created — and every
 * consumer downstream treats `core.*` as authoritative. So the prefix a caller
 * may use is derived from who the caller is, never from what it claims to be.
 *
 * `producer` in the envelope is therefore checked against the authenticated
 * identity too: a MOVE credential submitting an envelope that says
 * `producer: "wasla-market"` is a spoofing attempt, not a mistake.
 */
export const INGRESS_PRODUCERS: Readonly<Record<string, { prefix: string }>> = {
  "wasla-market": { prefix: "market." },
  "wasla-move": { prefix: "move." },
};

/**
 * The event types CORE actually has a consumer for.
 *
 * Derived from the normalisation rules rather than listed again here. Two lists
 * would drift, and the failure would be silent in the worst direction: a type
 * accepted at the edge that no normaliser can read is an event CORE promised to
 * handle and cannot.
 */
export const ACCEPTED_INBOUND_TYPES: readonly string[] = normalizableEventTypes();

export interface IngressResult {
  event_id: string;
  accepted: boolean;
  /** `false` means CORE already held this event; the producer need not retry. */
  first_delivery: boolean;
}

/**
 * The edge that lets MARKET and MOVE actually drive CORE.
 *
 * It does exactly two things: refuse anything it should not hold, and record
 * what it accepts durably. It deliberately does **not** process the event in
 * the request. Processing in-request would mean the producer's 2xx promises
 * something CORE has not made durable — a crash immediately afterwards loses
 * the event with the producer believing it was delivered, and at-least-once
 * delivery only helps a producer that has been told to retry.
 */
export class EventIngress {
  constructor(
    private readonly store: InboundEventStore,
    private readonly commit: <T>(work: (scope: TransactionScope) => Promise<T>) => Promise<T>,
    private readonly clock: Clock,
  ) {}

  /**
   * `serviceName` must come from the authenticated credential. Passing
   * anything a request supplied would defeat the whole check.
   */
  async submit(serviceName: string | null, event: unknown): Promise<IngressResult> {
    const source = serviceName ? INGRESS_PRODUCERS[serviceName] : undefined;
    if (!source) throw forbidden("this caller may not submit events");
    if (!isValidEnvelope(event)) throw invalid("invalid event envelope");

    const envelope = event as EventEnvelope;
    if (!envelope.event_type.startsWith(source.prefix)) {
      // Covers the important case: nobody outside CORE may assert `core.*`.
      throw forbidden(`this caller may only submit ${source.prefix}* events`);
    }
    if (envelope.producer !== serviceName) {
      throw forbidden("envelope producer does not match the authenticated caller");
    }
    // Refused rather than parked, and refused for the payload too. A type CORE
    // has no consumer for — or a payload no version of the contract can read —
    // would otherwise sit pending, fail its attempts one by one and end up
    // `dead`, long after the producer was told the event was accepted. The
    // producer learns now, while it still has the request in its hand.
    //
    // This enforces the published payload schemas rather than changing them:
    // every inbound contract already declares its required fields and forbids
    // unknown ones, and until now nothing checked either.
    normalizeOrThrow(envelope, this.clock.now().toISOString());

    const first = await this.commit((scope) => this.store.accept(envelope, scope));
    return { event_id: envelope.event_id, accepted: true, first_delivery: first };
  }
}
