/**
 * Operator revival of dead queue rows (B-27).
 *
 * Replay (`./service.ts`) covers `inbound_event`. This covers the other two
 * queues, and it is a sibling rather than a branch inside `ReplayService` because
 * the two operations differ in the only place that matters: what they do to cause
 * the work to happen again.
 *
 * - Replay **publishes**. It hands the stored envelope to the `EventBus` itself,
 *   so it needs normalisation, the consumer registry, the inbox, tenant scoping
 *   and a redelivery mode.
 * - Revival **publishes nothing**. It returns the row to `pending` and stops. The
 *   outbox relay then publishes the stored envelope; the delivery worker then
 *   POSTs the stored envelope. Same `event_id`, same `occurred_at`, same payload,
 *   same signature.
 *
 * Folding revival into `ReplayService` would have produced one service whose
 * behaviour bifurcates completely on which queue it was given, sharing only the
 * word "operator". What is worth sharing is the *rules*, and those are shared
 * literally: a scope must narrow, a limit is mandatory and bounded, a dry run
 * writes nothing at all, a run is journalled before its first effect and again
 * with its counts, and only one run may be in flight (its own advisory key, so a
 * revival and a replay do not block each other — they touch different tables).
 *
 * The one thing revival deliberately does *not* reuse is the publish path, and
 * that is the answer to the question B-27 was blocked on: reviving a dead outbox
 * row re-publishes the original envelope unchanged rather than emitting a fresh
 * one with a new `event_id`. Emitting a new envelope would need a new publish
 * path, and every consumer inbox and every subscriber deduplicating on `event_id`
 * would see an old fact as new — a duplicate effect bought for nothing.
 */
import type { AuditLog } from "../audit/audit.js";
import type { Clock } from "../clock.js";
import { conflict, invalid } from "../errors.js";
import type { DeliveryStore } from "../eventing/delivery.js";
import type { OutboxStore } from "../eventing/outbox.js";
import type {
  DeliveryRevivalSelection,
  OutboxRevivalSelection,
  RevivalQueue,
} from "../eventing/revival.js";
import { newId } from "../ids.js";
import type { ReplayLock } from "./lock.js";

/**
 * What to revive. The queue is part of the scope rather than a separate argument
 * so that a report, a journal entry and a command line all carry it as one thing
 * an operator can read back.
 */
export type RevivalScope =
  | ({ queue: "outbox" } & OutboxRevivalSelection)
  | ({ queue: "event_delivery" } & DeliveryRevivalSelection);

export type RevivalOutcomeKind =
  | "revived"
  | "skipped_not_dead"
  | "skipped_subscription_inactive"
  | "failed";

const OUTCOME_KINDS: readonly RevivalOutcomeKind[] = [
  "revived",
  "skipped_not_dead",
  "skipped_subscription_inactive",
  "failed",
];

/**
 * What happened to one row.
 *
 * Identifiers and reasons only, with no payload field, for the same reason
 * `ReplayOutcome` has none: neither an operator's terminal nor the audit metadata
 * may carry the contents of an event that describes a real person's order.
 */
export interface RevivalOutcome {
  /** `event_id` on the outbox, `delivery_id` on the delivery queue. */
  id: string;
  outcome: RevivalOutcomeKind;
  /** Present on every non-`revived` outcome: why. Safe to log. */
  reason?: string;
}

export interface RevivalReport {
  revival_id: string;
  queue: RevivalQueue;
  dry_run: boolean;
  scope: RevivalScope;
  actor: RevivalActor;
  started_at: string;
  finished_at: string;
  discovered: number;
  counts: Record<RevivalOutcomeKind, number>;
  outcomes: readonly RevivalOutcome[];
  /** True when a failure stopped the run before the scope was exhausted. */
  stopped_early: boolean;
  failure?: { id: string; reason: string };
  /**
   * Where to continue. On failure this points **before** the row that failed, so
   * resuming retries it instead of stepping over the one row that did not work.
   * `null` means "from the beginning of the scope".
   */
  resume_after: RevivalCursor | null;
  /** True when the scope may hold more rows than `limit` returned. */
  more_available: boolean;
}

