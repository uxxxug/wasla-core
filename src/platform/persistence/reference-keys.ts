/**
 * The schema's `FOREIGN KEY` constraints, restated once, for the reference
 * backend.
 *
 * This is the third and last large family of B-12. The uniqueness cycle closed
 * 24 rules of one kind, the check-constraint cycle 100 of another, and both
 * left this one open: the live schema declares **30 foreign keys**, and exactly
 * one of them — `usage_record_period_id_fkey` — was restated anywhere in
 * `src/`. The other 29 were enforced by Postgres alone, so a dual-backend test
 * could store a fulfillment in no tenant, a membership for no principal, a
 * notification addressed to a recipient row that was never created, or a
 * delivery of an envelope the outbox never recorded — and pass on the reference
 * half while production refused every one of them.
 *
 * A foreign key is harder to restate than a `CHECK`, and the difference is the
 * reason this file exists rather than a few more entries in `ROW_RULES`: a
 * `CHECK` reads the row being written, while a foreign key reads **another
 * table**, which in the reference backend is another store's private `Map`. The
 * four designs considered:
 *
 * 1. **A reader function per child store**, the way `InMemorySubscriptionRepository`
 *    already receives `authorizationSnapshot` for the deferred money-agreement
 *    trigger. Correct, and it does not scale to 30 keys across nine stores: the
 *    composition root would wire 30 closures, and a store built without one
 *    would silently enforce nothing.
 * 2. **One shared row table** that every reference store writes into instead of
 *    its own `Map`. That is a rewrite of every store, and it would make the
 *    reference backend a small database — the thing it exists not to be.
 * 3. **A copy of each parent's keys**, updated on write. Two sources of truth
 *    for the same rows, and the copy is wrong the moment a rollback unwinds a
 *    write it does not know about.
 * 4. **A registry of the parents' own maps**, which is what shipped. Each
 *    reference store hands its `Map`s to the bundle's registry at construction;
 *    an existence check then reads the live map, so a row rolled back by
 *    `InMemoryTransactionBoundary` stops satisfying foreign keys at the moment
 *    it stops existing, with nothing to keep in step.
 *
 * Enforcement hangs off `putRow`, so it applies to every reference write rather
 * than the ones someone remembered — the same property the check-constraint
 * cycle relied on, and the reason the three tables that still wrote with a bare
 * `map.set` (`session`, `plan_grant`, `usage_record`) were routed through
 * `putRow` in the same cycle.
 *
 * **The one weakening, named rather than left to be discovered.** A store
 * constructed without a registry — `new InMemoryOutbox(clock)` in a unit test,
 * say — cannot evaluate a foreign key at all, and accepts the write. Likewise a
 * registry that holds no source for a parent table. Neither case can be a
 * compile error without making every store's constructor require the bundle,
 * and it is not left unmeasured either: `tests/fk-parity.test.ts` probes every
 * key against the `memoryPersistence` bundle, so a parent nobody registered
 * makes its probe accept the orphan row and fails the suite.
 */
import type { Row } from "./row-rules.js";

/** One schema foreign key, as the reference backend has to read it. */
export interface ForeignKeyRule {
  /** The constraint name in the schema. Quoted verbatim in the refusal. */
  readonly constraint: string;
  /** The child column carrying the reference. */
  readonly column: string;
  /** The table it must be found in. */
  readonly parent: string;
  /**
   * Whether the column is nullable in the schema.
   *
   * `MATCH SIMPLE` is Postgres' default: a null reference satisfies the
   * constraint, because it references nothing. Declared per rule rather than
   * assumed, so a null in a `NOT NULL` column is not quietly waved through here
   * as "no reference" — that row is refused by Postgres for a different reason,
   * and null-rejection parity is a separate family this cycle does not claim.
   */
  readonly nullable: boolean;
}

function fk(constraint: string, column: string, parent: string, nullable = false): ForeignKeyRule {
  return { constraint, column, parent, nullable };
}

/**
 * Every foreign key a reference store can be made to violate, by child table.
 *
 * `ledger_entry_transaction_id_fkey` is the one schema key with no entry, and
 * it is recorded as unprobeable in `tests/fk-parity.test.ts` rather than
 * omitted quietly: entries are written as part of the transaction that contains
 * them, and the reference entry record has no `transaction_id` field for a
 * caller to falsify.
 */
