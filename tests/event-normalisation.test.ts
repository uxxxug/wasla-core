/**
 * Milestone 6, part one: raw inbound event → canonical event.
 *
 * The properties under test are the ones a replay depends on absolutely. If
 * normalisation can be talked into guessing, every later guarantee is worthless:
 * a dry-run would predict the wrong thing, and a replay would apply an invented
 * payload to real money.
 *
 * So: a readable event normalises exactly; an unreadable one is refused with a
 * reason a person can act on and never with a default; and the refusal names
 * fields without quoting their values, because a payload can describe a real
 * customer.
 *
 * No backend is needed — `normalize` is pure by construction, which is itself
 * one of the things asserted here.
 */
import { describe, expect, it } from "vitest";
import { makeEvent } from "../src/platform/eventing/envelope.js";
import type { EventEnvelope } from "../src/platform/eventing/envelope.js";
import {
  canonicalPayload,
  normalize,
  normalizeOrThrow,
  normalizableEventTypes,
  supportedVersions,
  type MarketOrderCreatedPayload,
  type MoveJobCompletedPayload,
} from "../src/platform/eventing/normalize.js";
import { ACCEPTED_INBOUND_TYPES } from "../src/platform/eventing/ingress.js";
import { testId } from "./support/ids.js";

const RECEIVED_AT = "2026-03-04T10:00:00.000Z";
const ORG = testId("norm-org");
const FULFILLMENT = testId("norm-fulfillment");

function envelope(
  eventType: string,
  payload: unknown,
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    ...makeEvent({
      event_type: eventType,
      version: 1,
      producer: eventType.startsWith("market.") ? "wasla-market" : "wasla-move",
      occurred_at: new Date("2026-03-04T09:00:00.000Z"),
      correlation_id: "corr-norm",
      entity_type: "commercial_order",
      entity_id: "order-1",
      payload: payload as Record<string, unknown>,
    }),
    ...overrides,
  };
}

function rejection(raw: unknown) {
  const result = normalize(raw, RECEIVED_AT);
  if (result.ok) throw new Error("expected a rejection, got a canonical event");
  return result;
}

function accepted(raw: unknown) {
  const result = normalize(raw, RECEIVED_AT);
  if (!result.ok) throw new Error(`expected acceptance, got ${result.detail}`);
  return result.event;
}

