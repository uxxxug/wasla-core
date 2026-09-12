import { type Clock, systemClock } from "./platform/clock.js";
import { type AuditLog } from "./platform/audit/audit.js";
import { LocalEventBus } from "./platform/eventing/bus.js";
import { type OutboxStore } from "./platform/eventing/outbox.js";
import { memoryPersistence, type Persistence } from "./platform/persistence/backends.js";
import { type TransactionBoundary } from "./platform/persistence/transaction.js";
import { OutboxPublisher } from "./platform/eventing/publisher.js";
import { EventIngress } from "./platform/eventing/ingress.js";
import { ReplayService } from "./platform/replay/service.js";
import { registerIngressRoutes } from "./platform/eventing/ingress-http.js";
import { InboundDispatcher } from "./platform/eventing/dispatcher.js";
import {
  DeliveryFanOut,
  DeliveryWorker,
  SubscriptionRegistry,
  type EventTransport,
} from "./platform/eventing/delivery.js";
import { FetchTransport } from "./platform/eventing/fetch-transport.js";
import { registerDeliveryRoutes } from "./platform/eventing/delivery-http.js";
import { newId } from "./platform/ids.js";
import { Router } from "./platform/http/router.js";
import {
  DEFAULT_RATE_LIMIT_POLICY,
  RateLimiter,
  type RateLimitPolicy,
  type RateLimitWindowStore,
} from "./platform/http/rate-limit.js";
import { MetricsRegistry } from "./platform/observability/metrics.js";
import { registerMetricsRoutes } from "./platform/observability/http.js";
import { DepthSampler } from "./platform/observability/sampler.js";
import { workerMetrics } from "./platform/observability/worker-metrics.js";
import { IdentityService } from "./modules/identity-access/service.js";
import { OrganizationService } from "./modules/organization/service.js";
import { registerIdentityRoutes } from "./modules/identity-access/http.js";
import { registerOrganizationRoutes } from "./modules/organization/http.js";
import { MoneyService } from "./modules/money/service.js";
import { registerMoneyRoutes } from "./modules/money/http.js";
import { FulfillmentService } from "./modules/fulfillment/service.js";
import { registerFulfillmentRoutes } from "./modules/fulfillment/http.js";
import { GeographyService } from "./modules/geography/service.js";
import { registerGeographyRoutes } from "./modules/geography/http.js";
import { SubscriptionService } from "./modules/subscription/service.js";
import { registerSubscriptionRoutes } from "./modules/subscription/http.js";
import {
  NotificationDispatcher,
  NotificationFanOut,
  NotificationReadService,
  NotificationRecipientRegistry,
} from "./modules/notification/service.js";
import { IdentityChannelDirectory } from "./modules/notification/identity-directory.js";
import { registerNotificationRoutes } from "./modules/notification/http.js";
import type { NotificationChannel } from "./modules/notification/ports.js";

export interface CoreApp {
  router: Router;
  bus: LocalEventBus;
  outbox: OutboxStore;
  boundary: TransactionBoundary;
  publisher: OutboxPublisher;
  ingress: EventIngress;
  dispatcher: InboundDispatcher;
  /**
   * Historical replay (milestone 6). On the bundle rather than behind the CLI so
   * it is the same object, with the same consumers subscribed, that an operator
   * drives and a test asserts on. A replay path wired separately from the
   * application would be a second delivery path, and the whole point is that
   * there is only one.
   */
  replay: ReplayService;
  subscriptions: SubscriptionRegistry;
  deliveries: DeliveryWorker;
  /**
   * Notifications to people. Named apart from `subscriptions`/`deliveries` on
   * purpose: those reach systems over signed HTTP, these reach a person on a
   * channel, and one bundle holding both must not let them answer to one name.
   */
  notificationRecipients: NotificationRecipientRegistry;
  notifications: NotificationReadService;
  notificationDispatcher: NotificationDispatcher;
  /**
   * Exposed because a redelivered event is a case worth testing directly: the
   * relay already calls it, and asserting that a second call queues nothing
   * needs the same object the relay uses, not a copy of it.
   */
  notificationFanOut: NotificationFanOut;
  audit: AuditLog;
  identity: IdentityService;
  organization: OrganizationService;
  money: MoneyService;
  /**
   * ADR 0013: plans, subscriptions, periods, usage and the entitlement
   * decision. Named `billing` on this bundle and not `subscriptions`, because
   * `subscriptions` above is the event-delivery registry and two unrelated
   * things answering to one name is how a caller ends up wiring the wrong one.
   */
  billing: SubscriptionService;
  fulfillment: FulfillmentService;
  geography: GeographyService;
  clock: Clock;
  /**
   * Counters, gauges and histograms for the whole process. Exposed on the bundle
   * so a test can read a value without parsing the exposition, and so the
   * operator loop can be written outside CORE.
   */
  metrics: MetricsRegistry;
  /**
   * Refreshes the queue-depth gauges. Not called by the metrics endpoint — see
   * `DepthSampler` for why the scrape must not do database work — so whoever
   * runs CORE calls this on an interval, next to the worker drains.
   */
  depthSampler: DepthSampler;
  /** Which backend is actually wired. Reported by /ready so it cannot be guessed. */
  persistence: Persistence["kind"];
}

