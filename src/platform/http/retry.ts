import { createHash } from "node:crypto";
import type { Clock } from "../clock.js";
import { conflict, invalid } from "../errors.js";
import { newId } from "../ids.js";
import { putRow } from "../persistence/row-rules.js";
import type { Body } from "./body.js";

/**
 * What a second, identical request to a route does.
 *
 * Milestone 30 made authentication a property of the registration and milestone
 * 31 made entitlement one; this is the same shape, one level over, for the
 * question a caller asks after a timeout: *may I send that again?* Until now
 * CORE answered it differently on every route and said so nowhere.
 *
 * Measured on `main` at `bd92b69`, by re-issuing each of the 29 write routes'
 * own recorded request a second time, byte-identical, against the state the
 * response gate's scenario left, and counting the rows of all 25 business
 * tables the reference registry holds before and after each one:
 *
 *   POST /v1/organizations            organization 2 → 3   (same name, same country)
 *   POST /v1/geography/cities         city 1 → 2
 *   POST /v1/geography/service-areas  service_area 1 → 2
 *   POST /v1/subscriptions            subscription 1 → 2, subscription_period 1 → 2,
 *                                     payment_authorization 5 → 6, ledger_transaction 6 → 7,
 *                                     outbox 26 → 30 — a second recurring charge
 *   POST /v1/sessions                 session 3 → 4        (correct, and the reason
 *                                     `new-each-time` exists)
 *
 * Three routes refused the repeat with `409`: `/v1/memberships`, `/v1/plans`
 * and `/v1/plans/{plan_id}/activate`. The rest already collapsed it, by four
 * mechanisms nothing named as a policy: a natural-key upsert (`/v1/identities`,
 * `/v1/wallets` and `…/usage` answer `200` rather than `201` the second time),
 * a caller-supplied reference (`/v1/payment-authorizations` returns the same
 * `authorization_id` for the same `business_reference`, `/v1/events` the same
 * `event_id`), a uniqueness constraint (`/v1/event-subscriptions`), and a state
 * machine that is a no-op once the transition has happened (`…/capture`,
 * `…/void`, `…/cancel`, `…/retire`, `…/deactivate`, `…/activate`, `…/collect`).
 * `POST /v1/geography/regions` deduped on `(country_code, code)` while
 * `/v1/geography/cities` beside it, in the same module, did not — which is the
 * clearest evidence that retry safety was an accident of each handler rather
 * than a property of the surface. No route read an `Idempotency-Key` header:
 * sending one changed nothing, because milestone 14's declaration means an
 * undeclared header is never read at all.
 *
 * One route the reservation expected to duplicate did not:
 * `POST /v1/geography/countries` answered `201` again and wrote no second row,
 * because the country's primary key is the code the caller sends and the repo
 * *upserts* it. It is declared `keyed` all the same, and that is a decision
 * rather than a copy of the reservation: an upsert on a caller-supplied key
 * silences the repeat by overwriting, so the second call to arrive decides what
 * the country's name and default currency are, and a caller retrying a call it
 * never saw the answer to cannot tell that from having been first.
 *
 * So the safety is declared at the registration, like `accepts`, `body` and
 * `authentication`, and the *router* enforces the one mechanism a handler
 * cannot provide for itself. Three mechanisms, because there are three honest
 * answers and no fourth:
 *
 *  - `natural` — the route already collapses a repeat, and the reason names
 *    **how**. This is a claim about the handler, which is why the gate re-drives
 *    every write route twice and fails if a second row appears.
 *  - `keyed` — the route has no natural key to collapse on, so the caller
 *    supplies one and the router collapses the repeat on its behalf.
 *  - `new-each-time` — a repeat legitimately creates a new thing. Issuing a
 *    session is the case: two calls mean two sessions, and collapsing them
 *    would be the defect.
 *
 * Milestone 32 left one bound open and said so here: the record was written
 * *after* the handler answered, so two identical requests in flight at the same
 * moment both found nothing and both ran. Milestone 33 closes it (B-43) by
 * making the row a **claim** written before the work rather than evidence
 * written after it.
 *
 * Re-measured on this branch before anything was changed — five byte-identical
 * `POST /v1/organizations` fired concurrently under one key, rows counted:
 *
 *   reference backend   5 organizations from 5 requests, 0 replays
 *   PostgreSQL          1, 5, 5, 4, 4 organizations across five rounds
 *
 * Nineteen duplicate tenants out of five asked for, and the number changed
 * between rounds of the identical experiment. The finding is not "a concurrent
 * retry can duplicate" but "whether it duplicates is decided by how the event
 * loop interleaved", which is the property this cycle removes. (ROADMAP row 33's
 * reservation recorded "five in four of five rounds"; it is left as written and
 * corrected here additively.)
 *
 * The shape, and why each part of it is not optional:
 *
 *  - **Claim before work.** `claim` inserts a `claimed` row with
 *    `on conflict (method, scope, key) do nothing`. Exactly one request wins,
 *    because the primary key arbitrates rather than a read followed by a write.
 *    This is `worker-claim-atomicity`'s shape one level up.
 *  - **The loser is answered, not run.** A twin that finds a completed record
 *    replays it; a twin that finds a live claim is refused with `409` and
 *    `retry-after: 1`. It never reaches the handler, which is the whole point.
 *  - **A refusal releases the claim.** A handler that answers non-2xx, or
 *    throws, deletes the row — so a caller told its body was invalid can
 *    correct it and resend under the same key, which was already the rule for
 *    recording and now has to be the rule for claiming too.
 *  - **An abandoned claim is recoverable on a bounded schedule.** A claim older
 *    than `CLAIM_HORIZON_MS` is taken over by the next request for the same key,
 *    in the same statement that would have inserted it. No sweeper: see
 *    migration 0021 for why recovering rows nobody is waiting for is the wrong
 *    amount of work.
 *
 * What the loser is told was left open by the reservation, to be decided by
 * measurement. It is `409`, not a bounded wait for the winner's answer, and the
 * reasoning is recorded in `docs/retry-claim.md`: a wait's outcome depends on
 * whether the winner finishes inside the bound, so it would reintroduce a
 * timing-dependent answer — the exact property being removed — and when the
 * bound elapses the honest answer is the `409` anyway, so the wait is the
 * refusal plus a delay plus a held connection per twin.
 */

