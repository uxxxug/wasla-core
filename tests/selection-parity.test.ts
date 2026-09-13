/**
 * Selection parity: what a store selects *by*.
 *
 * The write path has been gated for six cycles and the read path for one.
 * Milestone 20 named what neither reaches, in its own words: the static gate
 * proves no column is unreachable and cannot prove a read returns the right
 * *rows*; the round-trip gate compares two records for one write and says
 * nothing about a predicate over many.
 *
 * Every queue predicate in CORE is written twice — once as a `where`/`order
 * by`/`limit` in SQL, once as a `filter`/`sort`/`slice` in TypeScript — and
 * until this file nothing compared the two. That family has the worst history
 * in the repository: B-22 (two relays claiming the same rows), B-24 (a row held
 * by a dead worker indistinguishable from one waiting to retry) and B-25 (a
 * recovery budget that could be spent for ever) were all defects in exactly
 * these queries, and each was found by reasoning about the code rather than by
 * a test that could see the two backends disagree.
 *
 * The shape of the gate:
 *
 *   1. **One population, built through the store's own API** on both backends —
 *      same ids, same fixed clock, same sequence of calls, so the two stores
 *      hold the same rows in the same states. Nothing is inserted behind the
 *      store's back, because a population assembled by the test would prove
 *      parity of the test's own SQL.
 *   2. **Each selection run on both backends and compared as an ordered list of
 *      ids.** Order is part of a predicate, not a presentation detail: a relay
 *      that claims the newest pending row first starves the oldest, and
 *      `claimDue`'s ordering is what makes the queue fair.
 *   3. **Each selection must discriminate.** A case that returns nothing, or
 *      returns the entire population, compares nothing — this is the failure
 *      mode of every "list" test — so each case declares how many rows it
 *      expects and that expectation is asserted on the reference backend even
 *      when no database is present.
 *
 * Mutating selections (`claimDue`, `reclaimExpired`) get a freshly built
 * population per case on both backends, so no case can be affected by the
 * order the cases run in.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../src/platform/clock.js";
import { makeEvent, type EventEnvelope } from "../src/platform/eventing/envelope.js";
import { UNFENCED } from "../src/platform/eventing/fencing.js";
import {
  memoryPersistence,
  postgresPersistence,
  type Persistence,
} from "../src/platform/persistence/backends.js";
import { NO_SCOPE } from "../src/platform/persistence/transaction.js";
import { delivery, eventSubscription } from "./support/rows.js";

const url = process.env.DATABASE_URL;

const START = new Date("2026-04-01T00:00:00.000Z");
const MINUTE = 60_000;

/** Deterministic ids, so both backends and both runs name the same rows. */
function id(seed: number): string {
  const hex = seed.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

/**
 * The population, and what the store looked like while it was being built.
 *
 * Six outbox rows, six inbound rows and six deliveries, in every state a queue
 * row can be in: pending and never attempted, pending with attempts spent,
 * claimed and still leased, claimed with the lease expired, finished, and dead.
 * The states are reached by calling the store — `claimDue`, `markFailed`,
 * `markDead` — rather than by writing rows, because a row put there by the test
 * would be a row neither backend's own code produced.
 */
interface Population {
  readonly outbox: readonly string[];
  readonly inbound: readonly string[];
  readonly deliveries: readonly string[];
  readonly subscription: string;
  readonly eventFor: (index: number) => EventEnvelope;
}

function envelope(index: number, producer: string, type: string): EventEnvelope {
  return {
    ...makeEvent({
      event_type: type,
      version: 1,
      producer,
      occurred_at: new Date(START.getTime() + index * MINUTE),
      correlation_id: `corr-${index}`,
      entity_type: index % 2 === 0 ? "fulfillment" : "wallet",
      entity_id: id(1000 + index),
      payload: {},
    }),
    event_id: id(index),
  };
}

async function populate(store: Persistence, clock: FixedClock): Promise<Population> {
  clock.advance(START.getTime() - clock.now().getTime());

  const outbox: string[] = [];
  const inbound: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const out = envelope(index, "core", index < 3 ? "core.fulfillment.completed" : "core.wallet.debited");
    await store.outbox.append(out, NO_SCOPE);
    outbox.push(out.event_id);
    const inn = envelope(100 + index, index < 3 ? "move" : "market", "move.job.completed");
    await store.inbound.accept(inn);
    inbound.push(inn.event_id);
    // One minute between rows, so `created_at`/`received_at` order is total and
    // an ordering difference is visible rather than a tie.
    clock.advance(MINUTE);
  }

  // A deterministic subscription id: `eventSubscription` generates one, and two
  // populations built with different ids cannot be compared by id at all.
  const subscription = {
    ...eventSubscription("selection-parity", "core.fulfillment.completed"),
    subscription_id: id(300),
  };
  await store.delivery.insertSubscription(subscription);
  const deliveries: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const row = { ...delivery(outbox[index] as string, subscription.subscription_id) };
    (row as { delivery_id: string }).delivery_id = id(200 + index);
    (row as { created_at: string }).created_at = new Date(START.getTime() + index * MINUTE).toISOString();
    (row as { next_attempt_at: string }).next_attempt_at = new Date(
      START.getTime() + index * MINUTE,
    ).toISOString();
    await store.delivery.queue(row);
    deliveries.push(row.delivery_id);
  }

  // Row 0: claimed and finished. Row 1: attempted and failed, due later.
  // Row 2: claimed, lease still running. Row 3: dead. Rows 4 and 5: pending.
  const now = new Date(START.getTime() + 10 * MINUTE);
  const claimOne = async (
    claim: () => Promise<readonly { id: string; token: string | null }[]>,
  ): Promise<void> => {
    await claim();
  };
  void claimOne;

  // Outbox
  const outClaims = await store.outbox.claimDue(now, 4);
  const byEvent = new Map(outClaims.map((record) => [record.event.event_id, record]));
  await store.outbox.markPublished(outbox[0] as string, byEvent.get(outbox[0] as string)?.claim_token ?? UNFENCED);
  await store.outbox.markFailed(
    outbox[1] as string,
    byEvent.get(outbox[1] as string)?.claim_token ?? UNFENCED,
    "selection parity",
    new Date(START.getTime() + 30 * MINUTE),
  );
  await store.outbox.markDead(
    outbox[3] as string,
    byEvent.get(outbox[3] as string)?.claim_token ?? UNFENCED,
    "selection parity",
  );
  // Row 2 keeps its claim: a leased row that nothing has acknowledged.

  // Inbound
  const inClaims = await store.inbound.claimDue(now, 4);
  const byInbound = new Map(inClaims.map((record) => [record.event.event_id, record]));
  await store.inbound.markProcessed(
    inbound[0] as string,
    byInbound.get(inbound[0] as string)?.claim_token ?? UNFENCED,
  );
  await store.inbound.markFailed(
    inbound[1] as string,
    byInbound.get(inbound[1] as string)?.claim_token ?? UNFENCED,
    "selection parity",
    new Date(START.getTime() + 30 * MINUTE),
  );
  await store.inbound.markDead(
    inbound[3] as string,
    byInbound.get(inbound[3] as string)?.claim_token ?? UNFENCED,
    "selection parity",
  );

  // Deliveries
  const delClaims = await store.delivery.claimDue(now, 4);
  const byDelivery = new Map(delClaims.map((record) => [record.delivery_id, record]));
  await store.delivery.markDelivered(
    deliveries[0] as string,
    byDelivery.get(deliveries[0] as string)?.claim_token ?? UNFENCED,
    200,
  );
  await store.delivery.markFailed(
    deliveries[1] as string,
    byDelivery.get(deliveries[1] as string)?.claim_token ?? UNFENCED,
    "selection parity",
    502,
    new Date(START.getTime() + 30 * MINUTE),
  );
  await store.delivery.markDead(
    deliveries[3] as string,
    byDelivery.get(deliveries[3] as string)?.claim_token ?? UNFENCED,
    "selection parity",
    500,
  );

  return {
    outbox,
    inbound,
    deliveries,
    subscription: subscription.subscription_id,
    eventFor: (index) => envelope(index, "core", "core.fulfillment.completed"),
  };
}

