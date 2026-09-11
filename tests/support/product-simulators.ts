/**
 * Contract-conformant simulators for MARKET and MOVE.
 *
 * The three systems stay in separate repositories with separate databases, so
 * this suite cannot import their code. Instead it drives CORE through exactly
 * the published contracts (`contracts/events/*.schema.json`) that MARKET and
 * MOVE implement on their side. Anything these simulators do, the real
 * products must be able to do with the same payloads.
 */
import type { EventBus } from "../../src/platform/eventing/bus.js";
import type { EventEnvelope } from "../../src/platform/eventing/envelope.js";
import { makeEvent } from "../../src/platform/eventing/envelope.js";
import type { Clock } from "../../src/platform/clock.js";

export interface MarketOrder {
  order_id: string;
  status: "submitted" | "fulfilling" | "completed" | "failed" | "cancelled";
  closure_reason: string | null;
}

/** MARKET side: owns the commercial order, knows nothing about drivers or jobs. */
export class MarketSimulator {
  readonly orders = new Map<string, MarketOrder>();
  private seen = new Set<string>();

  constructor(
    _bus: EventBus,
    private readonly clock: Clock,
  ) {}

  submit(input: {
    order_id: string;
    organization_id: string;
    requested_service: string;
    payment_authorization_id?: string | null;
    correlation_id: string;
  }): EventEnvelope {
    this.orders.set(input.order_id, {
      order_id: input.order_id,
      status: "submitted",
      closure_reason: null,
    });
    return makeEvent({
      event_type: "market.order.created",
      version: 1,
      producer: "wasla-market",
      occurred_at: this.clock.now(),
      correlation_id: input.correlation_id,
      entity_type: "commercial_order",
      entity_id: input.order_id,
      payload: {
        order_id: input.order_id,
        organization_id: input.organization_id,
        requested_service: input.requested_service,
        payment_authorization_id: input.payment_authorization_id ?? null,
      },
    });
  }

  /** Inbox-style idempotent consumption of CORE closure events. */
  consume(event: EventEnvelope): void {
    if (this.seen.has(event.event_id)) return;
    this.seen.add(event.event_id);
    const payload = event.payload as Record<string, string>;
    const order = this.orders.get(payload["order_reference"] ?? "");
    if (!order) return;
    if (event.event_type === "core.fulfillment.cancelled") {
      order.status = "cancelled";
      order.closure_reason = payload["reason"] ?? null;
    } else if (event.event_type === "core.fulfillment.completed") {
      order.status = payload["outcome"] === "completed" ? "completed" : "failed";
      order.closure_reason = payload["reason"] ?? null;
    }
  }

  attach(bus: EventBus): void {
    for (const type of ["core.fulfillment.completed", "core.fulfillment.cancelled"]) {
      bus.subscribe("market.order-closure", type, (event) => this.consume(event));
    }
  }
}

export interface OperationalJob {
  job_id: string;
  fulfillment_id: string;
  status: "created" | "completed" | "failed" | "cancelled";
}

/** MOVE side: owns operational jobs, sees only an opaque fulfillment reference. */
export class MoveSimulator {
  readonly jobs = new Map<string, OperationalJob>();
  /** Set to make job creation fail, simulating no capacity. */
  rejectWith: string | null = null;
  private counter = 0;
  private handled = new Set<string>();

  constructor(
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  attach(bus: EventBus): void {
    bus.subscribe("move.job-intake", "core.fulfillment.created", async (event) => {
      await this.onFulfillmentCreated(event);
    });
    bus.subscribe("move.job-cancellation", "core.fulfillment.cancelled", (event) => {
      const payload = event.payload as Record<string, string>;
      for (const job of this.jobs.values()) {
        if (job.fulfillment_id === payload["fulfillment_id"] && job.status === "created") {
          job.status = "cancelled";
        }
      }
    });
  }

  private async onFulfillmentCreated(event: EventEnvelope): Promise<void> {
    if (this.handled.has(event.event_id)) return;
    const payload = event.payload as Record<string, string>;
    const fulfillmentId = payload["fulfillment_id"]!;
    if (this.rejectWith) {
      this.handled.add(event.event_id);
      await this.bus.publish(
        makeEvent({
          event_type: "move.job.rejected",
          version: 1,
          producer: "wasla-move",
          occurred_at: this.clock.now(),
          correlation_id: event.correlation_id,
          causation_id: event.event_id,
          entity_type: "operational_job",
          entity_id: fulfillmentId,
          payload: {
            fulfillment_id: fulfillmentId,
            reason: this.rejectWith,
            rejected_at: this.clock.now().toISOString(),
          },
        }),
      );
      return;
    }
    this.counter += 1;
    const jobId = `job-${this.counter}`;
    this.jobs.set(jobId, { job_id: jobId, fulfillment_id: fulfillmentId, status: "created" });
    this.handled.add(event.event_id);
    await this.bus.publish(this.acceptance(event, fulfillmentId, jobId));
  }

  private acceptance(event: EventEnvelope, fulfillmentId: string, jobId: string): EventEnvelope {
    return makeEvent({
      event_type: "move.job.accepted",
      version: 1,
      producer: "wasla-move",
      occurred_at: this.clock.now(),
      correlation_id: event.correlation_id,
      causation_id: event.event_id,
      entity_type: "operational_job",
      entity_id: jobId,
      payload: {
        fulfillment_id: fulfillmentId,
        job_id: jobId,
        accepted_at: this.clock.now().toISOString(),
      },
    });
  }

  completion(jobId: string, outcome: "completed" | "failed", correlationId: string): EventEnvelope {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`unknown job ${jobId}`);
    job.status = outcome;
    return makeEvent({
      event_type: "move.job.completed",
      version: 1,
      producer: "wasla-move",
      occurred_at: this.clock.now(),
      correlation_id: correlationId,
      entity_type: "operational_job",
      entity_id: jobId,
      payload: {
        fulfillment_id: job.fulfillment_id,
        job_id: jobId,
        outcome,
        completed_at: this.clock.now().toISOString(),
      },
    });
  }

  jobFor(fulfillmentId: string): OperationalJob | undefined {
    return [...this.jobs.values()].find((job) => job.fulfillment_id === fulfillmentId);
  }
}