/** How a route survives being called twice with the same request. */
export type RetryMechanism =
  /** The handler collapses the repeat itself. The reason names the mechanism. */
  | "natural"
  /** The router collapses it, against the caller's `Idempotency-Key`. */
  | "keyed"
  /** A repeat is a new request for a new thing, and must create one. */
  | "new-each-time";

export interface RetrySafetySpec {
  readonly mechanism: RetryMechanism;
  /**
   * Why this route is safe to retry, in the terms of its own mechanism: which
   * natural key collapses the repeat, or what a second call legitimately
   * creates. Never empty — "nobody thought about it" is the state this
   * milestone closed, and it is indistinguishable from a considered answer once
   * it is written down as one.
   */
  readonly reason: string;
}

function declared(mechanism: RetryMechanism, reason: string): RetrySafetySpec {
  if (reason.trim() === "") {
    throw new Error(`a ${mechanism} retry declaration must record why the route is safe to retry`);
  }
  return { mechanism, reason };
}

/**
 * The route already collapses a repeat. The reason must name the mechanism —
 * the natural key, the business reference, or the transition that is a no-op
 * the second time — because that is the claim the gate re-measures.
 */
export function natural(reason: string): RetrySafetySpec {
  return declared("natural", reason);
}

/** The router collapses the repeat, using the key the caller sends. */
export function keyed(reason: string): RetrySafetySpec {
  return declared("keyed", reason);
}

/** A repeat creates a new thing, on purpose, and the reason says what. */
export function newEachTime(reason: string): RetrySafetySpec {
  return declared("new-each-time", reason);
}

/**
 * A read. There is nothing to collapse, because there is nothing to create.
 *
 * Declared as `natural` rather than as a fourth mechanism: the sentence "the
 * route itself makes a repeat harmless" is exactly true of a read, and a
 * mechanism that applied to one HTTP method would be a second way of saying
 * `GET`.
 */
export const SAFE: RetrySafetySpec = natural(
  "a read creates nothing, so a repeat cannot duplicate anything; any number of identical GETs is one question asked twice",
);

