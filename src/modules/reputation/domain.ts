/**
 * Reputation and trust signals (ADR 0015).
 *
 * ADR 0015 places reputation in CORE and review content in MARKET. That split
 * is the whole design constraint of this module, and it cuts in both
 * directions:
 *
 *   - CORE stores the **signal**: who was rated, by which system, with which
 *     reference, when, and — for a rating — the number. It never stores the
 *     review text, the title, the photographs or anything else a person wrote.
 *     Text is content, content belongs to the product that collected it, and a
 *     copy in CORE would be a second place to moderate, redact and honour a
 *     deletion request from.
 *
 *   - CORE answers the **standing**, and nothing else does. A standing is
 *     derived here, in code, from the signals recorded against a subject. There
 *     is no score column and no score table: a stored aggregate is a second
 *     source of truth for something already fully determined, and this
 *     repository has twice paid for exactly that mistake — settlement state
 *     drifting from the ledger, and the entitlement table that ADR 0013
 *     refused to create for the same reason.
 *
 * What this module deliberately does not decide: how much a kind is worth, how
 * fast a signal ages, and what standing is good enough for anything. Those are
 * product policy (ADR 0018) and are recorded as blockers rather than answered
 * by whichever weighting was easiest to write. A composite "trust score" in
 * CORE would be CORE deciding MARKET's and MOVE's product rules, which is the
 * drift ADR 0018 exists to prevent.
 */

/** Who a signal can be about. Same shape as a wallet or a subscription owner. */
export const REPUTATION_SUBJECT_TYPES = ["identity", "organization"] as const;
export type ReputationSubjectType = (typeof REPUTATION_SUBJECT_TYPES)[number];

/**
 * The closed vocabulary of signal kinds, matching the CHECK constraint in
 * migration 0018.
 *
 * Closed on purpose. An open vocabulary would let a producer invent a kind that
 * counts towards nothing, and CORE would accept it, store it and report a
 * standing that silently ignores it — a fact accepted and discarded is worse
 * than a fact refused, because the producer was told it landed.
 *
 * Every kind here is a fact about a CORE subject that a producing system can
 * observe and CORE cannot. None of them names a MOVE or MARKET entity: the
 * subject is always the identity or organization the work belongs to.
 */
export const REPUTATION_SIGNAL_KINDS = [
  /** A rated outcome. The only kind carrying a number. */
  "service_rating",
  /** Work that was carried through to the end, as reported by the executor. */
  "completion",
  /** Work abandoned by the subject after it had been taken on. */
  "cancellation",
  /** A formal dispute was raised about the subject. */
  "dispute",
  /** Unsolicited positive feedback, with no number attached. */
  "compliment",
  /** Unsolicited negative feedback, with no number attached. */
  "complaint",
] as const;
export type ReputationSignalKind = (typeof REPUTATION_SIGNAL_KINDS)[number];

/** The one kind that carries a value, named once so no call site repeats it. */
export const RATED_KIND: ReputationSignalKind = "service_rating";
export const MIN_RATING = 1;
export const MAX_RATING = 5;

/**
 * One recorded signal.
 *
 * Append-only: the only field that may change after the insert is the
 * retraction marker, and only from absent to present, once. Enforced by a
 * database trigger in migration 0018 and restated by the in-memory store, so
 * neither backend is more permissive than the other (B-12).
 */
export interface ReputationSignal {
  reputation_signal_id: string;
  organization_id: string;
  subject_type: ReputationSubjectType;
  subject_id: string;
  signal_kind: ReputationSignalKind;
  /** 1…5 for `service_rating`, `null` for every other kind. */
  rating_value: number | null;
  /** Which system reported it. Opaque to CORE beyond being non-empty. */
  source_system: string;
  /** The producer's own reference for the fact. The exactly-once key. */
  source_reference: string;
  /** The producer's claim about when it happened. Never used for ordering. */
  occurred_at: string;
  /** CORE's own clock. This is what a standing and a listing order by. */
  recorded_at: string;
  correlation_id: string;
  retracted_at: string | null;
  retraction_reason: string | null;
}

