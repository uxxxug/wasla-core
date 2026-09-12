import { createHash } from "node:crypto";
import type { Clock } from "../clock.js";
import { CoreError } from "../errors.js";

/**
 * Ingress rate limiting (milestone 8).
 *
 * Placed at the HTTP edge and nowhere else. A limit inside a domain service
 * would be a business rule with an HTTP status code attached, would fire for
 * work the background workers do on nobody's behalf, and would have to be
 * repeated in every service. The edge is the only place where "a caller is
 * sending too much" is even a meaningful sentence.
 *
 * What it explicitly is not:
 *
 * - It is not applied to the outbox relay, the inbound dispatcher, the delivery
 *   worker or the notification dispatcher. Those never pass through the router:
 *   they are invoked directly by the process that runs them, so they cannot be
 *   throttled by construction rather than by configuration.
 * - It does not participate in the request's transaction. The counter is one
 *   statement of its own, before any handler runs, so a refusal cannot roll back
 *   domain work and domain work cannot roll back a refusal.
 */

/**
 * Route classes. A closed set, because the class is a metric label and a policy
 * key: one class per route would be a limit nobody can reason about and a
 * cardinality problem in the exposition.
 */
export type RateClass = "ingress_events" | "write" | "read" | "unmatched";

/**
 * What the limiter counts against.
 *
 * `credential` — the bearer token presented, reduced to a hash. This is the
 * logical identity of the caller: MARKET's credential and MOVE's credential are
 * different subjects, and two callers behind one NAT are still different
 * subjects. The token is hashed and never stored or logged in the clear, the
 * same discipline session tokens already follow.
 *
 * `network` — the client address, hashed, used only when there is no credential
 * to attribute the request to. An unauthenticated caller is the one case where
 * the network address is the only identity available; it is the fallback, never
 * the primary key, because an address is neither stable for one caller nor
 * unique to one caller.
 *
 * Organization is deliberately *not* the key. Resolving a token to an
 * organization requires a session lookup, i.e. a database read before the
 * limiter — which would mean an unauthenticated flood still costs a query per
 * request, exactly what the limiter exists to prevent. A credential belongs to
 * one caller, so per-credential is the strictest limit obtainable without
 * paying that cost. Recorded as a deliberate scope in `docs/observability.md`.
 */
export type SubjectKind = "credential" | "network";

export interface RateLimitSubject {
  kind: SubjectKind;
  /** Hex sha256. Never the token, never the address. */
  hash: string;
}

export interface RateLimitKey {
  subject_kind: SubjectKind;
  subject_hash: string;
  rate_class: RateClass;
}

export interface RateLimitPolicy {
  /** Fixed window length. */
  windowMs: number;
  /** Requests allowed per subject per class per window. */
  limits: Readonly<Record<RateClass, number>>;
}

/**
 * Defaults sized to be generous for the callers CORE actually has (two systems
 * and a small number of operators) and still finite. They are constructor
 * arguments, not constants read from the environment, because CORE does not read
 * configuration — the composition root decides.
 */
export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = {
  windowMs: 60_000,
  limits: {
    // The event ingress is the one endpoint another system calls in volume.
    ingress_events: 600,
    write: 120,
    read: 300,
    // A caller probing paths that do not exist gets the tightest budget.
    unmatched: 60,
  },
};

/**
 * Templates that are never limited: the two liveness routes and the metrics
 * exposition. Throttling a health check makes an unhealthy deployment look
 * unhealthy for the wrong reason, and throttling the scraper blinds the
 * monitoring exactly when a flood is in progress.
 */
export const UNLIMITED_ROUTES: readonly string[] = ["/health", "/ready", "/metrics"];