/**
 * The default for a write registration, and the reason it is this one.
 *
 * A forgotten declaration must fail closed, and for retry safety "closed" is
 * the router collapsing the repeat — not the route duplicating silently, which
 * is what the five measured routes did. The cost of the default being wrong is
 * that callers of a new route must send a header they did not expect to; the
 * cost of the opposite default being wrong is a second organization, a second
 * subscription and a second recurring charge. So an undeclared write route
 * requires an `Idempotency-Key`, and a route that genuinely needs no key has to
 * say which mechanism makes it safe.
 */
export const KEYED_BY_DEFAULT: RetrySafetySpec = keyed(
  "no mechanism was declared for this write route, so the fail-closed default applies: the router collapses a repeat against the caller's Idempotency-Key rather than letting the route duplicate in silence",
);

/**
 * How long a recorded answer is replayed for.
 *
 * Twenty-four hours, which is the retry horizon of the two callers CORE has:
 * MOVE and MARKET both retry a failed call with backoff over minutes, and an
 * operator re-running a failed job does it the same day. Beyond that a repeat is
 * a new request that happens to reuse a string, and answering it from a
 * day-old record would be the store lying about what CORE just did. The bound
 * is also what makes the table finite without a sweeper: `expires_at` is
 * already a column, `find` treats an expired record as absent, and a row older
 * than this is dead weight rather than a wrong answer waiting to happen.
 */
export const RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * JSON with the object keys in a stable order.
 *
 * Written here because `src/platform/` had none: `ids.ts` hashes a list of
 * strings (`idempotencyKey(...parts)`) and `reputation/service.ts`'s
 * `canonicalPayload` is a typed view of an event payload, not a serialiser.
 * `JSON.stringify` keeps insertion order, so `{a:1,b:2}` and `{b:2,a:1}` — the
 * same request written by two clients, or by one client on two platforms —
 * would hash differently and the second would be refused as a conflict. Sorting
 * the keys is what makes the fingerprint a property of the request rather than
 * of the order its fields happened to arrive in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    // An absent property and a property sent as `undefined` are the same
    // request, so neither contributes to the fingerprint. `null` is a value and
    // does contribute: `organization_id: null` means platform-wide.
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonicalJson(item)}`).join(",")}}`;
}

/**
 * What makes two requests the same request.
 *
 * The method and the route **template** rather than the path: the path of a
 * parameterised route carries identifiers, and two calls to
 * `/v1/things/{id}/act` with different ids are different requests already
 * distinguished by the scope they are recorded under. The parsed body rather
 * than the bytes on the wire: whitespace, key order and a property the route
 * does not declare are not part of what the caller asked for, and `parseBody`
 * has already refused the last of those.
 */
export function fingerprintRequest(method: string, template: string, body: Body): string {
  return createHash("sha256")
    .update(`${method}\u0000${template}\u0000${canonicalJson(body.snapshot())}`)
    .digest("hex");
}

/**
 * How long a claim may be held before the next request may take it over.
 *
 * Sixty seconds, and it is a measurement rather than a round number: the five
 * keyed routes' handlers are timed in `tests/retry-claim.test.ts`, and the gate
 * fails if the slowest of them comes within a tenth of this bound. A claim held
 * longer than a minute is not slow work, it is a process that died holding it.
 *
 * The bound is what makes a crash recoverable at all. Without it an abandoned
 * claim would block its own key until `expires_at` — twenty-four hours — and
 * the caller's only remedy would be to invent a new key, which is the same as
 * having no idempotency.
 */
export const CLAIM_HORIZON_MS = 60 * 1000;

/**
 * What a row means.
 *
 * Two states and no third. `released` is not a state, because a row that means
 * "nobody is doing this and there is no answer" is a row that should not exist:
 * keeping it would make the absence of a record two things to check instead of
 * one, and the primary key could no longer be the arbiter of the claim.
 */
export type RetryState = "claimed" | "completed";

