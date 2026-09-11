import { type Clock, systemClock } from "./platform/clock.js";
import { InMemoryAuditLog, type AuditLog } from "./platform/audit/audit.js";
import { LocalEventBus } from "./platform/eventing/bus.js";
import { InMemoryInbox } from "./platform/eventing/inbox.js";
import { InMemoryOutbox, type OutboxStore } from "./platform/eventing/outbox.js";
import {
  InMemoryTransactionBoundary,
  type TransactionBoundary,
} from "./platform/persistence/transaction.js";
import { OutboxPublisher } from "./platform/eventing/publisher.js";
import { Router } from "./platform/http/router.js";
import { InMemoryIdentityRepository } from "./modules/identity-access/memory-repository.js";
import { IdentityService } from "./modules/identity-access/service.js";
import {
  InMemoryOrganizationRepository,
  OrganizationService,
} from "./modules/organization/service.js";
import { registerIdentityRoutes } from "./modules/identity-access/http.js";
import { registerOrganizationRoutes } from "./modules/organization/http.js";
import { InMemoryMoneyRepository } from "./modules/money/repository.js";
import { MoneyService } from "./modules/money/service.js";
import { registerMoneyRoutes } from "./modules/money/http.js";
import {
  FulfillmentService,
  InMemoryFulfillmentRepository,
} from "./modules/fulfillment/service.js";
import { registerFulfillmentRoutes } from "./modules/fulfillment/http.js";
import { InMemoryGeographyRepository } from "./modules/geography/repository.js";
import { GeographyService } from "./modules/geography/service.js";
import { registerGeographyRoutes } from "./modules/geography/http.js";

export interface CoreApp {
  router: Router;
  bus: LocalEventBus;
  outbox: OutboxStore;
  boundary: TransactionBoundary;
  publisher: OutboxPublisher;
  audit: AuditLog;
  identity: IdentityService;
  organization: OrganizationService;
  money: MoneyService;
  fulfillment: FulfillmentService;
  geography: GeographyService;
  clock: Clock;
}

/**
 * Composition root. Modules are wired here and nowhere else — a module never
 * imports another module's internals, only its published service interface.
 */
export function createCoreApp(options: { clock?: Clock } = {}): CoreApp {
  const clock = options.clock ?? systemClock;
  const audit = new InMemoryAuditLog(clock);
  const outbox = new InMemoryOutbox(clock);
  const boundary = new InMemoryTransactionBoundary();
  const inbox = new InMemoryInbox();
  const bus = new LocalEventBus(inbox);
  const publisher = new OutboxPublisher(outbox, bus, clock);

  const identity = new IdentityService(new InMemoryIdentityRepository(), outbox, boundary, audit, clock);
  const organization = new OrganizationService(
    new InMemoryOrganizationRepository(),
    audit,
    clock,
  );
  const money = new MoneyService(new InMemoryMoneyRepository(), outbox, boundary, audit, clock);
  const geography = new GeographyService(new InMemoryGeographyRepository(), audit);
  const fulfillment = new FulfillmentService(
    new InMemoryFulfillmentRepository(),
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

  const router = new Router();
  router.get("/health", () => ({ status: 200, body: { status: "ok" } }));
  router.get("/ready", async () => ({
    status: 200,
    body: { status: "ready", outbox_pending: (await outbox.byStatus("pending")).length },
  }));
  registerIdentityRoutes(router, identity);
  registerOrganizationRoutes(router, organization, identity);
  registerMoneyRoutes(router, money, identity);
  registerFulfillmentRoutes(router, fulfillment, identity);
  registerGeographyRoutes(router, geography, identity);

  return {
    router,
    bus,
    outbox,
    boundary,
    publisher,
    audit,
    identity,
    organization,
    money,
    fulfillment,
    geography,
    clock,
  };
}
