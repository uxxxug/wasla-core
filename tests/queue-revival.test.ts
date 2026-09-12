/**
 * B-27: a dead row had to be reachable again without hand-written SQL.
 *
 * B-22 gave the queues a `dead` status, B-25 added a second way to reach it, and
 * B-26 made the acknowledgements that write it fence-safe. Between them the three
 * cycles built a terminal state with no exit: replay could bring back an
 * `inbound_event`, and nothing in CORE could bring back an `outbox` row or an
 * `event_delivery`. The recovery procedure was an UPDATE typed into a production
 * console by whoever was awake — unjournalled, unbounded, and free to resurrect a
 * row that had already been published.
 *
 * These tests hold the exit in place, and hold its shape: revival returns the row
 * to `pending` and publishes nothing itself, so what reaches the bus and the
 * subscriber is the original envelope, byte for byte, carrying the `event_id` every
 * consumer deduplicates on. The alternative — emitting a fresh envelope for the
 * same fact — is what the assertions on `event_id` and `occurred_at` below exist
 * to prevent.
 *
 * Postgres cases are skipped without DATABASE_URL, and they are the ones that
 * matter most here: the guarantee that a revival cannot touch a published row is a
 * `where status = 'dead'` inside one UPDATE, and only a real database can get
 * that wrong.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createCoreApp, type CoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { makeEvent, type EventEnvelope } from "../src/platform/eventing/envelope.js";
import type {
  EventTransport,
  TransportRequest,
  TransportResponse,
} from "../src/platform/eventing/delivery.js";
import { permissionsForRoles, type Role } from "../src/modules/identity-access/domain.js";
import { parseReviveArgs } from "../src/platform/replay/revive-cli.js";
import type { RevivalActor } from "../src/platform/replay/revive.js";
import { NO_SCOPE } from "../src/platform/persistence/transaction.js";
import {
  memoryPersistence,
  postgresPersistence,
  type Persistence,
} from "../src/platform/persistence/backends.js";

const url = process.env.DATABASE_URL;
const SECRET = "a".repeat(40);

/**
 * The service's own ceiling, written as a literal: a test that imports the
 * constant it is asserting on cannot notice the constant changing, and the point
 * of a bound is the number.
 */
const MAX_LIMIT = 1000;

/**
 * A real principal id, because the audit log stores it as a uuid: an actor the
 * journal cannot record is an actor whose revival fails half way through.
 */
const OPERATOR_ID = randomUUID();
const OPERATOR: RevivalActor = { actor_type: "principal", actor_id: OPERATOR_ID };

interface Backend {
  name: string;
  open(clock: FixedClock): Promise<{ store: Persistence; close(): Promise<void> }>;
}

const backends: Backend[] = [
  {
    name: "in-memory",
    async open(clock) {
      return { store: memoryPersistence(clock), async close() {} };
    },
  },
];

if (url) {
  backends.push({
    name: "postgres",
    async open(clock) {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: url, max: 4 });
      return {
        store: postgresPersistence(pool as never, clock),
        async close() {
          await pool.end();
        },
      };
    },
  });
}

async function truncate(): Promise<void> {
  if (!url) return;
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(
      `truncate notification, notification_recipient, event_delivery, event_subscription,
       inbound_event, outbox, inbox restart identity cascade`,
    );
  } finally {
    await pool.end();
  }
}

/** Records every request and answers 200 unless told otherwise. */
class RecordingTransport implements EventTransport {
  readonly sent: TransportRequest[] = [];
  constructor(private readonly script: TransportResponse[] = []) {}
  async send(request: TransportRequest): Promise<TransportResponse> {
    this.sent.push(request);
    return this.script.shift() ?? { status: 200 };
  }
}

