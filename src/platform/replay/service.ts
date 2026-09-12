/**
 * Historical event replay (milestone 6).
 *
 * The problem this solves: CORE has kept every inbound event since migration
 * 0007, and until now the only thing that could act on one was the dispatcher,
 * which only ever looks at rows that are `pending` and due. An event that went
 * `dead` after five failed attempts, or that was accepted while a consumer had a
 * bug, was durable and unreachable at the same time. Replay makes those rows
 * reachable — deliberately, narrowly, and with a record of what happened.
 *
 * What it is not:
 *
 * - **Not an event bus.** It publishes through the existing `EventBus`, so
 *   consumers cannot tell a replayed event from a dispatched one, and there is no
 *   second delivery path to keep in step with the first.
 * - **Not a second source of truth.** It writes no domain state itself. Every
 *   effect is the consumer's own handler doing what it always does, protected by
 *   the invariants it always has. There is no replay-specific shortcut into the
 *   ledger, and no replay-specific transition anywhere.
 * - **Not "re-run everything".** A scope must narrow (see `assertNarrow`), and
 *   it must be finite. An operation nobody can review before it runs is not an
 *   operation, it is an accident with a command line.
 */
import type { AuditLog } from "../audit/audit.js";
import type { Clock } from "../clock.js";
import { conflict, invalid } from "../errors.js";
import type { EventBus } from "../eventing/bus.js";
import type { InboxStore } from "../eventing/inbox.js";
import type {
  InboundEventStore,
  InboundRecord,
  InboundSelection,
  InboundStatus,
} from "../eventing/ingress.js";
import { newId } from "../ids.js";
import { normalize, type NormalizationRejection } from "../eventing/normalize.js";
import type { ReplayLock } from "./lock.js";

/**
 * How a replayed event meets the consumer inbox.
 *
 * Redelivery and replay are not the same operation, and conflating them is how a
 * "harmless re-run" captures a payment twice:
 *
 * - `pending_only` — publish the event and let the inbox decide. A consumer that
 *   already handled it does nothing; one that never did, does. This is the same
 *   guarantee at-least-once delivery already relies on, which is why it is the
 *   default: it can be run against any scope without asking whether an effect
 *   has already happened.
 * - `reapply` — clear this event's inbox entries for the consumers of its type
 *   first, so their handlers run again. This is the *only* way to obtain a second
 *   execution, it must be asked for by name, and it is not a way around
 *   idempotency: the handlers still enforce their own invariants, so a second
 *   capture is refused by the ledger rather than permitted by the replay. Its
 *   legitimate use is a consumer whose handler was wrong and has been fixed.
 *
 * Nothing here ever rewrites an `event_id` or wraps the envelope in a new one.
 * That would defeat the inbox by making an old event look new, which is the
 * cheapest possible way to cause a double effect and the reason the stored
 * envelope is republished byte for byte.
 */
export type ReplayMode = "pending_only" | "reapply";

/**
 * What to replay. At least one filter must narrow, and `limit` is mandatory.
 */
export interface ReplayScope {
  event_ids?: readonly string[];
  event_types?: readonly string[];
  producer?: string;
  statuses?: readonly InboundStatus[];
  received_from?: string;
  received_to?: string;
  occurred_from?: string;
  occurred_to?: string;
  /**
   * Restrict to one tenant. Events that do not carry a tenant scope are
   * refused, not assumed — see `organization_id` on `CanonicalEvent`.
   */
  organization_id?: string;
  /** Resume point: continue strictly after this position. */
  after?: { received_at: string; event_id: string };
  limit: number;
}

export type ReplayOutcomeKind =
  | "applied"
  | "skipped_duplicate"
  | "skipped_no_consumer"
  | "skipped_tenant_unknown"
  | "skipped_tenant_mismatch"
  | "not_normalizable"
  | "failed";

const OUTCOME_KINDS: readonly ReplayOutcomeKind[] = [
  "applied",
  "skipped_duplicate",
  "skipped_no_consumer",
  "skipped_tenant_unknown",
  "skipped_tenant_mismatch",
  "not_normalizable",
  "failed",
];

/**
 * What happened to one event.
 *
 * Identifiers, types and reasons only. No payload field exists on this type, so
 * neither a report on an operator's terminal nor the audit metadata can leak the
 * contents of an event that may describe a real person's order.
 */
export interface ReplayOutcome {
  event_id: string;
  event_type: string;
  version: number;
  received_at: string;
  status: InboundStatus;
  outcome: ReplayOutcomeKind;
  /** Present on every non-`applied` outcome: why. Safe to log. */
  reason?: string;
  rejection?: NormalizationRejection;
  /** Consumers the event was published to, or would have been. */
  consumers?: readonly string[];
}