describe("inbound event normalisation", () => {
  it("turns a valid market order into a canonical event", () => {
    const raw = envelope("market.order.created", {
      order_id: "ORD-1",
      organization_id: ORG,
      requested_service: "delivery",
      payment_authorization_id: testId("norm-hold"),
    });
    const event = accepted(raw);

    expect(event.event_type).toBe("market.order.created");
    expect(event.version).toBe(1);
    expect(event.producer).toBe("wasla-market");
    expect(event.event_id).toBe(raw.event_id);
    // The two clocks stay apart: one is MARKET's claim, one is CORE's receipt.
    expect(event.occurred_at).toBe("2026-03-04T09:00:00.000Z");
    expect(event.received_at).toBe(RECEIVED_AT);
    // The only inbound event that names its tenant.
    expect(event.organization_id).toBe(ORG);
    expect(event.payload).toEqual({
      order_id: "ORD-1",
      organization_id: ORG,
      requested_service: "delivery",
      payment_authorization_id: testId("norm-hold"),
    });
    // The envelope survives untouched, which is what lets replay republish the
    // stored bytes rather than a reconstruction of them.
    expect(event.envelope).toBe(raw);
  });

  it("normalises a historical order that predates payment_authorization_id", () => {
    // The real backwards-compatibility case in this repository:
    // `payment_authorization_id` was added to `market.order.created` v1 after
    // the type was already in use, additively. Rows accepted before that carry
    // no such key at all.
    const withoutKey = accepted(
      envelope("market.order.created", {
        order_id: "ORD-OLD",
        organization_id: ORG,
        requested_service: "delivery",
      }),
    );
    const withExplicitNull = accepted(
      envelope("market.order.created", {
        order_id: "ORD-NEW",
        organization_id: ORG,
        requested_service: "delivery",
        payment_authorization_id: null,
      }),
    );

    // Absent and explicitly null are the same fact — "no hold was declared" —
    // and both become `null`. Neither is invented into an id.
    expect((withoutKey.payload as MarketOrderCreatedPayload).payment_authorization_id).toBeNull();
    expect(
      (withExplicitNull.payload as MarketOrderCreatedPayload).payment_authorization_id,
    ).toBeNull();
  });

  it("refuses a present but malformed hold reference instead of treating it as absent", () => {
    // A missing key means "no hold". A key holding rubbish means "this producer
    // is broken", which is a different fact and must not be quietly downgraded
    // to the first one.
    const result = rejection(
      envelope("market.order.created", {
        order_id: "ORD-2",
        organization_id: ORG,
        requested_service: "delivery",
        payment_authorization_id: "",
      }),
    );
    expect(result.rejection).toBe("payload_malformed");
    expect(result.detail).toContain("payment_authorization_id");
  });

  it("leaves move events without a tenant scope rather than guessing one", () => {
    for (const [type, payload] of [
      ["move.job.accepted", { fulfillment_id: FULFILLMENT, job_id: "J1", accepted_at: RECEIVED_AT }],
      ["move.job.rejected", { fulfillment_id: FULFILLMENT, reason: "no_capacity", rejected_at: RECEIVED_AT }],
      [
        "move.job.completed",
        { fulfillment_id: FULFILLMENT, job_id: "J1", outcome: "completed", completed_at: RECEIVED_AT },
      ],
    ] as const) {
      const event = accepted(envelope(type, payload));
      // `null` is the honest answer: the envelope carries an opaque fulfillment
      // reference and nothing that names an organization. Resolving one would
      // mean looking the fulfillment up and assuming — the mislinking B-23
      // exists to prevent.
      expect(event.organization_id).toBeNull();
    }
  });

  it("normalises timestamps to UTC so producers with different formats compare", () => {
    const event = accepted(
      envelope("move.job.completed", {
        fulfillment_id: FULFILLMENT,
        job_id: "J1",
        outcome: "completed",
        completed_at: "2026-03-04T13:00:00+03:00",
      }),
    );
    expect((event.payload as MoveJobCompletedPayload).completed_at).toBe("2026-03-04T10:00:00.000Z");
  });

  it("refuses an unknown event type", () => {
    const result = rejection(envelope("market.order.archived", { order_id: "ORD-3" }));
    expect(result.rejection).toBe("unknown_event_type");
    expect(result.detail).toContain("market.order.archived");
  });

  it("refuses an unsupported version and says which versions it can read", () => {
    const result = rejection(
      envelope(
        "market.order.created",
        { order_id: "ORD-4", organization_id: ORG, requested_service: "delivery" },
        { version: 7 },
      ),
    );
    // The most dangerous case to guess at: version 7's fields may look familiar
    // and mean something else entirely.
    expect(result.rejection).toBe("unsupported_version");
    expect(result.detail).toContain("version 7");
    expect(result.detail).toContain("supported: 1");
    expect(supportedVersions("market.order.created")).toEqual([1]);
  });

  it("refuses a payload missing a field the contract requires", () => {
    const result = rejection(
      envelope("move.job.rejected", { fulfillment_id: FULFILLMENT, reason: "no_capacity" }),
    );
    // The exact gap this layer was built to close: the consumer used to accept
    // this, while `contracts/events/move.job.rejected.schema.json` requires
    // `rejected_at`.
    expect(result.rejection).toBe("payload_malformed");
    expect(result.detail).toContain("rejected_at");
  });

  it("refuses a payload carrying a field the contract does not declare", () => {
    const result = rejection(
      envelope("move.job.completed", {
        fulfillment_id: FULFILLMENT,
        job_id: "J1",
        outcome: "completed",
        completed_at: RECEIVED_AT,
        reason: "why-is-this-here",
      }),
    );
    // Every inbound contract is `additionalProperties: false`. An unexpected key
    // means the producer is running something CORE does not understand, and the
    // safe reading of that is to stop rather than to use the familiar-looking
    // parts.
    expect(result.rejection).toBe("payload_malformed");
    expect(result.detail).toContain("reason");
    // Names the key, never the value: a payload can carry personal data and this
    // string ends up in logs and reports.
    expect(result.detail).not.toContain("why-is-this-here");
  });

  it("refuses an outcome outside the contract's enumeration", () => {
    const result = rejection(
      envelope("move.job.completed", {
        fulfillment_id: FULFILLMENT,
        job_id: "J1",
        outcome: "partially_completed",
        completed_at: RECEIVED_AT,
      }),
    );
    expect(result.rejection).toBe("payload_malformed");
    expect(result.detail).toContain("outcome");
  });

  it("refuses an unreadable timestamp rather than substituting a clock", () => {
    const result = rejection(
      envelope("move.job.accepted", {
        fulfillment_id: FULFILLMENT,
        job_id: "J1",
        accepted_at: "last tuesday",
      }),
    );
    expect(result.rejection).toBe("payload_malformed");
    expect(result.detail).toContain("accepted_at");
  });

  it("refuses a malformed envelope without inspecting the payload", () => {
    for (const raw of [
      null,
      undefined,
      42,
      "an event",
      {},
      { event_type: "market.order.created" },
      [],
    ]) {
      expect(rejection(raw).rejection).toBe("envelope_malformed");
    }
  });

  it("refuses a payload that is not an object", () => {
    for (const payload of ["text", 7, [], null]) {
      const result = rejection(envelope("market.order.created", payload));
      // `null` fails the envelope's own structural check; the rest fail here.
      expect(["payload_malformed", "envelope_malformed"]).toContain(result.rejection);
    }
  });

  it("never throws, whatever it is handed", () => {
    // Replay classifies thousands of historical rows with this function before
    // touching anything. A classifier that can throw would make a dry-run
    // unable to report on the very rows most likely to be broken.
    const nasty: unknown[] = [
      Symbol("x"),
      () => 1,
      new Map(),
      { ...envelope("market.order.created", { order_id: 1 }) },
      { ...envelope("move.job.accepted", { fulfillment_id: [] }) },
    ];
    for (const raw of nasty) {
      expect(() => normalize(raw, RECEIVED_AT)).not.toThrow();
    }
  });

  it("exposes one list of readable types, shared with the ingress edge", () => {
    // Two lists would drift, and the drift would be silent in the worst
    // direction: a type accepted at the edge that no normaliser can read.
    expect([...ACCEPTED_INBOUND_TYPES].sort()).toEqual([...normalizableEventTypes()].sort());
    expect(normalizableEventTypes()).toHaveLength(4);
  });

  it("raises a 400-shaped error at the edge", () => {
    const raw = envelope("market.order.created", { order_id: "ORD-5" });
    try {
      normalizeOrThrow(raw, RECEIVED_AT);
      throw new Error("expected normalizeOrThrow to throw");
    } catch (error) {
      const err = error as { code?: string; details?: Record<string, unknown> };
      expect(err.code).toBe("invalid_request");
      expect(err.details?.["rejection"]).toBe("payload_malformed");
    }
  });

  it("gives consumers one shared reading of a payload", () => {
    const raw = envelope("move.job.accepted", {
      fulfillment_id: FULFILLMENT,
      job_id: "J1",
      accepted_at: RECEIVED_AT,
    });
    expect(canonicalPayload(raw, "move.job.accepted")).toEqual({
      fulfillment_id: FULFILLMENT,
      job_id: "J1",
      accepted_at: RECEIVED_AT,
    });
    // A handler that is passed the wrong event learns immediately, rather than
    // reading fields that happen to share a name.
    expect(() => canonicalPayload(raw, "move.job.completed")).toThrow(/expected move.job.completed/);
  });
});
