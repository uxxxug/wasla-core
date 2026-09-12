import { InMemoryAuditLog, type AuditLog } from "../audit/audit.js";
import { PgAuditLog } from "../audit/pg-audit.js";
import type { Clock } from "../clock.js";
import { InMemoryInbox, type InboxStore } from "../eventing/inbox.js";
import { InMemoryRateLimitWindowStore, type RateLimitWindowStore } from "../http/rate-limit.js";
import { PgRateLimitWindowStore } from "../http/pg-rate-limit.js";
import { InMemoryInboundEventStore, type InboundEventStore } from "../eventing/ingress.js";
import { InMemoryDeliveryStore, type DeliveryStore } from "../eventing/delivery.js";
import { PgDeliveryStore } from "../eventing/pg-delivery.js";
import { PgInboundEventStore } from "../eventing/pg-ingress.js";
import { InMemoryOutbox, type OutboxStore } from "../eventing/outbox.js";
import { PgInbox } from "../eventing/pg-inbox.js";
import { PgOutbox } from "../eventing/pg-outbox.js";
import { InMemoryFulfillmentRepository } from "../../modules/fulfillment/service.js";
import type { FulfillmentRepository } from "../../modules/fulfillment/service.js";
import { PgFulfillmentRepository } from "../../modules/fulfillment/pg-repository.js";
import { InMemoryGeographyRepository } from "../../modules/geography/repository.js";
import type { GeographyRepository } from "../../modules/geography/repository.js";
import { PgGeographyRepository } from "../../modules/geography/pg-repository.js";
import { InMemoryIdentityRepository } from "../../modules/identity-access/memory-repository.js";
import type { IdentityRepository } from "../../modules/identity-access/ports.js";
import { PgIdentityRepository } from "../../modules/identity-access/pg-repository.js";
import { InMemoryNotificationStore } from "../../modules/notification/repository.js";
import type { NotificationStore } from "../../modules/notification/repository.js";
import { PgNotificationStore } from "../../modules/notification/pg-repository.js";
import { InMemoryMoneyRepository } from "../../modules/money/repository.js";
import type { MoneyRepository } from "../../modules/money/repository.js";
import { PgMoneyRepository } from "../../modules/money/pg-repository.js";
import { InMemoryOrganizationRepository } from "../../modules/organization/service.js";
import { InMemorySubscriptionRepository } from "../../modules/subscription/repository.js";
import type { SubscriptionRepository } from "../../modules/subscription/repository.js";
import { PgSubscriptionRepository } from "../../modules/subscription/pg-repository.js";
import type { OrganizationRepository } from "../../modules/organization/service.js";
import { PgOrganizationRepository } from "../../modules/organization/pg-repository.js";
import type { Queryable } from "./postgres.js";
import { InProcessReplayLock, PgAdvisoryReplayLock, type ReplayLock } from "../replay/lock.js";
import { PgTransactionBoundary } from "./postgres.js";
import { InMemoryTransactionBoundary, type TransactionBoundary } from "./transaction.js";

/**
 * Everything the composition root needs in order to persist anything.
 *
 * It is one bundle on purpose. A unit of work commits a domain write and an
 * outbox append together, so the repositories, the outbox and the boundary
 * must all belong to the same backend. Selecting them individually would make
 * it possible to wire a `Map` repository next to a Postgres outbox, which
 * compiles, runs, and is not atomic.
 */
export interface Persistence {
  readonly kind: "memory" | "postgres";
  audit: AuditLog;
  outbox: OutboxStore;
  inbox: InboxStore;
  inbound: InboundEventStore;
  delivery: DeliveryStore;
  /** Notifications to people, as opposed to `delivery`, which is to systems. */
  notification: NotificationStore;
  boundary: TransactionBoundary;
  /**
   * Mutual exclusion for replay runs. Part of the bundle because the correct
   * lock depends entirely on the backend: in-process is right for the memory
   * store and wrong for Postgres, where two CORE instances share one database
   * and only the database can arbitrate between them.
   */
  replayLock: ReplayLock;
  /**
   * Ingress rate-limit windows. Part of the bundle so that choosing Postgres and
   * choosing the shared, cross-instance limiter is one decision rather than two:
   * wiring the durable backend next to an in-process limiter would silently
   * multiply every limit by the number of instances running.
   */
  rateLimit: RateLimitWindowStore;
  identity: IdentityRepository;
  organization: OrganizationRepository;
  money: MoneyRepository;
  geography: GeographyRepository;
  fulfillment: FulfillmentRepository;
  subscription: SubscriptionRepository;
}

/** Reference backend. Keeps the tests and local runs dependency-free. */
export function memoryPersistence(clock: Clock): Persistence {
  // Built before the bundle so the subscription store can be handed a reader
  // for it. Migration 0010 gives Postgres a deferred trigger comparing a
  // settled period against the hold that settled it; without this wiring the
  // memory backend could not express that check, and a backend that enforces
  // less than production is a backend that certifies bugs (B-12).
  const money = new InMemoryMoneyRepository();
  return {
    kind: "memory",
    audit: new InMemoryAuditLog(clock),
    outbox: new InMemoryOutbox(clock),
    inbox: new InMemoryInbox(),
    inbound: new InMemoryInboundEventStore(clock),
    delivery: new InMemoryDeliveryStore(),
    notification: new InMemoryNotificationStore(),
    boundary: new InMemoryTransactionBoundary(),
    replayLock: new InProcessReplayLock(),
    rateLimit: new InMemoryRateLimitWindowStore(),
    identity: new InMemoryIdentityRepository(),
    organization: new InMemoryOrganizationRepository(),
    money,
    geography: new InMemoryGeographyRepository(),
    fulfillment: new InMemoryFulfillmentRepository(),
    subscription: new InMemorySubscriptionRepository((id) => money.authorizationSnapshot(id)),
  };
}

/**
 * Postgres backend.
 *
 * `pool` is passed in rather than constructed here so that CORE never owns a
 * connection string and nothing in `src/` has to read an environment variable
 * or import the driver. The caller decides how the pool is configured and when
 * it is closed.
 */
export function postgresPersistence(pool: PostgresPool, clock: Clock): Persistence {
  return {
    kind: "postgres",
    audit: new PgAuditLog(pool, clock),
    outbox: new PgOutbox(pool, clock),
    inbox: new PgInbox(pool, clock),
    inbound: new PgInboundEventStore(pool, clock),
    delivery: new PgDeliveryStore(pool, clock),
    notification: new PgNotificationStore(pool),
    boundary: new PgTransactionBoundary(pool as never),
    replayLock: new PgAdvisoryReplayLock(pool),
    rateLimit: new PgRateLimitWindowStore(pool),
    identity: new PgIdentityRepository(pool),
    organization: new PgOrganizationRepository(pool),
    money: new PgMoneyRepository(pool),
    geography: new PgGeographyRepository(pool),
    fulfillment: new PgFulfillmentRepository(pool),
    subscription: new PgSubscriptionRepository(pool as never),
  };
}

/** The part of a `pg.Pool` this backend uses: queries plus a client to run BEGIN on. */
export interface PostgresPool extends Queryable {
  connect(): Promise<{
    query: Queryable["query"];
    release(): void;
  }>;
}
