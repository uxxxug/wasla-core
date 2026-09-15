/**
 * Metrics registry (milestone 8).
 *
 * Deliberately small: counters, gauges and histograms, a declared catalogue, and
 * one renderer. There is no metric abstraction beyond what the four workers, the
 * HTTP edge and the reconciliation reads actually need, because a metrics layer
 * is itself an operational surface — every name it accepts is a name somebody
 * has to keep alive, and every label value it accepts is a time series somebody
 * has to store.
 *
 * Two rules are enforced in code rather than written in a document, because a
 * convention nobody can violate is worth more than a convention everybody
 * remembers:
 *
 * 1. **A metric must be declared.** `CATALOGUE` fixes the name, the type, the
 *    help text and the exact label set. An undeclared name, a missing label or
 *    an extra label throws. Instrumentation is written once and read forever;
 *    finding out at scrape time that a counter has three different label shapes
 *    is finding out too late.
 * 2. **A label value must be low-cardinality and non-identifying.** Values are
 *    checked against a conservative shape and rejected if they look like an
 *    identifier, an address or a secret. This is the guard that keeps a metric
 *    from becoming the leak that the audit trail and the logs are careful not to
 *    be — and keeps one series per route from becoming one series per request.
 */

export type MetricType = "counter" | "gauge" | "histogram";

interface MetricDefinition {
  type: MetricType;
  help: string;
  /** Exact label set. Every series of this metric carries all of them. */
  labels: readonly string[];
  /** Histogram bucket upper bounds, seconds. Ignored for other types. */
  buckets?: readonly number[];
}

/**
 * Latency buckets, seconds. Chosen for the two things actually being measured:
 * an in-process HTTP handler (sub-millisecond to a few hundred milliseconds) and
 * a worker item that may involve a network call to somebody else's endpoint
 * (hundreds of milliseconds to the transport timeout of 5s, plus headroom).
 */
const LATENCY_BUCKETS = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

/**
 * The full set of metrics CORE exposes. Order here is the order in the
 * exposition, so a diff of two scrapes is a diff of values and never of layout.
 *
 * Dimensions are limited to five names on purpose — `route`, `method`,
 * `status`, `worker`, `queue`, `outcome`, `subject_kind`, `rate_class` — and
 * each one has an operational question behind it. Notably absent, and refused
 * at runtime by `assertLabelValue`: `fulfillment_id`, `event_id`,
 * `recipient_id`, `organization_id`, `channel address`, `order_reference`.
 * Those answer "which one" — a question for the API and the audit trail, whose
 * access is scoped to a tenant. A metric answers "how many", and a metric
 * series per entity is how a monitoring system runs out of memory.
 */
export const CATALOGUE: Readonly<Record<string, MetricDefinition>> = {
  core_http_requests_total: {
    type: "counter",
    help: "HTTP requests handled at the ingress edge, by route template and response status.",
    // `route` is the registered template (`/v1/fulfillments/:fulfillment_id`),
    // never the concrete path: the path contains an id, and one series per id is
    // both a cardinality failure and an information leak.
    // `status` is the exact code rather than a class, because CORE's error model
    // has a closed set of eight codes plus 200/201/202/429 — twelve values, and
    // the class is recoverable in a query (`status=~"5.."`) while the code is
    // not recoverable from the class.
    labels: ["route", "method", "status"],
  },
  core_http_request_duration_seconds: {
    type: "histogram",
    help: "Wall-clock time to handle an HTTP request, including the rate-limit check.",
    labels: ["route", "method"],
    buckets: LATENCY_BUCKETS,
  },
  core_http_rate_limited_total: {
    type: "counter",
    help: "Requests refused with 429 by the ingress rate limiter.",
    labels: ["rate_class", "subject_kind"],
  },
  core_worker_claims_total: {
    type: "counter",
    help: "Items claimed by a background worker. A claim is a write, so this counts leases taken.",
    labels: ["worker"],
  },
  core_worker_outcomes_total: {
    type: "counter",
    help: "How claimed work ended: completed, retried, failed_permanent, fenced or reclaimed.",
    labels: ["worker", "outcome"],
  },
  core_worker_item_duration_seconds: {
    type: "histogram",
    help: "Time from claim to recorded outcome for one item of work.",
    labels: ["worker"],
    buckets: LATENCY_BUCKETS,
  },
  core_queue_depth: {
    type: "gauge",
    help: "Rows in each durable queue by state, as of the last sample. Not read at scrape time.",
    labels: ["queue", "state"],
  },
  core_reconciliation_depth: {
    type: "gauge",
    help: "Size of each reconciliation queue platform-wide, as of the last sample.",
    labels: ["queue"],
  },
  core_sample_timestamp_seconds: {
    type: "gauge",
    help: "Unix time of the last successful queue-depth sample. Stale means the sampler stopped, not that the queues are empty.",
    labels: [],
  },
  core_sample_failures_total: {
    type: "counter",
    help: "Queue-depth samples that threw. A rising count with a frozen timestamp is the signal.",
    labels: [],
  },
  core_fulfillment_depth: {
    type: "gauge",
    help: "Fulfillments by status, as of the last sample. Not read at scrape time.",
    labels: ["status"],
  },
  core_subscription_depth: {
    type: "gauge",
    help: "Subscriptions by status, as of the last sample.",
    labels: ["status"],
  },
  core_money_depth: {
    type: "gauge",
    help: "Wallets and payment authorizations by status, as of the last sample.",
    labels: ["kind", "status"],
  },
  core_fulfillment_oldest_age_seconds: {
    type: "gauge",
    help: "Age in seconds of the oldest fulfillment in each status, measured from created_at. Not the time in the current status — CORE records no status_changed_at. Zero means no rows in that status.",
    labels: ["status"],
  },
  core_subscription_oldest_age_seconds: {
    type: "gauge",
    help: "Age in seconds of the oldest subscription in each status, measured from created_at. Zero means no rows in that status.",
    labels: ["status"],
  },
  core_money_oldest_age_seconds: {
    type: "gauge",
    help: "Age in seconds of the oldest wallet or payment authorization in each status, measured from created_at. Zero means no rows in that status.",
    labels: ["kind", "status"],
  },
} as const;