/**
 * One row of the `idempotency_key` table, as migration 0021 leaves it.
 *
 * `scope` is the route template and `method` is its own column, so the two
 * facts a record is scoped by are two columns rather than one composed string
 * nothing can index or read back. The pair plus the key is the primary key,
 * which is what makes "the same key on two routes" two records instead of a
 * collision — and, since 0021, what decides which of two concurrent twins does
 * the work.
 *
 * `response_status` is nullable because the row now exists before the answer
 * does. `idempotency_key_state_record_ck` is what keeps that from meaning
 * anything else: null status only ever accompanies `claimed`.
 */
export interface RetryRecordRow {
  readonly key: string;
  readonly method: string;
  readonly scope: string;
  readonly request_fingerprint: string;
  readonly state: RetryState;
  readonly claim_token: string;
  readonly claimed_at: string;
  readonly completed_at: string | null;
  readonly response_status: number | null;
  readonly response_body: unknown;
  readonly created_at: string;
  readonly expires_at: string;
}

/** A row whose answer has been recorded, which is the only kind worth replaying. */
export interface RetryCompletedRow extends RetryRecordRow {
  readonly state: "completed";
  readonly response_status: number;
}

/** The three columns that identify a record, which is what a caller's key means. */
export interface RetryLookup {
  readonly key: string;
  readonly method: string;
  readonly scope: string;
}

/** What the router asks to be allowed to do the work. */
export interface RetryClaimRequest extends RetryLookup {
  readonly request_fingerprint: string;
}

/** What the router presents to prove the claim it holds is still its own. */
export interface RetryClaimHold extends RetryLookup {
  readonly claim_token: string;
}

/** What the router records once a keyed route has answered. */
export interface RetryEntry extends RetryClaimHold {
  readonly response_status: number;
  readonly response_body: unknown;
}

/**
 * The four answers `claim` can give, which are the four situations a keyed
 * request can be in. Exhaustive on purpose: the router switches on `outcome`
 * and a fifth situation would have to be added here before it could be handled
 * anywhere.
 */
export type RetryClaimOutcome =
  /** The work is this request's to do, and this token is what completes it. */
  | { readonly outcome: "claimed"; readonly claim_token: string }
  /** A twin already answered. Replay it; do not run the handler. */
  | { readonly outcome: "completed"; readonly record: RetryCompletedRow }
  /** A twin is doing the work now. Refuse; do not run the handler. */
  | { readonly outcome: "in_flight"; readonly claimed_at: string }
  /** The key is in use for a *different* request. Refuse. */
  | { readonly outcome: "reused" };

/**
 * The four operations a backend has to provide.
 *
 * `find` takes the whole lookup rather than the key alone because a key is only
 * unique within a route: two systems retrying two different calls with the same
 * generated string must not be answered from each other's record, and a port
 * that took `find(key)` would leave that scoping to whoever remembered it.
 *
 * The store, not the router, stamps `created_at`, `claimed_at`, `completed_at`
 * and `expires_at`: it owns the clock, as every other store in CORE does, and a
 * router that computed the expiry would need a clock of its own for one line and
 * would be a second place the retention is written down.
 *
 * `claim` replaces milestone 32's `find`-then-`record` pair as the thing the
 * router calls before the handler, and that is the whole of B-43: a read
 * followed by a write cannot decide a winner, and a single conditional insert
 * can. `complete` and `release` both take the token, so a request whose
 * abandoned claim was taken over cannot write over the new owner's work — the
 * fence `worker-claim-atomicity` gates for the four workers, applied here.
 */
export interface RetryRecordStore {
  /**
   * The row for this key on this route, or `null` when there is none or it has
   * expired. Returns a claimed row as readily as a completed one: the router
   * does not read it on the request path any more, and a `find` that hid live
   * claims would make the table unobservable in exactly the state an operator
   * would want to look at it.
   */
  find(lookup: RetryLookup): Promise<RetryRecordRow | null>;
  /** Asks to do the work, and says what to do instead when the answer is no. */
  claim(request: RetryClaimRequest): Promise<RetryClaimOutcome>;
  /**
   * Records the answer against a claim this request still holds. `false` when
   * the claim has moved on, which is not an error: the caller is owed its
   * answer either way, and the router logs it.
   */
  complete(entry: RetryEntry): Promise<boolean>;
  /**
   * Gives up a claim without recording an answer, so the key may be used again
   * immediately. `false` when the claim was already gone.
   */
  release(hold: RetryClaimHold): Promise<boolean>;
}