export interface ReplayReport {
  replay_id: string;
  mode: ReplayMode;
  dry_run: boolean;
  scope: ReplayScope;
  actor: ReplayActor;
  started_at: string;
  finished_at: string;
  discovered: number;
  counts: Record<ReplayOutcomeKind, number>;
  outcomes: readonly ReplayOutcome[];
  /** True when a failure stopped the run before the scope was exhausted. */
  stopped_early: boolean;
  failure?: { event_id: string; event_type: string; reason: string };
  /**
   * Where to continue.
   *
   * On failure this points **before** the event that failed, so resuming
   * retries it rather than skipping it — a resume that silently steps over the
   * one event that did not work would be the worst possible reading of
   * "resumable". `null` means "from the beginning of the scope".
   */
  resume_after: { received_at: string; event_id: string } | null;
  /** True when the scope may hold more rows than `limit` returned. */
  more_available: boolean;
}

/** Who ordered the replay. Recorded in the journal; never inferred. */
export interface ReplayActor {
  actor_type: "principal" | "system" | "service";
  actor_id: string | null;
}

/** The statuses replay looks at when the operator does not say. */
const DEFAULT_STATUSES: readonly InboundStatus[] = ["pending", "dead"];

/** A single run may touch at most this many events. */
const MAX_LIMIT = 1000;

/**
 * Rejects a scope that would sweep the whole history.
 *
 * `statuses` alone does not count as narrowing: `statuses: ["processed"]` is
 * every event CORE has ever handled. What counts is something that ties the run
 * to a specific set of facts an operator can describe in a sentence.
 */
