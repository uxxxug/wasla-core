import { IncomingMessage, ServerResponse } from "node:http";
import { CoreError } from "../errors.js";
import { newId } from "../ids.js";
import type { MetricsRegistry } from "../observability/metrics.js";
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
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
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

export class Router {
  private routes: Route[] = [];
  readonly logs: LogRecord[] = [];

  constructor(private readonly options: RouterOptions = {}) {}

  add(method: string, path: string, handler: Handler): void {
    this.routes.push({ method, template: path, segments: path.split("/").filter(Boolean), handler });
  }

  get(path: string, handler: Handler) {
    this.add("GET", path, handler);
  }
  post(path: string, handler: Handler) {
    this.add("POST", path, handler);
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
    headers?: Record<string, string | string[] | undefined>;
  }): Promise<HandlerResult> {
    const started = Date.now();
    const url = new URL(input.url, "http://core.local");
    const headers = input.headers ?? {};
    const correlationHeader = headers["x-correlation-id"];
    const correlationId =
      typeof correlationHeader === "string" && correlationHeader ? correlationHeader : newId();
    const requestId = newId();

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
          headers: { ...rateHeaders, "x-correlation-id": correlationId },
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

    const ctx: RequestContext = {
      method: input.method,
      path: url.pathname,
      params: matched.params,
      query: url.searchParams,
      body: input.body ?? null,
      headers,
      correlation_id: correlationId,
      request_id: requestId,
    };

    try {
      const result = await matched.route.handler(ctx);
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
        headers: { ...rateHeaders, ...(result.headers ?? {}), "x-correlation-id": correlationId },
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
        headers: { ...rateHeaders, "x-correlation-id": correlationId },
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
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: "invalid_request", message: "body must be valid JSON" }));
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