/** Cursor shape per queue, matching the order each `selectDead` returns. */
export type RevivalCursor =
  | { occurred_at: string; event_id: string }
  | { created_at: string; delivery_id: string };

/** Who ordered the revival. Recorded in the journal; never inferred. */
export interface RevivalActor {
  actor_type: "principal" | "system" | "service";
  actor_id: string | null;
}

/** A single run may touch at most this many rows. The same number replay uses. */
const MAX_LIMIT = 1000;

/**
 * One candidate row, reduced to what the loop needs: an id to act on, a cursor
 * position to resume from, and — for a delivery — the subscription whose state
 * decides whether reviving it is legitimate at all.
 */
interface Candidate {
  id: string;
  cursor: RevivalCursor;
  subscription_id?: string;
}

/**
 * Rejects a scope that would sweep every dead row in the queue.
 *
 * The queue name does not count as narrowing: `{ queue: "outbox", limit: 1000 }`
 * is "revive the dead letter queue", which is precisely the request that must be
 * spelled out rather than defaulted to. An operation nobody can review before it
 * runs is not an operation.
 */
function assertNarrow(scope: RevivalScope): void {
  const narrowing =
    scope.queue === "outbox"
      ? scope.event_ids !== undefined ||
        scope.event_types !== undefined ||
        scope.producer !== undefined ||
        scope.entity_type !== undefined ||
        scope.entity_id !== undefined ||
        scope.occurred_from !== undefined ||
        scope.occurred_to !== undefined
      : scope.delivery_ids !== undefined ||
        scope.event_ids !== undefined ||
        scope.subscription_id !== undefined ||
        scope.created_from !== undefined ||
        scope.created_to !== undefined;
  if (!narrowing) {
    throw invalid(
      scope.queue === "outbox"
        ? "revival scope must narrow by at least one of: event_ids, event_types, producer, " +
            "entity_type, entity_id, occurred_from/occurred_to"
        : "revival scope must narrow by at least one of: delivery_ids, event_ids, " +
            "subscription_id, created_from/created_to",
    );
  }
  if (!Number.isInteger(scope.limit) || scope.limit < 1 || scope.limit > MAX_LIMIT) {
    throw invalid(`revival limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  if (scope.queue === "outbox") {
    if (scope.event_ids && scope.event_ids.length === 0) throw invalid("event_ids must not be empty");
    if (scope.event_types && scope.event_types.length === 0) {
      throw invalid("event_types must not be empty");
    }
  } else {
    if (scope.delivery_ids && scope.delivery_ids.length === 0) {
      throw invalid("delivery_ids must not be empty");
    }
    if (scope.event_ids && scope.event_ids.length === 0) throw invalid("event_ids must not be empty");
  }
}

function zeroCounts(): Record<RevivalOutcomeKind, number> {
  return Object.fromEntries(OUTCOME_KINDS.map((kind) => [kind, 0])) as Record<
    RevivalOutcomeKind,
    number
  >;
}

function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class QueueRevivalService {
  constructor(
    private readonly outbox: OutboxStore,
    private readonly deliveries: DeliveryStore,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    private readonly lock: ReplayLock,
  ) {}

  /**
   * What a revival would do, without doing any of it.
   *
   * No write, no status change, and deliberately no audit entry either — the same
   * absolute guarantee `ReplayService.plan` gives, for the same reason: a dry run
   * that journals itself is a dry run that writes, and this method is provably
   * incapable of mutation. `outcome: "revived"` in a plan means "would be
   * revived".
   */
  async plan(scope: RevivalScope): Promise<RevivalReport> {
    assertNarrow(scope);
    const startedAt = this.clock.now().toISOString();
    const candidates = await this.discover(scope);
    const outcomes: RevivalOutcome[] = [];
    for (const candidate of candidates) {
      const refusal = await this.refuse(candidate);
      outcomes.push(refusal ?? { id: candidate.id, outcome: "revived" });
    }
    return this.report({
      revivalId: newId(),
      dryRun: true,
      scope,
      actor: { actor_type: "system", actor_id: null },
      startedAt,
      discovered: candidates.length,
      outcomes,
      stoppedEarly: false,
      failure: undefined,
      resumeAfter: scope.after ?? null,
    });
  }

  /**
   * Revive the scope for real.
   *
   * One row at a time, each its own statement. There is no transaction around the
   * loop and there should not be: the rows are independent, a failure at row 300
   * must not discard 299 correct revivals, and per-row commits are what make the
   * resume cursor mean anything. A revival is also the cheapest possible thing to
   * repeat — a second run over the same scope finds the rows already pending and
   * reports `skipped_not_dead`.
   */
  async run(scope: RevivalScope, actor: RevivalActor): Promise<RevivalReport> {
    assertNarrow(scope);
    const lease = await this.lock.acquire();
    if (!lease) {
      // Refused, not queued, exactly as a second replay is: a revival waiting
      // behind another revival would run later against a state the operator never
      // inspected.
      throw conflict("another queue revival is already running");
    }
    try {
      const revivalId = newId();
      const startedAt = this.clock.now().toISOString();
      const candidates = await this.discover(scope);
      // Journalled before the first write, so a run that dies mid-way still left
      // evidence that it began and with what scope.
      await this.audit.record({
        actor_type: actor.actor_type,
        actor_id: actor.actor_id,
        action: "queue_revival.started",
        entity_type: "queue_revival",
        entity_id: revivalId,
        correlation_id: revivalId,
        metadata: { queue: scope.queue, scope: { ...scope }, discovered: candidates.length },
      });

      const outcomes: RevivalOutcome[] = [];
      let stoppedEarly = false;
      let failure: RevivalReport["failure"];
      let resumeAfter = scope.after ?? null;

      for (const candidate of candidates) {
        const refusal = await this.refuse(candidate);
        if (refusal) {
          // A refusal is decided, not pending: the cursor moves past it so a
          // resume does not re-examine what it already reported on.
          outcomes.push(refusal);
          resumeAfter = candidate.cursor;
          continue;
        }
        try {
          const applied = await this.revive(scope.queue, candidate.id);
          outcomes.push(
            applied
              ? { id: candidate.id, outcome: "revived" }
              : {
                  id: candidate.id,
                  outcome: "skipped_not_dead",
                  // Between the select and the update. Reported rather than
                  // hidden, because "somebody else already did it" is an answer
                  // the operator needs and is the evidence that running the same
                  // revival twice causes nothing twice.
                  reason: "row was no longer dead when the revival reached it",
                },
          );
          resumeAfter = candidate.cursor;
        } catch (error) {
          const reason = reasonOf(error);
          outcomes.push({ id: candidate.id, outcome: "failed", reason });
          failure = { id: candidate.id, reason };
          // Always stops. Unlike a replay, where one event can fail on its own
          // merits while the next succeeds, the only way a revival's single-row
          // status update fails is that the database refused it — which the next
          // row will meet too. Carrying on would produce a long report of the
          // same error.
          stoppedEarly = true;
          break;
        }
      }

      const report = this.report({
        revivalId,
        dryRun: false,
        scope,
        actor,
        startedAt,
        discovered: candidates.length,
        outcomes,
        stoppedEarly,
        failure,
        resumeAfter,
      });
      await this.audit.record({
        actor_type: actor.actor_type,
        actor_id: actor.actor_id,
        action: "queue_revival.finished",
        entity_type: "queue_revival",
        entity_id: revivalId,
        correlation_id: revivalId,
        metadata: {
          queue: scope.queue,
          scope: { ...scope },
          discovered: report.discovered,
          counts: report.counts,
          stopped_early: report.stopped_early,
          failure: report.failure ?? null,
          resume_after: report.resume_after,
          more_available: report.more_available,
          // Bounded, like the replay journal: a thousand-row run must not write a
          // thousand-line audit entry. The counts are the auditable facts and the
          // per-row detail is the operator's report — except the ids actually
          // brought back, which are what somebody reading the journal later needs
          // in order to explain why an event was published twice.
          revived_ids: report.outcomes
            .filter((outcome) => outcome.outcome === "revived")
            .slice(0, 50)
            .map((outcome) => outcome.id),
        },
      });
      return report;
    } finally {
      await lease.release();
    }
  }

  private async discover(scope: RevivalScope): Promise<Candidate[]> {
    if (scope.queue === "outbox") {
      const records = await this.outbox.selectDead(scope);
      return records.map((record) => ({
        id: record.event.event_id,
        cursor: { occurred_at: record.event.occurred_at, event_id: record.event.event_id },
      }));
    }
    const deliveries = await this.deliveries.selectDead(scope);
    return deliveries.map((delivery) => ({
      id: delivery.delivery_id,
      cursor: { created_at: delivery.created_at, delivery_id: delivery.delivery_id },
      subscription_id: delivery.subscription_id,
    }));
  }

  /**
   * The one reason a discovered row may not be revived, shared by `plan` and
   * `run` so a dry run cannot disagree with the run it predicts.
   *
   * Fan-out only ever queues a delivery for a subscription that was **active**
   * when the event was relayed, so deactivating a subscription is how an operator
   * stops CORE sending to that subscriber. Reviving into a deactivated
   * subscription would make revival the one path in CORE that POSTs to an
   * endpoint somebody deliberately switched off. A delivery that was already
   * pending when the subscription was deactivated is a different case and is left
   * alone here: it predates the decision, and draining it is not this command's
   * business.
   */
  private async refuse(candidate: Candidate): Promise<RevivalOutcome | undefined> {
    if (candidate.subscription_id === undefined) return undefined;
    const subscription = await this.deliveries.getSubscription(candidate.subscription_id);
    if (!subscription) {
      return {
        id: candidate.id,
        outcome: "skipped_subscription_inactive",
        reason: `subscription ${candidate.subscription_id} no longer exists`,
      };
    }
    if (!subscription.active) {
      return {
        id: candidate.id,
        outcome: "skipped_subscription_inactive",
        reason: `subscription ${candidate.subscription_id} is not active`,
      };
    }
    return undefined;
  }

  private async revive(queue: RevivalQueue, id: string): Promise<boolean> {
    const now = this.clock.now();
    return queue === "outbox"
      ? await this.outbox.revive(id, now)
      : await this.deliveries.revive(id, now);
  }

  private report(input: {
    revivalId: string;
    dryRun: boolean;
    scope: RevivalScope;
    actor: RevivalActor;
    startedAt: string;
    discovered: number;
    outcomes: readonly RevivalOutcome[];
    stoppedEarly: boolean;
    failure: RevivalReport["failure"];
    resumeAfter: RevivalCursor | null;
  }): RevivalReport {
    const counts = zeroCounts();
    for (const outcome of input.outcomes) counts[outcome.outcome] += 1;
    return {
      revival_id: input.revivalId,
      queue: input.scope.queue,
      dry_run: input.dryRun,
      scope: input.scope,
      actor: input.actor,
      started_at: input.startedAt,
      finished_at: this.clock.now().toISOString(),
      discovered: input.discovered,
      counts,
      outcomes: input.outcomes,
      stopped_early: input.stoppedEarly,
      failure: input.failure,
      resume_after: input.resumeAfter,
      // A full page means there may be another one, so an operator paging through
      // a large scope knows the run was bounded by `limit` and not by the data
      // running out.
      more_available: input.discovered === input.scope.limit,
    };
  }
}
