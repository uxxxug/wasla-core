import { type Clock, systemClock } from "./platform/clock.js";
import { InMemoryAuditLog, type AuditLog } from "./platform/audit/audit.js";
import { LocalEventBus } from "./platform/eventing/bus.js";
import { InMemoryInbox } from "./platform/eventing/inbox.js";
import { InMemoryOutbox, type OutboxStore } from "./platform/eventing/outbox.js";
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

export interface CoreApp {
  router: Router;
  bus: LocalEventBus;
  outbox: OutboxStore;
  publisher: OutboxPublisher;
  audit: AuditLog;
  identity: IdentityService;
  organization: OrganizationService;
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
  const inbox = new InMemoryInbox();
  const bus = new LocalEventBus(inbox);
  const publisher = new OutboxPublisher(outbox, bus, clock);

  const identity = new IdentityService(new InMemoryIdentityRepository(), outbox, audit, clock);
  const organization = new OrganizationService(
    new InMemoryOrganizationRepository(),
    audit,
    clock,
  );

  const router = new Router();
  router.get("/health", () => ({ status: 200, body: { status: "ok" } }));
  router.get("/ready", () => ({
    status: 200,
    body: { status: "ready", outbox_pending: outbox.byStatus("pending").length },
  }));
  registerIdentityRoutes(router, identity);
  registerOrganizationRoutes(router, organization, identity);

  return { router, bus, outbox, publisher, audit, identity, organization, clock };
}
