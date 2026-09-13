/**
 * What the schema does when a referenced row is deleted, and the three places
 * CORE deletes a row at all.
 *
 * The four parity cycles — uniqueness, checks, foreign keys, triggers — each
 * closed a family of rules about rows that exist, and each ended with the same
 * sentence in its "what this cycle did not do": the reference backend does not
 * model referential actions, and the delete halves of the append-only triggers
 * are *unreachable* rather than enforced. Unreachable is a fact about today's
 * ports, and nothing in the repository kept it true. This file is what keeps it
 * true.
 *
 * Two declarations, both checked against the live catalog rather than trusted:
 *
 * 1. `REFERENTIAL_ACTIONS` — the `ON DELETE` and `ON UPDATE` action of every
 *    foreign key. 29 of the 30 are `NO ACTION`, which the reference backend
 *    models correctly by doing nothing: a delete that would orphan a child is
 *    refused by the database, and in memory there is no delete to refuse.
 *    Exactly one is `CASCADE`, and it is declared as **not modelled**, with the
 *    reason it does not need to be.
 * 2. `DELETE_PATHS` — every place in `src/` that removes a row, with the reason
 *    each is safe. "Safe" is not an opinion here: it means the table it touches
 *    is neither the parent nor the child of any foreign key and carries no
 *    trigger, which `tests/delete-parity.test.ts` asserts against
 *    `pg_constraint` and `pg_trigger`.
 *
 * What this file deliberately does **not** do is add a delete path. CORE's
 * audit entries, ledger entries, usage records and reputation signals are
 * append-only by design and the schema has triggers saying so; the work here is
 * to make that design enforced, not to weaken it so a cascade becomes
 * observable.
 */

/** The referential actions Postgres can take, as the catalog spells them. */
export type ReferentialAction = "no action" | "restrict" | "cascade" | "set null" | "set default";

/** `pg_constraint.confdeltype` / `confupdtype` → the action it stands for. */
export const ACTION_CODES: Readonly<Record<string, ReferentialAction>> = {
  a: "no action",
  r: "restrict",
  c: "cascade",
  n: "set null",
  d: "set default",
};

export interface ReferentialActionRule {
  readonly onDelete: ReferentialAction;
  readonly onUpdate: ReferentialAction;
  /**
   * Whether the reference backend reproduces the action.
   *
   * `true` is only honest for an action the reference backend can actually
   * take. `false` requires `why`, and the parity suite additionally requires
   * that no delete path reaches the parent table — an unmodelled action that a
   * caller could trigger is a difference between the backends, not an
   * exemption.
   */
  readonly modelled: boolean;
  readonly why?: string;
}

/**
 * The action of every foreign key in the schema.
 *
 * `NO ACTION` is not "nothing happens": it is the database refusing a delete
 * that would leave a child pointing at nothing. The reference backend matches
 * that by construction, because it offers no way to delete the parent — which
 * is precisely the claim the delete-path gates below make enforceable.
 */
const NO_ACTION: ReferentialActionRule = {
  onDelete: "no action",
  onUpdate: "no action",
  modelled: true,
};

export const REFERENTIAL_ACTIONS: Readonly<Record<string, ReferentialActionRule>> = {
  // ---- geography ---------------------------------------------------------
  region_country_code_fkey: NO_ACTION,
  city_country_code_fkey: NO_ACTION,
  city_region_id_fkey: NO_ACTION,
  service_area_city_id_fkey: NO_ACTION,
  service_area_country_code_fkey: NO_ACTION,

  // ---- identity ----------------------------------------------------------
  identity_canonical_identity_id_fkey: NO_ACTION,
  identity_link_identity_id_fkey: NO_ACTION,
  principal_identity_id_fkey: NO_ACTION,
  session_principal_id_fkey: NO_ACTION,
  membership_principal_id_fkey: NO_ACTION,
  membership_organization_id_fkey: NO_ACTION,

  // ---- money -------------------------------------------------------------
  payment_authorization_wallet_id_fkey: NO_ACTION,
  ledger_transaction_authorization_id_fkey: NO_ACTION,
  ledger_entry_transaction_id_fkey: NO_ACTION,

  // ---- subscriptions -----------------------------------------------------
  subscription_plan_id_fkey: NO_ACTION,
  subscription_wallet_id_fkey: NO_ACTION,
  subscription_period_subscription_id_fkey: NO_ACTION,
  subscription_period_authorization_id_fkey: NO_ACTION,
  usage_record_period_id_fkey: NO_ACTION,
  plan_grant_plan_id_fkey: {
    onDelete: "cascade",
    onUpdate: "no action",
    modelled: false,
    why: "the only non-default action in the schema, and the reference backend models no cascade at all. It does not have to: a cascade is only observable if a plan can be deleted, and no port operation deletes a plan — `SubscriptionRepository` offers insertPlan, updatePlan and three reads. The parity suite asserts that absence rather than restating this sentence, so adding a plan delete fails here instead of silently diverging. Note also what the schema is saying: grants belong to the plan and have no life without it, which is why the cascade is right in SQL and why the immutability trigger, not a delete, is what protects them while the plan is offered.",
  },

  // ---- fulfillment -------------------------------------------------------
  fulfillment_organization_id_fkey: NO_ACTION,
  fulfillment_payment_authorization_id_fkey: NO_ACTION,

  // ---- eventing ----------------------------------------------------------
  event_delivery_event_id_fkey: NO_ACTION,
  event_delivery_subscription_id_fkey: NO_ACTION,

  // ---- notifications -----------------------------------------------------
  notification_recipient_identity_id_fkey: NO_ACTION,
  notification_recipient_organization_id_fkey: NO_ACTION,
  notification_recipient_id_fkey: NO_ACTION,
  notification_organization_id_fkey: NO_ACTION,
  notification_event_id_fkey: NO_ACTION,

  // ---- reputation --------------------------------------------------------
  reputation_signal_organization_id_fkey: NO_ACTION,
};

