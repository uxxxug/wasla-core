/**
 * The schema's triggers, restated once, for the reference backend.
 *
 * The fourth and last family of B-12. Uniqueness (24 rules), `CHECK`
 * constraints (100) and foreign keys (30) are all declarative statements about
 * **a row**, which is why each of them could be closed by one predicate table
 * called from one write path. A trigger is not that. The live schema installs
 * **12**, and they do three things a row predicate cannot:
 *
 * 1. **Judge a transition.** `plan_terms_immutable` refuses a change from one
 *    legal row to another legal row: nothing about the new plan is wrong, it is
 *    wrong *given what the plan was*. So a rule here reads `previous` as well
 *    as `next`.
 * 2. **Read another table.** `subscription_currency_check` compares the plan's
 *    currency with the wallet's; `usage_record_within_period` compares a usage
 *    record with its period's window. Those rows live in other stores, so the
 *    rules read them through the same bundle registry the foreign keys use —
 *    one mechanism, not two.
 * 3. **Run at commit.** Four of the twelve are `CONSTRAINT TRIGGER ...
 *    DEFERRABLE INITIALLY DEFERRED`, because the rows they compare are written
 *    in one transaction and either order is legitimate. Those four cannot be
 *    enforced from a write path at all, and they are not declared here as if
 *    they were: they are recorded in `DEFERRED_TRIGGERS` with the store that
 *    defers them onto the transaction journal, and the parity suite asserts
 *    they refuse at the commit point rather than at the write.
 *
 * What this file therefore is: the **inventory** of all twelve, plus the
 * enforcement of the immediate ones. `TRIGGER_INVENTORY` names every trigger
 * exactly once and says where it is enforced — as an immediate rule below, as a
 * deferred check in a named store, or as an exemption with a stated reason. The
 * parity suite reads `pg_trigger` at run time and fails if the schema installs a
 * trigger this inventory does not account for, so a migration cannot add one
 * and leave the reference backend permissive.
 *
 * **Insert versus update.** A reference store writes through `putRow`, which
 * sees only "is there already a row under this key". A repeated insert is
 * therefore read as an update. That is strictly stricter and never more
 * permissive: Postgres refuses a repeated insert too, as a primary-key
 * violation — a different family's refusal, not a missing one. Recorded here
 * because a reader comparing wording between the two backends will meet it.
 *
 * **The weakening, inherited and named.** A rule that reads another table can
 * only be evaluated if that table is registered with the bundle. When it is
 * not — a store built alone in a unit test — the rule is skipped, exactly as a
 * foreign key is. It is measured the same way: `tests/trigger-parity.test.ts`
 * probes every trigger against the `memoryPersistence` bundle and asserts that
 * no immediate rule has an unresolved read, so a new store that forgets to
 * register a table fails the suite instead of quietly enforcing nothing.
 */
import type { Row } from "./row-rules.js";
import type { ReferenceKeys } from "./reference-keys.js";

/** The operation the reference write path can produce. */
export type TransitionOp = "insert" | "update";

/** A reader for a row in another table, live from its owning store's map. */
export type ParentReader = (table: string, key: string) => Row | undefined;

/**
 * One trigger, as a refusal over (operation, previous row, next row).
 *
 * `refusal` returns the message Postgres raises, or `undefined` when the
 * transition is permitted. Returning the message rather than throwing keeps the
 * rule a pure statement about the transition, so the same declaration can be
 * read by the inventory gate without being run.
 */
export interface TransitionRule {
  /** The trigger name in the schema. Quoted in the refusal's audit trail. */
  readonly trigger: string;
  /** Which operations it judges. */
  readonly on: readonly TransitionOp[];
  /**
   * Other tables it reads. A rule whose reads are not all registered with the
   * bundle is skipped rather than evaluated against absent rows — the named
   * weakening, asserted absent for the real bundle by the parity suite.
   */
  readonly reads: readonly string[];
  refusal(
    op: TransitionOp,
    next: Row,
    previous: Row | undefined,
    parent: ParentReader,
  ): string | undefined;
}