describe.each(backends)("queue revival on $name", (backend) => {
  let store: Persistence;
  let close: () => Promise<void>;
  let clock: FixedClock;

  const app = (transport: EventTransport): CoreApp =>
    createCoreApp({ clock, persistence: store, transport });

  beforeEach(async () => {
    await truncate();
    clock = new FixedClock();
    const opened = await backend.open(clock);
    store = opened.store;
    close = opened.close;
  });

  afterEach(async () => {
    await close();
  });

  const event = (tag: string): EventEnvelope =>
    makeEvent({
      event_type: "core.fulfillment.created",
      version: 1,
      producer: "wasla-core",
      occurred_at: clock.now(),
      correlation_id: `corr-revive-${tag}`,
      entity_type: "fulfillment",
      entity_id: randomUUID(),
      payload: { organization_id: randomUUID(), tag },
    });

  /**
   * Kills an outbox row the way the relay does: claim it, then acknowledge the
   * failure as permanent. Going through the real acknowledgement rather than
   * writing `status = 'dead'` directly is deliberate — a fixture that fabricates
   * the state under test can make the state under test impossible to reach.
   */
  const killOutbox = async (envelope: EventEnvelope, error = "subscriber rejected"): Promise<void> => {
    await store.outbox.append(envelope, NO_SCOPE);
    const claimed = await store.outbox.claimDue(clock.now(), 10, 30_000);
    const row = claimed.find((record) => record.event.event_id === envelope.event_id);
    expect(row).toBeDefined();
    expect(await store.outbox.markDead(envelope.event_id, row?.claim_token ?? null, error)).toBe(
      true,
    );
  };

  it("brings a dead outbox row back and re-publishes the original envelope unchanged", async () => {
    const published: EventEnvelope[] = [];
    const core = createCoreApp({
      clock,
      persistence: store,
      // Watching the bus rather than the store, because the question is not "did
      // the row change" but "what did consumers receive".
      transport: new RecordingTransport(),
    });
    core.bus.subscribe("revival-observer", "core.fulfillment.created", async (envelope) => {
      published.push(envelope);
    });

    const envelope = event("outbox-happy");
    await killOutbox(envelope);
    // The relay does nothing for a dead row, which is the defect: durable and
    // unreachable at once.
    await core.publisher.drainOnce();
    expect(published).toHaveLength(0);

    const report = await core.revival.run(
      { queue: "outbox", event_ids: [envelope.event_id], limit: 10 },
      OPERATOR,
    );
    expect(report.counts.revived).toBe(1);
    expect(report.outcomes).toEqual([{ id: envelope.event_id, outcome: "revived" }]);
    // Revival itself published nothing. The row is merely due again.
    expect(published).toHaveLength(0);
    expect((await store.outbox.get(envelope.event_id))?.status).toBe("pending");

    await core.publisher.drainOnce();
    expect(published).toHaveLength(1);
    // The whole decision, in three assertions: same identity, same time of
    // occurrence, same payload. A fresh envelope for the same fact would have a
    // new `event_id`, and every consumer inbox and every subscriber deduplicating
    // on it would treat a month-old fact as news.
    expect(published[0]?.event_id).toBe(envelope.event_id);
    expect(published[0]?.occurred_at).toBe(envelope.occurred_at);
    expect(published[0]?.payload).toEqual(envelope.payload);
    expect((await store.outbox.get(envelope.event_id))?.status).toBe("published");
  });

  it("keeps the failure history and gives the row exactly one more attempt", async () => {
    const core = app(new RecordingTransport());
    const envelope = event("outbox-history");
    await killOutbox(envelope, "receiver refused: 422");
    const before = await store.outbox.get(envelope.event_id);

    await core.revival.run({ queue: "outbox", event_ids: [envelope.event_id], limit: 1 }, OPERATOR);
    const after = await store.outbox.get(envelope.event_id);

    expect(after?.status).toBe("pending");
    // `attempts` is left alone on purpose. It drives the backoff and the derived
    // `retrying` reading, and it is the only record of how many observed failures
    // this row caused. Zeroing it would falsify both and turn one revival into an
    // unbounded retry budget — the row would die, be revived, retry five times,
    // die, be revived. Preserved, a row that died at `maxAttempts` gets exactly
    // one further attempt, so every subsequent attempt costs another journalled
    // decision by a named operator.
    expect(after?.attempts).toBe(before?.attempts);
    // The same reason in the other direction: `last_error` is the only on-row
    // evidence of why this row died, and the revival is recorded in the audit
    // journal where the actor is named.
    expect(after?.last_error).toBe("receiver refused: 422");
    // The claim is released, so the relay can take it: a row left with
    // `claimed_at` set is pending and unclaimable at the same time.
    expect(after?.claimed_at).toBeNull();
    expect(after?.claim_token).toBeNull();
    // The abandonment budget resets, unlike the retry budget. It counts worker
    // deaths, which are evidence about the worker and not about this row.
    expect(after?.reclaims).toBe(0);
    // Due now rather than at the backoff the failure computed: the operator has
    // decided the moment.
    expect(new Date(after?.next_attempt_at ?? 0).getTime()).toBeLessThanOrEqual(
      clock.now().getTime(),
    );
  });

  it("cannot resurrect a row that is not dead", async () => {
    const core = app(new RecordingTransport());
    const pending = event("outbox-pending");
    await store.outbox.append(pending, NO_SCOPE);
    const done = event("outbox-published");
    await store.outbox.append(done, NO_SCOPE);
    const claimed = await store.outbox.claimDue(clock.now(), 10, 30_000);
    for (const row of claimed) {
      if (row.event.event_id === done.event_id) {
        await store.outbox.markPublished(done.event_id, row.claim_token ?? null);
      } else {
        // Release the other claim so it is plainly pending, not in flight.
        await store.outbox.markFailed(
          pending.event_id,
          row.claim_token ?? null,
          "transient",
          clock.now(),
        );
      }
    }

    const report = await core.revival.run(
      { queue: "outbox", event_ids: [pending.event_id, done.event_id], limit: 10 },
      OPERATOR,
    );
    // Neither is even discovered: `selectDead` filters on the status, so a
    // published event cannot be named into a second publication by an operator
    // pasting the wrong id. This is the assertion that stands in for the
    // production console nobody was auditing.
    expect(report.discovered).toBe(0);
    expect(report.counts.revived).toBe(0);
    expect((await store.outbox.get(done.event_id))?.status).toBe("published");
    // And directly: the store refuses the write even when asked for it.
    expect(await store.outbox.revive(done.event_id, clock.now())).toBe(false);
    expect(await store.outbox.revive(pending.event_id, clock.now())).toBe(false);
    expect((await store.outbox.get(done.event_id))?.status).toBe("published");
  });

  it("brings a dead delivery back and re-sends the same event to the subscriber", async () => {
    // Four 500s and a 200: the delivery worker's default budget is 8, so instead
    // of exhausting it, the row is dead-lettered through the store the way the
    // worker does it, and then revived.
    const transport = new RecordingTransport();
    const core = app(transport);
    await core.subscriptions.register({
      subscriber: "wasla-move",
      event_type: "core.fulfillment.created",
      endpoint_url: "https://move.example.com/events",
      signing_secret: SECRET,
    });
    const envelope = event("delivery-happy");
    await store.outbox.append(envelope, NO_SCOPE);
    await core.publisher.drainOnce();

    const queued = await store.delivery.byStatus("pending");
    expect(queued).toHaveLength(1);
    const delivery = queued[0] as { delivery_id: string };
    const claimed = await store.delivery.claimDue(clock.now(), 10, 30_000);
    expect(
      await store.delivery.markDead(
        delivery.delivery_id,
        claimed[0]?.claim_token ?? null,
        "gave up",
        503,
      ),
    ).toBe(true);
    expect(transport.sent).toHaveLength(0);

    const report = await core.revival.run(
      { queue: "event_delivery", delivery_ids: [delivery.delivery_id], limit: 10 },
      OPERATOR,
    );
    expect(report.counts.revived).toBe(1);
    expect(transport.sent).toHaveLength(0);

    await core.deliveries.drainOnce();
    expect(transport.sent).toHaveLength(1);
    // The subscriber receives the event it was always owed, under the id it
    // deduplicates on — not a new event describing the same thing.
    expect(JSON.parse(transport.sent[0]?.body ?? "{}").event_id).toBe(envelope.event_id);
    expect((await store.delivery.byStatus("delivered")).map((row) => row.delivery_id)).toEqual([
      delivery.delivery_id,
    ]);
  });

  it("refuses to revive a delivery for a subscription somebody switched off", async () => {
    const transport = new RecordingTransport();
    const core = app(transport);
    const subscription = await core.subscriptions.register({
      subscriber: "wasla-move",
      event_type: "core.fulfillment.created",
      endpoint_url: "https://move.example.com/events",
      signing_secret: SECRET,
    });
    const envelope = event("delivery-inactive");
    await store.outbox.append(envelope, NO_SCOPE);
    await core.publisher.drainOnce();
    const delivery = (await store.delivery.byStatus("pending"))[0] as { delivery_id: string };
    const claimed = await store.delivery.claimDue(clock.now(), 10, 30_000);
    await store.delivery.markDead(
      delivery.delivery_id,
      claimed[0]?.claim_token ?? null,
      "gave up",
      503,
    );

    // Deactivating a subscription is how an operator stops CORE sending to a
    // subscriber. Fan-out honours it; the delivery worker, which only reads rows
    // that already exist, does not — so if revival did not check, it would be the
    // one path in CORE that POSTs to an endpoint somebody deliberately switched
    // off, at the request of an operator who was looking at a dead-letter queue
    // and not at the subscription list.
    await core.subscriptions.setActive(subscription.subscription_id, false);

    const planned = await core.revival.plan({
      queue: "event_delivery",
      delivery_ids: [delivery.delivery_id],
      limit: 10,
    });
    expect(planned.counts.skipped_subscription_inactive).toBe(1);

    const report = await core.revival.run(
      { queue: "event_delivery", delivery_ids: [delivery.delivery_id], limit: 10 },
      OPERATOR,
    );
    expect(report.counts.revived).toBe(0);
    expect(report.counts.skipped_subscription_inactive).toBe(1);
    expect(report.outcomes[0]?.reason).toMatch(/not active/);
    // Still dead, so the decision can be reversed by reactivating the
    // subscription rather than by finding the row again.
    expect((await store.delivery.byStatus("dead")).map((row) => row.delivery_id)).toEqual([
      delivery.delivery_id,
    ]);
    await core.deliveries.drainOnce();
    expect(transport.sent).toHaveLength(0);
  });

  it("completes the loop: switched off, suppressed, switched on, revived, sent", async () => {
    // B-27 and B-28 are two halves of one operator story, and this is the whole of
    // it. Neither half is much use alone: suppression without a revival path parks
    // events with no way back, and a revival path without suppression brings back
    // rows that were still being sent anyway.
    const transport = new RecordingTransport();
    const core = app(transport);
    const subscription = await core.subscriptions.register({
      subscriber: "wasla-move",
      event_type: "core.fulfillment.created",
      endpoint_url: "https://move.example.com/events",
      signing_secret: SECRET,
    });
    const envelope = event("round-trip");
    await store.outbox.append(envelope, NO_SCOPE);
    await core.publisher.drainOnce();

    // 1. Switched off. The queued delivery is suppressed rather than sent.
    await core.subscriptions.setActive(subscription.subscription_id, false);
    expect((await core.deliveries.drainOnce()).suppressed).toBe(1);
    expect(transport.sent).toHaveLength(0);
    const delivery = (await store.delivery.byStatus("dead"))[0] as { delivery_id: string };

    // 2. Reviving now is refused, so the two halves cannot contradict each other:
    // an operator working from the dead-letter queue cannot undo the switch by
    // reviving past it.
    const refused = await core.revival.run(
      { queue: "event_delivery", delivery_ids: [delivery.delivery_id], limit: 5 },
      OPERATOR,
    );
    expect(refused.counts.skipped_subscription_inactive).toBe(1);
    expect(refused.counts.revived).toBe(0);

    // 3. Switched back on, then revived. One journalled command, no hand-written SQL.
    await core.subscriptions.setActive(subscription.subscription_id, true);
    const revived = await core.revival.run(
      { queue: "event_delivery", delivery_ids: [delivery.delivery_id], limit: 5 },
      OPERATOR,
    );
    expect(revived.counts.revived).toBe(1);

    // 4. And the subscriber finally receives the event it was always owed, under the
    // id it deduplicates on — nothing was lost by switching the subscription off.
    await core.deliveries.drainOnce();
    expect(transport.sent).toHaveLength(1);
    expect(JSON.parse(transport.sent[0]?.body ?? "{}").event_id).toBe(envelope.event_id);
    expect((await store.delivery.byStatus("delivered"))).toHaveLength(1);
  });

  it("plans without writing anything at all", async () => {
    const core = app(new RecordingTransport());
    const envelope = event("plan-only");
    await killOutbox(envelope);
    const auditBefore = (await store.audit.entries()).length;

    const planned = await core.revival.plan({
      queue: "outbox",
      event_ids: [envelope.event_id],
      limit: 5,
    });
    expect(planned.dry_run).toBe(true);
    expect(planned.counts.revived).toBe(1);
    // A dry run that journalled itself would be a dry run that writes. `plan` is
    // meant to be provably incapable of mutation, so the audit log is checked too
    // and not only the row.
    expect((await store.outbox.get(envelope.event_id))?.status).toBe("dead");
    expect((await store.audit.entries()).length).toBe(auditBefore);
  });

  it("refuses a scope that would sweep the whole dead-letter queue", async () => {
    const core = app(new RecordingTransport());
    // The queue name is not narrowing: this reads "revive everything that ever
    // died", which is the one request that has to be spelled out rather than
    // typed by accident.
    await expect(core.revival.plan({ queue: "outbox", limit: 10 })).rejects.toThrow(/must narrow/i);
    await expect(
      core.revival.plan({ queue: "event_delivery", limit: 10 }),
    ).rejects.toThrow(/must narrow/i);
    // A limit is mandatory and bounded on both sides, so neither an omission nor
    // a typo turns into an unbounded run.
    await expect(
      core.revival.plan({ queue: "outbox", producer: "wasla-core", limit: 0 }),
    ).rejects.toThrow(/between 1 and/);
    await expect(
      core.revival.plan({ queue: "outbox", producer: "wasla-core", limit: MAX_LIMIT + 1 }),
    ).rejects.toThrow(/between 1 and/);
    // An empty filter list is an empty scope dressed as a narrow one: it matches
    // nothing on one reading and everything on another, so it is refused rather
    // than interpreted.
    await expect(
      core.revival.plan({ queue: "outbox", event_ids: [], limit: 5 }),
    ).rejects.toThrow(/must not be empty/);
  });

  it("journals the run with its counts and the ids it brought back", async () => {
    const core = app(new RecordingTransport());
    const envelope = event("journal");
    await killOutbox(envelope);

    const report = await core.revival.run(
      { queue: "outbox", event_ids: [envelope.event_id], limit: 5 },
      OPERATOR,
    );
    // Filtered by this run's id rather than by action alone: the audit log is
    // append-only and deliberately not truncated between cases, so "the first
    // entry with this action" is another test's run.
    const entries = (await store.audit.entries()).filter(
      (entry) => entry.entity_id === report.revival_id,
    );
    const started = entries.find((entry) => entry.action === "queue_revival.started");
    const finished = entries.find((entry) => entry.action === "queue_revival.finished");
    // Journalled before the first write as well as after the last, so a run that
    // dies half way still leaves evidence that it began, with what scope, and by
    // whom.
    expect(started?.entity_id).toBe(report.revival_id);
    expect(started?.actor_id).toBe(OPERATOR_ID);
    expect(finished?.metadata?.["counts"]).toMatchObject({ revived: 1 });
    // The ids matter as much as the counts: this is what somebody investigating a
    // duplicate downstream effect needs in order to explain why an old event was
    // published again.
    expect(finished?.metadata?.["revived_ids"]).toEqual([envelope.event_id]);
  });

  it("does nothing the second time, and says so", async () => {
    const core = app(new RecordingTransport());
    const envelope = event("idempotent");
    await killOutbox(envelope);
    const scope = { queue: "outbox", event_ids: [envelope.event_id], limit: 5 } as const;

    expect((await core.revival.run(scope, OPERATOR)).counts.revived).toBe(1);
    const attemptsAfterFirst = (await store.outbox.get(envelope.event_id))?.attempts;
    const second = await core.revival.run(scope, OPERATOR);
    // Repeating a revival is the cheapest thing an operator can do wrong, so it
    // has to be harmless and legible: the row is no longer dead, so it is not
    // discovered, and nothing is published twice.
    expect(second.discovered).toBe(0);
    expect(second.counts.revived).toBe(0);
    // And the retry budget is where the first revival left it: a repeated command
    // neither spends an attempt nor hands the row a fresh one.
    expect((await store.outbox.get(envelope.event_id))?.attempts).toBe(attemptsAfterFirst);
  });

  it("pages through a scope in a fixed order without repeating or skipping a row", async () => {
    const core = app(new RecordingTransport());
    const first = event("page-a");
    clock.advance(1000);
    const second = event("page-b");
    await killOutbox(first);
    await killOutbox(second);

    const pageOne = await core.revival.run(
      { queue: "outbox", producer: "wasla-core", limit: 1 },
      OPERATOR,
    );
    expect(pageOne.outcomes.map((outcome) => outcome.id)).toEqual([first.event_id]);
    // A full page means there may be another, so an operator knows the run was
    // bounded by the limit and not by the data running out.
    expect(pageOne.more_available).toBe(true);
    expect(pageOne.resume_after).toEqual({
      occurred_at: first.occurred_at,
      event_id: first.event_id,
    });

    const pageTwo = await core.revival.run(
      {
        queue: "outbox",
        producer: "wasla-core",
        limit: 1,
        after: pageOne.resume_after as { occurred_at: string; event_id: string },
      },
      OPERATOR,
    );
    // The row already handled is not seen again, and the one that was waiting is
    // not stepped over.
    expect(pageTwo.outcomes.map((outcome) => outcome.id)).toEqual([second.event_id]);
    expect((await store.outbox.byStatus("dead"))).toHaveLength(0);
  });

  it("refuses a second revival while one is running", async () => {
    const core = app(new RecordingTransport());
    const envelope = event("locked");
    await killOutbox(envelope);
    const lease = await store.revivalLock.acquire();
    expect(lease).not.toBeNull();
    try {
      // Refused rather than queued, for the reason a second replay is refused: a
      // revival that waits runs later, against a state the operator who ordered
      // it never looked at.
      await expect(
        core.revival.run({ queue: "outbox", event_ids: [envelope.event_id], limit: 5 }, OPERATOR),
      ).rejects.toThrow(/already running/);
    } finally {
      await lease?.release();
    }
    // And the lock is released afterwards, so one refusal does not wedge the
    // command for good.
    expect((await core.revival.run(
      { queue: "outbox", event_ids: [envelope.event_id], limit: 5 },
      OPERATOR,
    )).counts.revived).toBe(1);
  });

  it("does not block on a replay, or a replay on it", async () => {
    const core = app(new RecordingTransport());
    const envelope = event("separate-lock");
    await killOutbox(envelope);
    // Two operations over different tables with different effects. Sharing one
    // advisory key would refuse an urgent revival because somebody is replaying
    // last month's inbound events, which is exclusion that protects nothing.
    const replayLease = await store.replayLock.acquire();
    try {
      expect((await core.revival.run(
        { queue: "outbox", event_ids: [envelope.event_id], limit: 5 },
        OPERATOR,
      )).counts.revived).toBe(1);
    } finally {
      await replayLease?.release();
    }
  });
});