/**
 * One selection, and how much of the population it is expected to pick out.
 *
 * `expected` is not the assertion — the assertion is that both backends agree —
 * it is the guard against a case that discriminates nothing. A selection that
 * returns everything or nothing would compare two empty lists and pass for ever.
 */
interface Case {
  readonly what: string;
  /** How many rows the reference backend must return; `[min, max]` when a range. */
  readonly expected: number | readonly [number, number];
  /** True when the call changes rows, so each backend needs its own population. */
  readonly mutates?: boolean;
  run(store: Persistence, population: Population): Promise<readonly string[]>;
}

const events = (records: readonly { event: EventEnvelope }[]): string[] =>
  records.map((record) => record.event.event_id);

const CASES: readonly Case[] = [
  {
    what: "outbox.all() — every row, in the store's total order",
    expected: 6,
    async run(store) {
      return events(await store.outbox.all());
    },
  },
  {
    what: "outbox.byStatus('pending')",
    expected: 4,
    async run(store) {
      return events(await store.outbox.byStatus("pending"));
    },
  },
  {
    what: "outbox.byStatus('published')",
    expected: 1,
    async run(store) {
      return events(await store.outbox.byStatus("published"));
    },
  },
  {
    what: "outbox.byStatus('dead')",
    expected: 1,
    async run(store) {
      return events(await store.outbox.byStatus("dead"));
    },
  },
  {
    what: "outbox.claimDue at a moment when a failed row is not yet due",
    expected: [1, 3],
    mutates: true,
    async run(store) {
      return events(await store.outbox.claimDue(new Date(START.getTime() + 20 * MINUTE), 10));
    },
  },
  {
    what: "outbox.claimDue honours its limit and picks the oldest first",
    expected: 1,
    mutates: true,
    async run(store) {
      return events(await store.outbox.claimDue(new Date(START.getTime() + 40 * MINUTE), 1));
    },
  },
  {
    what: "outbox.claimDue at the exact due instant of the failed row",
    expected: [1, 3],
    mutates: true,
    async run(store) {
      return events(await store.outbox.claimDue(new Date(START.getTime() + 30 * MINUTE), 10));
    },
  },
  {
    // B-24, on both backends. At this instant the leased row's lease has long
    // run out, so `next_attempt_at <= now` is true of it again; only
    // `claimed_at is null` keeps it from being served to a second worker while
    // the first may still be working on it. Dropping that half of the predicate
    // on either backend shows up here and nowhere else.
    what: "outbox.claimDue after the lease has run out still refuses the held row",
    expected: 3,
    mutates: true,
    async run(store) {
      return events(await store.outbox.claimDue(new Date(START.getTime() + 60 * MINUTE), 10));
    },
  },
  {
    what: "outbox.reclaimExpired frees the leased row once its lease has run out",
    expected: [0, 2],
    mutates: true,
    async run(store) {
      const outcome = await store.outbox.reclaimExpired(new Date(START.getTime() + 60 * MINUTE), 3, 10);
      return [`reclaimed=${outcome.reclaimed}`, `dead=${outcome.dead}`];
    },
  },
  {
    // The case that milestone 21 was opened for. `limit` turns an ordering into
    // a selection: whichever claims sort first are the ones recovered, and the
    // rest wait. Counting reclaims cannot see a divergence here — both backends
    // would say `reclaimed=1` — so the case reports *which* row was freed.
    what: "outbox.reclaimExpired under a limit frees the longest-overdue claim",
    expected: 1,
    mutates: true,
    async run(store) {
      await store.outbox.reclaimExpired(new Date(START.getTime() + 60 * MINUTE), 3, 1);
      return events((await store.outbox.all()).filter((record) => record.reclaims > 0));
    },
  },
  {
    what: "outbox.selectDead — the whole dead set",
    expected: 1,
    async run(store) {
      return events(await store.outbox.selectDead({ limit: 10 }));
    },
  },
  {
    what: "outbox.selectDead filtered to an event type that has no dead row",
    expected: 0,
    async run(store) {
      return events(await store.outbox.selectDead({ event_types: ["core.wallet.credited"], limit: 10 }));
    },
  },
  {
    what: "outbox.selectDead with an occurred_from that excludes the dead row",
    expected: 0,
    async run(store) {
      return events(
        await store.outbox.selectDead({
          occurred_from: new Date(START.getTime() + 5 * MINUTE).toISOString(),
          limit: 10,
        }),
      );
    },
  },
  {
    what: "outbox.counts()",
    // A count per status the store reports, including the derived `retrying`
    // gauge — the number is measured, not guessed, and a store that starts
    // reporting a new bucket fails here rather than silently changing a gauge.
    expected: 6,
    async run(store) {
      const counts = await store.outbox.counts();
      return Object.entries(counts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([status, count]) => `${status}=${count}`);
    },
  },

  {
    what: "inbound.all()",
    expected: 6,
    async run(store) {
      return events(await store.inbound.all());
    },
  },
  {
    what: "inbound.byStatus('pending')",
    expected: 4,
    async run(store) {
      return events(await store.inbound.byStatus("pending"));
    },
  },
  {
    what: "inbound.byStatus('processed')",
    expected: 1,
    async run(store) {
      return events(await store.inbound.byStatus("processed"));
    },
  },
  {
    what: "inbound.select by producer",
    expected: 3,
    async run(store) {
      return events(await store.inbound.select({ producer: "move", limit: 10 }));
    },
  },
  {
    what: "inbound.select by status and limit — the ordering decides which rows",
    expected: 2,
    async run(store) {
      return events(await store.inbound.select({ statuses: ["pending"], limit: 2 }));
    },
  },
  {
    what: "inbound.select with a received_from window",
    expected: [1, 5],
    async run(store) {
      return events(
        await store.inbound.select({
          received_from: new Date(START.getTime() + 3 * MINUTE).toISOString(),
          limit: 10,
        }),
      );
    },
  },
  {
    what: "inbound.select resumed after a cursor",
    expected: [1, 5],
    async run(store, population) {
      const first = await store.inbound.select({ limit: 2 });
      const last = first[first.length - 1];
      if (!last) return [];
      return events(
        await store.inbound.select({
          after: { received_at: last.received_at, event_id: last.event.event_id },
          limit: 10,
        }),
      ).concat(`cursor=${population.inbound.indexOf(last.event.event_id)}`);
    },
  },
  {
    what: "inbound.claimDue before the failed row is due",
    expected: [1, 3],
    mutates: true,
    async run(store) {
      return events(await store.inbound.claimDue(new Date(START.getTime() + 20 * MINUTE), 10));
    },
  },
  {
    // B-24, on both backends. At this instant the leased row's lease has long
    // run out, so `next_attempt_at <= now` is true of it again; only
    // `claimed_at is null` keeps it from being served to a second worker while
    // the first may still be working on it. Dropping that half of the predicate
    // on either backend shows up here and nowhere else.
    what: "inbound.claimDue after the lease has run out still refuses the held row",
    expected: 3,
    mutates: true,
    async run(store) {
      return events(await store.inbound.claimDue(new Date(START.getTime() + 60 * MINUTE), 10));
    },
  },
  {
    what: "inbound.reclaimExpired",
    expected: [0, 2],
    mutates: true,
    async run(store) {
      const outcome = await store.inbound.reclaimExpired(new Date(START.getTime() + 60 * MINUTE), 3, 10);
      return [`reclaimed=${outcome.reclaimed}`, `dead=${outcome.dead}`];
    },
  },
  {
    what: "inbound.reclaimExpired under a limit frees the longest-overdue claim",
    expected: 1,
    mutates: true,
    async run(store) {
      await store.inbound.reclaimExpired(new Date(START.getTime() + 60 * MINUTE), 3, 1);
      return events((await store.inbound.all()).filter((record) => record.reclaims > 0));
    },
  },
  {
    what: "inbound.counts()",
    expected: 6,
    async run(store) {
      const counts = await store.inbound.counts();
      return Object.entries(counts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([status, count]) => `${status}=${count}`);
    },
  },

  {
    what: "delivery.all()",
    expected: 6,
    async run(store) {
      return (await store.delivery.all()).map((row) => row.delivery_id);
    },
  },
  {
    what: "delivery.byStatus('pending')",
    expected: 4,
    async run(store) {
      return (await store.delivery.byStatus("pending")).map((row) => row.delivery_id);
    },
  },
  {
    what: "delivery.byStatus('delivered')",
    expected: 1,
    async run(store) {
      return (await store.delivery.byStatus("delivered")).map((row) => row.delivery_id);
    },
  },
  {
    what: "delivery.forEvent — the deliveries of one event",
    expected: 1,
    async run(store, population) {
      return (await store.delivery.forEvent(population.outbox[2] as string)).map(
        (row) => row.delivery_id,
      );
    },
  },
  {
    what: "delivery.selectDead",
    expected: 1,
    async run(store) {
      return (await store.delivery.selectDead({ limit: 10 })).map((row) => row.delivery_id);
    },
  },
  {
    what: "delivery.selectDead filtered to a subscription that has none",
    expected: 0,
    async run(store) {
      return (
        await store.delivery.selectDead({ subscription_id: id(999), limit: 10 })
      ).map((row) => row.delivery_id);
    },
  },
  {
    what: "delivery.subscriptionsFor an event type with one subscriber",
    expected: 1,
    async run(store) {
      return (await store.delivery.subscriptionsFor("core.fulfillment.completed")).map(
        (row) => row.subscription_id,
      );
    },
  },
  {
    what: "delivery.subscriptionsFor an event type with no subscriber",
    expected: 0,
    async run(store) {
      return (await store.delivery.subscriptionsFor("core.wallet.debited")).map(
        (row) => row.subscription_id,
      );
    },
  },
  {
    what: "delivery.claimDue honours its limit and picks the oldest first",
    expected: 2,
    mutates: true,
    async run(store) {
      return (await store.delivery.claimDue(new Date(START.getTime() + 40 * MINUTE), 2)).map(
        (row) => row.delivery_id,
      );
    },
  },
  {
    // B-24, on both backends. At this instant the leased row's lease has long
    // run out, so `next_attempt_at <= now` is true of it again; only
    // `claimed_at is null` keeps it from being served to a second worker while
    // the first may still be working on it. Dropping that half of the predicate
    // on either backend shows up here and nowhere else.
    what: "delivery.claimDue after the lease has run out still refuses the held row",
    expected: 3,
    mutates: true,
    async run(store) {
      return (await store.delivery.claimDue(new Date(START.getTime() + 60 * MINUTE), 10)).map((row) => row.delivery_id);
    },
  },
  {
    what: "delivery.reclaimExpired",
    expected: [0, 2],
    mutates: true,
    async run(store) {
      const outcome = await store.delivery.reclaimExpired(
        new Date(START.getTime() + 60 * MINUTE),
        3,
        10,
      );
      return [`reclaimed=${outcome.reclaimed}`, `dead=${outcome.dead}`];
    },
  },
  {
    what: "delivery.reclaimExpired under a limit frees the longest-overdue claim",
    expected: 1,
    mutates: true,
    async run(store) {
      await store.delivery.reclaimExpired(new Date(START.getTime() + 60 * MINUTE), 3, 1);
      return (await store.delivery.all())
        .filter((row) => row.reclaims > 0)
        .map((row) => row.delivery_id);
    },
  },
  {
    what: "delivery.counts()",
    expected: [3, 6],
    async run(store) {
      const counts = await store.delivery.counts();
      return Object.entries(counts)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([status, count]) => `${status}=${count}`);
    },
  },
];

