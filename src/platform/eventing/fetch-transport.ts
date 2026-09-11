import type { EventTransport, TransportRequest, TransportResponse } from "./delivery.js";

/**
 * The only place in CORE that opens a socket to a network CORE does not own.
 *
 * It reports failure rather than throwing, because a failed delivery is
 * ordinary and the worker has to record it. Whether it is worth repeating is
 * not decided here: this adapter's job is to report what happened accurately
 * and let `isRetryable` interpret it.
 */
export class FetchTransport implements EventTransport {
  async send(request: TransportRequest): Promise<TransportResponse> {
    // A hung endpoint must not hold the worker forever; without a timeout one
    // unresponsive subscriber stalls every other subscriber's queue.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeout_ms);
    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
        // No redirect following: a redirect would send a signed body to a host
        // the operator never registered.
        redirect: "manual",
      });
      // The body is deliberately not read. CORE needs the status, and reading
      // an arbitrary external response is unbounded work plus an unbounded
      // amount of somebody else's data in CORE's logs.
      return { status: response.status };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        status: null,
        error: aborted
          ? `no response within ${request.timeout_ms}ms`
          : err instanceof Error
            ? err.message
            : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
