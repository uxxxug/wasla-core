/**
 * Bringing a dead queue row back (B-27).
 *
 * The gap this closes: replay (`src/platform/replay/service.ts`) reads
 * `inbound_event` and nothing else. A row that reached `dead` on `outbox` or on
 * `event_delivery` had no path back anywhere in CORE — no requeue, no revive, no
 * equivalent of replay's `dead` status filter. A dead `outbox` row is an event
 * MOVE and MARKET will now **never** receive, and a dead `event_delivery` row is a
 * subscriber that will never be told: durable and unreachable at the same time,
 * which is exactly the defect Milestone 6 was created to remove for inbound
 * events. Recovering one meant a hand-written `update` against production,
 * unreviewed and unaudited. B-25 made it matter more rather than less, because it
 * added a second, entirely new way for rows in those two tables to reach `dead`.
 *
 * **Revival publishes nothing itself.** That is the whole design. It returns the
 * row to `pending` and lets the worker that already owns the queue do what it
 * always does: the relay publishes the stored envelope, the delivery worker POSTs
 * the stored envelope. Same `event_id`, same `occurred_at`, same payload, same
 * signature — the owner's decision, and the only version of it that does not
 * create a second publish path to keep in step with the first. Wrapping the
 * envelope in a fresh one with a new `event_id` was the alternative, and it would
 * defeat every consumer's inbox by making an old fact look new, which is the
 * cheapest possible way to cause a double effect.
 *
 * What a revival writes, per row:
 *
 * | Field | Becomes | Why |
 * | --- | --- | --- |
 * | `status` | `pending` | the whole point; matched on `dead` so it is a transition, not an overwrite |
 * | `next_attempt_at` | now | due immediately; the row has waited long enough for a person to notice it |
 * | `claimed_at` | null | nobody holds it, and the check constraint requires this off a non-pending row anyway |
 * | `claim_token` | null | a token outliving its claim is what B-26 exists to prevent |
 * | `reclaims` | 0 | see below |
 * | `attempts` | unchanged | see below |
 * | `last_error` | unchanged | see below |
 *
 * **`reclaims` is zeroed and `attempts` is not**, and the asymmetry is the load
 * bearing decision here. `attempts` counts failures somebody observed, drives the
 * backoff curve (`baseBackoffMs * 2 ** attempts`) and is what `retrying` is
 * derived from; rewriting it would falsify two derived readings and erase the only
 * record of how hard CORE already tried. `reclaims` bounds nothing except whether
 * recovery may happen again, and counts attempts nobody saw end — evidence about
 * the worker, not about this row. Once an operator has decided the row should run
 * again, an old count of abandonments nobody observed is not a reason to refuse it.
 *
 * The consequence of preserving `attempts` is stated rather than hidden: a row
 * that died at `maxAttempts` gets exactly **one** further attempt, and dies again
 * if that one fails. That is a feature. It makes a revival bounded by
 * construction — no revival can produce a retry storm or a loop — and it puts the
 * decision to try again where it belongs, with a person, in the journal, once per
 * attempt. An operator who needs three more tries revives three times and every
 * one of them is auditable.
 *
 * `last_error` is preserved for the same reason a coroner's report is: it is the
 * only on-row evidence of why the row died, and the revival itself is recorded in
 * the audit journal, where the actor who ordered it is recorded too. Overwriting
 * the error with "revived" would trade the useful fact for one already stored
 * somewhere better.
 */

/** The two queues that had no way back. `inbound_event` already has replay. */
export type RevivalQueue = "outbox" | "event_delivery";

/**
 * Which dead outbox rows to consider.
 *
 * Ordered and paged by `(occurred_at, event_id)` rather than `created_at`: the
 * in-memory backend does not keep a `created_at`, `occurred_at` is on the
 * envelope in both backends, and the two must agree about what page 2 contains or
 * a test that passes in memory certifies nothing (B-12). The `event_id` tiebreak
 * is what makes the order total, and a total order is what makes the cursor safe.
 */