/**
 * Composition root. Modules are wired here and nowhere else — a module never
 * imports another module's internals, only its published service interface.
 */
export function createCoreApp(
  options: {
    clock?: Clock;
    persistence?: Persistence;
    transport?: EventTransport;
    /**
     * Channel adapters. Empty by default: CORE ships no provider, and a fake
     * that quietly accepted everything would let the system report deliveries
     * that never happened. With none wired, notifications queue, retry and end
     * as `failed` with `channel_adapter_not_configured` — visible, not silent.
     */
    channels?: readonly NotificationChannel[];
    /**
     * Overrides the window store from the persistence bundle. The bundle
     * already pairs the memory backend with the in-process store and Postgres
     * with the shared one; this exists for tests that need a specific policy
     * against a specific backend.
     */
    rateLimitStore?: RateLimitWindowStore;
    rateLimitPolicy?: RateLimitPolicy;
    /**
     * Set to `false` to wire a router with no limiter at all. Only for tests
     * that assert unthrottled behaviour; a deployment always wants the limit.
     */
    rateLimit?: boolean;
  } = {},
): CoreApp {
  const clock = options.clock ?? systemClock;
  // One registry per process. Every counter below is an in-memory increment: no
  // instrumentation in this file adds a query, a transaction or a lock to any
  // request or any worker drain.
  const metrics = new MetricsRegistry();
  // One bundle, never a mix: see `Persistence` for why selecting adapters
  // individually would be a way to lose atomicity without noticing.
  const store = options.persistence ?? memoryPersistence(clock);
  const { audit, outbox, inbox, boundary } = store;
  const bus = new LocalEventBus(inbox);
  // Outbound: the relay queues one delivery row per interested subscriber in
  // the same transaction that marks the event published, and the worker sends
  // them. See `DeliveryFanOut` for why those two are one transaction.
  // Built before the relay because the notification fan-out resolves addresses
  // through identity's published service.
  const identity = new IdentityService(store.identity, outbox, boundary, audit, clock);
  const fanOut = new DeliveryFanOut(store.delivery, clock, newId);
  // Addresses come from identity links through a port, never from a table this
  // module reads itself (ADR 0016, ADR 0017).
  const channelDirectory = new IdentityChannelDirectory(identity);
  const notificationFanOut = new NotificationFanOut(
    store.notification,
    channelDirectory,
    clock,
    newId,
  );
  // Both fan-outs run inside the relay's transaction, so an event is never
  // marked published without the work it owes: a webhook row for every
  // subscriber and a notification row for every recipient.
  const publisher = new OutboxPublisher(
    outbox,
    bus,
    clock,
    5,
    1000,
    [fanOut, notificationFanOut],
    boundary,
    workerMetrics(metrics, "outbox_relay"),
  );
  const subscriptions = new SubscriptionRegistry(store.delivery, clock, newId);
  const deliveries = new DeliveryWorker(
    store.delivery,
    outbox,
    options.transport ?? new FetchTransport(),
    clock,
    8,
    1000,
    5000,
    workerMetrics(metrics, "event_delivery"),
  );
  // Ingress records; the dispatcher is what actually hands the event over.
  // Splitting them is the point: see `EventIngress` and `InboundDispatcher`.
  const ingress = new EventIngress(
    store.inbound,
    (work) => boundary.run((scope) => work(scope)),
    clock,
  );
  const replay = new ReplayService(
    store.inbound,
    bus,
    inbox,
    audit,
    clock,
    store.replayLock,
  );
  const dispatcher = new InboundDispatcher(
    store.inbound,
    bus,
    clock,
    5,
    1000,
    workerMetrics(metrics, "inbound_dispatcher"),
  );

  const organization = new OrganizationService(store.organization, audit, clock, boundary);
  const money = new MoneyService(store.money, outbox, boundary, audit, clock);
  const geography = new GeographyService(store.geography, audit, boundary);
  // Takes `money` rather than a wallet store: a billing period is collected by
  // an ordinary payment authorization, and the ledger is the only place that
  // knows whether the money actually moved.
  const billing = new SubscriptionService(
    store.subscription,
    money,
    outbox,
    boundary,
    audit,
    clock,
  );
  const fulfillment = new FulfillmentService(
    store.fulfillment,
    outbox,
    boundary,
    audit,
    clock,
    money,
  );
  bus.subscribe("core.fulfillment.market-order", "market.order.created", async (event) => {
    await fulfillment.consumeMarketOrder(event);
  });
  bus.subscribe("core.fulfillment.move-acceptance", "move.job.accepted", async (event) => {
    await fulfillment.consumeJobAccepted(event);
  });
  bus.subscribe("core.fulfillment.move-rejection", "move.job.rejected", async (event) => {
    await fulfillment.consumeJobRejected(event);
  });
  bus.subscribe("core.fulfillment.move-completion", "move.job.completed", async (event) => {
    await fulfillment.consumeMoveCompletion(event);
  });

  const notificationRecipients = new NotificationRecipientRegistry(
    store.notification,
    channelDirectory,
    audit,
    clock,
    newId,
  );
  const notifications = new NotificationReadService(store.notification);
  const notificationDispatcher = new NotificationDispatcher(
    store.notification,
    options.channels ?? [],
    clock,
    6,
    1000,
    30_000,
    workerMetrics(metrics, "notification"),
  );

  const depthSampler = new DepthSampler(
    metrics,
    {
      outbox,
      inbound: store.inbound,
      delivery: store.delivery,
      notification: store.notification,
      reconciliation: fulfillment,
    },
    clock,
  );

  // The limiter is given to the router, not to any service: the edge is the only
  // place a request rate exists. Background workers are invoked directly by the
  // process that runs them and never pass through this router, so they cannot be
  // throttled by construction rather than by remembering to exempt them.
  const rateLimiter =
    options.rateLimit === false
      ? undefined
      : new RateLimiter(
          options.rateLimitStore ?? store.rateLimit,
          clock,
          options.rateLimitPolicy ?? DEFAULT_RATE_LIMIT_POLICY,
        );
  const router = new Router({ metrics, rateLimiter });
  router.get("/health", () => ({ status: 200, body: { status: "ok" } }));
  router.get("/ready", async () => ({
    status: 200,
    body: {
      status: "ready",
      persistence: store.kind,
      // An aggregate count, not the length of every pending row. Reading the
      // whole queue to report its size made a readiness probe cost more the
      // busier the system was.
      outbox_pending: (await outbox.counts())["pending"] ?? 0,
    },
  }));
  registerMetricsRoutes(router, metrics);
  registerIdentityRoutes(router, identity);
  registerOrganizationRoutes(router, organization, identity);
  registerMoneyRoutes(router, money, identity);
  registerFulfillmentRoutes(router, fulfillment, identity);
  registerIngressRoutes(router, ingress, identity);
  registerDeliveryRoutes(router, subscriptions, identity);
  registerGeographyRoutes(router, geography, identity);
  registerSubscriptionRoutes(router, billing, identity);
  registerNotificationRoutes(router, notificationRecipients, notifications, identity);

  return {
    router,
    metrics,
    depthSampler,
    bus,
    outbox,
    boundary,
    publisher,
    ingress,
    dispatcher,
    replay,
    subscriptions,
    deliveries,
    notificationRecipients,
    notifications,
    notificationDispatcher,
    notificationFanOut,
    audit,
    identity,
    organization,
    money,
    billing,
    fulfillment,
    geography,
    clock,
    persistence: store.kind,
  };
}
