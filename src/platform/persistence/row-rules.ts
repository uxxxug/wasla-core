/**
 * The schema's `CHECK` constraints, restated once, for the reference backend.
 *
 * Every port has two implementations and the suite runs against both. That is
 * only evidence if a row Postgres refuses is also refused in memory — otherwise
 * a green reference-store run certifies a bug instead of catching it, which is
 * the failure B-12 names. The uniqueness cycle closed that for uniqueness. This
 * file closes it for the 100 `CHECK` constraints the schema declares.
 *
 * Restated **once**, in a table, rather than sprinkled through the stores:
 * twenty-odd closed vocabularies written out at each write site would be twenty
 * copies of one truth, and the copies would drift. A store calls `assertRow`
 * and gets every rule for its table.
 *
 * The rules are not derived from the live schema, because the point of the
 * reference backend is to run with no database. They are kept honest three ways
 * instead: `tests/check-parity.test.ts` probes each rule against both backends,
 * the same file fails when the schema declares a `CHECK` no case covers, and the
 * vocabularies here are asserted equal to the domain unions in both directions
 * at typecheck time, so drift is a compile error rather than a silent gap.
 */

import { assertReferences, registryFor } from "./reference-keys.js";

/** A row as its table sees it. Dotted paths reach into a nested record. */
export type Row = Readonly<Record<string, unknown>>;

export interface CheckRule {
  /** The constraint name in the schema. Quoted verbatim in the refusal. */
  readonly constraint: string;
  /**
   * The columns the rule reads, as paths.
   *
   * Declared so `assertRow` can refuse a row that lacks one instead of reading
   * `undefined` and silently passing: a column renamed in the domain would
   * otherwise disable its rule with nothing failing.
   */
  readonly fields: readonly string[];
  readonly holds: (row: Row) => boolean;
}

