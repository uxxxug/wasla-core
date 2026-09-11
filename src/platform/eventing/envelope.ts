import { newId } from "../ids.js";

/**
 * Canonical event envelope (ADR 0009).
 * Every event produced by any WASLA system carries exactly these fields.
 * `payload` is the only versioned, event-type-specific part.
 */
export interface EventEnvelope<P = unknown> {
  event_id: string;
  event_type: string;
  version: number;
  producer: string;
  occurred_at: string;
  correlation_id: string;
  causation_id: string | null;
  entity_type: string;
  entity_id: string;
  payload: P;
}

export interface NewEventInput<P> {
  event_type: string;
  version: number;
  producer: string;
  occurred_at: Date;
  correlation_id: string;
  causation_id?: string | null;
  entity_type: string;
  entity_id: string;
  payload: P;
}

export function makeEvent<P>(input: NewEventInput<P>): EventEnvelope<P> {
  return {
    event_id: newId(),
    event_type: input.event_type,
    version: input.version,
    producer: input.producer,
    occurred_at: input.occurred_at.toISOString(),
    correlation_id: input.correlation_id,
    causation_id: input.causation_id ?? null,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    payload: input.payload,
  };
}

const REQUIRED_KEYS = [
  "event_id",
  "event_type",
  "version",
  "producer",
  "occurred_at",
  "correlation_id",
  "causation_id",
  "entity_type",
  "entity_id",
  "payload",
] as const;

/** Structural validation used at every system boundary (producer and consumer). */
export function isValidEnvelope(value: unknown): value is EventEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  for (const key of REQUIRED_KEYS) {
    if (!(key in v)) return false;
  }
  return (
    typeof v["event_id"] === "string" &&
    typeof v["event_type"] === "string" &&
    typeof v["version"] === "number" &&
    typeof v["producer"] === "string" &&
    typeof v["occurred_at"] === "string" &&
    typeof v["correlation_id"] === "string" &&
    (v["causation_id"] === null || typeof v["causation_id"] === "string") &&
    typeof v["entity_type"] === "string" &&
    typeof v["entity_id"] === "string"
  );
}
