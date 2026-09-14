import { createHash } from "node:crypto";
import type { Clock } from "../clock.js";
import { conflict, invalid } from "../errors.js";
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
 * What this module deliberately does not do: it does not make a `keyed` route
 * safe to retry *concurrently*. The record is written after the handler
 * answered, so two identical requests in flight at the same moment can both
 * reach the handler — the second is collapsed only once the first has been
 * recorded. Closing that needs the record to be claimed before the work, in the
 * handler's own transaction, which is a different design and a different
 * cycle; stating the bound here is the alternative to implying a guarantee the
 * code does not give.
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
 * One row of the `idempotency_key` table, as migration 0020 leaves it.
 *
 * `scope` is the route template and `method` is its own column, so the two
 * facts a record is scoped by are two columns rather than one composed string
 * nothing can index or read back. The pair plus the key is the primary key,
 * which is what makes "the same key on two routes" two records instead of a
 * collision.
 */
export interface RetryRecordRow {
  readonly key: string;
  readonly method: string;
  readonly scope: string;
  readonly request_fingerprint: string;
  readonly response_status: number;
  readonly response_body: unknown;
  readonly created_at: string;
  readonly expires_at: string;
}

/** The three columns that identify a record, which is what a caller's key means. */
export interface RetryLookup {
  readonly key: string;
  readonly method: string;
  readonly scope: string;
}

/** What the router records once a keyed route has answered. */
export interface RetryEntry extends RetryLookup {
  readonly request_fingerprint: string;
  readonly response_status: number;
  readonly response_body: unknown;
}

/**
 * The two operations a backend has to provide.
 *
 * `find` takes the whole lookup rather than the key alone because a key is only
 * unique within a route: two systems retrying two different calls with the same
 * generated string must not be answered from each other's record, and a port
 * that took `find(key)` would leave that scoping to whoever remembered it.
 *
 * The store, not the router, stamps `created_at` and `expires_at`: it owns the
 * clock, as every other store in CORE does, and a router that computed the
 * expiry would need a clock of its own for one line and would be a second place
 * the retention is written down.
 */
export interface RetryRecordStore {
  /** The record for this key on this route, or `null` when there is none or it has expired. */
  find(lookup: RetryLookup): Promise<RetryRecordRow | null>;
  /** Records an answer. Fails if one is already recorded for the same key and route. */
  record(entry: RetryEntry): Promise<void>;
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

  async find(lookup: RetryLookup): Promise<RetryRecordRow | null> {
    const found = this.records.get(this.id(lookup));
    if (found === undefined) return null;
    // Expired is absent, not stale: the column exists, so a record past it must
    // not be replayed, and the caller is entitled to have its request run again.
    if (new Date(found.expires_at).getTime() <= this.clock.now().getTime()) return null;
    return found;
  }

  async record(entry: RetryEntry): Promise<void> {
    const now = this.clock.now();
    // First answer wins, matching the Postgres adapter's `on conflict do
    // nothing`: a row can only be here already if an identical request was
    // recorded between this one's lookup and its write, and the answer a later
    // retry is entitled to is the first one recorded. An expired row is
    // overwritten, because `find` has already stopped returning it.
    if ((await this.find(entry)) !== null) return;
    putRow("idempotency_key", this.records, this.id(entry), {
      key: entry.key,
      method: entry.method,
      scope: entry.scope,
      request_fingerprint: entry.request_fingerprint,
      response_status: entry.response_status,
      response_body: JSON.parse(JSON.stringify(entry.response_body ?? null)) as unknown,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + RETENTION_MS).toISOString(),
    });
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
 * The header that marks an answer as one CORE has given before.
 *
 * A caller cannot otherwise tell a collapsed retry from a fresh success, and the
 * difference matters to anything reconciling its own records against CORE's: the
 * second `201` created nothing. Declared in `response-headers.ts`, which is what
 * makes sending it possible at all.
 */
export const REPLAYED_HEADERS: Readonly<Record<string, string>> = { "idempotent-replay": "true" };
