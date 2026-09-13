/**
 * Selection parity for the HTTP read surface — milestone 23.
 *
 * Milestone 21 asked the three eventing queues whether the two backends pick the
 * same rows in the same order; milestone 22 asked the module repositories the
 * same question. Both found real divergence and both fixed it **below** the
 * routes. Neither proved that what a caller receives over HTTP is what the store
 * returned, and that gap is where this file starts: a selection can be perfectly
 * parity-checked at the store and then be re-filtered, re-ordered, truncated or
 * silently substituted by the route that serves it.
 *
 * What it measured, before anything was changed:
 *
 *  1. **The eventing routes returned insertion order.** Milestone 22's record
 *     claimed every listing in the repository was gated; it had gated the module
 *     repositories only. `InMemoryOutbox`, `InMemoryInboundStore` and
 *     `InMemoryDeliveryStore` still returned `Map` iteration order where their
 *     SQL sorted, and two routes exposed it — `GET /v1/event-subscriptions` and
 *     `GET /v1/event-deliveries/undelivered`. Seeded newest-first, the reference
 *     backend answered those routes in the exact reverse of Postgres.
 *  2. **`undelivered()` concatenated two ordered queries.** `byStatus("pending")`
 *     followed by `byStatus("dead")`, appended. Both halves sorted, the answer
 *     not: every pending row preceded every dead row whatever their ages.
 *  3. **Eight SQL orders were not total** (`order by created_at` with no id
 *     tiebreak), so rows sharing a timestamp came back in whatever order the plan
 *     produced.
 *  4. **The query string was read loosely.** A repeated parameter lost every
 *     value but the first, `?organization_id=` became a filter on `""` that
 *     answered `count: 0` for a tenant that has rows, and `Number()` accepted
 *     `limit=0x10` (16 rows) and `limit=1e3` (1000 rows, past the documented
 *     maximum of 500).
 *  5. **Text ordering depended on the deployment.** `orderedBy` compared with
 *     `localeCompare`, which sorts case- and punctuation-insensitively and agrees
 *     with no Postgres collation; and the server collation is itself a property
 *     of the database — this machine's is `C`, CI's `postgres:16` container comes
 *     up `en_US.utf8`. A declared text order would have had a different correct
 *     answer in each place.
 *
 * How the properties are kept, the same three as milestones 21 and 22 plus one:
 *
 *  1. Every case declares its **row count**, asserted against the reference
 *     backend with no database present, so a case that selects nothing fails
 *     instead of passing vacuously.
 *  2. Every list case declares the **order it must return**, computed from the
 *     fixture definitions rather than read back from a store, so "both backends
 *     agree" cannot mean "both are wrong the same way".
 *  3. A **premise** test proves both backends hold the same population before any
 *     selection runs.
 *  4. A **coverage** test reads the router's own registrations and fails when a
 *     GET route is neither gated here nor explicitly declared not-a-listing. A
 *     read route nobody gated is the only defect the first three cannot see.
 *
 * The population is seeded through the stores and read **through the Router**,
 * which is the split the milestone asked to decide. Seeding through HTTP would
 * have limited the fixtures to what the write routes accept — `created_at` is
 * assigned by the server, so several rows could not be given the same timestamp
 * and no tiebreak would ever be exercised — and it is the read path, not the
 * write path, that this file exists to measure. Every row is written in the
 * **reverse** of the order its route must return.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { FixedClock } from "../src/platform/clock.js";
import { createCoreApp, type CoreApp } from "../src/app.js";
import {
  memoryPersistence,
  postgresPersistence,
  type Persistence,
} from "../src/platform/persistence/backends.js";
import { NO_SCOPE } from "../src/platform/persistence/transaction.js";
import { makeEvent } from "../src/platform/eventing/envelope.js";
import {
  delivery,
  eventSubscription,
  notification,
  seedCountry,
  seedTenant,
} from "./support/rows.js";

const url = process.env["DATABASE_URL"];
const START = new Date("2026-06-01T00:00:00.000Z");
const MINUTE = 60_000;

const ORG = "00000000-0000-4000-8000-00000000a001";
const OTHER_ORG = "00000000-0000-4000-8000-00000000a002";

/** Deterministic ids, so a declared order can name the rows it expects. */
const id = (n: number): string => `00000000-0000-4000-9000-${n.toString(16).padStart(12, "0")}`;
const at = (minutes: number): string => new Date(START.getTime() + minutes * MINUTE).toISOString();

