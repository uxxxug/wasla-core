import type { Clock } from "../clock.js";
import { forbidden, invalid } from "../errors.js";
import {
  journalMapWrite,
  NO_SCOPE,
  type TransactionScope,
} from "../persistence/transaction.js";
import type { EventEnvelope } from "./envelope.js";
import { isValidEnvelope } from "./envelope.js";

export type InboundStatus = "pending" | "processed" | "dead";

export interface InboundRecord {
  event: EventEnvelope;
  status: InboundStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
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
  claimDue(now: Date, limit: number): Promise<InboundRecord[]>;
  markProcessed(eventId: string): Promise<void>;
  markFailed(eventId: string, error: string, nextAttemptAt: Date): Promise<void>;
  markDead(eventId: string, error: string): Promise<void>;
  byStatus(status: InboundStatus): Promise<InboundRecord[]>;
  all(): Promise<InboundRecord[]>;
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
    this.records.set(event.event_id, {
      event,
      status: "pending",
      attempts: 0,
      last_error: null,
      next_attempt_at: this.clock.now().toISOString(),
    });
    return true;
  }

  async get(eventId: string): Promise<InboundRecord | undefined> {
    return this.records.get(eventId);
  }

  async claimDue(now: Date, limit: number): Promise<InboundRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.status === "pending" && new Date(r.next_attempt_at) <= now)
      .sort((a, b) => a.next_attempt_at.localeCompare(b.next_attempt_at))
      .slice(0, limit);
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

/** The event types CORE actually has a consumer for. */
export const ACCEPTED_INBOUND_TYPES: readonly string[] = [
  "market.order.created",
  "move.job.accepted",
  "move.job.rejected",
  "move.job.completed",
];

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
    if (!ACCEPTED_INBOUND_TYPES.includes(envelope.event_type)) {
      // Refused rather than parked. A type CORE has no consumer for would sit
      // pending forever, and the producer would never learn that nothing will
      // ever happen.
      throw invalid(`no consumer for event type ${envelope.event_type}`);
    }

    const first = await this.commit((scope) => this.store.accept(envelope, scope));
    return { event_id: envelope.event_id, accepted: true, first_delivery: first };
  }
}