describe("revival authority", () => {
  it("is held by the platform operator alone", () => {
    // `events.submit` is held by every service caller, so reusing it would have
    // handed MARKET and MOVE the ability to re-send CORE's dead-lettered events.
    expect(permissionsForRoles(["platform_admin"]).has("events.revive")).toBe(true);
    const others: Role[] = ["org_admin", "org_member", "support_agent", "service"];
    for (const role of others) {
      expect(permissionsForRoles([role]).has("events.revive")).toBe(false);
    }
  });
});

describe("revive command line", () => {
  it("is a dry run unless execution is asked for", () => {
    const parsed = parseReviveArgs(["--queue", "outbox", "--producer", "wasla-core"]);
    // The safe thing is what happens when an argument is forgotten.
    expect(parsed.execute).toBe(false);
    expect(parsed.scope).toEqual({ queue: "outbox", limit: 100, producer: "wasla-core" });
    expect(
      parseReviveArgs(["--queue", "outbox", "--producer", "wasla-core", "--execute"]).execute,
    ).toBe(true);
  });

  it("maps the delivery queue and its filters", () => {
    const parsed = parseReviveArgs([
      "--queue",
      "event-delivery",
      "--subscription",
      "sub-1",
      "--event-ids",
      "e1,e2",
      "--limit",
      "25",
    ]);
    expect(parsed.scope).toEqual({
      queue: "event_delivery",
      limit: 25,
      subscription_id: "sub-1",
      event_ids: ["e1", "e2"],
    });
  });

  it("stops before a run on anything it cannot read", () => {
    expect(() => parseReviveArgs(["--queue", "inbound"])).toThrow(/outbox or event-delivery/);
    expect(() => parseReviveArgs(["--producer", "wasla-core"])).toThrow(/outbox or event-delivery/);
    expect(() => parseReviveArgs(["--queue", "outbox", "--limit", "many"])).toThrow(/integer/);
    expect(() =>
      parseReviveArgs(["--queue", "outbox", "--occurred-from", "yesterday"]),
    ).toThrow(/readable timestamp/);
    expect(() => parseReviveArgs(["--queue"])).toThrow(/needs a value/);
    expect(() => parseReviveArgs(["outbox"])).toThrow(/unexpected argument/);
    // Half a cursor is not a cursor: resuming from a timestamp without its
    // tiebreak repeats or skips every row sharing that timestamp.
    expect(() =>
      parseReviveArgs([
        "--queue",
        "outbox",
        "--producer",
        "wasla-core",
        "--after-occurred-at",
        "2026-01-01T00:00:00.000Z",
      ]),
    ).toThrow(/must be given together/);
  });
});
