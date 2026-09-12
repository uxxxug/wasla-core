/**
 * Reputation signals and derived standing (ADR 0015), on both backends.
 *
 * The properties under test are the ones a number in front of a person depends
 * on:
 *
 *   - a reported signal is recorded **exactly once**, however many times the
 *     producer delivers it;
 *   - a withdrawal is a marker, single-valued, and stops the signal counting
 *     towards anything derived while leaving the fact readable;
 *   - a standing is **derived on every read** and cannot disagree with its
 *     signals, because it is stored nowhere;
 *   - CORE refuses what it cannot count: an unknown kind, a rating with no
 *     number, a number on a kind that has none;
 *   - one tenant's signals never reach another's standing;
 *   - the in-memory backend and Postgres answer identically, down to the
 *     grouped rows the standing is folded from (B-12).
 *
 * Postgres tests are skipped without DATABASE_URL. The append-only guarantee is
 * asserted against real SQL, because a trigger is the only thing that stops a
 * hand-written UPDATE, and a memory double cannot stand in for that.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createCoreApp, type CoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { makeEvent } from "../src/platform/eventing/envelope.js";
import type { EventEnvelope } from "../src/platform/eventing/envelope.js";
import {
  memoryPersistence,
  postgresPersistence,
  type Persistence,
} from "../src/platform/persistence/backends.js";
import {
  REPUTATION_SIGNAL_KINDS,
  deriveStanding,
  groupSignals,
  ratingShapeIsValid,
  standingFromSignals,
  type ReputationSignal,
  type ReputationStanding,
} from "../src/modules/reputation/domain.js";

const url = process.env.DATABASE_URL;
const CORRELATION = "corr-reputation";

const TABLES = `reputation_signal, notification, notification_recipient, membership,
  session, principal, identity_link, identity, fulfillment, ledger_entry,
  ledger_transaction, payment_authorization, wallet, usage_record,
  subscription_period, subscription, plan_grant, plan, event_delivery,
  event_subscription, inbound_event, organization, outbox, inbox,
  idempotency_key, audit_entry`;

interface Backend {
  name: string;
  open(clock: FixedClock): Promise<{ store: Persistence; close(): Promise<void> }>;
  truncate(): Promise<void>;
  /** Raw SQL, only where the guarantee under test lives in the database. */
  sql?(text: string, params?: readonly unknown[]): Promise<{ rowCount: number | null }>;
}

const backends: Backend[] = [
  {
    name: "in-memory",
    async open(clock) {
      return { store: memoryPersistence(clock), async close() {} };
    },
    async truncate() {},
  },
];

if (url) {
  backends.push({
    name: "postgres",
    async open(clock) {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: url, max: 8 });
      return {
        store: postgresPersistence(pool as never, clock),
        async close() {
          await pool.end();
        },
      };
    },
    async truncate() {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: url, max: 1 });
      try {
        await pool.query(`truncate ${TABLES} restart identity cascade`);
      } finally {
        await pool.end();
      }
    },
    async sql(text, params = []) {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: url, max: 1 });
      try {
        const result = await pool.query(text, params as unknown[]);
        return { rowCount: result.rowCount };
      } finally {
        await pool.end();
      }
    },
  });
}

/**
 * Standings recorded per backend from one identical script, compared at the end.
 *
 * The comparison is the point: two adapters that each pass their own assertions
 * can still disagree with each other, and the disagreement is what certifies
 * bugs. Keyed by backend name so the check is skipped, not failed, when Postgres
 * is not configured.
 */
const crossBackend = new Map<string, { standing: ReputationStanding; groups: unknown }>();

async function harness(backend: Backend) {
  await backend.truncate();
  const clock = new FixedClock();
  const { store, close } = await backend.open(clock);
  const core = createCoreApp({ clock, persistence: store });
  const organization = await core.organization.create({
    name: "Reputation Co",
    country_code: "SA",
    correlation_id: CORRELATION,
  });
  const other = await core.organization.create({
    name: "Other Co",
    country_code: "SA",
    correlation_id: CORRELATION,
  });
  return {
    core,
    clock,
    store,
    close,
    organizationId: organization.organization_id,
    otherOrganizationId: other.organization_id,
  };
}