function within(size: number, expected: Case["expected"]): boolean {
  if (typeof expected === "number") return size === expected;
  return size >= expected[0] && size <= expected[1];
}

describe("selection parity: every case discriminates", () => {
  it("has a case for each listing the queue stores expose", () => {
    // Vacuity guard on the inventory itself. The three stores expose 13
    // selecting methods between them (`all`, `byStatus`, `claimDue`,
    // `reclaimExpired`, `selectDead`, `counts`, plus `select` on inbound and
    // `forEvent`/`subscriptionsFor` on delivery); every one has at least one
    // case, and the count is asserted so that a method added later without a
    // case fails here rather than being quietly unmeasured.
    const named = new Set(CASES.map((probe) => probe.what.split(" ")[0]));
    expect([...named].sort()).toEqual([
      "delivery.all()",
      "delivery.byStatus('delivered')",
      "delivery.byStatus('pending')",
      "delivery.claimDue",
      "delivery.counts()",
      "delivery.forEvent",
      "delivery.reclaimExpired",
      "delivery.selectDead",
      "delivery.subscriptionsFor",
      "inbound.all()",
      "inbound.byStatus('pending')",
      "inbound.byStatus('processed')",
      "inbound.claimDue",
      "inbound.counts()",
      "inbound.reclaimExpired",
      "inbound.select",
      "outbox.all()",
      "outbox.byStatus('dead')",
      "outbox.byStatus('pending')",
      "outbox.byStatus('published')",
      "outbox.claimDue",
      "outbox.counts()",
      "outbox.reclaimExpired",
      "outbox.selectDead",
    ]);
    expect(CASES.length).toBeGreaterThanOrEqual(30);
  });

  it("returns the number of rows each case says it should, on the reference backend", async () => {
    // The discrimination gate, and the half of this file that runs without a
    // database. A case that returns everything or nothing compares nothing:
    // both backends would agree on an empty list for ever.
    const wrong: string[] = [];
    for (const probe of CASES) {
      const clock = new FixedClock(START);
      const store = memoryPersistence(clock);
      const population = await populate(store, clock);
      const result = await probe.run(store, population);
      if (!within(result.length, probe.expected)) {
        wrong.push(`${probe.what}: got ${result.length}, expected ${String(probe.expected)}`);
      }
    }
    expect(
      wrong,
      "a case no longer picks out the part of the population it was written for, so it has stopped discriminating",
    ).toEqual([]);
  });
});