function at(row: Row, path: string): unknown {
  if (!path.includes(".")) return row[path];
  let current: unknown = row;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function has(row: Row, path: string): boolean {
  if (!path.includes(".")) return path in row;
  const parts = path.split(".");
  let current: unknown = row;
  for (const part of parts.slice(0, -1)) {
    if (typeof current !== "object" || current === null) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "object" && current !== null && parts.at(-1)! in current;
}

const isNull = (value: unknown): boolean => value === null || value === undefined;

/** `column = ANY (ARRAY[...])` — a closed vocabulary. */
function vocabulary(field: string, allowed: readonly string[], constraint: string): CheckRule {
  return {
    constraint,
    fields: [field],
    holds: (row) => allowed.includes(String(at(row, field))),
  };
}

/** `column ~ '...'` — a format the database refuses to store anything else in. */
function format(field: string, pattern: RegExp, constraint: string): CheckRule {
  return {
    constraint,
    fields: [field],
    holds: (row) => {
      const value = at(row, field);
      return isNull(value) || pattern.test(String(value));
    },
  };
}

/** `column <> ''` — null is allowed where the column is nullable. */
function notEmpty(field: string, constraint: string): CheckRule {
  return {
    constraint,
    fields: [field],
    holds: (row) => {
      const value = at(row, field);
      return isNull(value) || String(value) !== "";
    },
  };
}

/**
 * `length(trim(column)) > 0` — stricter than `<> ''`, and a different rule.
 *
 * A separate helper rather than a flag on `notEmpty` because the schema writes
 * both forms and means both: `principal.service_name <> ''` accepts a space,
 * `length(trim(plan_grant.feature_key)) > 0` does not. One helper covering both
 * would have to pick, and picking would make one of the two restatements wrong.
 */
function present(field: string, constraint: string): CheckRule {
  return {
    constraint,
    fields: [field],
    holds: (row) => {
      const value = at(row, field);
      return isNull(value) || String(value).trim().length > 0;
    },
  };
}

function numeric(
  field: string,
  constraint: string,
  ok: (value: number) => boolean,
  nullable = false,
): CheckRule {
  return {
    constraint,
    fields: [field],
    holds: (row) => {
      const value = at(row, field);
      if (isNull(value)) return nullable;
      return typeof value === "number" && Number.isFinite(value) && ok(value);
    },
  };
}

function rule(
  constraint: string,
  fields: readonly string[],
  holds: (row: Row) => boolean,
): CheckRule {
  return { constraint, fields, holds };
}

/**
 * Closed vocabularies, once each.
 *
 * These are the runtime half of a union that TypeScript only enforces at compile
 * time. A status arriving in an HTTP body or an external event payload is a
 * `string` until something checks it, and until this file existed nothing did on
 * the reference backend.
 */
export const VOCABULARIES = {
  actor_type: ["principal", "system", "service"],
  geo_status: ["active", "inactive"],
  identity_status: ["active", "suspended", "merged"],
  organization_status: ["active", "suspended"],
  channel_type: ["telegram", "phone", "email", "web", "partner_api"],
  notification_channel: ["telegram", "email", "phone"],
  notification_status: ["pending", "processing", "accepted", "delivered", "failed"],
  outbox_status: ["pending", "published", "dead"],
  inbound_status: ["pending", "processed", "dead"],
  delivery_status: ["pending", "delivered", "dead"],
  wallet_owner_type: ["identity", "organization"],
  wallet_status: ["active", "frozen", "closed"],
  authorization_status: ["authorized", "captured", "partially_captured", "voided"],
  ledger_kind: ["credit", "capture", "refund"],
  fulfillment_status: ["coordinating", "dispatched", "completed", "failed", "cancelled"],
  settlement_state: ["none", "held", "captured", "partially_captured", "released", "unsettled"],
  plan_status: ["draft", "active", "retired"],
  billing_interval: ["day", "week", "month", "year"],
  subscription_owner_type: ["identity", "organization"],
  subscription_status: ["active", "past_due", "cancelled", "expired"],
  period_status: ["pending", "settled", "uncollectible", "voided"],
  reputation_kind: [
    "service_rating",
    "completion",
    "cancellation",
    "dispute",
    "compliment",
    "complaint",
  ],
  reputation_subject_type: ["identity", "organization"],
} as const satisfies Record<string, readonly string[]>;

const CURRENCY = /^[A-Z]{3}$/;
const COUNTRY = /^[A-Z]{2}$/;

/**
 * Every rule, by table, named exactly as the schema names it.
 *
 * Constraints already restated inside a store — the money ceilings, the
 * subscription timestamp couplings, the reputation shape rules — are not
 * repeated here; `tests/check-parity.test.ts` probes those in place, so both
 * paths are measured and neither is duplicated.
 */
export const ROW_RULES = {
  audit_entry: [vocabulary("actor_type", VOCABULARIES.actor_type, "audit_entry_actor_type_check")],
  country: [
    format("country_code", COUNTRY, "country_country_code_check"),
    format("default_currency", CURRENCY, "country_default_currency_check"),
    vocabulary("status", VOCABULARIES.geo_status, "country_status_check"),
  ],
  region: [vocabulary("status", VOCABULARIES.geo_status, "region_status_check")],
  city: [
    numeric("latitude", "city_latitude_check", (v) => v >= -90 && v <= 90),
    numeric("longitude", "city_longitude_check", (v) => v >= -180 && v <= 180),
    vocabulary("status", VOCABULARIES.geo_status, "city_status_check"),
  ],
  service_area: [
    numeric("centre_latitude", "service_area_centre_latitude_check", (v) => v >= -90 && v <= 90),
    numeric("centre_longitude", "service_area_centre_longitude_check", (v) => v >= -180 && v <= 180),
    // 500km, so an area cannot silently mean a country.
    numeric("radius_metres", "service_area_radius_metres_check", (v) => v > 0 && v <= 500_000),
    vocabulary("status", VOCABULARIES.geo_status, "service_area_status_check"),
  ],
  identity: [
    vocabulary("status", VOCABULARIES.identity_status, "identity_status_check"),
    // A merged identity without a survivor is a dead end: reads that follow the
    // merge chain would stop at a row that says "not me" and names no one else.
    rule(
      "identity_merged_requires_canonical",
      ["status", "canonical_identity_id"],
      (row) => at(row, "status") !== "merged" || !isNull(at(row, "canonical_identity_id")),
    ),
  ],
  identity_link: [
    vocabulary("channel_type", VOCABULARIES.channel_type, "identity_link_channel_type_check"),
  ],
  principal: [notEmpty("service_name", "principal_service_name_check")],
  membership: [
    rule(
      "membership_roles_check",
      ["roles"],
      (row) => Array.isArray(at(row, "roles")) && (at(row, "roles") as unknown[]).length >= 1,
    ),
  ],
  organization: [
    vocabulary("status", VOCABULARIES.organization_status, "organization_status_check"),
  ],
  wallet: [
    format("currency", CURRENCY, "wallet_currency_check"),
    vocabulary("owner_type", VOCABULARIES.wallet_owner_type, "wallet_owner_type_check"),
    vocabulary("status", VOCABULARIES.wallet_status, "wallet_status_check"),
  ],
  payment_authorization: [
    // A hold for nothing is not consent to anything.
    numeric("amount_minor", "payment_authorization_amount_minor_check", (v) => v > 0),
    format("currency", CURRENCY, "payment_authorization_currency_check"),
    vocabulary("status", VOCABULARIES.authorization_status, "payment_authorization_status_check"),
  ],
  ledger_transaction: [vocabulary("kind", VOCABULARIES.ledger_kind, "ledger_transaction_kind_check")],
  ledger_entry: [
    // A zero entry is not a movement; it is a row that makes a balanced
    // transaction look like it did something.
    numeric("amount_minor", "ledger_entry_amount_minor_check", (v) => v !== 0),
    format("currency", CURRENCY, "ledger_entry_currency_check"),
  ],
  fulfillment: [
    vocabulary("status", VOCABULARIES.fulfillment_status, "fulfillment_status_check"),
    vocabulary(
      "settlement_state",
      VOCABULARIES.settlement_state,
      "fulfillment_settlement_state_check",
    ),
    // Coordination status and money state are one fact told twice, so the schema
    // pins the pairs that can coexist: work still being arranged cannot have
    // money already taken, and finished work cannot still be holding it.
    rule(
      "fulfillment_settlement_alignment_check",
      ["status", "settlement_state"],
      (row) => {
        const status = String(at(row, "status"));
        const settlement = String(at(row, "settlement_state"));
        const allowed: Record<string, readonly string[]> = {
          coordinating: ["none", "held"],
          dispatched: ["none", "held"],
          completed: ["none", "captured", "partially_captured", "unsettled"],
          failed: ["none", "released", "partially_captured", "unsettled"],
          cancelled: ["none", "released", "partially_captured", "unsettled"],
        };
        return (allowed[status] ?? []).includes(settlement);
      },
    ),
    rule(
      "fulfillment_execution_after_cancellation_check",
      ["executed_after_cancellation_at", "executed_after_cancellation_job_reference"],
      (row) =>
        isNull(at(row, "executed_after_cancellation_at")) ===
        isNull(at(row, "executed_after_cancellation_job_reference")),
    ),
    rule(
      "fulfillment_execution_after_cancellation_status_check",
      ["executed_after_cancellation_at", "status"],
      (row) =>
        isNull(at(row, "executed_after_cancellation_at")) || at(row, "status") === "cancelled",
    ),
  ],
  outbox: [
    vocabulary("status", VOCABULARIES.outbox_status, "outbox_status_check"),
    numeric("event.version", "outbox_version_check", (v) => v >= 1),
    numeric("reclaims", "outbox_reclaims_check", (v) => v >= 0),
    // A claim is only meaningful on work still to do, and a fencing token
    // without a claim would authorise an acknowledgement nobody is holding.
    rule(
      "outbox_claim_check",
      ["claimed_at", "status"],
      (row) => isNull(at(row, "claimed_at")) || at(row, "status") === "pending",
    ),
    rule(
      "outbox_claim_token_check",
      ["claim_token", "claimed_at"],
      (row) => isNull(at(row, "claim_token")) || !isNull(at(row, "claimed_at")),
    ),
  ],
  inbound_event: [
    vocabulary("status", VOCABULARIES.inbound_status, "inbound_event_status_check"),
    numeric("event.version", "inbound_event_version_check", (v) => v >= 1),
    numeric("reclaims", "inbound_event_reclaims_check", (v) => v >= 0),
    rule(
      "inbound_event_claim_check",
      ["claimed_at", "status"],
      (row) => isNull(at(row, "claimed_at")) || at(row, "status") === "pending",
    ),
    rule(
      "inbound_event_claim_token_check",
      ["claim_token", "claimed_at"],
      (row) => isNull(at(row, "claim_token")) || !isNull(at(row, "claimed_at")),
    ),
  ],
  event_subscription: [
    notEmpty("endpoint_url", "event_subscription_endpoint_url_check"),
    notEmpty("signing_secret", "event_subscription_signing_secret_check"),
  ],
  event_delivery: [
    vocabulary("status", VOCABULARIES.delivery_status, "event_delivery_status_check"),
    numeric("reclaims", "event_delivery_reclaims_check", (v) => v >= 0),
    rule(
      "event_delivery_claim_check",
      ["claimed_at", "status"],
      (row) => isNull(at(row, "claimed_at")) || at(row, "status") === "pending",
    ),
    rule(
      "event_delivery_claim_token_check",
      ["claim_token", "claimed_at"],
      (row) => isNull(at(row, "claim_token")) || !isNull(at(row, "claimed_at")),
    ),
    // Delivered means a timestamp, and a timestamp means delivered. An
    // equivalence, not an implication, so neither half can drift alone.
    rule(
      "event_delivery_delivered_at_check",
      ["status", "delivered_at"],
      (row) => (at(row, "status") === "delivered") === !isNull(at(row, "delivered_at")),
    ),
  ],
  notification_recipient: [
    vocabulary("channel", VOCABULARIES.notification_channel, "notification_recipient_channel_check"),
    // CORE notifies about CORE's events. A subscription to someone else's
    // event type would never match anything and would misreport why.
    rule("notification_recipient_event_type_check", ["event_type"], (row) =>
      String(at(row, "event_type")).startsWith("core."),
    ),
  ],
  notification: [
    vocabulary("channel", VOCABULARIES.notification_channel, "notification_channel_check"),
    vocabulary("status", VOCABULARIES.notification_status, "notification_status_check"),
    notEmpty("address", "notification_address_check"),
    notEmpty("body", "notification_body_check"),
    // Only a failed message may lack an address: everything else was, or is
    // about to be, sent somewhere.
    rule(
      "notification_address_when_failed_check",
      ["address", "status"],
      (row) => !isNull(at(row, "address")) || at(row, "status") === "failed",
    ),
    rule(
      "notification_claim_check",
      ["status", "claim_token"],
      (row) => (at(row, "status") === "processing") === !isNull(at(row, "claim_token")),
    ),
    rule("notification_accepted_check", ["status", "accepted_at"], (row) => {
      const accepted = at(row, "status") === "accepted" || at(row, "status") === "delivered";
      return accepted === !isNull(at(row, "accepted_at"));
    }),
    rule(
      "notification_delivered_check",
      ["status", "delivered_at"],
      (row) => (at(row, "status") === "delivered") === !isNull(at(row, "delivered_at")),
    ),
    rule(
      "notification_failed_check",
      ["status", "failed_at"],
      (row) => (at(row, "status") === "failed") === !isNull(at(row, "failed_at")),
    ),
  ],
  plan: [
    vocabulary("status", VOCABULARIES.plan_status, "plan_status_check"),
    vocabulary("billing_interval", VOCABULARIES.billing_interval, "plan_interval_check"),
  ],
  subscription: [
    vocabulary("owner_type", VOCABULARIES.subscription_owner_type, "subscription_owner_type_check"),
    vocabulary("status", VOCABULARIES.subscription_status, "subscription_status_check"),
  ],
  subscription_period: [
    vocabulary("status", VOCABULARIES.period_status, "subscription_period_status_check"),
  ],
  plan_grant: [
    present("feature_key", "plan_grant_feature_key_present"),
    numeric("limit_value", "plan_grant_limit_non_negative", (v) => v >= 0, true),
  ],
  usage_record: [
    present("feature_key", "usage_record_feature_key_present"),
    // Zero usage is not usage; a row saying nothing happened still bills as a
    // row that did.
    numeric("quantity", "usage_record_quantity_positive", (v) => v > 0),
    present("usage_reference", "usage_record_reference_present"),
  ],
  /**
   * No `CHECK` in the schema, and an entry here anyway.
   *
   * `ROW_RULES` is the set of tables a reference store writes through `putRow`,
   * and `putRow` is now also where foreign keys are enforced. `session` has one
   * — `session_principal_id_fkey` — so it has to be writable through this path;
   * an empty rule list is the honest way to say the table has no `CHECK` rather
   * than that nobody looked.
   */
  session: [],
  reputation_signal: [
    vocabulary("signal_kind", VOCABULARIES.reputation_kind, "reputation_signal_kind_check"),
    vocabulary(
      "subject_type",
      VOCABULARIES.reputation_subject_type,
      "reputation_signal_subject_type_check",
    ),
  ],
} as const satisfies Record<string, readonly CheckRule[]>;

export type RuledTable = keyof typeof ROW_RULES;

/** Every constraint this file enforces, for the coverage check in the tests. */
export function ruledConstraints(): readonly string[] {
  return Object.values(ROW_RULES as Record<string, readonly CheckRule[]>).flatMap((rules) =>
    rules.map((r) => r.constraint),
  );
}

/**
 * Refuses a row the database would refuse, quoting the rule that refuses it.
 *
 * Synchronous by construction: a reference store runs on one thread, so a check
 * and the write it guards are atomic only while no `await` separates them. Call
 * it immediately before the write.
 */
export function assertRow(table: RuledTable, row: Row): void {
  for (const check of ROW_RULES[table] as readonly CheckRule[]) {
    for (const field of check.fields) {
      if (!has(row, field)) {
        // Not a constraint violation: the rule cannot be evaluated at all. Loud
        // on purpose, because the alternative is a rule that reads `undefined`,
        // passes, and enforces nothing after a column is renamed.
        throw new Error(
          `row rule "${check.constraint}" reads "${field}", which relation "${table}" no longer has`,
        );
      }
    }
    if (!check.holds(row)) {
      throw new Error(
        `new row for relation "${table}" violates check constraint "${check.constraint}"`,
      );
    }
  }
}

/**
 * Writes a row into a reference-store map, refusing what the database refuses.
 *
 * The stores keep rows in `Map`s, and a `Map.set` accepts anything. Routing
 * every write through here is what makes the rules above unavoidable rather
 * than advisory: a new transition added to a store cannot forget to check,
 * because the only way it stores a row is this function.
 */
export function putRow<T>(table: RuledTable, map: Map<string, T>, key: string, row: T): void {
  assertRow(table, row as unknown as Row);
  // Foreign keys read another table, so they need the bundle the map belongs to
  // rather than the row alone. Looked up from the map instead of passed in, so
  // that adding referential enforcement changed no call site: every existing
  // write got it, including the ones written before this cycle existed.
  assertReferences(table, row as unknown as Row, registryFor(map));
  map.set(key, row);
}
