/**
 * Canonical error model (ADR: Contract Principles).
 * Every API error serialises to { code, message, details, retryable, correlation_id }.
 */
/**
 * The vocabulary and the status each word maps to, in **one** table — milestone
 * 37. Until then the code list was a hand-written union, the status map a second
 * table, the retryable set a third and the published `Error.code` enum a fourth,
 * all restating each other. Nothing compared them, and two words survived in all
 * four that CORE could not say: `precondition_failed` was constructed nowhere in
 * `src/` or `tests/` and is gone, and `unavailable` was constructed nowhere and
 * now has a producer (`/ready`, below). `ErrorCode` is derived from this table's
 * keys, so a code cannot exist without a status, and `tests/error-vocabulary`
 * requires every key to be produced by a real answer and the published enum to
 * be exactly these keys.
 */
const STATUS = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
  /**
   * CORE is up and cannot serve. Distinct from `internal`, which says CORE has a
   * defect: an orchestrator reading `500` from a readiness probe concludes the
   * deployment is broken, while `503` tells it to wait. Produced by `/ready`
   * when the dependency it checks cannot answer.
   */
  unavailable: 503,
} as const satisfies Record<string, number>;

/** Every code CORE can produce, derived from the one table above. */
export type ErrorCode = keyof typeof STATUS;

/** The vocabulary itself, for the gate and for anything that must enumerate it. */
export const ERROR_CODES: readonly ErrorCode[] = Object.keys(STATUS) as ErrorCode[];

/** The status each code answers with, readable without constructing an error. */
export const statusForCode = (code: ErrorCode): number => STATUS[code];

/**
 * Codes that are retryable **without CORE being able to say when**. A caller
 * that receives one of these should try again on its own schedule, because
 * CORE does not know how long its dependency will be unwell.
 *
 * `rate_limited` is here as well as carrying a time, which is not a
 * duplication: it would be retryable even if the window could not be
 * calculated, and the time it does state is what makes the retry useful rather
 * than what makes it legitimate.
 *
 * This set is not the whole answer to "may I retry this?". A refusal that
 * states a time is retryable whatever its code says — see `retryable` below,
 * and B-44 for the four refusals that used to answer otherwise.
 */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "unavailable",
  "internal",
  "rate_limited",
]);

export class CoreError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  /**
   * When CORE can say *when* the caller should come back, in whole seconds.
   *
   * This is the single place that fact lives. Before milestone 34 the
   * `retry-after` header was assembled beside the error in two unrelated
   * places while `retryable` was derived from the code alone, so the header
   * and the flag were two independent statements about one thing — and they
   * disagreed on every in-flight idempotency refusal, which is what B-44 was.
   * Now the flag and the header are both read off this field, so they cannot.
   */
  readonly retryAfterSeconds?: number;

  constructor(
    code: ErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "CoreError";
    this.code = code;
    this.details = details;
    if (retryAfterSeconds !== undefined) {
      // Refused at construction rather than rendered wrong, the way
      // `anonymous("")` is: a `retry-after` of `0` invites an immediate retry
      // that will be refused again, and a fractional or negative one is not a
      // value RFC 9110 allows. `response-headers.ts` refuses these too, but by
      // then the error exists and something has to decide what to do with it.
      if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
        throw new Error(
          `retryAfterSeconds must be a whole number of seconds not below 1, received ${String(retryAfterSeconds)}`,
        );
      }
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }

  get status(): number {
    return STATUS[this.code];
  }

  /**
   * True when repeating the identical request unchanged may succeed.
   *
   * Two ways to be retryable and they are different claims: the code says CORE
   * or its dependency is unwell and will likely recover (`unavailable`,
   * `internal`, `rate_limited`), or the refusal states a time, which is CORE
   * saying the obstacle is temporary and naming it. The second overrides the
   * first way round that matters: a `conflict` is not retryable in general,
   * and a `conflict` that hands back a `retry-after` is — because CORE only
   * states a time when it knows the refusal comes good by itself.
   */
  get retryable(): boolean {
    return this.retryAfterSeconds !== undefined || RETRYABLE.has(this.code);
  }

  /**
   * The headers this refusal implies, rendered from the same field the body's
   * `retryable` is read from. Every path in the router that renders a
   * `CoreError` merges this, so a refusal that states a time cannot be sent
   * without its header and a header cannot be sent without the flag agreeing.
   */
  get headers(): Readonly<Record<string, string>> {
    return this.retryAfterSeconds === undefined
      ? {}
      : { "retry-after": String(this.retryAfterSeconds) };
  }

  toBody(correlationId: string) {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
      correlation_id: correlationId,
    };
  }
}

export const invalid = (m: string, d?: Record<string, unknown>) =>
  new CoreError("invalid_request", m, d);
export const unauthenticated = (m = "unauthenticated") => new CoreError("unauthenticated", m);
export const forbidden = (m = "forbidden", d?: Record<string, unknown>) =>
  new CoreError("forbidden", m, d);
export const notFound = (m: string, d?: Record<string, unknown>) =>
  new CoreError("not_found", m, d);
export const conflict = (m: string, d?: Record<string, unknown>, retryAfterSeconds?: number) =>
  new CoreError("conflict", m, d, retryAfterSeconds);
/**
 * CORE is up and a dependency it needs is not. A constructor exists for the same
 * reason the other five do — milestone 37 found `unavailable` published in the
 * contract's `code` enum with no way to construct it, so a caller was asked to
 * branch on an answer it could never receive. No `retryAfterSeconds`: CORE does
 * not know when its dependency recovers, and `retryable` is true from the code
 * alone.
 */
export const unavailable = (m: string, d?: Record<string, unknown>) =>
  new CoreError("unavailable", m, d);