function assertNarrow(scope: ReplayScope): void {
  const narrowing =
    scope.event_ids !== undefined ||
    scope.event_types !== undefined ||
    scope.producer !== undefined ||
    scope.received_from !== undefined ||
    scope.received_to !== undefined ||
    scope.occurred_from !== undefined ||
    scope.occurred_to !== undefined ||
    scope.organization_id !== undefined;
  if (!narrowing) {
    throw invalid(
      "replay scope must narrow by at least one of: event_ids, event_types, producer, " +
        "received_from/received_to, occurred_from/occurred_to, organization_id",
    );
  }
  if (!Number.isInteger(scope.limit) || scope.limit < 1 || scope.limit > MAX_LIMIT) {
    throw invalid(`replay limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  if (scope.event_ids && scope.event_ids.length === 0) {
    throw invalid("event_ids must not be empty");
  }
  if (scope.event_types && scope.event_types.length === 0) {
    throw invalid("event_types must not be empty");
  }
}

function zeroCounts(): Record<ReplayOutcomeKind, number> {
  return Object.fromEntries(OUTCOME_KINDS.map((kind) => [kind, 0])) as Record<
    ReplayOutcomeKind,
    number
  >;
}

function selectionFor(scope: ReplayScope): InboundSelection {
  return {
    event_ids: scope.event_ids,
    event_types: scope.event_types,
    producer: scope.producer,
    statuses: scope.statuses ?? DEFAULT_STATUSES,
    received_from: scope.received_from,
    received_to: scope.received_to,
    occurred_from: scope.occurred_from,
    occurred_to: scope.occurred_to,
    after: scope.after,
    limit: scope.limit,
  };
}

function positionOf(record: InboundRecord): { received_at: string; event_id: string } {
  return { received_at: record.received_at, event_id: record.event.event_id };
}

function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface ReplayOptions {
  /**
   * Stop at the first failing event. Default, and the safe default: events from
   * one producer about one entity arrive in an order that means something, and
   * carrying on past a failure would apply later facts on top of an earlier one
   * that never landed. Set false only to survey which events in a scope fail.
   */
  stopOnError?: boolean;
}

export class ReplayService {
  constructor(
    private readonly store: InboundEventStore,
    private readonly bus: EventBus,
    private readonly inbox: InboxStore,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    private readonly lock: ReplayLock,
  ) {}

  /**
   * What a replay would do, without doing any of it.
   *
   * Every event in scope is normalised and classified exactly as `run` would
   * classify it, then nothing happens: no publish, no inbox write, no status
   * change, and deliberately **no audit entry either**. A dry-run that journals
   * itself is a dry-run that writes, and the guarantee worth having here is the
   * absolute one — this method is provably incapable of mutation, which is
   * demonstrated by running it against a store built on a read-only connection
   * where any write is refused by Postgres itself. The cost is that a dry-run
   * leaves no trace; the operator's terminal has the report, and the run that
   * follows is journalled.
   *
   * `outcome: "applied"` in a plan therefore means "would be applied".
   */
  async plan(scope: ReplayScope, mode: ReplayMode = "pending_only"): Promise<ReplayReport> {
    assertNarrow(scope);
    const startedAt = this.clock.now().toISOString();
    const records = await this.store.select(selectionFor(scope));
    const outcomes: ReplayOutcome[] = [];
    for (const record of records) {
      outcomes.push(await this.classify(record, scope, mode));
    }
    return this.report({
      replayId: newId(),
      mode,
      dryRun: true,
      scope,
      actor: { actor_type: "system", actor_id: null },
      startedAt,
      records,
      outcomes,
      stoppedEarly: false,
      failure: undefined,
      resumeAfter: scope.after ?? null,
    });
  }

  /**
   * Replay the scope for real.
   *
   * One event at a time, each publish standing alone. There is deliberately no
   * transaction around the loop: consumers open their own units of work (and
   * `TransactionBoundary` refuses to nest), and a single transaction spanning
   * hundreds of events would mean a failure at event 300 discards 299 correct
   * effects and leaves no partial progress to resume from. Per-event commits are
   * what make the resume cursor meaningful.
   */
  async run(
    scope: ReplayScope,
    mode: ReplayMode,
    actor: ReplayActor,
    options: ReplayOptions = {},
  ): Promise<ReplayReport> {
    assertNarrow(scope);
    const stopOnError = options.stopOnError ?? true;
    const lease = await this.lock.acquire();
    if (!lease) {
      // Refused, not queued. A replay waiting behind another replay would run
      // later against a state the operator never inspected.
      throw conflict("another replay is already running");
    }
    try {
      const replayId = newId();
      const startedAt = this.clock.now().toISOString();
      const records = await this.store.select(selectionFor(scope));
      // Journalled before the first effect, so a run that dies mid-way still
      // left evidence that it began and with what scope.
      await this.audit.record({
        actor_type: actor.actor_type,
        actor_id: actor.actor_id,
        action: "event_replay.started",
        entity_type: "event_replay",
        entity_id: replayId,
        correlation_id: replayId,
        metadata: { mode, scope: { ...scope }, discovered: records.length },
      });

      const outcomes: ReplayOutcome[] = [];
      let stoppedEarly = false;
      let failure: ReplayReport["failure"];
      let resumeAfter = scope.after ?? null;

      for (const record of records) {
        const classified = await this.classify(record, scope, mode);
        if (classified.outcome !== "applied") {
          // Skipped and unreadable events are decided, not pending: the cursor
          // moves past them so a resume does not re-examine what it already
          // reported on.
          outcomes.push(classified);
          resumeAfter = positionOf(record);
          continue;
        }
        try {
          await this.deliver(record, mode);
          outcomes.push(classified);
          resumeAfter = positionOf(record);
        } catch (error) {
          const reason = reasonOf(error);
          outcomes.push({ ...classified, outcome: "failed", reason });
          // `attempts`, `next_attempt_at` and `status` are left exactly as they
          // were. Replay must not spend the live queue's retry budget or push a
          // pending row's next attempt out: the dispatcher's schedule is the
          // dispatcher's, and an operator's replay failing should not change
          // what the system was already going to do on its own.
          failure = {
            event_id: record.event.event_id,
            event_type: record.event.event_type,
            reason,
          };
          if (stopOnError) {
            stoppedEarly = true;
            break;
          }
        }
      }

      const report = this.report({
        replayId,
        mode,
        dryRun: false,
        scope,
        actor,
        startedAt,
        records,
        outcomes,
        stoppedEarly,
        failure,
        resumeAfter,
      });
      await this.audit.record({
        actor_type: actor.actor_type,
        actor_id: actor.actor_id,
        action: "event_replay.finished",
        entity_type: "event_replay",
        entity_id: replayId,
        correlation_id: replayId,
        metadata: {
          mode,
          scope: { ...scope },
          discovered: report.discovered,
          counts: report.counts,
          stopped_early: report.stopped_early,
          failure: report.failure ?? null,
          resume_after: report.resume_after,
          more_available: report.more_available,
          // Bounded: a thousand-event run must not write a thousand-line audit
          // row. The full per-event detail is the operator's report; the journal
          // keeps the counts, which are the auditable facts, plus enough failing
          // ids to act on.
          failed_event_ids: report.outcomes
            .filter((o) => o.outcome === "failed")
            .slice(0, 20)
            .map((o) => o.event_id),
        },
      });
      return report;
    } finally {
      await lease.release();
    }
  }

  /**
   * Decides an event's fate without causing it. Read-only by construction:
   * `plan` and `run` share this exact code so a dry-run cannot disagree with the
   * run it is meant to predict.
   */
  private async classify(
    record: InboundRecord,
    scope: ReplayScope,
    mode: ReplayMode,
  ): Promise<ReplayOutcome> {
    const base = {
      event_id: record.event.event_id,
      event_type: record.event.event_type,
      version: record.event.version,
      received_at: record.received_at,
      status: record.status,
    };
    const normalized = normalize(record.event, record.received_at);
    if (!normalized.ok) {
      // The stored row stays exactly as it is. An event CORE cannot read is a
      // fact about a gap in CORE, and rewriting its status would destroy the
      // evidence needed to fix it.
      return {
        ...base,
        outcome: "not_normalizable",
        rejection: normalized.rejection,
        reason: normalized.detail,
      };
    }
    if (scope.organization_id !== undefined) {
      const tenant = normalized.event.organization_id;
      if (tenant === null) {
        return {
          ...base,
          outcome: "skipped_tenant_unknown",
          reason:
            `${record.event.event_type} carries no organization scope, so it cannot be ` +
            "attributed to a tenant without guessing (dependency B-23)",
        };
      }
      if (tenant !== scope.organization_id) {
        return {
          ...base,
          outcome: "skipped_tenant_mismatch",
          reason: "event belongs to a different organization",
        };
      }
    }
    const consumers = this.bus.consumersFor(record.event.event_type);
    if (consumers.length === 0) {
      return {
        ...base,
        outcome: "skipped_no_consumer",
        reason: `no consumer is subscribed to ${record.event.event_type}`,
        consumers,
      };
    }
    if (mode === "pending_only") {
      const seen = await Promise.all(consumers.map((c) => this.inbox.seen(c, record.event.event_id)));
      if (seen.every(Boolean)) {
        // Every consumer has already handled it, so publishing would be a
        // no-op. Reported rather than hidden: "nothing to do" is the answer an
        // operator most needs to see, and it is the evidence that a second
        // replay of the same scope causes no second effect.
        return {
          ...base,
          outcome: "skipped_duplicate",
          reason: "every consumer has already processed this event",
          consumers,
        };
      }
    }
    return { ...base, outcome: "applied", consumers };
  }

  private async deliver(record: InboundRecord, mode: ReplayMode): Promise<void> {
    if (mode === "reapply") {
      // The explicit, named, documented way to get a second execution. It is a
      // property of the mode, not a side effect of anything else: no other path
      // in CORE clears an inbox entry to force a re-handle.
      for (const consumer of this.bus.consumersFor(record.event.event_type)) {
        await this.inbox.release(consumer, record.event.event_id);
      }
    }
    // The stored envelope, unchanged. Same `event_id`, so the inbox still
    // recognises it; same `occurred_at`, so a consumer that compares timestamps
    // sees the original fact and not the replay.
    await this.bus.publish(record.event);
    if (record.status !== "processed") {
      // Now true, and it stops the dispatcher from doing the same work again.
      // Only ever moves a row forward: replay never returns a `processed` row to
      // `pending`, and never resets `attempts`.
      await this.store.markProcessed(record.event.event_id);
    }
  }

  private report(input: {
    replayId: string;
    mode: ReplayMode;
    dryRun: boolean;
    scope: ReplayScope;
    actor: ReplayActor;
    startedAt: string;
    records: readonly InboundRecord[];
    outcomes: readonly ReplayOutcome[];
    stoppedEarly: boolean;
    failure: ReplayReport["failure"];
    resumeAfter: { received_at: string; event_id: string } | null;
  }): ReplayReport {
    const counts = zeroCounts();
    for (const outcome of input.outcomes) counts[outcome.outcome] += 1;
    return {
      replay_id: input.replayId,
      mode: input.mode,
      dry_run: input.dryRun,
      scope: input.scope,
      actor: input.actor,
      started_at: input.startedAt,
      finished_at: this.clock.now().toISOString(),
      discovered: input.records.length,
      counts,
      outcomes: input.outcomes,
      stopped_early: input.stoppedEarly,
      failure: input.failure,
      resume_after: input.resumeAfter,
      // A full page means there may be another one. Reported so an operator
      // paging through a large scope knows the run was bounded by `limit` and
      // not by the data running out.
      more_available: input.records.length === input.scope.limit,
    };
  }
}