/**
 * Every place in `src/` a row is removed, and why each one is safe.
 *
 * Three, measured by reading the source rather than by recalling it. Safety
 * here has a testable meaning: the table is neither a foreign-key parent nor a
 * child, and carries no trigger — so there is nothing to cascade, nothing to
 * orphan, and no append-only rule to break.
 */
export interface DeletePath {
  /** The table the row is removed from. */
  readonly table: string;
  /** Where in the source, for a reader who wants to check the claim. */
  readonly where: readonly string[];
  /** Why removing a row there cannot break a referential rule. */
  readonly why: string;
}

export const DELETE_PATHS: readonly DeletePath[] = [
  {
    table: "inbox",
    where: ["src/platform/eventing/pg-inbox.ts", "src/platform/eventing/inbox.ts"],
    why: "releasing a consumer's claim on an event it failed to handle, so the next delivery can claim it again. The inbox is a claim ledger keyed by (consumer, event_id) and nothing references it: it is neither a parent nor a child of any foreign key and has no trigger. Removing the claim is the operation — keeping the row would make a retry impossible, which is the opposite of the at-least-once guarantee.",
  },
  {
    table: "rate_limit_counter",
    where: ["src/platform/http/pg-rate-limit.ts", "src/platform/http/rate-limit.ts"],
    why: "pruning windows that have closed. A counter is derived, bounded and reconstructible from the next request; no key references it and no trigger fires on it. Keeping closed windows would grow the table without bound for no reader.",
  },
  {
    table: "*",
    where: ["src/platform/persistence/transaction.ts"],
    why: "`InMemoryTransactionBoundary` unwinding a write on rollback: a row the journal recorded as absent before the scope began is removed to restore that state. This is not a delete a caller can reach and it deletes nothing that existed at the start of the transaction, which is what makes the foreign-key registry safe to read live maps — a rolled-back parent stops satisfying a key at the moment it stops existing.",
  },
];

/**
 * Keys the schema declares that `FOREIGN_KEYS` does not restate.
 *
 * One, and it is not an oversight: `ledger_entry_transaction_id_fkey` is exempt
 * from the reference-backend rules because entries are not a row table of their
 * own there — `insertTransaction` takes the header with its entries nested — so
 * there is no map to declare a rule against. Its referential action still has
 * to be declared and still has to match the catalog, because a migration
 * turning it into `ON DELETE CASCADE` would change what the database does to
 * entries when a transaction is deleted whether or not the reference backend
 * has a rule for the key.
 */
export const KEYS_WITHOUT_A_REFERENCE_RULE: readonly string[] = [
  "ledger_entry_transaction_id_fkey",
];

/** Tables a delete path may touch, `*` excluded: it is the rollback path. */
export function deletableTables(): readonly string[] {
  return DELETE_PATHS.map((path) => path.table)
    .filter((table) => table !== "*")
    .sort();
}

/** Keys whose action the reference backend does not reproduce. */
export function unmodelledActions(): readonly string[] {
  return Object.entries(REFERENTIAL_ACTIONS)
    .filter(([, rule]) => !rule.modelled)
    .map(([constraint]) => constraint)
    .sort();
}