/** The population, by the names the cases below refer to. */
interface Population {
  readonly identityId: string;
  readonly token: string;
  readonly regionId: string;
  readonly cityId: string;
  readonly subjectId: string;
}

/**
 * Builds the whole read surface's population.
 *
 * Rules followed by every batch here, and the reason each one exists:
 *  - inserted in the reverse of the order its route must return, so insertion
 *    order is distinguishable from a sort;
 *  - at least one batch has two rows sharing the sort's leading key, so a
 *    non-total order has a tie to get wrong;
 *  - at least one batch has values that a case-insensitive comparison would
 *    order differently from a byte comparison, so the collation pinning is
 *    exercised rather than assumed;
 *  - one tenant's rows sit beside another's, so a route that forgets to scope
 *    returns too many.
 */
async function populate(core: CoreApp, store: Persistence): Promise<Population> {
  await seedCountry(store);
  await seedTenant(store, ORG);
  await seedTenant(store, OTHER_ORG);

  // ── identity and a session, so the reads can be made at all ──
  const registered = await core.identity.registerIdentity({
    channel_type: "web",
    external_id: "http-parity-admin",
    correlation_id: "http-parity",
  });
  const principalId = registered.principal.principal_id;
  for (const organizationId of [ORG, OTHER_ORG]) {
    await core.identity.grantMembership({
      principal_id: principalId,
      organization_id: organizationId,
      roles: ["platform_admin"],
      correlation_id: "http-parity",
    });
  }
  const { token } = await core.identity.issueSession({
    principal_id: principalId,
    channel_type: "web",
    correlation_id: "http-parity",
  });

  // ── geography: countries by code, regions by code, cities by (name, id) ──
  // Countries inserted descending. `SA` already exists from `seedTenant`.
  for (const code of ["QA", "KW", "BH"]) {
    await store.geography.upsertCountry(
      { country_code: code, name: `Country ${code}`, default_currency: "SAR", status: "active" },
      NO_SCOPE,
    );
  }
  // Region codes chosen so that a case-insensitive comparison disagrees with a
  // byte comparison: `localeCompare` puts `r-b` before `R-B`, every Postgres
  // `C` collation puts `R-B` first. Inserted in neither order.
  const regionCodes: readonly [string, string][] = [
    [id(0x201), "r-b"],
    [id(0x202), "R-A"],
    [id(0x203), "R-B"],
  ];
  for (const [regionId, code] of regionCodes) {
    await store.geography.insertRegion(
      { region_id: regionId, country_code: "SA", code, name: `Region ${code}`, status: "active" },
      NO_SCOPE,
    );
  }
  const regionId = id(0x202);
  // Two cities share a name, so `order by name` alone cannot decide them and the
  // `city_id` tiebreak is what makes the answer the same twice.
  const cities: readonly [string, string][] = [
    [id(0x212), "Zahra"],
    [id(0x211), "Zahra"],
    [id(0x210), "Amir"],
  ];
  for (const [cityId, name] of cities) {
    await store.geography.insertCity(
      {
        city_id: cityId,
        region_id: regionId,
        country_code: "SA",
        name,
        latitude: 21.5,
        longitude: 39.2,
        status: "active",
      },
      NO_SCOPE,
    );
  }
  const cityId = id(0x210);
  // Two service areas centred on the same point, so they are equidistant from
  // the probe: the distance sort has a tie, and only the repository's own
  // `(name, id)` order can break it identically on both backends.
  const areas: readonly [string, string, number][] = [
    [id(0x222), "Ring", 20_000],
    [id(0x221), "Centre", 20_000],
    [id(0x220), "Far", 4_000],
  ];
  for (const [areaId, name, radius] of areas) {
    await store.geography.insertServiceArea(
      {
        service_area_id: areaId,
        city_id: cityId,
        country_code: "SA",
        name,
        centre_latitude: 21.5,
        centre_longitude: 39.2,
        radius_metres: radius,
        status: "active",
      },
      NO_SCOPE,
    );
  }

  // ── plans: by code, inserted descending ──
  for (const [n, code] of [
    [0x231, "plan-c"],
    [0x232, "plan-b"],
    [0x233, "plan-a"],
  ] as const) {
    await store.subscription.insertPlan(
      {
        plan_id: id(n),
        code,
        name: `Plan ${code}`,
        currency: "SAR",
        amount_minor: 1_000,
        billing_interval: "month",
        interval_count: 1,
        status: n === 0x233 ? "draft" : "active",
        created_at: at(0),
        activated_at: n === 0x233 ? null : at(0),
        retired_at: null,
      },
      NO_SCOPE,
    );
  }

  // ── notification recipients: by (created_at, recipient_id), inserted newest-first ──
  const recipients: readonly [string, string, string | null, "telegram" | "email" | "phone"][] = [
    [id(0x241), at(30), ORG, "telegram"],
    [id(0x242), at(20), ORG, "email"],
    // Same timestamp as the row above: the id tiebreak decides these two.
    [id(0x243), at(20), OTHER_ORG, "telegram"],
    [id(0x244), at(10), null, "phone"],
  ];
  for (const [recipientId, createdAt, organizationId, channel] of recipients) {
    await store.notification.insertRecipient(
      {
        recipient_id: recipientId,
        organization_id: organizationId,
        event_type: "core.fulfillment.completed",
        identity_id: registered.identity.identity_id,
        channel,
        active: true,
        created_at: createdAt,
      },
      NO_SCOPE,
    );
  }

  // ── notifications: newest first by (created_at desc, notification_id desc),
  // so they are inserted oldest-first. `notification.event_id` carries a foreign
  // key to `outbox(event_id)`, which both backends now enforce, so each one
  // needs a published event.
  const notifications: readonly [string, string, string, string][] = [
    [id(0x251), at(10), ORG, id(0x261)],
    [id(0x252), at(20), ORG, id(0x262)],
    [id(0x253), at(20), OTHER_ORG, id(0x263)],
    [id(0x254), at(30), ORG, id(0x264)],
  ];
  for (const [notificationId, createdAt, organizationId, eventId] of notifications) {
    await store.outbox.append(
      {
        ...makeEvent({
          event_type: "core.fulfillment.completed",
          version: 1,
          producer: "core",
          occurred_at: new Date(START),
          correlation_id: "http-parity",
          entity_type: "fulfillment",
          entity_id: eventId,
          payload: {},
        }),
        event_id: eventId,
      },
      NO_SCOPE,
    );
    await store.notification.queue(
      {
        ...notification(organizationId === OTHER_ORG ? id(0x243) : id(0x241), organizationId, {
          event_id: eventId,
          idempotency_key: `http-parity-${notificationId}`,
        }),
        notification_id: notificationId,
        created_at: createdAt,
        next_attempt_at: createdAt,
        status: notificationId === id(0x254) ? "failed" : "pending",
        ...(notificationId === id(0x254) ? { failed_at: createdAt, last_error: "no adapter" } : {}),
      },
      NO_SCOPE,
    );
  }

  // ── reputation signals: newest first, inserted oldest-first, one pair sharing
  // a `recorded_at` so the id tiebreak is exercised, and one row in the other
  // tenant so a missing scope shows up as an extra row.
  const subjectId = id(0x270);
  const signals: readonly [string, string, string][] = [
    [id(0x271), at(10), ORG],
    [id(0x272), at(20), ORG],
    [id(0x273), at(20), ORG],
    [id(0x274), at(30), OTHER_ORG],
  ];
  for (const [signalId, recordedAt, organizationId] of signals) {
    await store.reputation.insertIfAbsent(
      {
        reputation_signal_id: signalId,
        organization_id: organizationId,
        subject_type: "identity",
        subject_id: subjectId,
        signal_kind: "service_rating",
        rating_value: 5,
        source_system: "market",
        source_reference: `http-parity-${signalId}`,
        occurred_at: recordedAt,
        recorded_at: recordedAt,
        correlation_id: "http-parity",
        retracted_at: null,
        retraction_reason: null,
      },
      NO_SCOPE,
    );
  }

  // ── fulfillments: by (created_at, fulfillment_id), inserted newest-first.
  // Each row is given a status/settlement pair that puts it in exactly one
  // reconciliation queue: `unsettled` is always inconsistent, and a cancelled
  // fulfillment that was executed anyway is always a pending decision (B-29).
  const fulfillments: readonly [string, string, "unsettled" | "released", boolean][] = [
    [id(0x281), at(30), "unsettled", false],
    [id(0x282), at(20), "unsettled", false],
    [id(0x283), at(20), "released", true],
    [id(0x284), at(10), "released", true],
  ];
  for (const [fulfillmentId, createdAt, settlement, executedAfterCancellation] of fulfillments) {
    await store.fulfillment.insert(
      {
        fulfillment_id: fulfillmentId,
        organization_id: ORG,
        market_order_reference: `order-${fulfillmentId}`,
        move_job_reference: executedAfterCancellation ? `job-${fulfillmentId}` : null,
        payment_authorization_id: null,
        // `completed` + `unsettled` and `cancelled` + `released`-after-execution
        // are the two pairs `fulfillment_settlement_alignment_check` allows that
        // land in the two reconciliation queues; an open row could not carry
        // `unsettled` at all, which is the schema refusing to describe money that
        // moved before the work was arranged.
        status: executedAfterCancellation ? "cancelled" : "completed",
        settlement_state: settlement,
        created_at: createdAt,
        completed_at: executedAfterCancellation ? null : createdAt,
        closure_reason: executedAfterCancellation ? "cancelled_upstream" : null,
        executed_after_cancellation_at: executedAfterCancellation ? createdAt : null,
        executed_after_cancellation_job_reference: executedAfterCancellation
          ? `job-${fulfillmentId}`
          : null,
      },
      NO_SCOPE,
    );
  }

  // ── event subscriptions: by (subscriber, event_type, subscription_id).
  // `Move-b` and `move-b` are the collation pair again, and two rows share a
  // subscriber so `event_type` and then the id have to decide them.
  const subscriptions: readonly [string, string, string][] = [
    [id(0x291), "move-b", "core.fulfillment.completed"],
    [id(0x292), "Move-b", "core.fulfillment.completed"],
    [id(0x293), "move-a", "core.fulfillment.failed"],
    [id(0x294), "move-a", "core.fulfillment.completed"],
  ];
  for (const [subscriptionId, subscriber, eventType] of subscriptions) {
    await store.delivery.insertSubscription(
      {
        ...eventSubscription(subscriber, eventType),
        subscription_id: subscriptionId,
        created_at: at(0),
      },
      NO_SCOPE,
    );
  }

  // ── deliveries: by (created_at, delivery_id) across pending **and** dead, so
  // a concatenation of two ordered queries is visibly not an ordered answer.
  const deliveries: readonly [string, string, "pending" | "dead" | "delivered", string, string][] = [
    [id(0x2a1), at(40), "pending", id(0x291), id(0x261)],
    [id(0x2a2), at(30), "dead", id(0x292), id(0x261)],
    [id(0x2a3), at(20), "pending", id(0x293), id(0x261)],
    // Inserted in the opposite order to their ids and carrying different
    // statuses at the same instant: whichever half of the tiebreak is missing —
    // the `delivery_id` in the SQL order or the single merged query — the
    // declared order below stops agreeing with at least one backend.
    [id(0x2a5), at(10), "pending", id(0x294), id(0x262)],
    [id(0x2a4), at(10), "dead", id(0x294), id(0x261)],
    // Delivered, so it must not appear in the undelivered listing at all — and it
    // is the oldest row, so a listing that forgot to filter by status would put
    // it first and be caught by the declared order as well as the count.
    [id(0x2a6), at(1), "delivered", id(0x293), id(0x262)],
  ];
  for (const [deliveryId, createdAt, status, subscriptionId, eventId] of deliveries) {
    await store.delivery.queue(
      {
        ...delivery(eventId, subscriptionId),
        delivery_id: deliveryId,
        created_at: createdAt,
        next_attempt_at: createdAt,
        status,
        ...(status === "dead" ? { attempts: 5, last_error: "gone" } : {}),
        ...(status === "delivered"
          ? { attempts: 1, delivered_at: createdAt, last_status: 200 }
          : {}),
      },
      NO_SCOPE,
    );
  }

  return { identityId: registered.identity.identity_id, token, regionId, cityId, subjectId };
}

