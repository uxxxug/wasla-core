import { IncomingMessage, ServerResponse } from "node:http";
import { CoreError, invalid } from "../errors.js";
import { newId } from "../ids.js";
import type { MetricsRegistry } from "../observability/metrics.js";
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

export interface RequestContext {
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
  correlation_id: string;
  request_id: string;
}

export interface HandlerResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type Handler = (ctx: RequestContext) => Promise<HandlerResult> | HandlerResult;

interface Route {
  method: string;
  /**
   * The registered path, parameters included (`/v1/fulfillments/:fulfillment_id`).
   * Kept because it is the only low-cardinality name for a route: the concrete
   * path contains identifiers, so using it as a metric label would be one time
   * series per fulfillment and would publish entity ids to anyone who can scrape.
   */
  template: string;
  segments: string[];
  handler: Handler;
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
}

/**
 * What the router needs in order to be observable and defensible. Both optional:
 * most tests construct a bare router and must not have to know that metrics or
 * rate limiting exist, and a bare router behaves exactly as it did before
 * milestone 8.
 */
export interface RouterOptions {
  metrics?: MetricsRegistry;
  rateLimiter?: RateLimiter;
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

export class Router {
  private routes: Route[] = [];
  readonly logs: LogRecord[] = [];

  constructor(private readonly options: RouterOptions = {}) {}

  add(
    method: string,
    path: string,
    handler: Handler,
    accepts: readonly ParamSpec[] = [],
    body: BodySpec = NO_BODY,
  ): void {
    this.routes.push({
      method,
      template: path,
      segments: path.split("/").filter(Boolean),
      handler,
      accepts,
      body,
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
  get(path: string, accepts: readonly ParamSpec[], handler: Handler) {
    this.add("GET", path, handler, accepts);
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
  }[] {
    return this.routes.map((route) => ({
      method: route.method,
      template: route.template,
      accepts: route.accepts,
      body: route.body,
    }));
  }
  /**
   * A write route, with what it accepts stated first.
   *
   * `body` is positional and not optional for the reason `accepts` is: the body
   * is the whole of what a write route reads from its caller, and a route that
   * reads none of it writes `NO_BODY` and says so.
   */
  post(path: string, body: BodySpec, handler: Handler) {
    this.add("POST", path, handler, [], body);
  }

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
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
        headers: sealHeaders({ "x-correlation-id": correlationId }),
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
          headers: sealHeaders(rateHeaders, { "x-correlation-id": correlationId }),
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

    let selection: Selection;
    let parsedBody: Body;
    try {
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
        headers: sealHeaders(rateHeaders, { "x-correlation-id": correlationId }),
      };
    }

    const ctx: RequestContext = {
      method: input.method,
      path: url.pathname,
      params: matched.params,
      selection,
      input: parsedBody,
      headers,
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
      const duration = Date.now() - started;
      this.record(
        {
          level: "info",
          request_id: requestId,
          correlation_id: correlationId,
          method: input.method,
          path: url.pathname,
          status: result.status,
          duration_ms: duration,
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
        headers: sealHeaders(rateHeaders, { "x-correlation-id": correlationId }),
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