const text = (row: Row, field: string): string => String(row[field]);
const num = (row: Row, field: string): number => Number(row[field]);

/**
 * `plan_terms_immutable` (migration 0010), `BEFORE UPDATE ON plan`.
 *
 * Three separate refusals in one trigger, and they are different statements:
 * a retired plan is a closed book, a plan that has been offered cannot go back
 * to draft, and an offered plan's commercial terms cannot move because periods
 * have already been priced from them.
 */
const planTermsImmutable: TransitionRule = {
  trigger: "plan_terms_immutable",
  on: ["update"],
  reads: [],
  refusal(_op, next, previous) {
    if (!previous) return undefined;
    const was = text(previous, "status");
    const now = text(next, "status");
    const id = text(next, "plan_id");
    if (was === "retired" && now !== "retired") {
      return `plan ${id} is retired and cannot return to ${now}`;
    }
    if (now === "draft" && was !== "draft") {
      return `plan ${id} has been offered and cannot return to draft`;
    }
    if (was === "draft") return undefined;
    const moved =
      text(previous, "code") !== text(next, "code") ||
      text(previous, "currency") !== text(next, "currency") ||
      num(previous, "amount_minor") !== num(next, "amount_minor") ||
      text(previous, "billing_interval") !== text(next, "billing_interval") ||
      num(previous, "interval_count") !== num(next, "interval_count");
    return moved
      ? `plan ${id} is ${was}; its commercial terms cannot change because periods have already been priced from them - publish a new plan instead`
      : undefined;
  },
};

/**
 * `plan_grant_immutable`, `BEFORE INSERT OR UPDATE OR DELETE ON plan_grant`.
 *
 * Grants freeze with the plan: once it has been offered, its entitlements
 * cannot move, because usage has already been measured against them. A grant
 * whose plan does not exist is left to `plan_grant_plan_id_fkey`, which runs
 * first — the trigger itself returns without refusing in that case, and so does
 * this.
 */
const planGrantImmutable: TransitionRule = {
  trigger: "plan_grant_immutable",
  on: ["insert", "update"],
  reads: ["plan"],
  refusal(_op, next, _previous, parent) {
    const planId = text(next, "plan_id");
    const plan = parent("plan", planId);
    if (!plan) return undefined;
    const status = text(plan, "status");
    if (status === "draft") return undefined;
    return `plan ${planId} is ${status}; its grants cannot change because usage has already been measured against them - publish a new plan instead`;
  },
};

/**
 * `subscription_currency_check`, `BEFORE INSERT OR UPDATE ON subscription`.
 *
 * Until this cycle this trigger was restated **nowhere** in `src/`. The
 * service refused both of its cases, which is not the same thing: every test
 * that went through the repository accepted a subscription Postgres refuses,
 * and a caller reaching the store by any other path had nothing between a
 * currency mismatch and the ledger.
 *
 * Two refusals, and the second only on insert. A plan that has been retired
 * keeps its existing subscriptions running — the trigger refuses *new* ones —
 * so an update is judged on currency alone.
 */
const subscriptionCurrencyCheck: TransitionRule = {
  trigger: "subscription_currency_check",
  on: ["insert", "update"],
  reads: ["plan", "wallet"],
  refusal(op, next, _previous, parent) {
    const planId = text(next, "plan_id");
    const plan = parent("plan", planId);
    const wallet = parent("wallet", text(next, "wallet_id"));
    // A missing parent is a foreign key's refusal, not this one's. Postgres
    // reaches the same outcome from the other direction: the key is immediate
    // and refuses before the trigger's `SELECT` ever runs.
    if (!plan || !wallet) return undefined;
    const planCurrency = text(plan, "currency").trim();
    const walletCurrency = text(wallet, "currency").trim();
    if (planCurrency !== walletCurrency) {
      return `subscription ${text(next, "subscription_id")} bills a ${planCurrency} plan against a ${walletCurrency} wallet`;
    }
    const status = text(plan, "status");
    if (op === "insert" && status !== "active") {
      return `plan ${planId} is ${status}, so it cannot be subscribed to`;
    }
    return undefined;
  },
};