export type MetricName = keyof typeof CATALOGUE;

export type Labels = Readonly<Record<string, string>>;

/**
 * Label values must look like enumerations, not like data.
 *
 * Allowed: lowercase words, digits, `_`, `-`, `.`, `/`, `:` — enough for
 * `/v1/fulfillments/reconciliation/pending-financial-decision`, which is the
 * longest route template CORE registers, and for `failed_permanent`, `429`,
 * `telegram`. The length cap is generous enough for a descriptive route and far
 * too small for a payload, a token or an address.
 * Refused: anything long, anything uuid-shaped, anything with an `@`, a `+`
 * prefix or whitespace. Those are the shapes of the things that must never be
 * in a metric: ids, emails, phone numbers, tokens, free text from a provider.
 */
const LABEL_VALUE = /^[a-z0-9_.:/-]{1,96}$/;
const UUID_SHAPED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LONG_OPAQUE = /[a-z0-9]{24,}/i;

export function assertLabelValue(metric: string, label: string, value: string): void {
  if (!LABEL_VALUE.test(value)) {
    throw new Error(
      `metric ${metric}: label ${label} value is not a bounded enumeration: ${describeRejection(value)}`,
    );
  }
  if (UUID_SHAPED.test(value) || LONG_OPAQUE.test(value)) {
    throw new Error(
      `metric ${metric}: label ${label} looks like an identifier, which would be one series per entity`,
    );
  }
}

/** Never echoes the value itself: the rejection may be a token or an address. */
function describeRejection(value: string): string {
  return `${value.length} chars, first char class ${/^[a-z]/.test(value) ? "alpha" : "other"}`;
}

interface HistogramState {
  counts: number[];
  sum: number;
  count: number;
}

const seriesKey = (labels: Labels, order: readonly string[]): string =>
  order.map((name) => `${name}=${labels[name]}`).join(",");

/**
 * In-memory aggregation. No database, no locks, no allocation per request beyond
 * the label lookup — the instrumentation must not become a second load on the
 * hot path it is measuring, and a counter that costs a query per increment is a
 * counter nobody can afford to keep.
 *
 * Reset only by process restart, which is what Prometheus counters assume.
 */
export class MetricsRegistry {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly gauges = new Map<string, Map<string, number>>();
  private readonly histograms = new Map<string, Map<string, HistogramState>>();

  private definition(name: string, expected: MetricType): MetricDefinition {
    const definition = CATALOGUE[name];
    if (!definition) throw new Error(`metric ${name} is not declared in the catalogue`);
    if (definition.type !== expected) {
      throw new Error(`metric ${name} is a ${definition.type}, used as a ${expected}`);
    }
    return definition;
  }

  private key(name: string, definition: MetricDefinition, labels: Labels): string {
    const given = Object.keys(labels);
    for (const label of definition.labels) {
      if (!(label in labels)) throw new Error(`metric ${name}: missing label ${label}`);
      assertLabelValue(name, label, labels[label]!);
    }
    for (const label of given) {
      if (!definition.labels.includes(label)) {
        throw new Error(`metric ${name}: label ${label} is not declared for it`);
      }
    }
    return seriesKey(labels, definition.labels);
  }