/**
 * A gated read: a request, the number of rows it must return, and the row
 * identities it must return them in.
 *
 * `order` is written out rather than derived from a query, which is the point of
 * property 2: these literals come from the fixture definitions above, so a
 * backend that agrees with the other one and disagrees with this list still
 * fails.
 */
interface ListCase {
  readonly name: string;
  readonly path: (p: Population) => string;
  readonly field: string;
  readonly order: (p: Population) => readonly string[];
  /** Which property of a returned item the declared order names. */
  readonly key?: (item: Record<string, unknown>) => string;
}

const short = (value: string): string => value.slice(-3);

const LIST_CASES: readonly ListCase[] = [
  {
    name: "GET /v1/geography/countries — by country_code",
    path: () => "/v1/geography/countries",
    field: "countries",
    order: () => ["BH", "KW", "QA", "SA"],
    key: (item) => String(item["country_code"]),
  },
  {
    name: "GET /v1/geography/countries/:country_code/regions — by code, byte order",
    path: () => "/v1/geography/countries/SA/regions",
    field: "regions",
    order: () => ["R-A", "R-B", "r-b"],
    key: (item) => String(item["code"]),
  },
  {
    name: "GET /v1/geography/regions/:region_id/cities — by name then id",
    path: (p) => `/v1/geography/regions/${p.regionId}/cities`,
    field: "cities",
    order: () => [id(0x210), id(0x211), id(0x212)].map(short),
    key: (item) => short(String(item["city_id"])),
  },
  {
    name: "GET /v1/geography/service-areas/resolve — by distance, ties by (name, id)",
    path: () => "/v1/geography/service-areas/resolve?latitude=21.5&longitude=39.2",
    field: "matches",
    // All three cover the point and the two 20km areas are equidistant with the
    // 4km one: the distances are 0, so the repository's order decides all three.
    order: () => [id(0x221), id(0x220), id(0x222)].map(short),
    key: (item) =>
      short(String((item["service_area"] as Record<string, unknown>)["service_area_id"])),
  },
  {
    name: "GET /v1/plans — by code",
    path: () => "/v1/plans",
    field: "plans",
    order: () => ["plan-a", "plan-b", "plan-c"],
    key: (item) => String(item["code"]),
  },
  {
    name: "GET /v1/plans?status=active — filtered, by code",
    path: () => "/v1/plans?status=active",
    field: "plans",
    order: () => ["plan-b", "plan-c"],
    key: (item) => String(item["code"]),
  },
  {
    name: "GET /v1/notification-recipients — by (created_at, recipient_id)",
    path: () => "/v1/notification-recipients",
    field: "items",
    order: () => [id(0x244), id(0x242), id(0x243), id(0x241)].map(short),
    key: (item) => short(String(item["recipient_id"])),
  },
  {
    name: "GET /v1/notification-recipients?organization_id=… — scoped to one tenant",
    path: () => `/v1/notification-recipients?organization_id=${ORG}`,
    field: "items",
    order: () => [id(0x242), id(0x241)].map(short),
    key: (item) => short(String(item["recipient_id"])),
  },
  {
    name: "GET /v1/notifications — newest first",
    path: () => "/v1/notifications",
    field: "items",
    order: () => [id(0x254), id(0x253), id(0x252), id(0x251)].map(short),
    key: (item) => short(String(item["notification_id"])),
  },
  {
    name: "GET /v1/notifications?limit=2 — newest first, bounded",
    path: () => "/v1/notifications?limit=2",
    field: "items",
    order: () => [id(0x254), id(0x253)].map(short),
    key: (item) => short(String(item["notification_id"])),
  },
  {
    name: "GET /v1/notifications?status=failed — filtered",
    path: () => "/v1/notifications?status=failed",
    field: "items",
    order: () => [id(0x254)].map(short),
    key: (item) => short(String(item["notification_id"])),
  },
  {
    name: "GET /v1/notifications?organization_id=… — scoped to one tenant",
    path: () => `/v1/notifications?organization_id=${ORG}`,
    field: "items",
    order: () => [id(0x254), id(0x252), id(0x251)].map(short),
    key: (item) => short(String(item["notification_id"])),
  },
  {
    name: "GET /v1/reputation/:type/:id/signals — newest first, ties by id",
    path: (p) => `/v1/reputation/identity/${p.subjectId}/signals?organization_id=${ORG}`,
    field: "items",
    order: () => [id(0x273), id(0x272), id(0x271)].map(short),
    key: (item) => short(String(item["reputation_signal_id"])),
  },
  {
    name: "GET /v1/reputation/:type/:id/signals?limit=2 — bounded",
    path: (p) => `/v1/reputation/identity/${p.subjectId}/signals?organization_id=${ORG}&limit=2`,
    field: "items",
    order: () => [id(0x273), id(0x272)].map(short),
    key: (item) => short(String(item["reputation_signal_id"])),
  },
  {
    name: "GET /v1/fulfillments/reconciliation/inconsistent — by (created_at, id)",
    path: () => `/v1/fulfillments/reconciliation/inconsistent?organization_id=${ORG}`,
    field: "items",
    // All four: this route reports everything not finished with money, which by
    // `isFinanciallyConsistent` includes the two rows waiting on a B-20 decision.
    // The two ties at minute 20 are broken by `fulfillment_id`.
    order: () => [id(0x284), id(0x282), id(0x283), id(0x281)].map(short),
    key: (item) => short(String(item["fulfillment_id"])),
  },
  {
    name: "GET /v1/fulfillments/reconciliation/pending-financial-decision — by (created_at, id)",
    path: () =>
      `/v1/fulfillments/reconciliation/pending-financial-decision?organization_id=${ORG}`,
    field: "items",
    order: () => [id(0x284), id(0x283)].map(short),
    key: (item) => short(String(item["fulfillment_id"])),
  },
  {
    name: "GET /v1/fulfillments/reconciliation/stale-holds — empty, and empty for a reason",
    path: () => `/v1/fulfillments/reconciliation/stale-holds?organization_id=${ORG}`,
    field: "items",
    // No fulfillment in the population names a payment authorization, so no open
    // work can have an unusable hold. Declared rather than skipped: an empty list
    // is the invariant this route reports, and a case that expects zero rows is
    // the only way a route that starts inventing them fails.
    order: () => [],
  },
  {
    name: "GET /v1/event-subscriptions — by (subscriber, event_type, id)",
    path: () => "/v1/event-subscriptions",
    field: "items",
    order: () => [id(0x292), id(0x294), id(0x293), id(0x291)].map(short),
    key: (item) => short(String(item["subscription_id"])),
  },
  {
    name: "GET /v1/event-deliveries/undelivered — pending and dead in one order",
    path: () => "/v1/event-deliveries/undelivered",
    field: "items",
    order: () => [id(0x2a4), id(0x2a5), id(0x2a3), id(0x2a2), id(0x2a1)].map(short),
    key: (item) => short(String(item["delivery_id"])),
  },
];