/**
 * `usage_record_within_period`, `BEFORE INSERT ON usage_record`.
 *
 * Usage is metered against a period, so a record outside that period's window
 * would be counted in an invoice it does not belong to, and a voided period
 * cannot accrue anything at all. The comparison needs the parent row, which is
 * why this rule declares its read: the foreign key runs first and has already
 * refused a record whose period does not exist.
 */
const usageWithinPeriod: TransitionRule = {
  trigger: "usage_record_within_period",
  on: ["insert"],
  reads: ["subscription_period"],
  refusal(_op, next, _previous, parent) {
    const periodId = text(next, "period_id");
    const period = parent("subscription_period", periodId);
    if (!period) return undefined;
    if (text(period, "status") === "voided") {
      return `period ${periodId} was voided and cannot accrue usage`;
    }
    const at = Date.parse(text(next, "recorded_at"));
    const starts = Date.parse(text(period, "starts_at"));
    const ends = Date.parse(text(period, "ends_at"));
    if (at < starts || at >= ends) {
      return `usage recorded at ${text(next, "recorded_at")} falls outside period ${periodId} (${text(period, "starts_at")} to ${text(period, "ends_at")})`;
    }
    return undefined;
  },
};

/**
 * `reputation_signal_append_only`, `BEFORE UPDATE OR DELETE ON
 * reputation_signal`.
 *
 * The only update the port can express is the retraction marker, and both
 * backends narrow it on `retracted_at is null`, so the *stale* path never
 * reaches the trigger in either. The rule is declared anyway, for the writes a
 * future caller could express: a second retraction, an un-retraction, or a
 * change to any field that is not the marker.
 */
const reputationAppendOnly: TransitionRule = {
  trigger: "reputation_signal_append_only",
  on: ["update"],
  reads: [],
  refusal(_op, next, previous) {
    if (!previous) return undefined;
    const id = text(previous, "reputation_signal_id");
    if (previous["retracted_at"] !== null && previous["retracted_at"] !== undefined) {
      return `reputation signal ${id} was already retracted at ${text(previous, "retracted_at")}; a retraction is single-valued`;
    }
    const frozen = [
      "reputation_signal_id",
      "organization_id",
      "subject_type",
      "subject_id",
      "signal_kind",
      "rating_value",
      "source_system",
      "source_reference",
      "occurred_at",
      "recorded_at",
      "correlation_id",
    ];
    if (frozen.some((field) => previous[field] !== next[field])) {
      return "reputation_signal is append-only; only the retraction marker may be written after insert";
    }
    if (next["retracted_at"] === null || next["retracted_at"] === undefined) {
      return "a reputation signal may not be un-retracted";
    }
    return undefined;
  },
};

/** The immediate triggers, by the table they fire on. */
export const TRANSITION_RULES: Readonly<Record<string, readonly TransitionRule[]>> = {
  plan: [planTermsImmutable],
  plan_grant: [planGrantImmutable],
  subscription: [subscriptionCurrencyCheck],
  usage_record: [usageWithinPeriod],
  reputation_signal: [reputationAppendOnly],
};

/**
 * Where each trigger is accounted for.
 *
 * `immediate` — declared in `TRANSITION_RULES` above and enforced by `putRow`.
 * `deferred` — a constraint trigger; the reference backend defers it onto the
 * transaction journal in the named store, so it refuses at the commit point the
 * way Postgres does.
 * `exempt` — no caller can express the write it refuses, with the reason.
 */
export type TriggerEnforcement =
  | { readonly kind: "immediate"; readonly table: string }
  | { readonly kind: "deferred"; readonly table: string; readonly deferredIn: string }
  | { readonly kind: "exempt"; readonly table: string; readonly why: string };

