import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { assertId, isId, newId } from "../src/platform/ids.js";
import { createCoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { testId } from "./support/ids.js";

/**
 * These tests pin the identity decision recorded in `docs/identifiers.md`.
 *
 * Every CORE-owned key is `uuid` in the schema, the OpenAPI contract declares
 * `format: uuid` on every one of them, and `newId` returns UUID v4. Three of
 * the four layers already agreed; the domain layer had no opinion, and the
 * fixtures lived in that gap. The gap mattered because a `Map` accepts
 * `"org-1"` and Postgres does not, so the two backends disagreed about which
 * commands were even well formed.
 */
describe("identifier identity", () => {
  it("issues UUIDs and accepts nothing else as a CORE identifier", () => {
    expect(isId(newId())).toBe(true);
    expect(isId(randomUUID())).toBe(true);
    expect(isId("org-1")).toBe(false);
    expect(isId("")).toBe(false);
    expect(isId(undefined)).toBe(false);
    // Right length, wrong alphabet — a guard on length alone would pass this.
    expect(isId("zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz")).toBe(false);
    expect(() => assertId("organization_id", "org-1")).toThrow(/organization_id must be a UUID/);
  });

  it("does not echo the rejected value back to the caller", () => {
    // The identifier arrives from outside CORE and this message reaches logs.
    expect(() => assertId("wallet_id", "<script>alert(1)</script>")).toThrow(
      /^wallet_id must be a UUID$/,
    );
  });

  it("rejects a malformed identifier as a bad request, not as a missing row", () => {
    const core = createCoreApp({ clock: new FixedClock() });
    // Before the guard this was `notFound` in memory and an opaque
    // `invalid input syntax for type uuid` on Postgres. Now both say the same
    // thing, and they say the accurate thing: the request was malformed.
    return expect(
      core.money.createWallet({
        owner_type: "organization",
        owner_id: "org-1",
        currency: "SAR",
        correlation_id: "corr-1",
      }),
    ).rejects.toThrow(/owner_id must be a UUID/);
  });

  it("leaves references CORE does not own free-form", async () => {
    const core = createCoreApp({ clock: new FixedClock() });
    const org = await core.organization.create({
      name: "Acme",
      country_code: "SA",
      correlation_id: "corr-1",
    });

    // MARKET's order id is MARKET's business. Constraining its format would be
    // CORE inventing rules for data it does not issue.
    const fulfillment = await core.fulfillment.consumeMarketOrder({
      event_id: randomUUID(),
      event_type: "market.order.created",
      version: 1,
      producer: "wasla-market",
      occurred_at: "2026-01-01T00:00:00.000Z",
      correlation_id: "corr-1",
      causation_id: null,
      entity_type: "order",
      entity_id: "ORD/2026/000123",
      payload: {
        order_id: "ORD/2026/000123",
        organization_id: org.organization_id,
        requested_service: "delivery",
      },
    });

    expect(fulfillment.market_order_reference).toBe("ORD/2026/000123");
    expect(isId(fulfillment.fulfillment_id)).toBe(true);
  });

  it("keeps fixture identifiers well formed and distinct", () => {
    expect(isId(testId("org-1"))).toBe(true);
    expect(testId("org-1")).toBe(testId("org-1"));
    expect(testId("org-1")).not.toBe(testId("org-2"));
  });
});
