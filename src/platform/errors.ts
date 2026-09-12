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
 * `rate_limited` is retryable by definition: the response carries `retry-after`
 * precisely because repeating the request later is the correct behaviour.
 */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "unavailable",
  "internal",
  "rate_limited",
]);

export class CoreError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CoreError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return STATUS[this.code];
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
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
export const conflict = (m: string, d?: Record<string, unknown>) =>
  new CoreError("conflict", m, d);