/**
 * GET routes that return no listing, with the reason.
 *
 * Present so the coverage test can insist on a decision for every registered
 * route: a new read route is either gated above or written down here, and
 * "nobody noticed it existed" is not one of the two options.
 */
const NOT_LISTINGS: Readonly<Record<string, string>> = {
  "/health": "liveness, a constant",
  "/ready": "readiness, one object",
  "/metrics": "Prometheus exposition, not JSON rows",
  "/v1/sessions/current": "the caller's own session, one object",
  "/v1/organizations/:organization_id": "one organization by id",
  "/v1/fulfillments/:fulfillment_id": "one fulfillment by id",
  "/v1/plans/:plan_id": "one plan; its grants are gated by the module parity suite",
  "/v1/subscriptions/:subscription_id": "one subscription by id",
  "/v1/wallets/:wallet_id/balance": "computed balances, one object",
  "/v1/reputation/:subject_type/:subject_id":
    "the derived standing, one object; the signals behind it are gated above",
};

/** Parameter readings that must be refused rather than answered plausibly. */
const REFUSED: readonly { readonly name: string; readonly path: string }[] = [
  { name: "a repeated filter", path: "/v1/notifications?status=failed&status=pending" },
  { name: "a repeated tenant", path: `/v1/notifications?organization_id=${ORG}&organization_id=${OTHER_ORG}` },
  { name: "a repeated limit", path: "/v1/notifications?limit=1&limit=2" },
  { name: "an empty tenant filter", path: "/v1/notifications?organization_id=" },
  { name: "an empty status filter", path: "/v1/notifications?status=" },
  // A value outside the vocabulary must be refused, not treated as a filter that
  // happens to match nothing: an empty page and a rejected request are different
  // answers, and only one of them tells the caller they asked for a status the
  // system does not have.
  { name: "an unknown status filter", path: "/v1/notifications?status=pendng" },
  { name: "a status filter in the wrong case", path: "/v1/notifications?status=FAILED" },
  { name: "an unknown plan status", path: "/v1/plans?status=activated" },
  // The tenant scope on a reconciliation queue is not optional: without it the
  // route would report other tenants' rows to whoever asked.
  { name: "a reconciliation queue with no tenant", path: "/v1/fulfillments/reconciliation/inconsistent" },
  {
    name: "a stale-holds queue with no tenant",
    path: "/v1/fulfillments/reconciliation/stale-holds",
  },
  { name: "a resolve with no latitude", path: "/v1/geography/service-areas/resolve?longitude=39.2" },
  { name: "an empty limit", path: "/v1/notifications?limit=" },
  { name: "a hexadecimal limit", path: "/v1/notifications?limit=0x10" },
  { name: "an exponential limit", path: "/v1/notifications?limit=1e3" },
  { name: "a padded limit", path: "/v1/notifications?limit=%205" },
  { name: "a signed limit", path: "/v1/notifications?limit=%2B5" },
  { name: "a decimal limit", path: "/v1/notifications?limit=5.0" },
  { name: "a limit past the maximum", path: "/v1/notifications?limit=501" },
  { name: "a zero limit", path: "/v1/notifications?limit=0" },
  { name: "an empty recipients tenant", path: "/v1/notification-recipients?organization_id=" },
  { name: "an empty plan status", path: "/v1/plans?status=" },
  { name: "a repeated plan status", path: "/v1/plans?status=draft&status=active" },
  { name: "an empty reconciliation tenant", path: "/v1/fulfillments/reconciliation/inconsistent?organization_id=" },
  {
    name: "a repeated reconciliation tenant",
    path: `/v1/fulfillments/reconciliation/inconsistent?organization_id=${ORG}&organization_id=${OTHER_ORG}`,
  },
  { name: "a hexadecimal coordinate", path: "/v1/geography/service-areas/resolve?latitude=0x15&longitude=39.2" },
  { name: "an exponential coordinate", path: "/v1/geography/service-areas/resolve?latitude=2.15e1&longitude=39.2" },
  { name: "a repeated coordinate", path: "/v1/geography/service-areas/resolve?latitude=21.5&latitude=1&longitude=39.2" },
  { name: "an empty country filter", path: "/v1/geography/service-areas/resolve?latitude=21.5&longitude=39.2&country_code=" },
];