/** A `market.review.rated` envelope. A fresh `event_id` each time by default. */
function ratedEvent(input: {
  organization_id: string;
  subject_id: string;
  review_reference: string;
  rating: number;
  rated_at: string;
  subject_type?: "identity" | "organization";
}): EventEnvelope {
  return makeEvent({
    event_type: "market.review.rated",
    version: 1,
    producer: "wasla-market",
    occurred_at: new Date(input.rated_at),
    correlation_id: CORRELATION,
    entity_type: "review",
    entity_id: input.review_reference,
    payload: {
      review_reference: input.review_reference,
      organization_id: input.organization_id,
      subject_type: input.subject_type ?? "identity",
      subject_id: input.subject_id,
      rating: input.rating,
      rated_at: input.rated_at,
    },
  });
}

function retractedEvent(input: {
  organization_id: string;
  review_reference: string;
  reason: string;
  retracted_at: string;
}): EventEnvelope {
  return makeEvent({
    event_type: "market.review.retracted",
    version: 1,
    producer: "wasla-market",
    occurred_at: new Date(input.retracted_at),
    correlation_id: CORRELATION,
    entity_type: "review",
    entity_id: input.review_reference,
    payload: {
      review_reference: input.review_reference,
      organization_id: input.organization_id,
      reason: input.reason,
      retracted_at: input.retracted_at,
    },
  });
}

async function published(core: CoreApp, eventType: string) {
  return (await core.outbox.all()).filter((record) => record.event.event_type === eventType);
}

/** A platform admin session token, which carries `reputation.read`. */
async function operatorToken(core: CoreApp, organizationId: string): Promise<string> {
  const registered = await core.identity.registerIdentity({
    channel_type: "web",
    external_id: `admin-${randomUUID()}`,
    correlation_id: CORRELATION,
  });
  await core.identity.grantMembership({
    principal_id: registered.principal.principal_id,
    organization_id: organizationId,
    roles: ["platform_admin"],
    correlation_id: CORRELATION,
  });
  const { token } = await core.identity.issueSession({
    principal_id: registered.principal.principal_id,
    channel_type: "web",
    correlation_id: CORRELATION,
  });
  return token;
}

describe("reputation standing is derived, never stored", () => {
  it("counts a retracted rating out of the average without hiding it", () => {
    // Pure arithmetic, no store: the same fold both backends use.
    const base = {
      organization_id: "org",
      subject_type: "identity" as const,
      subject_id: "subject",
    };
    const signal = (
      reference: string,
      rating: number | null,
      retracted: boolean,
      kind: ReputationSignal["signal_kind"] = "service_rating",
    ): ReputationSignal => ({
      reputation_signal_id: reference,
      ...base,
      signal_kind: kind,
      rating_value: rating,
      source_system: "wasla-market",
      source_reference: reference,
      occurred_at: "2026-01-01T00:00:00.000Z",
      recorded_at: `2026-01-0${reference.length}T00:00:00.000Z`,
      correlation_id: CORRELATION,
      retracted_at: retracted ? "2026-01-09T00:00:00.000Z" : null,
      retraction_reason: retracted ? "moderated" : null,
    });

    const standing = standingFromSignals(base, [
      signal("a", 5, false),
      signal("bb", 1, true),
      signal("ccc", 4, false),
      signal("dddd", null, false, "complaint"),
    ]);

    // Four facts, one withdrawn. The average is over the two ratings that still
    // stand, not the three that were ever reported.
    expect(standing.signal_count).toBe(4);
    expect(standing.retracted_count).toBe(1);
    expect(standing.rating_count).toBe(2);
    expect(standing.rating_sum).toBe(9);
    expect(standing.average_rating_milli).toBe(4500);
    expect(standing.counts["service_rating"]).toBe(2);
    expect(standing.counts["complaint"]).toBe(1);
    expect(standing.counts["dispute"]).toBe(0);
    expect(standing.first_signal_at).toBe("2026-01-01T00:00:00.000Z");
    expect(standing.last_signal_at).toBe("2026-01-04T00:00:00.000Z");
  });

  it("says null rather than zero when nothing has been rated", () => {
    const subject = {
      organization_id: "org",
      subject_type: "organization" as const,
      subject_id: "subject",
    };
    const empty = deriveStanding(subject, []);
    // A subject with no ratings is not a subject rated badly, and a zero here
    // would be read as one by anything that formats it.
    expect(empty.average_rating_milli).toBeNull();
    expect(empty.rating_count).toBe(0);
    expect(empty.signal_count).toBe(0);
    expect(empty.first_signal_at).toBeNull();
    for (const kind of REPUTATION_SIGNAL_KINDS) expect(empty.counts[kind]).toBe(0);
  });

  it("omits kinds with no signals from the groups, as a group-by would", () => {
    // The grouped shape is a contract between the two adapters: Postgres emits
    // one row per kind present, so the reference implementation must not emit
    // zero rows for kinds nobody reported.
    expect(groupSignals([])).toEqual([]);
  });

  it("refuses a rating with no number and a number on a kind that has none", () => {
    expect(ratingShapeIsValid("service_rating", 3)).toBe(true);
    expect(ratingShapeIsValid("service_rating", null)).toBe(false);
    expect(ratingShapeIsValid("service_rating", 0)).toBe(false);
    expect(ratingShapeIsValid("service_rating", 6)).toBe(false);
    expect(ratingShapeIsValid("service_rating", 3.5)).toBe(false);
    // A dispute carrying a 4 would be read as satisfaction by anything that
    // trusts the column.
    expect(ratingShapeIsValid("dispute", 4)).toBe(false);
    expect(ratingShapeIsValid("dispute", null)).toBe(true);
  });
});