export const FOREIGN_KEYS = {
  region: [fk("region_country_code_fkey", "country_code", "country")],
  city: [
    fk("city_country_code_fkey", "country_code", "country"),
    fk("city_region_id_fkey", "region_id", "region"),
  ],
  service_area: [
    fk("service_area_city_id_fkey", "city_id", "city"),
    fk("service_area_country_code_fkey", "country_code", "country"),
  ],
  identity: [
    // Self-referencing: the survivor of a merge is an identity like any other,
    // and a merged row pointing at an identity that does not exist is a read
    // that follows the chain to nowhere.
    fk("identity_canonical_identity_id_fkey", "canonical_identity_id", "identity", true),
  ],
  identity_link: [fk("identity_link_identity_id_fkey", "identity_id", "identity")],
  principal: [fk("principal_identity_id_fkey", "identity_id", "identity")],
  session: [fk("session_principal_id_fkey", "principal_id", "principal")],
  membership: [
    fk("membership_organization_id_fkey", "organization_id", "organization"),
    fk("membership_principal_id_fkey", "principal_id", "principal"),
  ],
  payment_authorization: [fk("payment_authorization_wallet_id_fkey", "wallet_id", "wallet")],
  ledger_transaction: [
    fk("ledger_transaction_authorization_id_fkey", "authorization_id", "payment_authorization", true),
  ],
  fulfillment: [
    fk("fulfillment_organization_id_fkey", "organization_id", "organization"),
    fk(
      "fulfillment_payment_authorization_id_fkey",
      "payment_authorization_id",
      "payment_authorization",
      true,
    ),
  ],
  event_delivery: [
    fk("event_delivery_event_id_fkey", "event_id", "outbox"),
    fk("event_delivery_subscription_id_fkey", "subscription_id", "event_subscription"),
  ],
  notification_recipient: [
    fk("notification_recipient_identity_id_fkey", "identity_id", "identity"),
    // Nullable: a platform-wide recipient belongs to no tenant, which is how
    // `recipientsFor` fans out to operators as well as to a tenant's people.
    fk("notification_recipient_organization_id_fkey", "organization_id", "organization", true),
  ],
  notification: [
    fk("notification_event_id_fkey", "event_id", "outbox"),
    fk("notification_organization_id_fkey", "organization_id", "organization", true),
    fk("notification_recipient_id_fkey", "recipient_id", "notification_recipient"),
  ],
  plan_grant: [fk("plan_grant_plan_id_fkey", "plan_id", "plan")],
  subscription: [
    fk("subscription_plan_id_fkey", "plan_id", "plan"),
    fk("subscription_wallet_id_fkey", "wallet_id", "wallet"),
  ],
  subscription_period: [
    fk("subscription_period_subscription_id_fkey", "subscription_id", "subscription"),
    fk("subscription_period_authorization_id_fkey", "authorization_id", "payment_authorization", true),
  ],
  usage_record: [fk("usage_record_period_id_fkey", "period_id", "subscription_period")],
  reputation_signal: [fk("reputation_signal_organization_id_fkey", "organization_id", "organization")],
} as const satisfies Record<string, readonly ForeignKeyRule[]>;

/** Every foreign key this file enforces, for the coverage gate in the tests. */
export function foreignKeyConstraints(): readonly string[] {
  return Object.values(FOREIGN_KEYS as Record<string, readonly ForeignKeyRule[]>).flatMap((rules) =>
    rules.map((rule) => rule.constraint),
  );
}

/** Every parent table a rule reads, which is what a registry has to cover. */
export function referencedParents(): readonly string[] {
  return [
    ...new Set(
      Object.values(FOREIGN_KEYS as Record<string, readonly ForeignKeyRule[]>).flatMap((rules) =>
        rules.map((rule) => rule.parent),
      ),
    ),
  ].sort();
}

/**
 * Postgres' refusal for a named key, built from the declaration.
 *
 * For the few places that have to refuse an orphan *before* `putRow` runs,
 * because the code between the two reads the parent row: `insertUsage` compares
 * a usage record against its period's window, and there is nothing to compare
 * against when the period does not exist. Those sites quote the constraint by
 * name and get the wording from here, so the message stays in one place; the
 * lookup throws on an unknown name, so a renamed constraint is a loud failure
 * rather than a refusal nobody can trace back to the schema.
 */
