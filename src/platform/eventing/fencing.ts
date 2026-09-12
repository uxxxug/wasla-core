import { randomUUID } from "node:crypto";

/**
 * Claim fencing for the three eventing queues (B-26).
 *
 * B-22 made a claim exclusive at the instant it is taken: `claimDue` writes, so
 * two workers polling together cannot both get the row. What no lock and no
 * timestamp can give is exclusivity *over time*. A worker that stalls past its
 * lease is reclaimed, the row is claimed and finished by somebody else, and then
 * the first worker wakes up and acknowledges work that is no longer its own. The
 * statement names the row by id, so it applies, and the row ends up describing
 * the attempt that was abandoned instead of the one that happened.
 *
 * A token closes that window. It is stamped on the row at claim time and handed
 * to the worker; every acknowledgement carries it back and matches on it. The
 * first worker's token was cleared when its claim was taken away, so its late
 * acknowledgement matches nothing and is refused — reported as `fenced`, which is
 * a metric outcome that has existed since Milestone 8 and could not be produced by
 * three of the four workers until now.
 *
 * What a fence does not do: it does not stop the duplicate *side effect*. If the
 * stalled worker already published to the bus or POSTed to a subscriber, that has
 * happened and no token can undo it — the delivery guarantee is at-least-once and
 * stays at-least-once. What the fence protects is the row: the recorded status,
 * error, response code and timestamps stay those of the attempt that actually
 * completed.
 */

/**
 * Absence of a fence: the caller never claimed the row and is not a worker.
 *
 * Named rather than passed as a bare `null` so it is legible at the call site and
 * greppable in review — every unfenced acknowledgement in the codebase should be
 * findable in one search. There is exactly one legitimate user: an operator
 * replaying an inbound event (`src/platform/replay/service.ts`), which moves a
 * `pending` or `dead` row forward without ever holding a claim.
 */
export const UNFENCED = null;

/** A claim token, or `UNFENCED` for a caller that holds no claim. */
export type Fence = string | typeof UNFENCED;

/**
 * A fresh token for one claim.
 *
 * v4 UUID, from the platform CSPRNG. It does not need to be unpredictable to be
 * correct — the fence compares equality, it does not authenticate — but it does
 * need to never repeat, including across process restarts, because a repeated
 * token would let a stale acknowledgement match a later claim. A counter would
 * repeat on restart; a timestamp would repeat under a frozen test clock.
 */
export function newClaimToken(): string {
  return randomUUID();
}

/**
 * True when this acknowledgement must be refused.
 *
 * Three cases, and the middle one is the one worth stating: a row whose
 * `claim_token` is null is held by nobody, so a worker presenting a token for it
 * has already lost its claim — recovery cleared the token when it took the row
 * back. Refusing there is not an edge case, it is the main line of the defect
 * B-26 describes.
 */
export function isFenced(rowToken: string | null, fence: Fence): boolean {
  if (fence === UNFENCED) return false;
  return rowToken !== fence;
}

/**
 * Thrown to abort a transaction whose acknowledgement was fenced.
 *
 * The outbox relay marks a row published *inside* the same transaction that queues
 * its fan-out deliveries, on purpose (that is the dual-write the outbox exists to
 * prevent). When `markPublished` is refused, returning false is not enough: the
 * fan-out rows are already written in that scope and would commit against a row
 * this worker no longer owns. Throwing is what rolls them back.
 *
 * Its own class, not a plain `Error`, because the relay's catch block cannot tell a
 * refusal from a publish failure by message — and treating a fence as a publish
 * failure would charge an attempt and schedule a retry for work that the current
 * claim holder is already doing.
 */
export class FencedError extends Error {
  constructor(readonly recordId: string) {
    super(`acknowledgement fenced: ${recordId} is no longer held by this claim`);
    this.name = "FencedError";
  }
}