describe.runIf(url)("selection parity: both backends select the same rows in the same order", () => {
  let pool: { end(): Promise<void>; query(text: string): Promise<unknown> } | undefined;

  beforeAll(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: url }) as never;
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function fresh(): Promise<{ memory: Persistence; postgres: Persistence; population: Population }> {
    await pool?.query(
      `truncate event_delivery, event_subscription, outbox, inbound_event, audit_entry restart identity cascade`,
    );
    const memoryClock = new FixedClock(START);
    const postgresClock = new FixedClock(START);
    const memory = memoryPersistence(memoryClock);
    const postgres = postgresPersistence(pool as never, postgresClock);
    const population = await populate(memory, memoryClock);
    await populate(postgres, postgresClock);
    return { memory, postgres, population };
  }

  for (const probe of CASES) {
    it(`agrees on ${probe.what}`, async () => {
      const { memory, postgres, population } = await fresh();
      const fromMemory = await probe.run(memory, population);
      const fromPostgres = await probe.run(postgres, population);
      expect(
        within(fromMemory.length, probe.expected),
        `${probe.what}: the reference backend returned ${fromMemory.length} rows, so the case stopped discriminating before the comparison`,
      ).toBe(true);
      expect(
        [...fromPostgres],
        "the two backends selected different rows, or the same rows in a different order: one of the two predicates is wrong and production runs the Postgres one",
      ).toEqual([...fromMemory]);
    });
  }

  it("holds the same population on both backends before any selection runs", async () => {
    // The premise of every case above. If the two stores did not start alike,
    // an agreement between them would mean nothing and a disagreement would be
    // blamed on the wrong thing.
    const { memory, postgres } = await fresh();
    const memoryRows = (await memory.outbox.all()).map((record) => [
      record.event.event_id,
      record.status,
      record.attempts,
      record.next_attempt_at,
      record.claimed_at === null ? "unclaimed" : "claimed",
    ]);
    const postgresRows = (await postgres.outbox.all()).map((record) => [
      record.event.event_id,
      record.status,
      record.attempts,
      record.next_attempt_at,
      record.claimed_at === null ? "unclaimed" : "claimed",
    ]);
    expect(memoryRows.length, "the population is empty").toBe(6);
    expect(postgresRows, "the two backends do not hold the same population").toEqual(memoryRows);
    // And the population really does cover the states the cases select by.
    const statuses = new Set(memoryRows.map((row) => row[1]));
    expect([...statuses].sort()).toEqual(["dead", "pending", "published"]);
    expect(
      memoryRows.some((row) => row[4] === "claimed"),
      "no row is left claimed, so nothing tests the claim predicates",
    ).toBe(true);
  });
});