export function rateClassFor(method: string, template: string | null): RateClass | null {
  if (template !== null && UNLIMITED_ROUTES.includes(template)) return null;
  if (template === null) return "unmatched";
  if (template === "/v1/events" && method === "POST") return "ingress_events";
  return method === "GET" ? "read" : "write";
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** First value of a possibly-repeated header, trimmed. */
function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Derives the subject without touching the database.
 *
 * A malformed or expired token still produces a `credential` subject: the
 * limiter's job is to bound how much work a caller can ask for, and finding out
 * that a token is invalid is itself work. Attributing invalid tokens to the
 * network subject would let a flood of garbage tokens share one budget with
 * every other anonymous caller.
 */
export function subjectFor(headers: Record<string, string | string[] | undefined>): RateLimitSubject {
  const authorization = headerValue(headers, "authorization");
  if (authorization && /^bearer\s+\S/i.test(authorization)) {
    return { kind: "credential", hash: sha256(authorization.replace(/^bearer\s+/i, "")) };
  }
  const forwarded = headerValue(headers, "x-forwarded-for");
  const address =
    (forwarded ? forwarded.split(",")[0]?.trim() : null) ??
    headerValue(headers, "x-real-ip") ??
    headerValue(headers, "x-client-ip");
  // A caller with neither a credential nor a reported address shares one
  // bucket. That is the correct default: unattributable traffic is limited
  // together rather than being exempt.
  return { kind: "network", hash: sha256(address ?? "unattributed") };
}

export type RateLimitDecision =
  | { allowed: true; limit: number; remaining: number; reset_at: Date }
  | { allowed: false; limit: number; remaining: 0; retry_after_ms: number; reset_at: Date };

/**
 * The one operation a backend has to provide: add one to a window and say what
 * the total became.
 *
 * It returns the post-increment count rather than a boolean because the decision
 * belongs to the policy, not to the store, and because "read then write" is the
 * shape of the bug fixed as B-22 — two concurrent callers both reading 99 of 100
 * and both being allowed. Every implementation must make the increment and the
 * read one atomic step.
 */
export interface RateLimitWindowStore {
  hit(key: RateLimitKey, windowStart: Date): Promise<number>;
  /** Removes windows that ended before `before`. Called by the operator loop. */
  prune(before: Date): Promise<number>;
}

/**
 * Reference backend, and the one used with the memory persistence.
 *
 * Atomic because JavaScript execution is single-threaded: nothing can interleave
 * between the read and the write inside `hit`, which has no `await`. That is
 * enough for correctness within one process and is *not* enough across
 * processes — two instances each keep their own counters, so the effective limit
 * is the policy times the number of instances. Stated here rather than
 * discovered later: the Postgres store exists because that difference matters,
 * and the memory store must not be wired into a multi-instance deployment.
 */
export class InMemoryRateLimitWindowStore implements RateLimitWindowStore {
  private readonly windows = new Map<string, { count: number; window_start: number }>();

  async hit(key: RateLimitKey, windowStart: Date): Promise<number> {
    const id = `${key.subject_kind}|${key.subject_hash}|${key.rate_class}|${windowStart.getTime()}`;
    const existing = this.windows.get(id);
    const next = (existing?.count ?? 0) + 1;
    this.windows.set(id, { count: next, window_start: windowStart.getTime() });
    return next;
  }

  async prune(before: Date): Promise<number> {
    let removed = 0;
    for (const [id, entry] of this.windows) {
      if (entry.window_start < before.getTime()) {
        this.windows.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

/**
 * Fixed-window counter.
 *
 * Fixed rather than sliding because a fixed window is one atomic statement and a
 * sliding window is a log of request timestamps per subject — durable state that
 * grows with traffic, for a smoothness nobody has asked for. The known cost is
 * the boundary burst: a caller can spend its budget at the end of one window and
 * again at the start of the next. That is documented, bounded at twice the limit,
 * and acceptable for protecting CORE from a runaway caller.
 */
export class RateLimiter {
  constructor(
    private readonly store: RateLimitWindowStore,
    private readonly clock: Clock,
    private readonly policy: RateLimitPolicy = DEFAULT_RATE_LIMIT_POLICY,
  ) {}

  /** The window a moment belongs to, aligned to the epoch so every instance agrees. */
  private windowStart(now: Date): Date {
    return new Date(Math.floor(now.getTime() / this.policy.windowMs) * this.policy.windowMs);
  }

  async check(subject: RateLimitSubject, rateClass: RateClass): Promise<RateLimitDecision> {
    const limit = this.policy.limits[rateClass];
    const now = this.clock.now();
    const windowStart = this.windowStart(now);
    const resetAt = new Date(windowStart.getTime() + this.policy.windowMs);
    const count = await this.store.hit(
      { subject_kind: subject.kind, subject_hash: subject.hash, rate_class: rateClass },
      windowStart,
    );
    if (count > limit) {
      // Counted even when refused, so a caller that keeps hammering stays
      // refused for the rest of the window rather than being let back in by its
      // own excess.
      return {
        allowed: false,
        limit,
        remaining: 0,
        retry_after_ms: Math.max(0, resetAt.getTime() - now.getTime()),
        reset_at: resetAt,
      };
    }
    return { allowed: true, limit, remaining: limit - count, reset_at: resetAt };
  }
}

/**
 * The refusal.
 *
 * `rate_limited` is a first-class error code with status 429 and `retryable:
 * true`, not a repurposed `unavailable` and certainly not a domain error: a
 * caller must be able to tell "you asked too often, wait" from "the system is
 * broken" and from "your request was wrong". The message carries no subject, no
 * hash and no address — the caller already knows who it is, and anyone else
 * reading the response must not learn it.
 */
export const rateLimited = (decision: Extract<RateLimitDecision, { allowed: false }>): CoreError =>
  new CoreError("rate_limited", "rate limit exceeded for this credential and route class", {
    retry_after_ms: decision.retry_after_ms,
    limit: decision.limit,
  });

/** Headers advertised on every limited response, and on allowed ones. */
export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  const headers: Record<string, string> = {
    "x-ratelimit-limit": String(decision.limit),
    "x-ratelimit-remaining": String(decision.remaining),
    "x-ratelimit-reset": String(Math.ceil(decision.reset_at.getTime() / 1000)),
  };
  if (!decision.allowed) {
    // Seconds, rounded up, per RFC 9110: a `retry-after` of 0 invites an
    // immediate retry that would be refused again.
    headers["retry-after"] = String(Math.max(1, Math.ceil(decision.retry_after_ms / 1000)));
  }
  return headers;
}
