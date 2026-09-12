import { type Clock, systemClock } from "./platform/clock.js";
import { type AuditLog } from "./platform/audit/audit.js";
import { LocalEventBus } from "./platform/eventing/bus.js";
import { type OutboxStore } from "./platform/eventing/outbox.js";
import { memoryPersistence, type Persistence } from "./platform/persistence/backends.js";
import { type TransactionBoundary } from "./platform/persistence/transaction.js";
import { OutboxPublisher } from "./platform/eventing/publisher.js";
import { EventIngress } from "./platform/eventing/ingress.js";
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
  } = {},
): CoreApp {
  const clock = options.clock ?? systemClock;
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
  );
  const subscriptions = new SubscriptionRegistry(store.delivery, clock, newId);
  const deliveries = new DeliveryWorker(
    store.delivery,
    outbox,
    options.transport ?? new FetchTransport(),
    clock,
  );
  // Ingress records; the dispatcher is what actually hands the event over.
  // Splitting them is the point: see `EventIngress` and `InboundDispatcher`.
  const ingress = new EventIngress(store.inbound, (work) =>
    boundary.run((scope) => work(scope)),
  );
  const dispatcher = new InboundDispatcher(store.inbound, bus, clock);

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
  );

  const router = new Router();
  router.get("/health", () => ({ status: 200, body: { status: "ok" } }));
  router.get("/ready", async () => ({
    status: 200,
    body: {
      status: "ready",
      persistence: store.kind,
      outbox_pending: (await outbox.byStatus("pending")).length,
    },
  }));
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
    bus,
    outbox,
    boundary,
    publisher,
    ingress,
    dispatcher,
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