for (const backend of backends) {
  describe(`reputation ingestion (${backend.name})`, () => {
    it("records a reported rating exactly once, however often it is delivered", async () => {
      const { core, close, organizationId } = await harness(backend);
      try {
        const subject = randomUUID();
        const first = ratedEvent({
          organization_id: organizationId,
          subject_id: subject,
          review_reference: "review-1",
          rating: 5,
          rated_at: "2026-01-01T09:00:00.000Z",
        });
        await core.bus.publish(first);
        // The same event again — the inbox refuses it on `event_id`.
        await core.bus.publish(first);
        // A *different* envelope carrying the same report, which is what a
        // producer retrying after a timeout actually sends: a new event_id, the
        // same review. The inbox cannot see that these are one fact; only the
        // unique constraint on the producer's reference can.
        await core.bus.publish(
          ratedEvent({
            organization_id: organizationId,
            subject_id: subject,
            review_reference: "review-1",
            rating: 5,
            rated_at: "2026-01-01T09:00:00.000Z",
          }),
        );

        const standing = await core.reputation.standing({
          organization_id: organizationId,
          subject_type: "identity",
          subject_id: subject,
        });
        expect(standing.signal_count).toBe(1);
        expect(standing.rating_count).toBe(1);
        expect(standing.average_rating_milli).toBe(5000);
        // One fact, one announcement. A second event would make every consumer
        // count the rating twice.
        expect(await published(core, "core.reputation.signal_recorded")).toHaveLength(1);
      } finally {
        await close();
      }
    });

    it("orders and lists signals by CORE's clock, not the producer's claim", async () => {
      const { core, clock, close, organizationId } = await harness(backend);
      try {
        const subject = randomUUID();
        // Reported in the opposite order to when they supposedly happened. A
        // producer's skew must not reorder CORE's record of what it received.
        await core.bus.publish(
          ratedEvent({
            organization_id: organizationId,
            subject_id: subject,
            review_reference: "review-late-claim",
            rating: 2,
            rated_at: "2026-01-05T09:00:00.000Z",
          }),
        );
        clock.advance(60_000);
        await core.bus.publish(
          ratedEvent({
            organization_id: organizationId,
            subject_id: subject,
            review_reference: "review-early-claim",
            rating: 4,
            rated_at: "2026-01-02T09:00:00.000Z",
          }),
        );

        const signals = await core.reputation.listSignals({
          organization_id: organizationId,
          subject_type: "identity",
          subject_id: subject,
        });
        expect(signals.map((signal) => signal.source_reference)).toEqual([
          "review-early-claim",
          "review-late-claim",
        ]);
        // Both timestamps are kept: the claim and the record.
        expect(signals[0]!.occurred_at).toBe("2026-01-02T09:00:00.000Z");
        expect(signals[0]!.recorded_at).toBe("2026-01-01T00:01:00.000Z");
        await expect(
          core.reputation.listSignals(
            { organization_id: organizationId, subject_type: "identity", subject_id: subject },
            0,
          ),
        ).rejects.toThrow(/limit/);
        await expect(
          core.reputation.listSignals(
            { organization_id: organizationId, subject_type: "identity", subject_id: subject },
            5_000,
          ),
        ).rejects.toThrow(/limit/);
      } finally {
        await close();
      }
    });

    it("withdraws a signal once, keeps the fact, and stops it counting", async () => {
      const { core, close, organizationId } = await harness(backend);
      try {
        const subject = randomUUID();
        await core.bus.publish(
          ratedEvent({
            organization_id: organizationId,
            subject_id: subject,
            review_reference: "review-kept",
            rating: 5,
            rated_at: "2026-01-01T09:00:00.000Z",
          }),
        );
        await core.bus.publish(
          ratedEvent({
            organization_id: organizationId,
            subject_id: subject,
            review_reference: "review-withdrawn",
            rating: 1,
            rated_at: "2026-01-01T10:00:00.000Z",
          }),
        );
        const retraction = retractedEvent({
          organization_id: organizationId,
          review_reference: "review-withdrawn",
          reason: "moderated as abusive content",
          retracted_at: "2026-01-02T00:00:00.000Z",
        });
        await core.bus.publish(retraction);
        // Delivered again as a fresh envelope: the marker must stay
        // single-valued without relying on the inbox.
        await core.bus.publish(
          retractedEvent({
            organization_id: organizationId,
            review_reference: "review-withdrawn",
            reason: "moderated again",
            retracted_at: "2026-01-03T00:00:00.000Z",
          }),
        );

        const standing = await core.reputation.standing({
          organization_id: organizationId,
          subject_type: "identity",
          subject_id: subject,
        });
        expect(standing.signal_count).toBe(2);
        expect(standing.retracted_count).toBe(1);
        expect(standing.rating_count).toBe(1);
        // The 1 is gone from the average and still present in the record.
        expect(standing.average_rating_milli).toBe(5000);

        const signals = await core.reputation.listSignals({
          organization_id: organizationId,
          subject_type: "identity",
          subject_id: subject,
        });
        const withdrawn = signals.find((s) => s.source_reference === "review-withdrawn");
        expect(withdrawn).toMatchObject({
          rating_value: 1,
          retracted_at: "2026-01-02T00:00:00.000Z",
          retraction_reason: "moderated as abusive content",
        });
        // The second retraction changed nothing: not the marker, not the reason.
        expect(await published(core, "core.reputation.signal_retracted")).toHaveLength(1);
      } finally {
        await close();
      }
    });

    it("answers a retraction for a signal it never received instead of failing forever", async () => {
      const { core, close, organizationId } = await harness(backend);
      try {
        // A refusal here would be retried until the inbound event dead-lettered,
        // and the producer's intent — this must not count — is already satisfied
        // by there being nothing to count.
        await core.bus.publish(
          retractedEvent({
            organization_id: organizationId,
            review_reference: "review-never-seen",
            reason: "moderated",
            retracted_at: "2026-01-02T00:00:00.000Z",
          }),
        );
        expect(await published(core, "core.reputation.signal_retracted")).toHaveLength(0);
        const outcome = await core.reputation.retractSignal({
          organization_id: organizationId,
          source_system: "wasla-market",
          source_reference: "review-never-seen",
          retracted_at: "2026-01-02T00:00:00.000Z",
          reason: "moderated",
          correlation_id: CORRELATION,
        });
        expect(outcome).toMatchObject({ retracted: false, signal: undefined });
      } finally {
        await close();
      }
    });

    it("refuses what it cannot count", async () => {
      const { core, close, organizationId } = await harness(backend);
      try {
        const subject = randomUUID();
        const base = {
          organization_id: organizationId,
          subject_type: "identity" as const,
          subject_id: subject,
          source_system: "wasla-market",
          occurred_at: "2026-01-01T09:00:00.000Z",
          correlation_id: CORRELATION,
        };
        // An unknown kind counts towards nothing, so accepting it would discard
        // a fact the producer was told had landed.
        await expect(
          core.reputation.recordSignal({
            ...base,
            signal_kind: "vibes" as never,
            source_reference: "r-1",
          }),
        ).rejects.toThrow(/signal_kind/);
        await expect(
          core.reputation.recordSignal({
            ...base,
            signal_kind: "service_rating",
            rating_value: null,
            source_reference: "r-2",
          }),
        ).rejects.toThrow(/rating_value/);
        await expect(
          core.reputation.recordSignal({
            ...base,
            signal_kind: "service_rating",
            rating_value: 9,
            source_reference: "r-3",
          }),
        ).rejects.toThrow(/rating_value/);
        await expect(
          core.reputation.recordSignal({
            ...base,
            signal_kind: "complaint",
            rating_value: 4,
            source_reference: "r-4",
          }),
        ).rejects.toThrow(/rating_value/);
        await expect(
          core.reputation.recordSignal({
            ...base,
            subject_type: "operational_job" as never,
            signal_kind: "complaint",
            source_reference: "r-5",
          }),
        ).rejects.toThrow(/subject_type/);
        await expect(
          core.reputation.recordSignal({
            ...base,
            signal_kind: "complaint",
            source_reference: "   ",
          }),
        ).rejects.toThrow(/source_reference/);

        // Nothing was stored by any of the refusals, on either backend.
        const standing = await core.reputation.standing({ ...base });
        expect(standing.signal_count).toBe(0);
        expect(await published(core, "core.reputation.signal_recorded")).toHaveLength(0);
      } finally {
        await close();
      }
    });

    it("keeps one tenant's signals out of another's standing", async () => {
      const { core, close, organizationId, otherOrganizationId } = await harness(backend);
      try {
        // The same subject id and the same producer reference in two tenants.
        // Both must be recorded — the uniqueness is per tenant — and neither may
        // appear in the other's standing.
        const subject = randomUUID();
        for (const org of [organizationId, otherOrganizationId]) {
          await core.bus.publish(
            ratedEvent({
              organization_id: org,
              subject_id: subject,
              review_reference: "review-shared-reference",
              rating: org === organizationId ? 5 : 1,
              rated_at: "2026-01-01T09:00:00.000Z",
            }),
          );
        }

        const mine = await core.reputation.standing({
          organization_id: organizationId,
          subject_type: "identity",
          subject_id: subject,
        });
        const theirs = await core.reputation.standing({
          organization_id: otherOrganizationId,
          subject_type: "identity",
          subject_id: subject,
        });
        expect(mine.average_rating_milli).toBe(5000);
        expect(theirs.average_rating_milli).toBe(1000);
        expect(mine.signal_count).toBe(1);
        expect(theirs.signal_count).toBe(1);
      } finally {
        await close();
      }
    });

    it("separates an identity's standing from an organization's", async () => {
      const { core, close, organizationId } = await harness(backend);
      try {
        // One id used as both subject types. A standing is keyed by the pair, so
        // a rating of the company must not appear on the person.
        const id = randomUUID();
        await core.bus.publish(
          ratedEvent({
            organization_id: organizationId,
            subject_id: id,
            subject_type: "identity",
            review_reference: "review-person",
            rating: 5,
            rated_at: "2026-01-01T09:00:00.000Z",
          }),
        );
        await core.bus.publish(
          ratedEvent({
            organization_id: organizationId,
            subject_id: id,
            subject_type: "organization",
            review_reference: "review-company",
            rating: 2,
            rated_at: "2026-01-01T09:00:00.000Z",
          }),
        );
        expect(
          (
            await core.reputation.standing({
              organization_id: organizationId,
              subject_type: "identity",
              subject_id: id,
            })
          ).average_rating_milli,
        ).toBe(5000);
        expect(
          (
            await core.reputation.standing({
              organization_id: organizationId,
              subject_type: "organization",
              subject_id: id,
            })
          ).average_rating_milli,
        ).toBe(2000);
      } finally {
        await close();
      }
    });

    it("audits every recorded and withdrawn signal without the review behind it", async () => {
      const { core, close, organizationId } = await harness(backend);
      try {
        const subject = randomUUID();
        await core.bus.publish(
          ratedEvent({
            organization_id: organizationId,
            subject_id: subject,
            review_reference: "review-audited",
            rating: 3,
            rated_at: "2026-01-01T09:00:00.000Z",
          }),
        );
        await core.bus.publish(
          retractedEvent({
            organization_id: organizationId,
            review_reference: "review-audited",
            reason: "moderated",
            retracted_at: "2026-01-02T00:00:00.000Z",
          }),
        );
        const entries = (await core.audit.entries()).filter((entry) =>
          entry.action.startsWith("reputation."),
        );
        // Sorted before comparing, and that is a correction rather than a
        // convenience: the first version of this assertion compared the order the
        // log returned, which passed on one backend and failed intermittently on
        // the other. Under a fixed clock both entries carry the same instant, so
        // their relative order is not something CORE guarantees — asserting it
        // would have been asserting an accident of the query plan.
        expect(entries.map((entry) => entry.action).sort()).toEqual([
          "reputation.signal_recorded",
          "reputation.signal_retracted",
        ]);
        // What is guaranteed: both entries name the signal, and neither carries
        // anything a person wrote. `metadata` is the whole audit payload, so an
        // exact comparison is what proves the review text is absent rather than
        // merely unasserted.
        for (const entry of entries) {
          expect(entry.entity_type).toBe("reputation_signal");
          expect(Object.keys(entry.metadata).sort()).toEqual(
            entry.action === "reputation.signal_recorded"
              ? ["organization_id", "signal_kind", "source_system", "subject_id", "subject_type"]
              : ["organization_id", "reason", "signal_kind", "subject_id", "subject_type"],
          );
        }
      } finally {
        await close();
      }
    });

    it("serves the standing and its signals over HTTP, to permitted callers only", async () => {
      const { core, close, organizationId } = await harness(backend);
      try {
        const subject = randomUUID();
        await core.bus.publish(
          ratedEvent({
            organization_id: organizationId,
            subject_id: subject,
            review_reference: "review-http",
            rating: 4,
            rated_at: "2026-01-01T09:00:00.000Z",
          }),
        );
        const headers = { authorization: `Bearer ${await operatorToken(core, organizationId)}` };

        const standing = await core.router.handle({
          method: "GET",
          url: `/v1/reputation/identity/${subject}?organization_id=${organizationId}`,
          headers,
        });
        expect(standing.status).toBe(200);
        expect(standing.body).toMatchObject({
          subject_type: "identity",
          subject_id: subject,
          rating_count: 1,
          average_rating_milli: 4000,
        });

        const signals = await core.router.handle({
          method: "GET",
          url: `/v1/reputation/identity/${subject}/signals?organization_id=${organizationId}&limit=10`,
          headers,
        });
        expect(signals.status).toBe(200);
        expect(signals.body).toMatchObject({ count: 1 });

        // The tenant is stated, never inferred: a principal can belong to
        // several organizations and CORE must not choose one.
        expect(
          (
            await core.router.handle({
              method: "GET",
              url: `/v1/reputation/identity/${subject}`,
              headers,
            })
          ).status,
        ).toBe(400);
        // A subject type CORE does not own.
        expect(
          (
            await core.router.handle({
              method: "GET",
              url: `/v1/reputation/operational_job/${subject}?organization_id=${organizationId}`,
              headers,
            })
          ).status,
        ).toBe(400);
        // An unbounded listing is a cost nobody chose.
        expect(
          (
            await core.router.handle({
              method: "GET",
              url: `/v1/reputation/identity/${subject}/signals?organization_id=${organizationId}&limit=5000`,
              headers,
            })
          ).status,
        ).toBe(400);
        // No token at all.
        expect(
          (
            await core.router.handle({
              method: "GET",
              url: `/v1/reputation/identity/${subject}?organization_id=${organizationId}`,
              headers: {},
            })
          ).status,
        ).toBe(401);

        // An ordinary member does not hold `reputation.read`: reading everyone's
        // standing is an administrative act.
        const member = await core.identity.registerIdentity({
          channel_type: "web",
          external_id: `member-${randomUUID()}`,
          correlation_id: CORRELATION,
        });
        await core.identity.grantMembership({
          principal_id: member.principal.principal_id,
          organization_id: organizationId,
          roles: ["org_member"],
          correlation_id: CORRELATION,
        });
        const memberSession = await core.identity.issueSession({
          principal_id: member.principal.principal_id,
          channel_type: "web",
          correlation_id: CORRELATION,
        });
        expect(
          (
            await core.router.handle({
              method: "GET",
              url: `/v1/reputation/identity/${subject}?organization_id=${organizationId}`,
              headers: { authorization: `Bearer ${memberSession.token}` },
            })
          ).status,
        ).toBe(403);
      } finally {
        await close();
      }
    });

    it("decides duplication and retraction in the write, not in a preceding read", async () => {
      const { core, close, store, organizationId } = await harness(backend);
      try {
        // Straight at the port, deliberately. The service checks first and
        // returns early, so its own path never exercises the conditions in the
        // write — and those conditions are the whole guarantee under
        // concurrency, where two copies of one report both pass any preceding
        // read. A mutation that deleted the `retracted_at is null` predicate from
        // the UPDATE survived the service-level tests; this one kills it.
        const subject = randomUUID();
        await core.bus.publish(
          ratedEvent({
            organization_id: organizationId,
            subject_id: subject,
            review_reference: "review-port",
            rating: 4,
            rated_at: "2026-01-01T09:00:00.000Z",
          }),
        );
        const stored = await store.reputation.findBySource(
          organizationId,
          "wasla-market",
          "review-port",
        );
        expect(stored).toBeDefined();

        // A second insert of the same producer reference, with a different id:
        // reported as a duplicate, not raised as an error, because a redelivery
        // is the expected case.
        await expect(
          store.reputation.insertIfAbsent({ ...stored!, reputation_signal_id: randomUUID() }),
        ).resolves.toBe("duplicate_source_reference");

        const retraction = {
          organization_id: organizationId,
          source_system: "wasla-market",
          source_reference: "review-port",
          retracted_at: "2026-01-02T00:00:00.000Z",
          reason: "moderated",
        };
        await expect(store.reputation.retractIfStanding(retraction)).resolves.toBe("applied");
        // The second withdrawal writes nothing and says so. It must not raise:
        // an exception here would be retried until the event dead-lettered, over
        // an instruction that had already been carried out.
        await expect(
          store.reputation.retractIfStanding({ ...retraction, reason: "moderated again" }),
        ).resolves.toBe("stale");
        // And the first reason stands — a stale retraction cannot overwrite it.
        expect(
          await store.reputation.findBySource(organizationId, "wasla-market", "review-port"),
        ).toMatchObject({ retraction_reason: "moderated" });

        // A signal in another tenant is not reachable by reference alone.
        await expect(
          store.reputation.retractIfStanding({
            ...retraction,
            organization_id: randomUUID(),
          }),
        ).resolves.toBe("stale");
      } finally {
        await close();
      }
    });

    it("derives the same standing and the same groups as the other backend", async () => {
      const { core, clock, close, store, organizationId } = await harness(backend);
      try {
        // A fixed subject id, so the two backends record the identical script and
        // the results can be compared field for field.
        const subject = "8f14e45f-ce0a-4e2b-9a1d-2b6f1c3d4e55";
        const script: Array<[string, number, string]> = [
          ["review-x1", 5, "2026-01-01T09:00:00.000Z"],
          ["review-x2", 3, "2026-01-01T10:00:00.000Z"],
          ["review-x3", 1, "2026-01-01T11:00:00.000Z"],
        ];
        for (const [reference, rating, at] of script) {
          await core.bus.publish(
            ratedEvent({
              organization_id: organizationId,
              subject_id: subject,
              review_reference: reference,
              rating,
              rated_at: at,
            }),
          );
          clock.advance(1_000);
        }
        await core.reputation.recordSignal({
          organization_id: organizationId,
          subject_type: "identity",
          subject_id: subject,
          signal_kind: "complaint",
          source_reference: "case-1",
          source_system: "wasla-support",
          occurred_at: "2026-01-01T12:00:00.000Z",
          correlation_id: CORRELATION,
        });
        clock.advance(1_000);
        await core.bus.publish(
          retractedEvent({
            organization_id: organizationId,
            review_reference: "review-x3",
            reason: "moderated",
            retracted_at: "2026-01-02T00:00:00.000Z",
          }),
        );

        const subjectKey = {
          organization_id: organizationId,
          subject_type: "identity" as const,
          subject_id: subject,
        };
        const standing = await core.reputation.standing(subjectKey);
        const groups = await store.reputation.groupsForSubject(subjectKey);
        // Two standing ratings, 5 and 3.
        expect(standing.average_rating_milli).toBe(4000);
        expect(standing.counts["complaint"]).toBe(1);
        expect(standing.retracted_count).toBe(1);

        // The grouped rows are what the SQL and the reference implementation must
        // agree on; the standing is a fold of them, so comparing both catches a
        // divergence that cancels out in the total.
        const signals = await core.reputation.listSignals(subjectKey, 200);
        expect(groups).toEqual(groupSignals([...signals].reverse()));

        crossBackend.set(backend.name, {
          // `organization_id` differs between runs, so it is normalised out of
          // the comparison. Everything derived from the signals is not.
          standing: { ...standing, organization_id: "normalised" },
          groups: groups.map((group) => ({ ...group })),
        });
      } finally {
        await close();
      }
    });

    if (backend.name === "postgres") {
      it("refuses to let a recorded signal be edited or deleted", async () => {
        const { core, close, organizationId } = await harness(backend);
        try {
          const subject = randomUUID();
          await core.bus.publish(
            ratedEvent({
              organization_id: organizationId,
              subject_id: subject,
              review_reference: "review-immutable",
              rating: 2,
              rated_at: "2026-01-01T09:00:00.000Z",
            }),
          );
          const sql = backend.sql;
          if (!sql) throw new Error("postgres backend must expose raw SQL");

          // A hand-written UPDATE is exactly the operation a trigger exists to
          // stop: nothing in `src/` issues one, so only the database can refuse
          // it, and a reputation that can be quietly edited is not evidence of
          // anything.
          await expect(
            sql(`UPDATE reputation_signal SET rating_value = 5 WHERE source_reference = $1`, [
              "review-immutable",
            ]),
          ).rejects.toThrow(/append-only|immutable/i);
          await expect(
            sql(`UPDATE reputation_signal SET subject_id = $1 WHERE source_reference = $2`, [
              randomUUID(),
              "review-immutable",
            ]),
          ).rejects.toThrow(/append-only|immutable/i);
          await expect(
            sql(`DELETE FROM reputation_signal WHERE source_reference = $1`, [
              "review-immutable",
            ]),
          ).rejects.toThrow(/append-only|immutable/i);

          // The retraction marker is the one permitted transition, and only
          // once: a second withdrawal is refused by the trigger even when it is
          // issued directly.
          await expect(
            sql(
              `UPDATE reputation_signal SET retracted_at = now(), retraction_reason = 'first'
                WHERE source_reference = $1`,
              ["review-immutable"],
            ),
          ).resolves.toMatchObject({ rowCount: 1 });
          await expect(
            sql(
              `UPDATE reputation_signal SET retracted_at = now(), retraction_reason = 'second'
                WHERE source_reference = $1`,
              ["review-immutable"],
            ),
          ).rejects.toThrow(/append-only|immutable|retract/i);
        } finally {
          await close();
        }
      });

      it("refuses a rating shape and an unknown kind in the schema itself", async () => {
        const { core, close, organizationId } = await harness(backend);
        try {
          const sql = backend.sql;
          if (!sql) throw new Error("postgres backend must expose raw SQL");
          const insert = (kind: string, rating: number | null) =>
            sql(
              `INSERT INTO reputation_signal (
                 reputation_signal_id, organization_id, subject_type, subject_id,
                 signal_kind, rating_value, source_system, source_reference,
                 occurred_at, recorded_at, correlation_id
               ) VALUES ($1,$2,'identity',$3,$4,$5,'wasla-market',$6,now(),now(),$7)`,
              [
                randomUUID(),
                organizationId,
                randomUUID(),
                kind,
                rating,
                `raw-${randomUUID()}`,
                CORRELATION,
              ],
            );
          // The constraints are the database's, not only the service's: a second
          // writer, a migration or a console session meets the same refusals.
          await expect(insert("service_rating", null)).rejects.toThrow(/rating_shape/);
          await expect(insert("service_rating", 6)).rejects.toThrow(/rating/);
          await expect(insert("complaint", 4)).rejects.toThrow(/rating_shape/);
          await expect(insert("vibes", null)).rejects.toThrow(/signal_kind/);
          await expect(insert("complaint", null)).resolves.toMatchObject({ rowCount: 1 });
          expect(core.persistence).toBe("postgres");

          // A withdrawal with a timestamp and no reason. Asserted at the schema
          // level because the first version of this constraint accepted it: SQL
          // three-valued logic made the guard evaluate to NULL, and a CHECK only
          // rejects FALSE, so the one row it existed to refuse was the row it let
          // through. See migration 0018.
          await expect(
            sql(
              `INSERT INTO reputation_signal (
                 reputation_signal_id, organization_id, subject_type, subject_id,
                 signal_kind, source_system, source_reference,
                 occurred_at, recorded_at, correlation_id, retracted_at
               ) VALUES ($1,$2,'identity',$3,'complaint','wasla-market',$4,now(),now(),$5,now())`,
              [randomUUID(), organizationId, randomUUID(), `raw-${randomUUID()}`, CORRELATION],
            ),
          ).rejects.toThrow(/retraction_fields/);
          // And a reason with no timestamp, which does not say anything was
          // withdrawn.
          await expect(
            sql(
              `INSERT INTO reputation_signal (
                 reputation_signal_id, organization_id, subject_type, subject_id,
                 signal_kind, source_system, source_reference,
                 occurred_at, recorded_at, correlation_id, retraction_reason
               ) VALUES ($1,$2,'identity',$3,'complaint','wasla-market',$4,now(),now(),$5,'moderated')`,
              [randomUUID(), organizationId, randomUUID(), `raw-${randomUUID()}`, CORRELATION],
            ),
          ).rejects.toThrow(/retraction_fields/);
          // A blank reason is no reason.
          await expect(
            sql(
              `INSERT INTO reputation_signal (
                 reputation_signal_id, organization_id, subject_type, subject_id,
                 signal_kind, source_system, source_reference,
                 occurred_at, recorded_at, correlation_id, retracted_at, retraction_reason
               ) VALUES ($1,$2,'identity',$3,'complaint','wasla-market',$4,now(),now(),$5,now(),'   ')`,
              [randomUUID(), organizationId, randomUUID(), `raw-${randomUUID()}`, CORRELATION],
            ),
          ).rejects.toThrow(/retraction_fields/);
        } finally {
          await close();
        }
      });
    }
  });
}

afterAll(() => {
  // Only meaningful when both backends ran. Skipped rather than asserted when
  // Postgres is not configured, because a comparison against one participant
  // proves nothing.
  if (crossBackend.size < 2) return;
  const [first, second] = [...crossBackend.values()];
  expect(second!.standing).toEqual(first!.standing);
  expect(second!.groups).toEqual(first!.groups);
});
