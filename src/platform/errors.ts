/**
 * Canonical error model (ADR: Contract Principles).
 * Every API error serialises to { code, message, details, retryable, correlation_id }.
 */
export type ErrorCode =
  | "invalid_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "precondition_failed"
  /**
   * The caller asked too often. Its own code, because "wait and try the same
   * request again" is advice no other code in this list gives: `unavailable`
   * says CORE is unwell, `invalid_request` says the request was wrong, and
   * `conflict` says the state moved. Only this one means the request was fine
   * and the timing was not.
   */
  | "rate_limited"
  | "unavailable"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

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