describe("selection parity: the population itself", () => {
  it("is built through the stores' own API, in every state a queue row can be in", async () => {
    const clock = new FixedClock(START);
    const store = memoryPersistence(clock);
    const population = await populate(store, clock);
    expect(new Set(population.outbox).size, "the outbox ids are not distinct").toBe(6);
    expect(new Set(population.inbound).size, "the inbound ids are not distinct").toBe(6);
    expect(new Set(population.deliveries).size, "the delivery ids are not distinct").toBe(6);
    const outbox = await store.outbox.all();
    expect(outbox.filter((row) => row.claimed_at !== null).length).toBeGreaterThan(0);
    expect(outbox.filter((row) => row.attempts > 0).length).toBeGreaterThan(0);
    expect(new Set(outbox.map((row) => row.status)).size).toBe(3);
    // A distinct id per row, so nothing below can pass by coincidence.
    expect(new Set([...population.outbox, ...population.inbound, ...population.deliveries]).size).toBe(
      18,
    );
    expect(randomUUID).toBeTypeOf("function");
  });
});

/**
 * Recovery under a limit, with the leases staggered.
 *
 * The cases above cannot see the order `reclaimExpired` recovers in: a batch
 * claim stamps one lease expiry on every row it takes, so due order and
 * insertion order agree by accident and any comparison between them passes.
 * This scenario pulls them apart deliberately. Three rows are claimed together,
 * the middle one is failed and re-claimed later, and its lease therefore runs
 * out last — so due order is first, third, second, while insertion order is
 * first, second, third.
 *
 * With `limit = 2`, the two orders recover different rows. The reference
 * backend is checked against the intended discipline (longest-overdue first)
 * without a database, and against Postgres when one is present.
 */
