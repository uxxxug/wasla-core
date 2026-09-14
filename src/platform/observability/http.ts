import { anonymous } from "../http/authentication.js";
import type { Router } from "../http/router.js";
import type { MetricsRegistry } from "./metrics.js";

/**
 * The metrics endpoint. One route, one format, no parameters.
 *
 * One route because two endpoints over the same numbers is two things to keep
 * consistent and one of them will drift. No query parameters because a
 * filterable exposition is an API, and this is a scrape target: the scraper
 * takes everything and the query language lives in the monitoring system.
 *
 * It renders in-process aggregates and nothing else — no database access, no
 * sampling, no writes — so scraping cannot slow the system down, cannot fail
 * when the database is unwell, and cannot change what it is reporting on. Two
 * scrapes of an idle process return identical bytes.
 *
 * Unauthenticated, and deliberately system-level only.
 *
 * There is no tenant dimension anywhere in the catalogue: no organization label,
 * no per-recipient count, nothing that would let a reader learn that some other
 * tenant has a notification backlog or a reconciliation problem. That is the
 * decision milestone 8 required to be made explicitly rather than half-made —
 * observability here is aggregate, and the tenant-scoped questions stay behind
 * the authenticated reconciliation and notification reads, where a permission
 * check and an organization filter already apply.
 *
 * The consequence is that the exposition is still an operational surface: it
 * reveals volumes and error rates for the platform. Like `/health` and `/ready`
 * it must not be routed to the public internet. CORE cannot enforce that from
 * inside the process — where the listener is exposed is a deployment decision,
 * and CORE's deployment topology is still an external dependency (B-5).
 */
export function registerMetricsRoutes<A>(router: Router<A>, registry: MetricsRegistry): void {
  router.get(
    "/metrics",
    [],
    // Declared anonymous rather than left anonymous. A scraper is a process
    // with no session, and requiring a credential would mean CORE could only be
    // monitored by something that can obtain one — but the reason it is safe is
    // the paragraph above, not the absence of a line of code, and B-5 is the
    // record that keeping this off the public internet is a deployment duty
    // CORE cannot discharge from inside the process.
    anonymous("a scrape target has no session; kept off the public internet by deployment (B-5)"),
    async () => ({
      status: 200,
      // A string body: the router's Node adapter writes strings verbatim with
      // the Prometheus content type instead of JSON-encoding them.
      body: registry.render(),
      headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
    }),
  );
}