/**
 * Reference backend, and the one the memory persistence uses.
 *
 * The body is round-tripped through JSON on the way in, for the same reason the
 * Postgres adapter cannot avoid it: the column is `jsonb`, so what a caller gets
 * from a replay on Postgres is what JSON can carry and nothing more. A
 * reference store that replayed the handler's original object graph would
 * replay `undefined` properties and class instances the database silently drops,
 * and the two backends would answer a replay differently — which is the defect
 * B-12 names, in the one place a test would be least likely to look.
 */
export class InMemoryRetryRecordStore implements RetryRecordStore {
  private readonly records = new Map<string, RetryRecordRow>();

  /** See `InMemoryInbox` for why the clock is optional and defaults this way. */
  constructor(private readonly clock: Clock = { now: () => new Date() }) {}

  /** The primary key of migration 0020, as one map key. */
  private id(lookup: RetryLookup): string {
    return `${lookup.method}\u0000${lookup.scope}\u0000${lookup.key}`;
  }

  /**
   * The live row, or `undefined` when there is none or it has expired.
   *
   * Synchronous, and that is load-bearing rather than tidy: `claim` decides a
   * winner by reading and writing with no `await` between the two, which on one
   * thread is as atomic as `on conflict do nothing` is on Postgres. Milestone
   * 32's `record` awaited its own `find` and that alone was enough to let two
   * twins both see nothing — the reference backend duplicated all five requests
   * in the measurement above, more reliably than Postgres did.
   */
  private live(lookup: RetryLookup): RetryRecordRow | undefined {
    const found = this.records.get(this.id(lookup));
    if (found === undefined) return undefined;
    // Expired is absent, not stale: the column exists, so a record past it must
    // not be replayed, and the caller is entitled to have its request run again.
    if (new Date(found.expires_at).getTime() <= this.clock.now().getTime()) return undefined;
    return found;
  }

  async find(lookup: RetryLookup): Promise<RetryRecordRow | null> {
    return this.live(lookup) ?? null;
  }

  async claim(request: RetryClaimRequest): Promise<RetryClaimOutcome> {
    const now = this.clock.now();
    const existing = this.live(request);
    if (existing !== undefined) {
      // A claim nobody has completed within the horizon is taken over, request
      // and all: the row is the new owner's from here, and the old owner's
      // token no longer matches, so its `complete` becomes a no-op.
      const abandoned =
        existing.state === "claimed" &&
        new Date(existing.claimed_at).getTime() + CLAIM_HORIZON_MS <= now.getTime();
      if (!abandoned) {
        // Fingerprint before state, in both backends: a key reused for a
        // different request is refused whether the twin is finished or still
        // working, because the answer to "may I do this?" is no either way and
        // the reason the caller needs to hear is the reuse.
        if (existing.request_fingerprint !== request.request_fingerprint) {
          return { outcome: "reused" };
        }
        if (existing.state === "completed") {
          return { outcome: "completed", record: existing as RetryCompletedRow };
        }
        return { outcome: "in_flight", claimed_at: existing.claimed_at };
      }
    }
    const token = newId();
    putRow("idempotency_key", this.records, this.id(request), {
      key: request.key,
      method: request.method,
      scope: request.scope,
      request_fingerprint: request.request_fingerprint,
      state: "claimed",
      claim_token: token,
      claimed_at: now.toISOString(),
      completed_at: null,
      response_status: null,
      response_body: null,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + RETENTION_MS).toISOString(),
    });
    return { outcome: "claimed", claim_token: token };
  }

  async complete(entry: RetryEntry): Promise<boolean> {
    const existing = this.live(entry);
    // Fenced on the token and on the state: a claim that was taken over, or one
    // some other request already completed, is not this request's to write.
    if (existing === undefined) return false;
    if (existing.state !== "claimed" || existing.claim_token !== entry.claim_token) return false;
    const now = this.clock.now();
    putRow("idempotency_key", this.records, this.id(entry), {
      ...existing,
      state: "completed",
      completed_at: now.toISOString(),
      response_status: entry.response_status,
      // Round-tripped through JSON for the reason the class comment gives: the
      // column is `jsonb`, so a replay must carry what JSON can carry and
      // nothing more, on both backends.
      response_body: JSON.parse(JSON.stringify(entry.response_body ?? null)) as unknown,
    });
    return true;
  }

  async release(hold: RetryClaimHold): Promise<boolean> {
    const existing = this.live(hold);
    if (existing === undefined) return false;
    if (existing.state !== "claimed" || existing.claim_token !== hold.claim_token) return false;
    // Deleted rather than marked: see `RetryState` for why there is no third
    // state to move it to. `tests/delete-parity.test.ts` classifies this.
    this.records.delete(this.id(hold));
    return true;
  }

  /** The rows this store holds, for the reference backend's key registry. */
  rows(): ReadonlyMap<string, RetryRecordRow> {
    return this.records;
  }
}