export interface OutboxRevivalSelection {
  event_ids?: readonly string[];
  event_types?: readonly string[];
  producer?: string;
  entity_type?: string;
  entity_id?: string;
  occurred_from?: string;
  occurred_to?: string;
  after?: { occurred_at: string; event_id: string };
  limit: number;
}

/**
 * Which dead deliveries to consider.
 *
 * `(created_at, delivery_id)` here, because a delivery row has a `created_at` in
 * both backends and no `occurred_at` of its own — its event's `occurred_at` lives
 * on the outbox row, and joining to it to page an operator command would buy
 * nothing.
 */
export interface DeliveryRevivalSelection {
  delivery_ids?: readonly string[];
  event_ids?: readonly string[];
  subscription_id?: string;
  created_from?: string;
  created_to?: string;
  after?: { created_at: string; delivery_id: string };
  limit: number;
}

/**
 * Shared filter for dead outbox rows, so both backends admit exactly the same
 * set. The status predicate is deliberately part of the shared helper: a backend
 * that forgot it would offer live rows for revival, and "revive" on a `published`
 * row would republish an event every consumer has already seen.
 */
export function matchesOutboxRevival(
  input: {
    status: string;
    event_id: string;
    event_type: string;
    producer: string;
    entity_type: string;
    entity_id: string;
    occurred_at: string;
  },
  selection: OutboxRevivalSelection,
): boolean {
  if (input.status !== "dead") return false;
  if (selection.event_ids && !selection.event_ids.includes(input.event_id)) return false;
  if (selection.event_types && !selection.event_types.includes(input.event_type)) return false;
  if (selection.producer !== undefined && input.producer !== selection.producer) return false;
  if (selection.entity_type !== undefined && input.entity_type !== selection.entity_type) {
    return false;
  }
  if (selection.entity_id !== undefined && input.entity_id !== selection.entity_id) return false;
  if (selection.occurred_from !== undefined && input.occurred_at < selection.occurred_from) {
    return false;
  }
  if (selection.occurred_to !== undefined && input.occurred_at > selection.occurred_to) {
    return false;
  }
  if (selection.after && !isAfter(input.occurred_at, input.event_id, selection.after.occurred_at, selection.after.event_id)) {
    return false;
  }
  return true;
}

/** Shared filter for dead deliveries. Same contract as `matchesOutboxRevival`. */
export function matchesDeliveryRevival(
  input: {
    status: string;
    delivery_id: string;
    event_id: string;
    subscription_id: string;
    created_at: string;
  },
  selection: DeliveryRevivalSelection,
): boolean {
  if (input.status !== "dead") return false;
  if (selection.delivery_ids && !selection.delivery_ids.includes(input.delivery_id)) return false;
  if (selection.event_ids && !selection.event_ids.includes(input.event_id)) return false;
  if (
    selection.subscription_id !== undefined &&
    input.subscription_id !== selection.subscription_id
  ) {
    return false;
  }
  if (selection.created_from !== undefined && input.created_at < selection.created_from) {
    return false;
  }
  if (selection.created_to !== undefined && input.created_at > selection.created_to) return false;
  if (
    selection.after &&
    !isAfter(input.created_at, input.delivery_id, selection.after.created_at, selection.after.delivery_id)
  ) {
    return false;
  }
  return true;
}

/**
 * Strictly after a cursor position, comparing the pair and not the columns
 * separately.
 *
 * Comparing them separately is the bug replay's Postgres `select` avoids with a
 * row-value comparison: `timestamp > x or id > y` either skips rows sharing a
 * timestamp or repeats them, which is the difference between a resumable
 * operation and one that quietly loses a row on resume.
 */
function isAfter(
  primary: string,
  secondary: string,
  cursorPrimary: string,
  cursorSecondary: string,
): boolean {
  if (primary !== cursorPrimary) return primary > cursorPrimary;
  return secondary > cursorSecondary;
}

/** Shared ordering, so both backends page identically. */
export function compareRevivalPosition(
  a: { primary: string; secondary: string },
  b: { primary: string; secondary: string },
): number {
  return a.primary.localeCompare(b.primary) || a.secondary.localeCompare(b.secondary);
}
