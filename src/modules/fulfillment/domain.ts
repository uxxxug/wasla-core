/**
 * Fulfillment coordination domain (ADR 0006).
 *
 * CORE coordinates a fulfillment as an OPAQUE reference: it never learns what
 * was ordered (MARKET's business) and never learns who executes it or how
 * (MOVE's business). It only knows that a commercial order needs operational
 * execution, and it owns the money hold that guards that execution.
 */
export type FulfillmentStatus =
  | "coordinating"
  | "dispatched"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Where the money that guards this fulfillment currently stands, as known by
 * CORE. This is a projection of the money module's authorization state onto
 * the fulfillment, kept so that execution state and financial state can be
 * compared without a cross-module join.
 *
 * - `none`      no hold guards this fulfillment (unfunded coordination).
 * - `held`      the hold exists and is still authorized.
 * - `captured`  the hold was captured in full; the whole consented amount moved.
 * - `released`  the hold was voided and **no money moved at all**.
 * - `partially_captured`
 *               the hold closed with part of the consented amount having moved
 *               and the remainder released. Since migration 0009 a hold can be
 *               captured in legs, so this is a reachable terminal money state
 *               and it is NOT the same fact as `released`: calling it
 *               `released` would claim nothing moved when some did, and the
 *               settlement state is what a reconciliation trusts.
 * - `unsettled` CORE closed the execution but could NOT bring the hold to a
 *               terminal state. It must be reconciled by an operator.
 */
export type SettlementState =
  | "none"
  | "held"
  | "captured"
  | "partially_captured"
  | "released"
  | "unsettled";

export interface Fulfillment {
  fulfillment_id: string;
  organization_id: string;
  market_order_reference: string;
  move_job_reference: string | null;
  /** CORE-owned money hold guarding this fulfillment; null when unfunded. */
  payment_authorization_id: string | null;
  status: FulfillmentStatus;
  /** Financial counterpart of `status`; see SettlementState. */
  settlement_state: SettlementState;
  created_at: string;
  completed_at: string | null;
  closure_reason: string | null;
}

export function isClosed(status: FulfillmentStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** Every status a fulfillment can hold, in lifecycle order. */
export const ALL_STATUSES: readonly FulfillmentStatus[] = [
  "coordinating",
  "dispatched",
  "completed",
  "failed",
  "cancelled",
];

/**
 * The statuses from which a fulfillment can still be closed.
 *
 * Derived from `isClosed` rather than listed a second time: a status added to
 * the union and forgotten here would silently widen or narrow the guard on
 * every terminal transition, which is the guard that makes a closure
 * single-valued (B-21).
 */
export const OPEN_STATUSES: readonly FulfillmentStatus[] = ALL_STATUSES.filter(
  (status) => !isClosed(status),
);

/**
 * What CORE can say about the money behind a fulfillment, derived from the two
 * states and never stored.
 *
 * This exists because `isFinanciallyConsistent` answered one question with a
 * boolean and two different situations collapsed into its `false`: CORE having
 * failed at its own bookkeeping, and CORE having done its job correctly but
 * needing a decision it was never given. An operator cannot act on the same
 * queue for both — one is an incident, the other is a business question — and
 * a boolean forced them to.
 *
 * - `no_money`          no hold guards this fulfillment; nothing to settle.
 * - `awaiting_execution`
 *                       a hold guards open work. Consistent and with nothing
 *                       pending on anyone: the money question is answered when
 *                       the execution closes.
 * - `settled`           the money reached a terminal state that agrees with the
 *                       execution outcome. Nothing further is owed or pending.
 * - `decision_required` execution closed as failed or cancelled while part of
 *                       the payer's money had already moved. The record is
 *                       true and complete; what happens to that amount is a
 *                       policy question CORE has not been given an answer to
 *                       (blocker B-20). CORE does not refund, retain or split
 *                       it, and does not claim it was returned.
 * - `inconsistent`      the two states contradict each other — `unsettled`, or
 *                       an open hold on closed work. This is a CORE defect or a
 *                       failed settlement and needs investigation, not a
 *                       business decision.
 *
 * `decision_required` is deliberately NOT a settled outcome. Reporting a
 * fulfillment as finished while money it moved has no decided destination would
 * make the pending question invisible, and invisible is how the whole
 * `partially_captured` gap survived a cycle.
 */
export type FinancialDisposition =
  | "no_money"
  | "awaiting_execution"
  | "settled"
  | "decision_required"
  | "inconsistent";

export function financialDisposition(fulfillment: Fulfillment): FinancialDisposition {
  const { status, settlement_state: settlement } = fulfillment;
  if (settlement === "unsettled") return "inconsistent";
  if (!isClosed(status)) {
    // Open work may hold money or hold none of it. Anything terminal here means
    // the money moved on without the execution, which is a defect.
    if (settlement === "none") return "no_money";
    return settlement === "held" ? "awaiting_execution" : "inconsistent";
  }
  if (settlement === "held") return "inconsistent";
  if (settlement === "none") return "no_money";
  if (status === "completed") {
    // A job that cost less than the consented ceiling is a legitimate outcome
    // of a capture in legs: the work was delivered and paid for. Nothing is
    // pending, so this is settled and not a decision.
    return settlement === "captured" || settlement === "partially_captured" ? "settled" : "inconsistent";
  }
  // failed | cancelled
  if (settlement === "released") return "settled";
  if (settlement === "partially_captured") return "decision_required";
  return "inconsistent";
}

/**
 * True when money moved for work that did not complete and CORE has not been
 * told what to do with it. The queue this feeds is B-20's, and it is separate
 * from the defect queue on purpose.
 */
export function requiresFinancialDecision(fulfillment: Fulfillment): boolean {
  return financialDisposition(fulfillment) === "decision_required";
}

/**
 * A fulfillment is financially consistent when its execution state and its
 * money state agree:
 *  - open work may only hold money or hold none of it;
 *  - a completed execution must have captured the hold it declared, in full or
 *    in part — a job that cost less than the consented ceiling is a legitimate
 *    outcome of migration 0009's split captures;
 *  - a failed or cancelled execution must have released it and moved nothing;
 *  - `unsettled` is never consistent.
 *
 * `partially_captured` on a **failed or cancelled** fulfillment is deliberately
 * reported as inconsistent. Nothing is broken in CORE's bookkeeping — the money
 * state is terminal and truthful — but the payer has paid for work that did not
 * complete, and whether that money is refunded, kept as a cancellation fee or
 * split is a policy decision CORE has not been given (blocker B-20). Surfacing
 * it in the reconciliation read is the reversible direction: an operator can
 * act on a case CORE reported, and cannot act on one it hid.
 */
export function isFinanciallyConsistent(fulfillment: Fulfillment): boolean {
  // Expressed through the disposition so the two cannot drift apart. Both a
  // pending decision and a contradiction are reported here, because both mean
  // the fulfillment is not finished with money — the disposition is what says
  // which of the two it is, and who should be looking at it.
  const disposition = financialDisposition(fulfillment);
  return (
    disposition === "settled" ||
    disposition === "no_money" ||
    disposition === "awaiting_execution"
  );
}

/*
 * The inbound payload shapes used to be declared here, duplicating the published
 * contracts. They now live in `platform/eventing/normalize.ts` next to the rules
 * that read them, because they describe what arrives from outside CORE rather
 * than anything this module owns — and because two declarations of one contract
 * is one too many.
 */