export function foreignKeyRefusal(table: string, constraint: string): string {
  const rules = (FOREIGN_KEYS as Record<string, readonly ForeignKeyRule[]>)[table] ?? [];
  if (!rules.some((rule) => rule.constraint === constraint)) {
    throw new Error(`no foreign key "${constraint}" is declared on "${table}"`);
  }
  return `insert or update on table "${table}" violates foreign key constraint "${constraint}"`;
}

/** Tells a key apart from a row: the map's key is the table's primary key. */
type KeyedMap = { has(key: string): boolean };

/**
 * Which reference store holds which table, for one persistence bundle.
 *
 * Scoped to a bundle rather than to the process on purpose. A module-level
 * registry would need no wiring at all, and would let a parent row written by
 * one bundle satisfy a foreign key in another — two `memoryPersistence` bundles
 * in one test file are two independent databases, and a check that cannot tell
 * them apart accepts rows the corresponding Postgres run would refuse. That is
 * the defect this file exists to remove, so it is not reintroduced to save a
 * constructor argument.
 */
export class ReferenceKeys {
  private readonly tables = new Map<string, KeyedMap>();

  /**
   * Hands a store's map to the registry.
   *
   * Called once per table in a store's constructor, for child tables as well as
   * parents: the child registration is what links the map to this registry, and
   * `putRow` reads that link to find the rules to apply. A store whose maps are
   * never attached is a store with no registry, which is the documented
   * fail-open case.
   */
  attach(table: string, map: KeyedMap): void {
    this.tables.set(table, map);
    OWNERS.set(map, this);
  }

  /** Whether this bundle can answer existence for a table at all. */
  knows(table: string): boolean {
    return this.tables.has(table);
  }

  exists(table: string, key: string): boolean {
    return this.tables.get(table)?.has(key) ?? false;
  }

  /**
   * Parent tables `FOREIGN_KEYS` reads that no store attached.
   *
   * Every one of them is a foreign key this bundle cannot evaluate. Asserted
   * empty for `memoryPersistence` by the parity suite, which is what keeps the
   * fail-open case confined to stores deliberately built in isolation.
   */
  unresolvedParents(): readonly string[] {
    return referencedParents().filter((parent) => !this.knows(parent));
  }
}

/**
 * Map → the registry it was attached to.
 *
 * A `WeakMap` so a discarded bundle's stores are collectable, and so nothing
 * has to be unregistered: tests build and drop thousands of bundles.
 */
const OWNERS = new WeakMap<KeyedMap, ReferenceKeys>();

/** The registry a map belongs to, if its store was given one. */
export function registryFor(map: KeyedMap): ReferenceKeys | undefined {
  return OWNERS.get(map);
}

/**
 * Refuses a row whose reference names a parent that does not exist.
 *
 * Quotes Postgres' own wording so a reference-store stack trace and a
 * production stack trace read the same, and a test cannot pass because the
 * store refused the row for an unrelated reason.
 */
export function assertReferences(table: string, row: Row, keys: ReferenceKeys | undefined): void {
  if (!keys) return; // No registry: the rule cannot be evaluated. See the header.
  const rules = (FOREIGN_KEYS as Record<string, readonly ForeignKeyRule[]>)[table];
  if (!rules) return;
  for (const rule of rules) {
    if (!(rule.column in row)) {
      // Not a violation: the rule cannot be evaluated at all. Loud for the same
      // reason `assertRow` is loud about a missing field — a renamed column
      // would otherwise disable its foreign key with nothing failing.
      throw new Error(
        `foreign key "${rule.constraint}" reads "${rule.column}", which relation "${table}" no longer has`,
      );
    }
    const value = row[rule.column];
    if (value === null || value === undefined) {
      if (rule.nullable) continue;
      // A null in a `NOT NULL` column: Postgres refuses it, but as a null
      // violation and not as this rule. Left to the null family rather than
      // reported under a constraint that did not fire.
      continue;
    }
    if (!keys.knows(rule.parent)) continue; // See the header: unevaluable, not satisfied.
    if (!keys.exists(rule.parent, String(value))) {
      throw new Error(
        `insert or update on table "${table}" violates foreign key constraint "${rule.constraint}"`,
      );
    }
  }
}
