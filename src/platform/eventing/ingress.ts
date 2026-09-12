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
   * `retrying` is derived here, at read time, from the same rows: it is not a
   * status any row carries and must never become a second store competing with
   * the queue for the truth.
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
      last_error: null,
      next_attempt_at: now,
      received_at: now,
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
   * column, so an abandoned claim comes back by the same clock that schedules
   * retries — one timer, one truth. A worker that dies mid-attempt costs one
   * lease of delay, which is the same trade every retry in CORE already makes.
   */
  async claimDue(now: Date, limit: number, leaseMs = 30_000): Promise<InboundRecord[]> {
    const due = [...this.records.values()]
      .filter((r) => r.status === "pending" && new Date(r.next_attempt_at) <= now)
      .sort((a, b) => a.next_attempt_at.localeCompare(b.next_attempt_at))
      .slice(0, limit);
    for (const record of due) {
      this.records.set(record.event.event_id, {
        ...record,
        next_attempt_at: new Date(now.getTime() + leaseMs).toISOString(),
      });
    }
    return due;
  }

  async markProcessed(eventId: string): Promise<void> {
    const record = this.records.get(eventId);
    if (!record) return;
    this.records.set(eventId, { ...record, status: "processed", last_error: null });
  }

  async markFailed(eventId: string, error: string, nextAttemptAt: Date): Promise<void> {
    const record = this.records.get(eventId);
    if (!record) return;
    this.records.set(eventId, {
      ...record,
      attempts: record.attempts + 1,
      last_error: error,
      next_attempt_at: nextAttemptAt.toISOString(),
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
    });
  }

  async byStatus(status: InboundStatus): Promise<InboundRecord[]> {
    return [...this.records.values()].filter((r) => r.status === status);
  }

  async all(): Promise<InboundRecord[]> {
    return [...this.records.values()];
  }

  async counts(): Promise<Record<string, number>> {
    return tallyByStatus([...this.records.values()], ["pending", "processed", "dead"]);
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
