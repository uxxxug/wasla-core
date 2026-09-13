import { invalid } from "../../platform/errors.js";
import type { Router } from "../../platform/http/router.js";
import { limitParam, requiredParam } from "../../platform/http/query.js";
import { requirePrincipal } from "../identity-access/http.js";
import type { IdentityService } from "../identity-access/service.js";
import { isReputationSubjectType, type ReputationSubject } from "./domain.js";
import { MAX_SIGNAL_PAGE, type ReputationService } from "./service.js";

/**
 * The subject and tenant of a read, from the path and the query string.
 *
 * `organization_id` is a required query parameter rather than something inferred
 * from the caller's memberships. A principal can belong to several
 * organizations, and inferring the tenant would mean CORE choosing which one an
 * ambiguous read meant — the silent mislinking B-23 exists to prevent. The
 * reconciliation reads take it the same way, for the same reason.
 */
function subjectOf(ctx: {
  params: Record<string, string | undefined>;
  query: URLSearchParams;
}): ReputationSubject {
  const organizationId = requiredParam(ctx.query, "organization_id");
  const subjectType = ctx.params["subject_type"] ?? "";
  if (!isReputationSubjectType(subjectType)) {
    throw invalid("subject_type must be identity or organization");
  }
  return {
    organization_id: organizationId,
    subject_type: subjectType,
    subject_id: ctx.params["subject_id"] ?? "",
  };
}

/**
 * Reputation routes: two reads, no write.
 *
 * There is no endpoint that records a signal, and that is a decision rather than
 * an omission. A signal is a report about something that happened outside CORE,
 * so the systems that observed it publish it and CORE consumes the event — one
 * ingestion path, exactly-once on the producer's own reference, auditable and
 * replayable. An HTTP write would be a second ingestion path with none of those
 * properties, and ADR 0008 keeps the list of synchronous cross-system paths
 * closed: opening one needs an ADR, which is recorded as a blocker rather than
 * quietly taken here.
 */
export function registerReputationRoutes(
  router: Router,
  reputation: ReputationService,
  identity: IdentityService,
): void {
  // The derived standing. Every number in the response is computed from the
  // signals at the moment of the read; none of it is stored.
  router.get("/v1/reputation/:subject_type/:subject_id", async (ctx) => {
    const subject = subjectOf(ctx);
    await requirePrincipal(ctx, identity, "reputation.read", subject.organization_id);
    return { status: 200, body: await reputation.standing(subject) };
  });

  // The signals behind the standing, so a support agent can see what a number is
  // made of instead of having to believe it.
  router.get("/v1/reputation/:subject_type/:subject_id/signals", async (ctx) => {
    const subject = subjectOf(ctx);
    await requirePrincipal(ctx, identity, "reputation.read", subject.organization_id);
    const limit = limitParam(ctx.query, "limit", { default: 50, min: 1, max: MAX_SIGNAL_PAGE });
    const items = await reputation.listSignals(subject, limit);
    return { status: 200, body: { count: items.length, items } };
  });
}