/** The subject of a standing, as a value so no signature takes two loose ids. */
export interface ReputationSubject {
  organization_id: string;
  subject_type: ReputationSubjectType;
  subject_id: string;
}

/**
 * What CORE can say about a subject, derived and never stored.
 *
 * Two numbers rather than one average, deliberately: a caller that wants to
 * combine standings, weight them or apply its own rounding needs the count and
 * the sum, and an average alone cannot be recombined without losing the
 * denominator. `average_rating_milli` is provided because everybody wants it,
 * and it is an integer in thousandths because a float would make two backends
 * — and two languages — disagree in the last digit about a number that ends up
 * in front of a person.
 */
export interface ReputationStanding extends ReputationSubject {
  /** Every signal ever recorded, including retracted ones. */
  signal_count: number;
  /** How many were withdrawn by their producer. */
  retracted_count: number;
  /** Per kind, counting only signals that still stand. */
  counts: Readonly<Record<ReputationSignalKind, number>>;
  /** Ratings that still stand. */
  rating_count: number;
  /** Sum of the ratings that still stand; the denominator's companion. */
  rating_sum: number;
  /** Thousandths of a star, or `null` when nothing has been rated. */
  average_rating_milli: number | null;
  /** Bounds of the recorded window, by CORE's clock. `null` when empty. */
  first_signal_at: string | null;
  last_signal_at: string | null;
}

/** Type guard for the closed kind vocabulary. */
export function isReputationSignalKind(value: unknown): value is ReputationSignalKind {
  return (
    typeof value === "string" &&
    (REPUTATION_SIGNAL_KINDS as readonly string[]).includes(value)
  );
}

