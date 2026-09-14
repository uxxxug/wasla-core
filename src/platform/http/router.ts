import { IncomingMessage, ServerResponse } from "node:http";
import { CoreError, invalid } from "../errors.js";
import { newId } from "../ids.js";
import type { MetricsRegistry } from "../observability/metrics.js";
import {
  AUTHENTICATED,
  bearerCredential,
  type AuthenticationSpec,
  type Authenticator,
} from "./authentication.js";
import { NO_BODY, parseBody, type Body, type BodySpec } from "./body.js";
import { parseHeaders, type RawHeaders, type RequestHeaders } from "./headers.js";
import { sealHeaders } from "./response-headers.js";
import { parseSelection, type ParamSpec, type Selection } from "./query.js";
import {
  rateClassFor,
  rateLimited,
  rateLimitHeaders,
  subjectFor,
  type RateLimiter,
} from "./rate-limit.js";
import {
  KEYED_BY_DEFAULT,
  REPLAYED_HEADERS,
  SAFE,
  fingerprintRequest,
  idempotencyKeyInFlight,
  idempotencyKeyReused,
  missingIdempotencyKey,
  type RetryClaimOutcome,
  type RetryCompletedRow,
  type RetryRecordStore,
  type RetrySafetySpec,
} from "./retry.js";

export interface RequestContext<A = unknown> {
  method: string;
  path: string;
  params: Record<string, string>;
  /**
   * The query parameters this route declared, already parsed.
   *
   * There is deliberately no `URLSearchParams` here. Milestone 24 made the
   * declaration at the registration the only description of what a route
   * accepts, and a handler holding the raw query string could read a parameter
   * the route never declared — which is the state milestone 23 measured and left
   * open, where an unread parameter was ignored in silence.
   */
  selection: Selection;
  /**
   * The body properties this route declared, already parsed.
   *
   * There is deliberately no raw `body` here, for the reason there is no
   * `URLSearchParams`: milestone 25 measured a capture that took 5000 because
   * `amount_minor` was misspelled `amountMinor` and the route read the body by
   * hand, so an unread property was ignored in silence. A handler can only read
   * what its registration declared; the one route entitled to the body as sent
   * asks for it with `ctx.input.raw()` and declares `opaqueBody(reason)`.
   */
  input: Body;
  /**
   * The declared request headers, already checked.
   *
   * Not a `Record`, for the reason there is no `URLSearchParams` and no raw
   * `body`: milestone 26 measured an 8000-character `x-correlation-id` accepted,
   * echoed and stored, `"   "` accepted as the identity of record, and a repeated
   * `authorization` silently narrowed to its first value. A reader can only ask
   * for a header `DECLARED_HEADERS` names, and asking for anything else throws.
   */
  headers: RequestHeaders;
  /**
   * Who is making this request, established by the router before the handler
   * ran, or `null` on a route whose registration declared itself anonymous.
   *
   * A handler does not authenticate. Milestone 30 measured what happens when it
   * does: authentication was a line inside a function body, so 28 registrations
   * answered `400` about the body to a caller holding no credential, and two
   * answered `404` for an identifier that does not exist and `401` for one that
   * does — an existence oracle for anonymous callers. The router now
   * authenticates every registration that declared `AUTHENTICATED`, before the
   * query string is parsed, before the body is parsed and before any handler
   * runs, so `401` precedes `400` and precedes every lookup by construction
   * rather than by each handler remembering to.
   *
   * `null` is not "unknown": on a required route the request never reaches a
   * handler without a principal, so a handler seeing `null` is on a route that
   * declared itself anonymous and said why.
   */
  principal: A | null;
  correlation_id: string;
  request_id: string;
}

export interface HandlerResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type Handler<A = unknown> = (
  ctx: RequestContext<A>,
) => Promise<HandlerResult> | HandlerResult;