interface Backend {
  readonly kind: string;
  readonly core: CoreApp;
  readonly store: Persistence;
  readonly population: Population;
}

async function read(
  backend: Backend,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await backend.core.router.handle({
    method: "GET",
    url: path,
    headers: { authorization: `Bearer ${backend.population.token}` },
  });
  return { status: response.status, body: (response.body ?? {}) as Record<string, unknown> };
}

function rows(body: Record<string, unknown>, field: string): Record<string, unknown>[] {
  const value = body[field];
  if (!Array.isArray(value)) {
    throw new Error(`expected an array at "${field}", received ${JSON.stringify(body).slice(0, 200)}`);
  }
  return value as Record<string, unknown>[];
}

describe("selection parity for the HTTP read surface", () => {
  const backends: Backend[] = [];
  let pool: Pool | undefined;

  beforeAll(async () => {
    const memoryClock = new FixedClock(START);
    const memory = memoryPersistence(memoryClock);
    const memoryCore = createCoreApp({ clock: memoryClock, persistence: memory, rateLimit: false });
    backends.push({
      kind: "memory",
      core: memoryCore,
      store: memory,
      population: await populate(memoryCore, memory),
    });

    if (!url) return;
    pool = new Pool({ connectionString: url });
    await pool.query(
      `truncate event_delivery, event_subscription, inbound_event, notification,
       notification_recipient, reputation_signal, fulfillment, plan_grant, plan,
       subscription, membership, session, principal, identity_link, identity,
       organization, outbox, audit_entry, service_area, city, region, country
       restart identity cascade`,
    );
    const pgClock = new FixedClock(START);
    const pg = postgresPersistence(pool, pgClock);
    const pgCore = createCoreApp({ clock: pgClock, persistence: pg, rateLimit: false });
    backends.push({
      kind: "postgres",
      core: pgCore,
      store: pg,
      population: await populate(pgCore, pg),
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  /**
   * Property 3. Runs before any selection is compared, because two backends that
   * hold different rows can agree about a listing and mean nothing by it.
   */
  it("holds the same population on both backends", async () => {
    // Which halves are actually being measured, stated rather than assumed: a
    // run that silently dropped the Postgres backend would otherwise report the
    // same 43 green tests as a run that compared both.
    expect(backends.map((backend) => backend.kind)).toEqual(
      url ? ["memory", "postgres"] : ["memory"],
    );
    const censuses = await Promise.all(
      backends.map(async (backend) => ({
        kind: backend.kind,
        countries: (await backend.store.geography.listCountries()).map((c) => c.country_code),
        regions: (await backend.store.geography.listRegions("SA")).map((r) => r.region_id).sort(),
        cities: (await backend.store.geography.listCities(backend.population.regionId))
          .map((c) => c.city_id)
          .sort(),
        areas: (await backend.store.geography.listServiceAreas()).map((a) => a.service_area_id).sort(),
        plans: (await backend.store.subscription.listPlans()).map((p) => p.plan_id).sort(),
        recipients: (await backend.store.notification.listRecipients())
          .map((r) => r.recipient_id)
          .sort(),
        notifications: (await backend.store.notification.list({ limit: 500 })).map((n) => n.notification_id).sort(),
        fulfillments: (await backend.store.fulfillment.all()).map((f) => f.fulfillment_id).sort(),
        subscriptions: (await backend.store.delivery.listSubscriptions())
          .map((s) => s.subscription_id)
          .sort(),
        deliveries: (await backend.store.delivery.all()).map((d) => d.delivery_id).sort(),
      })),
    );
    // Declared, not merely compared: the counts come from the fixture
    // definitions, so a population that shrank on both backends still fails.
    for (const census of censuses) {
      expect(census.countries.length, `${census.kind} countries`).toBe(4);
      expect(census.regions.length, `${census.kind} regions`).toBe(3);
      expect(census.cities.length, `${census.kind} cities`).toBe(3);
      expect(census.areas.length, `${census.kind} service areas`).toBe(3);
      expect(census.plans.length, `${census.kind} plans`).toBe(3);
      expect(census.recipients.length, `${census.kind} recipients`).toBe(4);
      expect(census.notifications.length, `${census.kind} notifications`).toBe(4);
      expect(census.fulfillments.length, `${census.kind} fulfillments`).toBe(4);
      expect(census.subscriptions.length, `${census.kind} subscriptions`).toBe(4);
      expect(census.deliveries.length, `${census.kind} deliveries`).toBe(6);
    }
    for (const census of censuses.slice(1)) {
      expect({ ...census, kind: censuses[0]!.kind }).toEqual(censuses[0]);
    }
  });

  /**
   * Properties 1 and 2, per case: the declared count, the declared order, and —
   * when a database is present — the same answer from both backends.
   */
  for (const listCase of LIST_CASES) {
    it(`${listCase.name}`, async () => {
      const expected = listCase.order(backends[0]!.population);
      const answers: Record<string, readonly string[]> = {};
      for (const backend of backends) {
        const response = await read(backend, listCase.path(backend.population));
        expect(response.status, `${backend.kind} status`).toBe(200);
        const items = rows(response.body, listCase.field);
        expect(items.length, `${backend.kind} row count`).toBe(expected.length);
        const key = listCase.key;
        answers[backend.kind] = key ? items.map(key) : [];
        expect(answers[backend.kind], `${backend.kind} order`).toEqual(expected);
        // `count` is what a caller reads instead of measuring the array, so it
        // has to agree with the array it describes.
        if (typeof response.body["count"] === "number") {
          expect(response.body["count"], `${backend.kind} count field`).toBe(items.length);
        }
      }
      const kinds = Object.keys(answers);
      for (const kind of kinds.slice(1)) {
        expect(answers[kind], `${kind} vs ${kinds[0]}`).toEqual(answers[kinds[0]!]);
      }
    });
  }

  for (const refusal of REFUSED) {
    it(`refuses ${refusal.name}`, async () => {
      for (const backend of backends) {
        const response = await read(backend, refusal.path);
        expect(response.status, `${backend.kind} ${refusal.path}`).toBe(400);
        expect(response.body["code"], `${backend.kind} ${refusal.path}`).toBe("invalid_request");
      }
    });
  }

  /**
   * Property 4. The router is asked what it serves, rather than a list here being
   * trusted to still be complete.
   */
  it("gates every registered GET route", () => {
    const gated = new Set(
      LIST_CASES.map((listCase) => {
        const path = listCase.path(backends[0]!.population);
        return path.split("?")[0]!;
      }),
    );
    // A concrete request path is matched back to its template so a case written
    // with a real id still counts as covering the parameterised route.
    const covers = (template: string): boolean => {
      const segments = template.split("/").filter(Boolean);
      for (const path of gated) {
        const parts = path.split("/").filter(Boolean);
        if (parts.length !== segments.length) continue;
        if (segments.every((segment, i) => segment.startsWith(":") || segment === parts[i])) {
          return true;
        }
      }
      return false;
    };
    const ungated = backends[0]!.core.router
      .registrations()
      .filter((route) => route.method === "GET")
      .map((route) => route.template)
      .filter((template) => !covers(template) && NOT_LISTINGS[template] === undefined);
    expect(ungated, "GET routes neither gated nor declared not-a-listing").toEqual([]);

    // And the other direction: a route named in `NOT_LISTINGS` that no longer
    // exists is a stale exemption, which is how a real listing hides later.
    const registered = new Set(
      backends[0]!.core.router
        .registrations()
        .filter((route) => route.method === "GET")
        .map((route) => route.template),
    );
    expect(
      Object.keys(NOT_LISTINGS).filter((template) => !registered.has(template)),
      "declared not-a-listing but not registered",
    ).toEqual([]);
  });
});