interface StaggeredQueue {
  readonly what: string;
  seed(store: Persistence, clock: FixedClock): Promise<string[]>;
  claim(store: Persistence, at: Date, limit: number): Promise<{ id: string; token: string | null }[]>;
  fail(store: Persistence, id: string, token: string | null, dueAt: Date): Promise<void>;
  reclaim(store: Persistence, at: Date, limit: number): Promise<void>;
  freed(store: Persistence): Promise<string[]>;
}

const STAGGERED: readonly StaggeredQueue[] = [
  {
    what: "outbox",
    async seed(store, clock) {
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const out = envelope(400 + index, "core", "core.fulfillment.completed");
        await store.outbox.append(out, NO_SCOPE);
        ids.push(out.event_id);
        clock.advance(MINUTE);
      }
      return ids;
    },
    async claim(store, at, limit) {
      const claimed = await store.outbox.claimDue(at, limit);
      return claimed.map((record) => ({ id: record.event.event_id, token: record.claim_token }));
    },
    async fail(store, id, token, dueAt) {
      await store.outbox.markFailed(id, token ?? UNFENCED, "staggered lease", dueAt);
    },
    async reclaim(store, at, limit) {
      await store.outbox.reclaimExpired(at, 9, limit);
    },
    async freed(store) {
      return (await store.outbox.all())
        .filter((record) => record.reclaims > 0)
        .map((record) => record.event.event_id);
    },
  },
  {
    what: "inbound",
    async seed(store, clock) {
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const inn = envelope(500 + index, "move", "move.job.completed");
        await store.inbound.accept(inn);
        ids.push(inn.event_id);
        clock.advance(MINUTE);
      }
      return ids;
    },
    async claim(store, at, limit) {
      const claimed = await store.inbound.claimDue(at, limit);
      return claimed.map((record) => ({ id: record.event.event_id, token: record.claim_token }));
    },
    async fail(store, id, token, dueAt) {
      await store.inbound.markFailed(id, token ?? UNFENCED, "staggered lease", dueAt);
    },
    async reclaim(store, at, limit) {
      await store.inbound.reclaimExpired(at, 9, limit);
    },
    async freed(store) {
      return (await store.inbound.all())
        .filter((record) => record.reclaims > 0)
        .map((record) => record.event.event_id);
    },
  },
  {
    what: "delivery",
    async seed(store, clock) {
      void clock;
      const subscription = {
        ...eventSubscription("staggered-lease", "core.fulfillment.completed"),
        subscription_id: id(600),
      };
      await store.delivery.insertSubscription(subscription);
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const event = envelope(700 + index, "core", "core.fulfillment.completed");
        await store.outbox.append(event, NO_SCOPE);
        const row = { ...delivery(event.event_id, subscription.subscription_id) };
        (row as { delivery_id: string }).delivery_id = id(610 + index);
        (row as { created_at: string }).created_at = new Date(
          START.getTime() + index * MINUTE,
        ).toISOString();
        (row as { next_attempt_at: string }).next_attempt_at = new Date(
          START.getTime() + index * MINUTE,
        ).toISOString();
        await store.delivery.queue(row);
        ids.push(row.delivery_id);
      }
      return ids;
    },
    async claim(store, at, limit) {
      const claimed = await store.delivery.claimDue(at, limit);
      return claimed.map((row) => ({ id: row.delivery_id, token: row.claim_token }));
    },
    async fail(store, rowId, token, dueAt) {
      await store.delivery.markFailed(rowId, token ?? UNFENCED, "staggered lease", 502, dueAt);
    },
    async reclaim(store, at, limit) {
      await store.delivery.reclaimExpired(at, 9, limit);
    },
    async freed(store) {
      return (await store.delivery.all())
        .filter((row) => row.reclaims > 0)
        .map((row) => row.delivery_id);
    },
  },
];