/**
 * The refusal a `keyed` route gives a caller that sent no key.
 *
 * It names the header and says why CORE insists on it, because the caller of a
 * route that used to accept the request without one has to be able to fix it
 * from the refusal alone. This is the breaking half of the milestone and it is
 * stated in the contract as well.
 */
export const missingIdempotencyKey = (method: string, template: string) =>
  invalid(
    `${method} ${template} requires an Idempotency-Key header: this route has no natural key to collapse a repeat on, ` +
      "so the key is what lets CORE answer a retried request with the answer it already gave instead of creating a second row",
  );

/**
 * The refusal when a key is reused for a different request.
 *
 * A conflict rather than a replay: the caller either reused a key it should have
 * renewed, or two of its own requests are sharing one key. Answering the second
 * request with the first one's result would be worse than refusing it, because
 * the caller would be told its second, different request succeeded.
 */
export const idempotencyKeyReused = () =>
  conflict("this Idempotency-Key was already used with a different request");

/**
 * The refusal when the identical request is already being worked on.
 *
 * A `409`, because the state CORE holds — a live claim on this key — is what
 * prevents the request, which is what `conflict` means. Not `429`: the caller
 * did not ask too often, it asked at the same moment as itself, and the
 * rate-limit code would send it to a backoff loop reading a budget that is not
 * the thing in its way.
 *
 * `details` names the twin's claim time rather than describing it, so a caller
 * that sees this in a log can tell "my own retry raced me" from "something else
 * is using my key" without asking CORE a second question. It is not the answer
 * to the request and it is not pretending to be: the request did not run, and
 * `retry-after` says when to ask again.
 *
 * One thing this refusal reports wrongly, measured rather than assumed: the
 * body's `retryable` is `false`, because `CoreError` derives it from the code
 * alone and every `conflict` is unretryable. That is right for a reuse and
 * wrong here — this one comes good by itself, which is why it carries
 * `retry-after` at all. Left wrong on purpose and recorded as a blocker: making
 * it right means letting a refusal override the flag its code implies, which is
 * a change to the shared error type, and reaching into that type from this
 * cycle would be changing the thing under measurement while measuring it.
 */
export const idempotencyKeyInFlight = (claimedAt: string) =>
  conflict(
    "an identical request under this Idempotency-Key is already being processed: it was not run again, and nothing was created. " +
      "Resend the identical request after retry-after to be given the answer the first one produced",
    { claimed_at: claimedAt },
  );

/**
 * The header that tells a refused twin when to come back.
 *
 * One second, whole, per RFC 9110 and per `response-headers.ts`, which refuses
 * `0`. It is a floor rather than an estimate: CORE cannot know how long the
 * twin will take, and a number invented from the claim horizon would be a
 * minute of waiting for work that measurably finishes in milliseconds.
 */
export const IN_FLIGHT_HEADERS: Readonly<Record<string, string>> = { "retry-after": "1" };

/**
 * The header that marks an answer as one CORE has given before.
 *
 * A caller cannot otherwise tell a collapsed retry from a fresh success, and the
 * difference matters to anything reconciling its own records against CORE's: the
 * second `201` created nothing. Declared in `response-headers.ts`, which is what
 * makes sending it possible at all.
 */
export const REPLAYED_HEADERS: Readonly<Record<string, string>> = { "idempotent-replay": "true" };