export const TRIGGER_INVENTORY: Readonly<Record<string, TriggerEnforcement>> = {
  plan_terms_immutable: { kind: "immediate", table: "plan" },
  plan_grant_immutable: { kind: "immediate", table: "plan_grant" },
  subscription_currency_check: { kind: "immediate", table: "subscription" },
  usage_record_within_period: { kind: "immediate", table: "usage_record" },
  reputation_signal_append_only: { kind: "immediate", table: "reputation_signal" },
  ledger_transaction_balance: {
    kind: "deferred",
    table: "ledger_entry",
    deferredIn: "InMemoryMoneyRepository.insertTransaction, via assertBalanced",
  },
  ledger_transaction_agrees_with_authorization: {
    kind: "deferred",
    table: "ledger_transaction",
    deferredIn: "InMemoryMoneyRepository.deferLedgerAgreement",
  },
  payment_authorization_agrees_with_ledger: {
    kind: "deferred",
    table: "payment_authorization",
    deferredIn: "InMemoryMoneyRepository.deferLedgerAgreement",
  },
  subscription_period_money_agrees: {
    kind: "deferred",
    table: "subscription_period",
    deferredIn: "InMemorySubscriptionRepository.deferMoneyAgreement",
  },
  audit_entry_no_mutation: {
    kind: "exempt",
    table: "audit_entry",
    why: "the audit port is `record` and two reads: there is no update and no delete to refuse, and adding one would be a port change that this exemption would fail",
  },
  ledger_entry_no_mutation: {
    kind: "exempt",
    table: "ledger_entry",
    why: "entries are written only as part of the transaction that holds them, and the port has no operation that touches an entry afterwards",
  },
  usage_record_append_only: {
    kind: "exempt",
    table: "usage_record",
    why: "the subscription port has no updateUsage and no deleteUsage at all — the strongest form of append-only, since the operation cannot be expressed; a repeated insert is refused by the primary key, which is the uniqueness family's rule and not this trigger's",
  },
};

/** Every trigger name the reference backend claims to account for. */
export function inventoriedTriggers(): readonly string[] {
  return Object.keys(TRIGGER_INVENTORY).sort();
}

/**
 * Immediate rules whose reads no store registered with this bundle.
 *
 * Each one is a trigger this bundle cannot evaluate. Asserted empty for
 * `memoryPersistence` by the parity suite, which is what keeps the fail-open
 * case confined to stores deliberately built in isolation.
 */
export function unresolvedReads(keys: ReferenceKeys): readonly string[] {
  const missing = new Set<string>();
  for (const rules of Object.values(TRANSITION_RULES)) {
    for (const rule of rules) {
      for (const table of rule.reads) {
        if (!keys.knows(table)) missing.add(`${rule.trigger} reads ${table}`);
      }
    }
  }
  return [...missing].sort();
}

/**
 * Refuses a transition the schema's triggers refuse.
 *
 * Called from `putRow` with the row already in hand and the previous row read
 * from the same map, so a store gets trigger parity by writing through the one
 * path — the property that made the check and foreign-key families hold for
 * every table rather than for the ones someone remembered.
 */
export function assertTransition(
  table: string,
  previous: Row | undefined,
  next: Row,
  keys: ReferenceKeys | undefined,
): void {
  const rules = TRANSITION_RULES[table];
  if (!rules) return;
  const op: TransitionOp = previous === undefined ? "insert" : "update";
  const parent: ParentReader = (parentTable, key) => keys?.row(parentTable, key);
  for (const rule of rules) {
    if (!rule.on.includes(op)) continue;
    // See the header: a rule that cannot read what it judges says nothing,
    // rather than judging an absent row as if it were an empty one.
    if (rule.reads.some((read) => !keys?.knows(read))) continue;
    const refusal = rule.refusal(op, next, previous, parent);
    if (refusal !== undefined) throw new Error(refusal);
  }
}