interface Route<A> {
  method: string;
  /**
   * The registered path, parameters included (`/v1/fulfillments/:fulfillment_id`).
   * Kept because it is the only low-cardinality name for a route: the concrete
   * path contains identifiers, so using it as a metric label would be one time
   * series per fulfillment and would publish entity ids to anyone who can scrape.
   */
  template: string;
  segments: string[];
  handler: Handler<A>;
  /**
   * Every query parameter this route accepts. An empty list means the route
   * accepts none and any query string is refused — the default, because a
   * forgotten declaration must fail closed.
   */
  accepts: readonly ParamSpec[];
  /**
   * What this route accepts as a body. `NO_BODY` — the default — refuses every
   * property, because a forgotten declaration must fail closed here too.
   */
  body: BodySpec;
  /**
   * Whether this route may be reached without a credential. `AUTHENTICATED` —
   * the default — requires one, because a forgotten declaration must fail
   * closed here as it does for `accepts` and `body`.
   */
  authentication: AuthenticationSpec;
  /**
   * What a second, identical call to this route does. `KEYED_BY_DEFAULT` — the
   * default — makes the router collapse the repeat against the caller's
   * `Idempotency-Key`, because a forgotten declaration must fail closed here
   * as it does for `accepts`, `body` and `authentication`, and the closed
   * answer for a write is "do it once".
   */
  retry: RetrySafetySpec;
}

/**
 * What the router needs in order to be observable and defensible.
 *
 * `metrics` and `rateLimiter` are optional: a bare router must not have to know
 * that either exists, and behaves exactly as it did before milestone 8.
 * `authenticator` is not optional. A router that cannot authenticate could only
 * serve a required route by letting it through, and "the deployment forgot to
 * wire authentication" is precisely the failure this milestone exists to make
 * impossible — so it is impossible to construct.
 */
export interface RouterOptions<A> {
  metrics?: MetricsRegistry;
  rateLimiter?: RateLimiter;
  authenticator: Authenticator<A>;
  /**
   * Where answers to keyed requests are recorded. Required, for the reason
   * `authenticator` is: a router without one could only serve a `keyed` route
   * by letting every retry through, and "the deployment forgot to wire the
   * retry record" would be a duplicate subscription rather than a startup
   * error. Optional dependencies are the ones a deployment can be wrong about
   * in silence.
   */
  retry: RetryRecordStore;
}

export interface LogRecord {
  level: "info" | "error";
  request_id: string;
  correlation_id: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  error_code?: string;
}

/**
 * How many request logs are kept in memory.
 *
 * There was no bound before: `logs` grew for the lifetime of the process, so a
 * long-running deployment leaked memory in proportion to traffic — the opposite
 * of what an observability surface should do. Bounded to the most recent
 * records, which is what a human reading them ever wants; the durable record of
 * what happened is the audit trail, not this array.
 */
const MAX_RETAINED_LOGS = 1000;

