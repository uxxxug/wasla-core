import { testId } from "./support/ids.js";
import { InMemoryAuditLog } from "../src/platform/audit/audit.js";
import { describe, expect, it } from "vitest";
import { FixedClock } from "../src/platform/clock.js";
import { makeEvent } from "../src/platform/eventing/envelope.js";
import { InMemoryOutbox } from "../src/platform/eventing/outbox.js";
import { withTransaction } from "../src/platform/eventing/unit-of-work.js";
import {
  InMemoryTransactionBoundary,
  type TransactionBoundary,
  type TransactionScope,
} from "../src/platform/persistence/transaction.js";

function event(id: string) {
  return makeEvent({
    event_type: "core.identity.verified",
    version: 1,
    producer: "wasla-core",
    occurred_at: new Date("2026-01-01T00:00:00.000Z"),
    correlation_id: "c",
    entity_type: "identity",
    entity_id: id,
    payload: { identity_id: id },
  });
}

/**
 * Boundary that records what happened, so the tests can assert that the work
 * and the outbox append really were inside one transaction rather than merely
 * looking like it.
 */
class RecordingBoundary implements TransactionBoundary {
  readonly log: string[] = [];
  readonly scope: TransactionScope = { handle: "recording-tx" };

  async run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    this.log.push("begin");
    try {
      const result = await work(this.scope);
      this.log.push("commit");
      return result;
    } catch (error) {
      this.log.push("rollback");
      throw error;
    }
  }
}

describe("transaction boundary", () => {
  it("commits the mutation and the outbox append inside one transaction", async () => {
    const boundary = new RecordingBoundary();
    const outbox = new InMemoryOutbox(new FixedClock());
    const applied: string[] = [];

    await withTransaction({ boundary, outbox, audit: new InMemoryAuditLog(new FixedClock()) }, (uow) => {
      uow.stage(() => {
        applied.push("mutation");
      });
      uow.emit(event(testId("identity-1")));
    });

    expect(boundary.log).toEqual(["begin", "commit"]);
    expect(applied).toEqual(["mutation"]);
    expect(await outbox.all()).toHaveLength(1);
  });

  it("hands every staged mutation the scope of the surrounding transaction", async () => {
    const boundary = new RecordingBoundary();
    const outbox = new InMemoryOutbox(new FixedClock());
    const seen: TransactionScope[] = [];

    await withTransaction({ boundary, outbox, audit: new InMemoryAuditLog(new FixedClock()) }, (uow) => {
      uow.stage((scope) => {
        seen.push(scope);
      });
      uow.stage((scope) => {
        seen.push(scope);
      });
    });

    // A repository write that receives this scope joins the transaction.
    // A write that ignores it escapes, which is the whole point of passing it.
    expect(seen).toEqual([boundary.scope, boundary.scope]);
  });

  it("rolls back and appends nothing when the work throws", async () => {
    const boundary = new RecordingBoundary();
    const outbox = new InMemoryOutbox(new FixedClock());
    const applied: string[] = [];

    await expect(
      withTransaction({ boundary, outbox, audit: new InMemoryAuditLog(new FixedClock()) }, (uow) => {
        uow.stage(() => {
          applied.push("mutation");
        });
        uow.emit(event(testId("identity-2")));
        throw new Error("domain rule rejected the command");
      }),
    ).rejects.toThrow(/domain rule rejected/);

    expect(boundary.log).toEqual(["begin", "rollback"]);
    expect(applied).toEqual([]);
    expect(await outbox.all()).toHaveLength(0);
  });

  it("rolls back when a staged mutation itself fails", async () => {
    const boundary = new RecordingBoundary();
    const outbox = new InMemoryOutbox(new FixedClock());

    await expect(
      withTransaction({ boundary, outbox, audit: new InMemoryAuditLog(new FixedClock()) }, (uow) => {
        uow.stage(() => {
          throw new Error("unique violation");
        });
        uow.emit(event(testId("identity-3")));
      }),
    ).rejects.toThrow(/unique violation/);

    expect(boundary.log).toEqual(["begin", "rollback"]);
    // The event was emitted before the mutation failed and must not survive it.
    expect(await outbox.all()).toHaveLength(0);
  });

  it("orders the unit of work as mutation, audit, then outbox append", async () => {
    const boundary = new RecordingBoundary();
    const clock = new FixedClock();
    const order: string[] = [];
    const outbox = new InMemoryOutbox(clock);
    const recording = {
      ...outbox,
      append: async (e: ReturnType<typeof event>, scope: TransactionScope) => {
        order.push("append");
        return outbox.append(e, scope);
      },
    } as unknown as InMemoryOutbox;
    const auditLog = new InMemoryAuditLog(clock);
    const recordingAudit = {
      ...auditLog,
      record: async (entry: Parameters<InMemoryAuditLog["record"]>[0], scope?: TransactionScope) => {
        order.push("audit");
        return auditLog.record(entry, scope);
      },
      entries: () => auditLog.entries(),
      forEntity: (t: string, i: string) => auditLog.forEntity(t, i),
    } as unknown as InMemoryAuditLog;

    await withTransaction({ boundary, outbox: recording, audit: recordingAudit }, (uow) => {
      uow.stage(() => {
        order.push("mutation");
      });
      uow.audit({
        actor_type: "system",
        actor_id: null,
        action: "identity.registered",
        entity_type: "identity",
        entity_id: testId("identity-4"),
        correlation_id: "corr-1",
        metadata: {},
      });
      uow.emit(event(testId("identity-4")));
    });

    // The append stays last on purpose: a failure anywhere earlier then means
    // no event was ever written, which is what the relay relies on.
    expect(order).toEqual(["mutation", "audit", "append"]);
  });

  it("the reference boundary keeps the same rollback semantics", async () => {
    const outbox = new InMemoryOutbox(new FixedClock());
    const applied: string[] = [];

    await expect(
      withTransaction({ boundary: new InMemoryTransactionBoundary(), outbox, audit: new InMemoryAuditLog(new FixedClock()) }, (uow) => {
        uow.stage(() => {
          applied.push("mutation");
        });
        uow.emit(event(testId("identity-5")));
        throw new Error("nope");
      }),
    ).rejects.toThrow(/nope/);

    expect(applied).toEqual([]);
    expect(await outbox.all()).toHaveLength(0);
  });
});
