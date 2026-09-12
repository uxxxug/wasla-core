/**
 * What instrumentation costs a request.
 *
 * Milestone 8 asks for the number, not the assurance. This drives the same
 * router with the same handler three ways — bare, with the metrics registry, and
 * with metrics plus the rate limiter — and prints the added time per request.
 *
 * It measures the router deliberately rather than the whole app: the question is
 * what the *instrumentation* costs, and a handler that touches the database would
 * bury that number under its own work. The structural property (no extra query
 * per request) is asserted in `tests/observability.test.ts`; this says how much
 * the in-process bookkeeping adds on top.
 *
 * With DATABASE_URL set, the limiter runs against the real Postgres window store
 * — one statement per request, which is the real cost of the shared limiter and
 * is reported separately for that reason.
 *
 * Usage:  node scripts/measure-ingress-overhead.mjs [rounds]
 *         DATABASE_URL=… node scripts/measure-ingress-overhead.mjs [rounds]
 *
 * Build first: `npx tsc --noEmit false --outDir dist --declaration false` (this reads dist/src).
 */
import { Router } from "../dist/src/platform/http/router.js";
import { MetricsRegistry } from "../dist/src/platform/observability/metrics.js";
import {
  InMemoryRateLimitWindowStore,
  RateLimiter,
} from "../dist/src/platform/http/rate-limit.js";
import { PgRateLimitWindowStore } from "../dist/src/platform/http/pg-rate-limit.js";
import { FixedClock } from "../dist/src/platform/clock.js";

const rounds = Number(process.argv[2] ?? 20_000);
const url = process.env.DATABASE_URL;
const clock = new FixedClock();

/** A handler that does nothing, so the sample is the edge and not the work. */
function build(options) {
  const router = new Router(options);
  router.get("/health", () => ({ status: 200, body: { status: "ok" } }));
  return router;
}

async function measure(label, router, headers) {
  for (let i = 0; i < 500; i++) await router.handle({ method: "GET", url: "/health", headers });
  const samples = new Array(rounds);
  for (let i = 0; i < rounds; i++) {
    const started = process.hrtime.bigint();
    await router.handle({ method: "GET", url: "/health", headers });
    samples[i] = Number(process.hrtime.bigint() - started) / 1000;
  }
  samples.sort((a, b) => a - b);
  return {
    label,
    mean_us: Number((samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(3)),
    p50_us: Number(samples[Math.floor(rounds * 0.5)].toFixed(3)),
    p99_us: Number(samples[Math.floor(rounds * 0.99)].toFixed(3)),
  };
}

const results = [];
results.push(await measure("bare router", build()));

const metrics = new MetricsRegistry();
results.push(await measure("+ metrics", build({ metrics })));

// `/health` is exempt from the limit by policy, so a limited route is used for the
// limiter rows: the interesting cost is the counter, not the exemption check.
const limitedRouter = (limiterStore) => {
  const router = new Router({
    metrics: new MetricsRegistry(),
    rateLimiter: new RateLimiter(limiterStore, clock, {
      windowMs: 60_000,
      // Above the sample size so the run measures allowed requests throughout.
      limits: { ingress_events: rounds * 10, write: rounds * 10, read: rounds * 10, unmatched: rounds * 10 },
    }),
  });
  router.get("/v1/measured", () => ({ status: 200, body: { status: "ok" } }));
  return router;
};

async function measureLimited(label, limiterStore) {
  const router = limitedRouter(limiterStore);
  const headers = { authorization: "Bearer measurement-credential" };
  for (let i = 0; i < 500; i++) await router.handle({ method: "GET", url: "/v1/measured", headers });
  const samples = new Array(rounds);
  for (let i = 0; i < rounds; i++) {
    const started = process.hrtime.bigint();
    await router.handle({ method: "GET", url: "/v1/measured", headers });
    samples[i] = Number(process.hrtime.bigint() - started) / 1000;
  }
  samples.sort((a, b) => a - b);
  return {
    label,
    mean_us: Number((samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(3)),
    p50_us: Number(samples[Math.floor(rounds * 0.5)].toFixed(3)),
    p99_us: Number(samples[Math.floor(rounds * 0.99)].toFixed(3)),
  };
}

results.push(await measureLimited("+ metrics + limiter (memory)", new InMemoryRateLimitWindowStore()));

let pool;
if (url) {
  const { Pool } = await import("pg");
  pool = new Pool({ connectionString: url, max: 4 });
  results.push(await measureLimited("+ metrics + limiter (postgres)", new PgRateLimitWindowStore(pool)));
}

for (const row of results) {
  process.stdout.write(
    `${row.label.padEnd(32)} mean ${String(row.mean_us).padStart(9)}µs  p50 ${String(row.p50_us).padStart(9)}µs  p99 ${String(row.p99_us).padStart(9)}µs\n`,
  );
}
const base = results[0];
process.stdout.write(`\nadded per request, against the bare router (${rounds} requests each):\n`);
for (const row of results.slice(1)) {
  process.stdout.write(
    `  ${row.label.padEnd(32)} mean +${(row.mean_us - base.mean_us).toFixed(3)}µs  p50 +${(row.p50_us - base.p50_us).toFixed(3)}µs\n`,
  );
}
if (pool) await pool.end();