/** A value that would serialise to `{}` while looking like a real body. */
function isThenable(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export class Router<A = unknown> {
  private routes: Route<A>[] = [];
  readonly logs: LogRecord[] = [];

  constructor(private readonly options: RouterOptions<A>) {}

  add(
    method: string,
    path: string,
    handler: Handler<A>,
    accepts: readonly ParamSpec[] = [],
    body: BodySpec = NO_BODY,
    authentication: AuthenticationSpec = AUTHENTICATED,
    retry: RetrySafetySpec = KEYED_BY_DEFAULT,
  ): void {
    this.routes.push({
      method,
      template: path,
      segments: path.split("/").filter(Boolean),
      handler,
      accepts,
      body,
      authentication,
      retry,
    });
  }

  /**
   * A read route, with what it accepts stated first.
   *
   * `accepts` is positional and not optional on purpose: a `GET` is where a
   * caller's selection is expressed, and the declaration is the route's contract
   * with them. A route that reads nothing from the query string writes `[]`, and
   * says so.
   */
  get(
    path: string,
    accepts: readonly ParamSpec[],
    authentication: AuthenticationSpec,
    handler: Handler<A>,
  ) {
    // A read is safe to repeat by construction, so the declaration is made here
    // rather than at every `get` call site: asking 41 read routes to each write
    // "a read creates nothing" would be 41 chances to write something else.
    this.add("GET", path, handler, accepts, NO_BODY, authentication, SAFE);
  }

  /**
   * Every registered route, as `(method, template)`.
   *
   * Exists for the selection-parity gate. That gate can only assert that a read
   * route returns the same rows in the same order on both backends for the
   * routes it knows about, and a list of routes maintained by hand inside a test
   * goes stale the first time somebody adds one — silently, because a missing
   * case is a case that cannot fail. Reading the registrations back off the
   * router turns "a new read route was added and nobody gated it" into a failing
   * test instead of a gap.
   */
  registrations(): readonly {
    readonly method: string;
    readonly template: string;
    readonly accepts: readonly ParamSpec[];
    readonly body: BodySpec;
    readonly authentication: AuthenticationSpec;
    readonly retry: RetrySafetySpec;
  }[] {
    return this.routes.map((route) => ({
      method: route.method,
      template: route.template,
      accepts: route.accepts,
      body: route.body,
      authentication: route.authentication,
      retry: route.retry,
    }));
  }
  /**
   * A write route, with what it accepts stated first.
   *
   * `body` is positional and not optional for the reason `accepts` is: the body
   * is the whole of what a write route reads from its caller, and a route that
   * reads none of it writes `NO_BODY` and says so. `retry` is positional and
   * not optional for the same reason again, and for one more: a write is the
   * only kind of route where being called twice can cost the caller money, so
   * "what happens if this is sent again" is part of registering it rather than
   * something to be discovered afterwards.
   */
  post(
    path: string,
    body: BodySpec,
    authentication: AuthenticationSpec,
    retry: RetrySafetySpec,
    handler: Handler<A>,
  ) {
    this.add("POST", path, handler, [], body, authentication, retry);
  }

  private match(
    method: string,
    path: string,
  ): { route: Route<A>; params: Record<string, string> } | null {
    const parts = path.split("/").filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]!;
        const part = parts[i]!;
        if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(part);
        else if (seg !== part) {
          ok = false;
          break;
        }
      }
      if (ok) return { route, params };
    }
    return null;
  }

  private record(record: LogRecord, route: string, durationMs: number): void {
    this.logs.push(record);
    if (this.logs.length > MAX_RETAINED_LOGS) this.logs.splice(0, this.logs.length - MAX_RETAINED_LOGS);
    const metrics = this.options.metrics;
    if (!metrics) return;
    // Two increments and one observation, all in-process maps. No query, no
    // transaction, no lock: instrumentation that costs a round trip per request
    // is a second load on the system it claims to be measuring.
    metrics.increment("core_http_requests_total", {
      route,
      method: record.method.toLowerCase(),
      status: String(record.status),
    });
    metrics.observe(
      "core_http_request_duration_seconds",
      { route, method: record.method.toLowerCase() },
      durationMs / 1000,
    );
  }

  /** Transport-independent handling — used directly by tests and by the http server. */
  async handle(input: {
    method: string;
    url: string;
    body?: unknown;
    headers?: RawHeaders;
  }): Promise<HandlerResult> {
    const started = Date.now();
    const url = new URL(input.url, "http://core.local");
    const requestId = newId();

    // The headers first, before the route is matched and before the limiter
    // runs. Two reasons, both recorded in `headers.ts`: the limiter derives its
    // subject from `authorization` and the forwarding headers, so it cannot run
    // before those are known to be single and bounded; and the correlation id
    // becomes CORE's own record of this request the moment anything is logged, so
    // it has to be a value CORE is willing to store before it is used once.
    let headers: RequestHeaders;
    try {
      headers = parseHeaders(input.headers ?? {});
    } catch (err) {
      const coreError = err instanceof CoreError ? err : new CoreError("internal", "unexpected error");
      // A generated id, never the rejected header. Echoing the value that caused
      // the refusal would put it in the response, the log and the metric — the
      // three places the refusal exists to keep it out of.
      const correlationId = newId();
      const duration = Date.now() - started;
      this.record(
        {
          level: "error",
          request_id: requestId,
          correlation_id: correlationId,
          method: input.method,
          path: url.pathname,
          status: coreError.status,
          duration_ms: duration,
          error_code: coreError.code,
        },
        // `unmatched`, not the template: the route has deliberately not been
        // looked up yet, and inventing a label here would be a guess.
        "unmatched",
        duration,
      );
      return {
        status: coreError.status,
        body: coreError.toBody(correlationId),
        headers: sealHeaders(coreError.headers, { "x-correlation-id": correlationId }),
      };
    }
    const correlationId = headers.value("x-correlation-id") ?? newId();

    const matched = this.match(input.method, url.pathname);
    // `unmatched` rather than the path itself: an unknown path is attacker-
    // controlled text, and putting it in a label would let anyone create
    // unlimited time series by typing unlimited URLs.
    const routeLabel = matched ? matched.route.template : "unmatched";

    // The limit is checked here — after the route is known, so the class is
    // known, and before the handler runs, so a refused request has touched no
    // fulfillment, no ledger, no outbox, no inbox, no notification and no audit
    // entry. Nothing below this point in the milestone-8 design is allowed to
    // move the check into a handler.
    const rateClass = rateClassFor(input.method, matched ? matched.route.template : null);
    let rateHeaders: Record<string, string> = {};
    if (this.options.rateLimiter && rateClass !== null) {
      const subject = subjectFor(headers);

      const decision = await this.options.rateLimiter.check(subject, rateClass);
      rateHeaders = rateLimitHeaders(decision);
      if (!decision.allowed) {
        const error = rateLimited(decision);
        const duration = Date.now() - started;
        this.record(
          {
            level: "error",
            request_id: requestId,
            correlation_id: correlationId,
            method: input.method,
            path: url.pathname,
            status: error.status,
            duration_ms: duration,
            error_code: error.code,
          },
          routeLabel,
          duration,
        );
        this.options.metrics?.increment("core_http_rate_limited_total", {
          rate_class: rateClass,
          subject_kind: subject.kind,
        });
        return {
          status: error.status,
          body: error.toBody(correlationId),
          // `error.headers` carries the `retry-after`: the limiter states the
          // time on the error it raises, so the header and the body's
          // `retryable` are read off one field rather than assembled apart.
          headers: sealHeaders(rateHeaders, error.headers, { "x-correlation-id": correlationId }),
        };
      }
    }

    if (!matched) {
      const result = {
        status: 404,
        body: {
          code: "not_found",
          message: `no route for ${input.method} ${url.pathname}`,
          details: {},
          retryable: false,
          correlation_id: correlationId,
        },
        // The defect this milestone was reserved for: this branch used to return
        // no headers at all, so the one answer a caller gets when it cannot reach
        // any route in CORE was the one answer it could not correlate to CORE's
        // logs — while the body next to it carried the very same id.
        headers: sealHeaders(rateHeaders, { "x-correlation-id": correlationId }),
      };
      const duration = Date.now() - started;
      this.record(
        {
          level: "error",
          request_id: requestId,
          correlation_id: correlationId,
          method: input.method,
          path: url.pathname,
          status: 404,
          duration_ms: duration,
          error_code: "not_found",
        },
        routeLabel,
        duration,
      );
      return result;
    }

    let principal: A | null = null;
    let selection: Selection;
    let parsedBody: Body;
    try {
      // Authentication first — before the query string is parsed, before the
      // body is parsed, and before any handler can look anything up. A caller
      // with no credential is told that, and is told nothing else: not whether
      // its body was well formed, and not whether the identifier it named
      // exists. Milestone 30 measured both leaks on this router.
      if (matched.route.authentication.required) {
        principal = await this.options.authenticator.authenticate(bearerCredential(headers));
      }
      // Parsed here, before the handler and after the rate limit, for the same
      // reason the limit is checked here: a request CORE cannot understand must
      // not have touched a store, an outbox or an audit entry on its way to a
      // 400. It is inside the try/catch below in spirit — the refusal is a
      // `CoreError`, so it is rendered by exactly the same path as any other.
      selection = parseSelection(url.searchParams, matched.route.accepts);
      // The query string first, then the body: a request with a misspelled
      // parameter *and* a misspelled property is told about the parameter, which
      // is what its caller reads first when constructing the request.
      parsedBody = parseBody(input.body, matched.route.body);
    } catch (err) {
      const coreError = err instanceof CoreError ? err : new CoreError("internal", "unexpected error");
      const duration = Date.now() - started;
      this.record(
        {
          level: "error",
          request_id: requestId,
          correlation_id: correlationId,
          method: input.method,
          path: url.pathname,
          status: coreError.status,
          duration_ms: duration,
          error_code: coreError.code,
        },
        routeLabel,
        duration,
      );
      return {
        status: coreError.status,
        body: coreError.toBody(correlationId),
        headers: sealHeaders(rateHeaders, coreError.headers, { "x-correlation-id": correlationId }),
      };
    }

    // Retry safety, after authentication and after the body is parsed, and
    // before the handler. After authentication, because who the caller is
    // decides whether it may reach this route at all and a 401 must not be
    // answerable from a record; after the body, because the fingerprint is a
    // fingerprint of the request CORE understood, and a body CORE cannot parse
    // is not a request it can record an answer for. Before the handler,
    // because collapsing a repeat after the work has been done collapses
    // nothing. Nothing above this point moved.
    const keyed = matched.route.retry.mechanism === "keyed";
    let retryKey: string | undefined;
    let claimToken: string | undefined;
    if (keyed) {
      retryKey = headers.value("idempotency-key");
      let recorded: RetryCompletedRow | null = null;
      let failure: CoreError | null = null;
      if (retryKey === undefined) {
        // `parseHeaders` drops a zero-length value, so an empty header arrives
        // here as an absent one and is refused by this branch; a blank value
        // like `"  "` was already refused as a malformed identifier, before
        // the route was even matched.
        failure = missingIdempotencyKey(input.method, matched.route.template);
      } else {
        const fingerprint = fingerprintRequest(input.method, matched.route.template, parsedBody);
        let outcome: RetryClaimOutcome | null = null;
        try {
          // Claimed, not looked up. Milestone 32 read the record here and the
          // read is what left B-43 open: two twins read the same absence and
          // both ran. One conditional insert decides which of them may, and
          // the other three outcomes are all "do not run the handler".
          outcome = await this.options.retry.claim({
            key: retryKey,
            method: input.method,
            scope: matched.route.template,
            request_fingerprint: fingerprint,
          });
        } catch {
          // A claim that failed is not a claim granted. Running the handler
          // anyway would be doing the work this route declared it must not do
          // twice, with the protection silently absent — so the request is
          // refused, and nothing has been written at this point for the
          // refusal to undo. The cause is not passed to the caller, for the
          // reason every internal error is not.
          failure = new CoreError("internal", "unexpected error");
        }
        if (outcome !== null) {
          switch (outcome.outcome) {
            case "claimed":
              claimToken = outcome.claim_token;
              break;
            case "completed":
              recorded = outcome.record;
              break;
            case "in_flight":
              // The twin is doing the work. This request is answered rather
              // than run, which is the difference between a collapsed retry
              // and a second organization.
              failure = idempotencyKeyInFlight(outcome.claimed_at);
              break;
            case "reused":
              failure = idempotencyKeyReused();
              break;
          }
        }
      }
      if (failure !== null) {
        const duration = Date.now() - started;
        this.record(
          {
            level: "error",
            request_id: requestId,
            correlation_id: correlationId,
            method: input.method,
            path: url.pathname,
            status: failure.status,
            duration_ms: duration,
            error_code: failure.code,
          },
          routeLabel,
          duration,
        );
        return {
          status: failure.status,
          body: failure.toBody(correlationId),
          // Whatever this refusal is, its own headers: an in-flight twin
          // states a `retry-after` and a reuse does not, and neither the
          // router nor the caller has to know which is which.
          headers: sealHeaders(rateHeaders, failure.headers, {
            "x-correlation-id": correlationId,
          }),
        };
      }
      if (recorded !== null) {
        // The answer CORE already gave, unchanged: the same status and the same
        // body, because a retry is the caller asking what happened to its first
        // call and not a second request. The only difference is the replay
        // header, which is how it can tell the two apart.
        const duration = Date.now() - started;
        this.record(
          {
            level: "info",
            request_id: requestId,
            correlation_id: correlationId,
            method: input.method,
            path: url.pathname,
            status: recorded.response_status,
            duration_ms: duration,
          },
          routeLabel,
          duration,
        );
        return {
          status: recorded.response_status,
          body: recorded.response_body,
          headers: sealHeaders(rateHeaders, REPLAYED_HEADERS, {
            "x-correlation-id": correlationId,
          }),
        };
      }
    }

    const ctx: RequestContext<A> = {
      method: input.method,
      path: url.pathname,
      params: matched.params,
      selection,
      input: parsedBody,
      headers,
      principal,
      correlation_id: correlationId,
      request_id: requestId,
    };

    try {
      const result = await matched.route.handler(ctx);
      // A body that is still a promise is a route that forgot to await its own
      // service. `JSON.stringify` renders a promise as `{}`, so the caller gets
      // a success status with an empty object and nothing anywhere fails —
      // which is precisely how `/v1/organizations` shipped an empty body past a
      // full test suite, because the tests read statuses. There is no request a
      // client could send that makes this its fault, so it is internal, and it
      // is refused rather than repaired: awaiting it here would hide the same
      // mistake in every route written afterwards.
      if (isThenable(result.body)) {
        throw new Error(
          `route ${input.method} ${matched.route.template} returned a promise as its body`,
        );
      }
      // The claim is settled here, one way or the other. Completed on a 2xx;
      // released on anything else, because a caller told its body was invalid
      // has to be able to correct it and send it again under the same key — and
      // a claim left behind by a refusal would refuse the corrected request as
      // in-flight, then as a reuse once the fingerprint changed. Recording the
      // refusal itself is refused by the schema in the one place code cannot
      // bypass (`idempotency_key_response_status_ck`), so releasing is not a
      // convenience: it is the only thing the row can honestly become.
      let notRecorded = false;
      if (claimToken !== undefined) {
        const hold = {
          key: retryKey as string,
          method: input.method,
          scope: matched.route.template,
          claim_token: claimToken,
        };
        const succeeded = result.status >= 200 && result.status < 300;
        try {
          const settled = succeeded
            ? await this.options.retry.complete({
                ...hold,
                response_status: result.status,
                response_body: result.body ?? null,
              })
            : await this.options.retry.release(hold);
          // A claim that has moved on — taken over after the horizon, or
          // already settled — is not an error, but it is not nothing either:
          // the next retry of a success will run the handler again, which is
          // the condition this milestone exists to remove, so it is logged
          // under the same code a failed write is.
          notRecorded = succeeded && !settled;
        } catch {
          // The work is done and the caller is owed its answer, so a store that
          // cannot record it must not turn a success into a 500 — that would
          // be CORE hiding an organization it just created. What it costs is
          // that the next retry runs again once the claim horizon passes,
          // which is the behaviour of every route before milestone 32, so this
          // request is logged as an error naming exactly that.
          notRecorded = true;
        }
      }
      const duration = Date.now() - started;
      this.record(
        {
          level: notRecorded ? "error" : "info",
          request_id: requestId,
          correlation_id: correlationId,
          method: input.method,
          path: url.pathname,
          status: result.status,
          duration_ms: duration,
          // One record per request, so the failure to record rides on the
          // request's own line rather than adding a second one nothing else
          // in CORE produces.
          ...(notRecorded ? { error_code: "retry_not_recorded" } : {}),
        },
        routeLabel,
        duration,
      );
      return {
        ...result,
        // The correlation id last, so a route cannot overwrite CORE's record of
        // the request with a value of its own choosing.
        headers: sealHeaders(rateHeaders, result.headers, { "x-correlation-id": correlationId }),
      };
    } catch (err) {
      const coreError =
        err instanceof CoreError
          ? err
          : new CoreError("internal", "unexpected error"); // never leak internals
      // A handler that threw did not answer, so the claim has nothing to
      // record and must not be left standing: the caller is entitled to send
      // the same request again immediately, and a claim held for the horizon
      // would refuse it for a minute for a request that never ran. Awaited and
      // swallowed — a release that fails must not replace the handler's own
      // error with a different one, and the horizon is the backstop.
      if (claimToken !== undefined) {
        try {
          await this.options.retry.release({
            key: retryKey as string,
            method: input.method,
            scope: matched.route.template,
            claim_token: claimToken,
          });
        } catch {
          // Deliberately empty: see above. The claim expires on its own.
        }
      }
      const duration = Date.now() - started;
      this.record(
        {
          level: "error",
          request_id: requestId,
          correlation_id: correlationId,
          method: input.method,
          path: url.pathname,
          status: coreError.status,
          duration_ms: duration,
          error_code: coreError.code,
        },
        routeLabel,
        duration,
      );
      return {
        status: coreError.status,
        body: coreError.toBody(correlationId),
        headers: sealHeaders(rateHeaders, coreError.headers, { "x-correlation-id": correlationId }),
      };
    }
  }

  /** Node http adapter. */
  nodeListener() {
    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          // Answered here rather than by the router, because a body that is not
          // JSON cannot be handed to it — but answered in the *same* shape.
          // Before this milestone this was the one refusal in CORE that carried
          // neither `correlation_id`, `details` nor `retryable`, and no
          // `x-correlation-id` header: a caller with a malformed body got an
          // answer it could not parse as an `Error` and could not trace.
          const coreError = invalid("body must be valid JSON");
          const correlationId = newId();
          res.writeHead(coreError.status, {
            "content-type": "application/json",
            ...sealHeaders({ "x-correlation-id": correlationId }),
          });
          res.end(JSON.stringify(coreError.toBody(correlationId)));
          return;
        }
      }
      const result = await this.handle({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        body,
        headers: req.headers,
      });
      // A string body is written as-is: the metrics exposition is text, not
      // JSON, and wrapping it in quotes would make it unparseable by every
      // scraper. Everything else is serialised as before.
      const isText = typeof result.body === "string";
      res.writeHead(result.status, {
        "content-type": isText ? "text/plain; version=0.0.4; charset=utf-8" : "application/json",
        ...(result.headers ?? {}),
      });
      res.end(isText ? (result.body as string) : JSON.stringify(result.body));
    };
  }
}