/** Type guard for the closed subject vocabulary. */
export function isReputationSubjectType(value: unknown): value is ReputationSubjectType {
  return (
    typeof value === "string" &&
    (REPUTATION_SUBJECT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Whether a kind/value pair is one the schema would accept.
 *
 * The same two halves as the `reputation_signal_rating_shape` constraint, in
 * one place, so the service, the in-memory store and the HTTP edge all refuse
 * the same pairs. A rating with no number cannot be averaged; a dispute with a
 * 4 in it would be read as satisfaction by anything that trusts the column.
 */
export function ratingShapeIsValid(
  kind: ReputationSignalKind,
  value: number | null,
): boolean {
  if (kind === RATED_KIND) {
    return (
      value !== null &&
      Number.isInteger(value) &&
      value >= MIN_RATING &&
      value <= MAX_RATING
    );
  }
  return value === null;
}

/**
 * One kind's contribution to a standing.
 *
 * This type exists so that the *arithmetic* of a standing has exactly one
 * implementation while the *grouping* can happen where it belongs. A subject
 * with ten thousand signals must not be loaded into memory to be counted — the
 * same argument `usageTotal` settled for billing — so the Postgres adapter
 * groups in SQL and returns at most one row per kind, and the in-memory adapter
 * produces the identical rows with `groupSignals`. `deriveStanding` then folds
 * them, once, for both backends. The conformance tests assert the two adapters
 * return the same groups for the same signals, which is what keeps the SQL and
 * the reference implementation from drifting (B-12).
 */
export interface ReputationKindGroup {
  signal_kind: ReputationSignalKind;
  /** Signals of this kind that still stand. */
  standing_count: number;
  /** Signals of this kind that were withdrawn by their producer. */
  retracted_count: number;
  /** Ratings that still stand. Zero for every kind but `service_rating`. */
  rating_count: number;
  /** Sum of the ratings that still stand. */
  rating_sum: number;
  /** Earliest and latest `recorded_at` of this kind, retracted rows included. */
  first_recorded_at: string;
  last_recorded_at: string;
}

/** Zeroed per-kind counters. Built fresh per call so no caller shares one. */
function emptyCounts(): Record<ReputationSignalKind, number> {
  const counts = {} as Record<ReputationSignalKind, number>;
  for (const kind of REPUTATION_SIGNAL_KINDS) counts[kind] = 0;
  return counts;
}

/**
 * Buckets signals by kind — the reference implementation of what the Postgres
 * adapter does with `group by signal_kind`.
 *
 * Kinds with no signals are omitted rather than emitted as zeroes, because that
 * is what a `group by` returns and the two adapters have to agree row for row.
 * Ordering follows `REPUTATION_SIGNAL_KINDS` so a comparison between backends
 * is not sensitive to iteration order.
 */
export function groupSignals(
  signals: readonly ReputationSignal[],
): readonly ReputationKindGroup[] {
  const groups = new Map<ReputationSignalKind, ReputationKindGroup>();
  for (const signal of signals) {
    const existing = groups.get(signal.signal_kind);
    const group: ReputationKindGroup = existing ?? {
      signal_kind: signal.signal_kind,
      standing_count: 0,
      retracted_count: 0,
      rating_count: 0,
      rating_sum: 0,
      first_recorded_at: signal.recorded_at,
      last_recorded_at: signal.recorded_at,
    };
    if (signal.recorded_at < group.first_recorded_at) {
      group.first_recorded_at = signal.recorded_at;
    }
    if (signal.recorded_at > group.last_recorded_at) {
      group.last_recorded_at = signal.recorded_at;
    }
    if (signal.retracted_at !== null) {
      group.retracted_count += 1;
    } else {
      group.standing_count += 1;
      if (signal.signal_kind === RATED_KIND && signal.rating_value !== null) {
        group.rating_count += 1;
        group.rating_sum += signal.rating_value;
      }
    }
    groups.set(signal.signal_kind, group);
  }
  return REPUTATION_SIGNAL_KINDS.map((kind) => groups.get(kind)).filter(
    (group): group is ReputationKindGroup => group !== undefined,
  );
}

/**
 * The standing of a subject, from its grouped signals.
 *
 * Pure and total: no clock, no store, no I/O. That is what makes it testable
 * against hand-written inputs and what makes it safe to call on every read
 * instead of caching an answer that could go stale.
 *
 * A retracted signal counts towards `signal_count` and `retracted_count` and
 * towards nothing else. It is not deleted and not hidden: the producer said it
 * happened and then said it should not count, and both statements are true.
 * Dropping it from the totals is the whole point of the marker — an average
 * that still included a withdrawn rating would be knowingly wrong.
 */
export function deriveStanding(
  subject: ReputationSubject,
  groups: readonly ReputationKindGroup[],
): ReputationStanding {
  const counts = emptyCounts();
  let total = 0;
  let retracted = 0;
  let ratingCount = 0;
  let ratingSum = 0;
  let first: string | null = null;
  let last: string | null = null;

  for (const group of groups) {
    counts[group.signal_kind] = group.standing_count;
    total += group.standing_count + group.retracted_count;
    retracted += group.retracted_count;
    ratingCount += group.rating_count;
    ratingSum += group.rating_sum;
    if (first === null || group.first_recorded_at < first) first = group.first_recorded_at;
    if (last === null || group.last_recorded_at > last) last = group.last_recorded_at;
  }

  return {
    ...subject,
    signal_count: total,
    retracted_count: retracted,
    counts,
    rating_count: ratingCount,
    rating_sum: ratingSum,
    // Integer thousandths, rounded once, here. `null` rather than 0 when
    // nothing has been rated: zero is a rating nobody gave, and a subject with
    // no ratings is not a subject rated badly.
    average_rating_milli:
      ratingCount === 0 ? null : Math.round((ratingSum * 1000) / ratingCount),
    first_signal_at: first,
    last_signal_at: last,
  };
}

/** Convenience for callers holding the signals themselves. One fold, two steps. */
export function standingFromSignals(
  subject: ReputationSubject,
  signals: readonly ReputationSignal[],
): ReputationStanding {
  return deriveStanding(subject, groupSignals(signals));
}