  increment(name: MetricName | string, labels: Labels = {}, by = 1): void {
    const definition = this.definition(name, "counter");
    const key = this.key(name, definition, labels);
    const series = this.counters.get(name) ?? new Map<string, number>();
    series.set(key, (series.get(key) ?? 0) + by);
    this.counters.set(name, series);
  }

  setGauge(name: MetricName | string, labels: Labels, value: number): void {
    const definition = this.definition(name, "gauge");
    const key = this.key(name, definition, labels);
    const series = this.gauges.get(name) ?? new Map<string, number>();
    series.set(key, value);
    this.gauges.set(name, series);
  }

  /** `value` in seconds for every histogram in the catalogue. */
  observe(name: MetricName | string, labels: Labels, value: number): void {
    const definition = this.definition(name, "histogram");
    const key = this.key(name, definition, labels);
    const buckets = definition.buckets ?? LATENCY_BUCKETS;
    const series = this.histograms.get(name) ?? new Map<string, HistogramState>();
    const state =
      series.get(key) ?? { counts: new Array<number>(buckets.length).fill(0), sum: 0, count: 0 };
    for (let i = 0; i < buckets.length; i++) {
      if (value <= buckets[i]!) state.counts[i] = (state.counts[i] ?? 0) + 1;
    }
    state.sum += value;
    state.count += 1;
    series.set(key, state);
    this.histograms.set(name, series);
  }

  /** Reading a counter without rendering. For tests and for the readiness route. */
  counterValue(name: MetricName | string, labels: Labels = {}): number {
    const definition = this.definition(name, "counter");
    return this.counters.get(name)?.get(this.key(name, definition, labels)) ?? 0;
  }

  gaugeValue(name: MetricName | string, labels: Labels = {}): number | undefined {
    const definition = this.definition(name, "gauge");
    return this.gauges.get(name)?.get(this.key(name, definition, labels));
  }

  histogramValue(
    name: MetricName | string,
    labels: Labels = {},
  ): { count: number; sum: number } | undefined {
    const definition = this.definition(name, "histogram");
    const state = this.histograms.get(name)?.get(this.key(name, definition, labels));
    return state ? { count: state.count, sum: state.sum } : undefined;
  }

  /**
   * Prometheus text exposition, format 0.0.4.
   *
   * Chosen because it is the format every scraper and every local `curl` already
   * reads, and because the roadmap named "metrics and trace export" without
   * naming a format — inventing a second JSON shape would mean writing an
   * adapter for every tool that already speaks this one.
   *
   * Reads only in-process maps: no query, no lock, no state change, so scraping
   * cannot slow down or perturb the system being scraped. Series are emitted in
   * catalogue order and then sorted by label key, so two scrapes of an unchanged
   * process are byte-identical.
   */
  render(): string {
    const lines: string[] = [];
    for (const [name, definition] of Object.entries(CATALOGUE)) {
      const series =
        definition.type === "counter"
          ? this.counters.get(name)
          : definition.type === "gauge"
            ? this.gauges.get(name)
            : this.histograms.get(name);
      if (!series || series.size === 0) continue;
      lines.push(`# HELP ${name} ${definition.help}`);
      lines.push(`# TYPE ${name} ${definition.type}`);
      const keys = [...series.keys()].sort();
      if (definition.type === "histogram") {
        const buckets = definition.buckets ?? LATENCY_BUCKETS;
        for (const key of keys) {
          const state = (series as Map<string, HistogramState>).get(key)!;
          for (let i = 0; i < buckets.length; i++) {
            lines.push(
              `${name}_bucket${renderLabels(key, { le: formatNumber(buckets[i]!) })} ${state.counts[i] ?? 0}`,
            );
          }
          lines.push(`${name}_bucket${renderLabels(key, { le: "+Inf" })} ${state.count}`);
          lines.push(`${name}_sum${renderLabels(key)} ${formatNumber(state.sum)}`);
          lines.push(`${name}_count${renderLabels(key)} ${state.count}`);
        }
      } else {
        for (const key of keys) {
          const value = (series as Map<string, number>).get(key)!;
          lines.push(`${name}${renderLabels(key)} ${formatNumber(value)}`);
        }
      }
    }
    return `${lines.join("\n")}\n`;
  }
}

function renderLabels(key: string, extra: Record<string, string> = {}): string {
  const pairs = key ? key.split(",") : [];
  const rendered = [
    ...pairs.map((pair) => {
      const index = pair.indexOf("=");
      return `${pair.slice(0, index)}="${pair.slice(index + 1)}"`;
    }),
    ...Object.entries(extra).map(([name, value]) => `${name}="${value}"`),
  ];
  return rendered.length === 0 ? "" : `{${rendered.join(",")}}`;
}

/** Stable, locale-independent, and never exponential for the values we emit. */
function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
