/**
 * Inbound event normalisation (milestone 6).
 *
 * Four stages, deliberately named apart because conflating them is how a system
 * ends up with each consumer inventing its own reading of the same event:
 *
 * 1. **raw** — whatever arrived: a JSON body at the ingress edge, or a `payload`
 *    column written months ago by a producer version nobody runs any more.
 * 2. **validated envelope** — the transport-level fields are present and
 *    well-typed (`isValidEnvelope`). Says nothing about the payload.
 * 3. **canonical event** — this file. The event type is one CORE has a consumer
 *    for, the version is one CORE knows how to read, the payload has been
 *    checked field by field and reduced to the single shape the current code
 *    expects, and the two timestamps that matter are separated: `occurred_at` is
 *    the producer's claim, `received_at` is CORE's own durable fact.
 * 4. **consumer-specific effect** — what a handler does with it. Not here, and
 *    never mixed in here: normalisation is pure, so replaying it a thousand
 *    times over historical rows costs nothing and changes nothing.
 *
 * The rule this file exists to enforce: **a consumer never interprets a version
 * again.** Before it, all four inbound handlers repeated `event.version !== 1`
 * and their own partial payload checks, which meant the answer to "can CORE read
 * this event?" was spread across four methods and disagreed with the published
 * contract in at least one place (`move.job.rejected` was accepted without the
 * `rejected_at` the contract requires). Now the question has exactly one
 * answer, and it lives next to the contracts it implements.
 *
 * What this file must never do is guess. An event it cannot read is refused with
 * a reason a person can act on — never defaulted, never coerced, never dropped.
 * A guessed payload is worse than a refused one: the refusal stops, the guess
 * settles money.
 */
import { invalid } from "../errors.js";
import { isId } from "../ids.js";
import type { EventEnvelope } from "./envelope.js";
import { isValidEnvelope } from "./envelope.js";

/**
 * The inbound payload shapes, as the current code understands them.
 *
 * They live here rather than in the consuming module because they are the
 * *contract's* shapes, not the domain's: `contracts/events/*.schema.json` is
 * the published definition and this is its executable twin. A module that
 * consumes an inbound event imports the canonical type from here, so there is
 * one place to change when a contract gains a version.
 */
export interface MarketOrderCreatedPayload {
  order_id: string;
  organization_id: string;
  requested_service: string;
  /** Optional CORE money hold created by MARKET before submitting the order. */
  payment_authorization_id: string | null;
}

export interface MoveJobAcceptedPayload {
  fulfillment_id: string;
  job_id: string;
  accepted_at: string;
}

export interface MoveJobRejectedPayload {
  fulfillment_id: string;
  reason: string;
  rejected_at: string;
}

export interface MoveJobCompletedPayload {
  fulfillment_id: string;
  job_id: string;
  outcome: "completed" | "failed";
  completed_at: string;
}

/**
 * A normalised event, ready to be handed to a consumer or reasoned about by an
 * operator.
 *
 * `envelope` is kept verbatim and is what actually reaches the bus: consumers
 * subscribe to envelopes, and re-serialising a normalised copy would risk
 * changing an `event_id` or an `occurred_at` that other systems have already
 * recorded. The canonical fields alongside it are what CORE reasons *about*.
 */
export interface CanonicalEvent<P = unknown> {
  event_id: string;
  event_type: string;
  version: number;
  producer: string;
  /** The producer's claim about when the fact happened. Not a CORE clock. */
  occurred_at: string;
  /**
   * When CORE accepted the event. CORE's own clock, and therefore the only one
   * of the two that can order events from different producers — see
   * `docs/replay.md` for why replay orders by this and not by `occurred_at`.
   */
  received_at: string;
  correlation_id: string;
  causation_id: string | null;
  entity_type: string;
  entity_id: string;
  /**
   * Tenant scope, and `null` when the event does not carry one.
   *
   * `null` is a fact, not a gap to be filled. `market.order.created` names its
   * organization; the three `move.*` events name only an opaque fulfillment
   * reference, so CORE cannot know the tenant from the envelope alone. Guessing
   * it — by looking up the fulfillment and assuming the answer applies — is the
   * silent mislinking B-23 exists to prevent, so tenant-scoped replay refuses
   * these events instead of including them on a hunch.
   */
  organization_id: string | null;
  payload: P;
  envelope: EventEnvelope;
}

/** Why an event could not be normalised. Stable strings: operators grep these. */
export type NormalizationRejection =
  | "envelope_malformed"
  | "unknown_event_type"
  | "unsupported_version"
  | "payload_malformed";

export type NormalizationResult =
  | { ok: true; event: CanonicalEvent }
  | { ok: false; rejection: NormalizationRejection; detail: string };

/** Thrown by a payload normaliser; carries no value from the input. */
class PayloadError extends Error {}

