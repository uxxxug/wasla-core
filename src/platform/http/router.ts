import { IncomingMessage, ServerResponse } from "node:http";
import { CoreError } from "../errors.js";
import { newId } from "../ids.js";

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
  segments: string[];
  handler: Handler;
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

export class Router {
  private routes: Route[] = [];
  readonly logs: LogRecord[] = [];

  add(method: string, path: string, handler: Handler): void {
    this.routes.push({ method, segments: path.split("/").filter(Boolean), handler });
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
      this.logs.push({
        level: "error",
        request_id: requestId,
        correlation_id: correlationId,
        method: input.method,
        path: url.pathname,
        status: 404,
        duration_ms: Date.now() - started,
        error_code: "not_found",
      });
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
      this.logs.push({
        level: "info",
        request_id: requestId,
        correlation_id: correlationId,
        method: input.method,
        path: url.pathname,
        status: result.status,
        duration_ms: Date.now() - started,
      });
      return {
        ...result,
        headers: { ...(result.headers ?? {}), "x-correlation-id": correlationId },
      };
    } catch (err) {
      const coreError =
        err instanceof CoreError
          ? err
          : new CoreError("internal", "unexpected error"); // never leak internals
      this.logs.push({
        level: "error",
        request_id: requestId,
        correlation_id: correlationId,
        method: input.method,
        path: url.pathname,
        status: coreError.status,
        duration_ms: Date.now() - started,
        error_code: coreError.code,
      });
      return {
        status: coreError.status,
        body: coreError.toBody(correlationId),
        headers: { "x-correlation-id": correlationId },
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
      res.writeHead(result.status, { "content-type": "application/json", ...(result.headers ?? {}) });
      res.end(JSON.stringify(result.body));
    };
  }
}