/** Builds the staggered scenario and returns the rows the limited recovery freed. */
async function staggered(queue: StaggeredQueue, store: Persistence, clock: FixedClock): Promise<{
  ids: string[];
  freed: string[];
}> {
  const ids = await queue.seed(store, clock);
  const first = await queue.claim(store, new Date(START.getTime() + 10 * MINUTE), 3);
  const tokens = new Map(first.map((row) => [row.id, row.token]));
  // The middle row goes back into the queue and is claimed again later, so its
  // lease is the last to run out even though it was inserted second.
  await queue.fail(store, ids[1] as string, tokens.get(ids[1] as string) ?? UNFENCED, new Date(START.getTime() + 20 * MINUTE));
  await queue.claim(store, new Date(START.getTime() + 25 * MINUTE), 1);
  await queue.reclaim(store, new Date(START.getTime() + 90 * MINUTE), 2);
  return { ids, freed: await queue.freed(store) };
}

describe("selection parity: a limited recovery takes the longest-overdue claims", () => {
  for (const queue of STAGGERED) {
    it(`${queue.what}.reclaimExpired frees the two oldest leases, not the two oldest rows`, async () => {
      const clock = new FixedClock(START);
      const store = memoryPersistence(clock);
      const { ids, freed } = await staggered(queue, store, clock);
      expect(
        freed,
        "a limited recovery freed the rows in insertion order: the queue is recovering by when a row arrived rather than by how long its claim has been abandoned",
      ).toEqual([ids[0], ids[2]]);
    });
  }
});

describe.runIf(url)("selection parity: both backends recover the same staggered claims", () => {
  let pool: { end(): Promise<void>; query(text: string): Promise<unknown> } | undefined;

  beforeAll(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: url }) as never;
  });

  afterAll(async () => {
    await pool?.end();
  });

  for (const queue of STAGGERED) {
    it(`agrees on ${queue.what}.reclaimExpired under a limit`, async () => {
      await pool?.query(
        `truncate event_delivery, event_subscription, outbox, inbound_event, audit_entry restart identity cascade`,
      );
      const memoryClock = new FixedClock(START);
      const postgresClock = new FixedClock(START);
      const fromMemory = await staggered(queue, memoryPersistence(memoryClock), memoryClock);
      const fromPostgres = await staggered(
        queue,
        postgresPersistence(pool as never, postgresClock),
        postgresClock,
      );
      expect(
        fromMemory.freed.length,
        "the scenario stopped discriminating: a limited recovery freed something other than two rows",
      ).toBe(2);
      expect(
        fromPostgres.freed,
        "the two backends recovered different abandoned claims: one of the two recovery orders is wrong and production runs the Postgres one",
      ).toEqual(fromMemory.freed);
    });
  }
});