function fail(detail: string): never {
  throw new PayloadError(detail);
}

function requiredString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${field} must be a non-empty string`);
  }
  return value as string;
}

function requiredId(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (!isId(value)) fail(`${field} must be a UUID`);
  return value as string;
}

/**
 * A timestamp that must be readable as an instant.
 *
 * Normalised to ISO-8601 UTC so two producers that both wrote a valid but
 * differently formatted timestamp become one comparable value. An unparseable
 * one is refused: a date CORE cannot read is not a date it may invent.
 */
function requiredInstant(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string") fail(`${field} must be a timestamp string`);
  const parsed = new Date(value as string);
  if (Number.isNaN(parsed.getTime())) fail(`${field} is not a readable timestamp`);
  return parsed.toISOString();
}

/**
 * An optional field that historical rows may simply not have.
 *
 * This is the one real backwards-compatibility rule CORE has today, and it is
 * not hypothetical: `payment_authorization_id` was added to
 * `market.order.created` v1 after the type was already in use, additively. Rows
 * accepted before that carry no such key, and the canonical form of "no hold
 * was declared" is `null`. Absent and explicitly null therefore normalise to
 * the same value — while a *present but wrong* value is still refused, because
 * a malformed reference is a different fact from an absent one.
 */
function optionalReference(payload: Record<string, unknown>, field: string): string | null {
  if (!(field in payload)) return null;
  const value = payload[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${field} must be a non-empty string or null`);
  }
  return value as string;
}

/**
 * Refuses fields the contract does not declare.
 *
 * Every inbound schema is `additionalProperties: false`, so this is enforcement
 * of the published contract rather than a new rule. It matters for replay: an
 * unexpected key means the row was produced by something CORE does not
 * understand, and the safe reading of "I do not understand this" is to stop,
 * not to use the parts that look familiar. The offending key names are reported;
 * their values are not, because a payload may carry a person's data.
 */
function noExtraFields(payload: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (extra.length > 0) fail(`unexpected field(s): ${extra.sort().join(", ")}`);
}

type PayloadNormalizer = (payload: Record<string, unknown>) => unknown;

interface TypeRules {
  /** Version → how to read that version's payload into the canonical shape. */
  versions: Readonly<Record<number, PayloadNormalizer>>;
  /** Tenant scope, read from the canonical payload. `null` when not carried. */
  tenant: (payload: unknown) => string | null;
}

/**
 * Which inbound events CORE can read, and how.
 *
 * One entry per published type, one normaliser per version of it. Today every
 * inbound type is at version 1 and there is no second version to migrate from —
 * so this holds exactly the rules that exist, and no speculative migration
 * machinery. What it does provide is the shape a second version slots into: add
 * `2: (p) => ...` next to `1`, and both old and new rows normalise to one
 * canonical payload without a single consumer learning that a version exists.
 */
const RULES: Readonly<Record<string, TypeRules>> = {
  "market.order.created": {
    versions: {
      1: (payload) => {
        noExtraFields(payload, [
          "order_id",
          "organization_id",
          "requested_service",
          "payment_authorization_id",
        ]);
        const canonical: MarketOrderCreatedPayload = {
          // MARKET's own reference: opaque to CORE, so only "non-empty" is
          // checkable. `organization_id` is a CORE identifier being echoed
          // back, so it gets the full check.
          order_id: requiredString(payload, "order_id"),
          organization_id: requiredId(payload, "organization_id"),
          requested_service: requiredString(payload, "requested_service"),
          payment_authorization_id: optionalReference(payload, "payment_authorization_id"),
        };
        return canonical;
      },
    },
    tenant: (payload) => (payload as MarketOrderCreatedPayload).organization_id,
  },
  "move.job.accepted": {
    versions: {
      1: (payload) => {
        noExtraFields(payload, ["fulfillment_id", "job_id", "accepted_at"]);
        const canonical: MoveJobAcceptedPayload = {
          fulfillment_id: requiredId(payload, "fulfillment_id"),
          job_id: requiredString(payload, "job_id"),
          accepted_at: requiredInstant(payload, "accepted_at"),
        };
        return canonical;
      },
    },
    tenant: () => null,
  },
  "move.job.rejected": {
    versions: {
      1: (payload) => {
        noExtraFields(payload, ["fulfillment_id", "reason", "rejected_at"]);
        const canonical: MoveJobRejectedPayload = {
          fulfillment_id: requiredId(payload, "fulfillment_id"),
          reason: requiredString(payload, "reason"),
          rejected_at: requiredInstant(payload, "rejected_at"),
        };
        return canonical;
      },
    },
    tenant: () => null,
  },
  "move.job.completed": {
    versions: {
      1: (payload) => {
        noExtraFields(payload, ["fulfillment_id", "job_id", "outcome", "completed_at"]);
        const outcome = requiredString(payload, "outcome");
        if (outcome !== "completed" && outcome !== "failed") {
          fail(`outcome must be "completed" or "failed"`);
        }
        const canonical: MoveJobCompletedPayload = {
          fulfillment_id: requiredId(payload, "fulfillment_id"),
          job_id: requiredString(payload, "job_id"),
          outcome,
          completed_at: requiredInstant(payload, "completed_at"),
        };
        return canonical;
      },
    },
    tenant: () => null,
  },
};

/** The inbound types CORE has a consumer for. Derived, never a second list. */
export function normalizableEventTypes(): readonly string[] {
  return Object.keys(RULES);
}

/** The versions CORE can read for a type, for an operator-facing message. */
export function supportedVersions(eventType: string): readonly number[] {
  const rules = RULES[eventType];
  return rules ? Object.keys(rules.versions).map(Number).sort((a, b) => a - b) : [];
}

/**
 * raw + when CORE received it → canonical, or a reason it cannot be one.
 *
 * Pure and total: it never throws, never writes, never reads a clock. Replay
 * classifies thousands of historical rows with it before touching anything, and
 * a classification step that could itself fail or mutate would make dry-run
 * meaningless.
 */
export function normalize(raw: unknown, receivedAt: string): NormalizationResult {
  if (!isValidEnvelope(raw)) {
    return { ok: false, rejection: "envelope_malformed", detail: "envelope is not well-formed" };
  }
  const envelope = raw as EventEnvelope;
  const rules = RULES[envelope.event_type];
  if (!rules) {
    return {
      ok: false,
      rejection: "unknown_event_type",
      detail: `no consumer for event type ${envelope.event_type}`,
    };
  }
  const normalizer = rules.versions[envelope.version];
  if (!normalizer) {
    // Explicit, and it names what CORE *can* read. A version CORE does not know
    // is the one case where guessing is most tempting and most dangerous: the
    // fields it recognises may mean something different in the version it does
    // not.
    return {
      ok: false,
      rejection: "unsupported_version",
      detail:
        `${envelope.event_type} version ${envelope.version} is not supported ` +
        `(supported: ${supportedVersions(envelope.event_type).join(", ")})`,
    };
  }
  if (typeof envelope.payload !== "object" || envelope.payload === null || Array.isArray(envelope.payload)) {
    return { ok: false, rejection: "payload_malformed", detail: "payload must be an object" };
  }
  let payload: unknown;
  try {
    payload = normalizer(envelope.payload as Record<string, unknown>);
  } catch (error) {
    if (error instanceof PayloadError) {
      return { ok: false, rejection: "payload_malformed", detail: error.message };
    }
    throw error;
  }
  const occurredAt = new Date(envelope.occurred_at);
  if (Number.isNaN(occurredAt.getTime())) {
    return { ok: false, rejection: "envelope_malformed", detail: "occurred_at is not a readable timestamp" };
  }
  return {
    ok: true,
    event: {
      event_id: envelope.event_id,
      event_type: envelope.event_type,
      version: envelope.version,
      producer: envelope.producer,
      occurred_at: occurredAt.toISOString(),
      received_at: receivedAt,
      correlation_id: envelope.correlation_id,
      causation_id: envelope.causation_id,
      entity_type: envelope.entity_type,
      entity_id: envelope.entity_id,
      organization_id: rules.tenant(payload),
      payload,
      envelope,
    },
  };
}

/**
 * The ingress form: normalise or refuse the request.
 *
 * Ingress used to record any structurally valid envelope and let the payload be
 * discovered as unreadable four failed attempts later, by which time the
 * producer had long been told the event was accepted and the row was `dead`.
 * Validating at the edge means a producer learns immediately, from the response
 * to the request it can still fix.
 */
export function normalizeOrThrow(raw: unknown, receivedAt: string): CanonicalEvent {
  const result = normalize(raw, receivedAt);
  if (result.ok) return result.event;
  throw invalid(result.detail, { rejection: result.rejection });
}

/**
 * The consumer form: the canonical payload of an event already on the bus.
 *
 * A handler states the type it subscribed to and gets a payload it can trust.
 * The version check that used to sit in every handler is this call, so there is
 * one implementation of "can CORE read this" instead of four that drift.
 */
export function canonicalPayload<P>(event: EventEnvelope, expectedType: string): P {
  if (event.event_type !== expectedType) {
    throw invalid(`expected ${expectedType}, received ${event.event_type}`);
  }
  // `received_at` is irrelevant to a payload read, and a handler does not know
  // it; the envelope's own timestamp keeps the value well-formed without
  // pretending to be a receipt time.
  const result = normalize(event, event.occurred_at);
  if (!result.ok) throw invalid(result.detail, { rejection: result.rejection });
  return result.event.payload as P;
}
