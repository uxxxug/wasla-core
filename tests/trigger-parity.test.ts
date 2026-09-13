/**
 * Every trigger in the schema, probed against both backends (B-12, milestone 16).
 *
 * The fourth and last family. Uniqueness closed 24 rules, the check
 * constraints 100, the foreign keys 30 — all of them statements about a row,
 * each closed by one predicate table read on one write path. The schema also
 * installs **12 triggers**, and they are a different kind of rule: they judge a
 * transition, they read other tables, and four of them run at commit. Before
 * this cycle five of the twelve were named anywhere in `src/`, and
 * `subscription_currency_check` — the one that keeps a plan priced in one
 * currency from being billed against a wallet in another — was restated in no
 * store at all, only in the service above it. A dual-backend test could
 * therefore create through the repository a subscription production refuses.
 *
 * Three kinds of case, because the twelve are not alike:
 *
 *   1. **Refusal probes.** A write that is valid in every other respect and
 *      illegal only as a transition. Both backends must refuse it, and the
 *      refusal must quote what Postgres says, so a reference-store stack trace
 *      and a production one read the same and a case cannot pass because a
 *      store refused the row for an unrelated reason. For the four deferred
 *      triggers the probe wraps the whole `boundary.run`, because the refusal
 *      belongs to the commit and not to the write — asserting it at the write
 *      would pass on the reference backend and fail on Postgres.
 *   2. **Outcome probes**, for a trigger whose guarded path both backends
 *      narrow away before it can fire. `retractIfStanding` filters on
 *      `retracted_at is null` in memory and in SQL, so a second retraction is
 *      never a write either backend refuses — it is a `stale` verdict. The
 *      parity that matters there is that both return the same verdict, which is
 *      what the probe asserts.
 *   3. **Exemptions**, for a trigger whose write no caller can express. Each
 *      one names the port operations that must stay absent, and the case
 *      asserts their absence, so "unreachable" is measured rather than
 *      asserted in prose: adding `updateUsage` to the port fails the exemption
 *      instead of quietly leaving the reference backend permissive.
 *
 * Four gates hold the file honest:
 *
 *   - `accounts for every trigger the live schema installs` reads `pg_trigger`
 *     and fails when a trigger has neither a case nor a recorded reason, so a
 *     migration cannot add one and leave the reference backend behind.
 *   - `agrees with the catalog about which triggers are deferred` reads
 *     `tgdeferrable`/`tginitdeferred`. Timing is not cosmetic: an immediate rule
 *     enforced from `putRow` is wrong for a constraint trigger, and a deferred
 *     one is wrong for an immediate trigger. A migration that changes the
 *     timing fails here.
 *   - `resolves every table an immediate rule reads` asserts the reference
 *     bundle registered a source for every table `TRANSITION_RULES` reads. This
 *     is the design's one weakening — an unregistered table is a trigger that
 *     cannot be evaluated — and it is measured, not trusted.
 *   - `records a reason for every exemption`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock, type Clock } from "../src/platform/clock.js";
import {
  memoryPersistence,
  postgresPersistence,
  type Persistence,
} from "../src/platform/persistence/backends.js";
import {
  TRANSITION_RULES,
  TRIGGER_INVENTORY,
  inventoriedTriggers,
  unresolvedReads,
} from "../src/platform/persistence/transition-rules.js";
import { NO_SCOPE } from "../src/platform/persistence/transaction.js";
import {
  LATER,
  NOW,
  period,
  plan,
  refuse,
  seedAuthorization,
  seedOrganization,
  signal,
  subscription,
  wallet,
  type Verdict,
} from "./support/rows.js";

const url = process.env.DATABASE_URL;

const TABLES = `reputation_signal, notification, notification_recipient, membership,
  session, principal, identity_link, identity, fulfillment, ledger_entry,
  ledger_transaction, payment_authorization, wallet, usage_record,
  subscription_period, subscription, plan_grant, plan, event_delivery,
  event_subscription, inbound_event, organization, outbox, inbox,
  idempotency_key, audit_entry, service_area, city, region`;

/** A write that must be refused, and the words the refusal must contain. */
interface RefusalProbe {
  readonly what: string;
  /** A substring of Postgres' own message. */
  readonly says: string;
  run(store: Persistence): Promise<Verdict>;
}

/** A path both backends narrow away, asserted to reach the same verdict. */
interface OutcomeProbe {
  readonly what: string;
  readonly expected: string;
  run(store: Persistence): Promise<string>;
}

interface TriggerCase {
  /** The trigger name in the schema. */
  readonly trigger: string;
  readonly refusals?: readonly RefusalProbe[];
  readonly outcomes?: readonly OutcomeProbe[];
  /**
   * Port operations that must not exist for an exemption to hold. Present only
   * on exempt triggers; the case asserts the absence rather than trusting it.
   */
  readonly absentOperations?: readonly { readonly port: keyof Persistence; readonly method: string }[];
}

/** A plan in a state `seedPlan` does not produce. */
async function seedPlanIn(
  store: Persistence,
  status: "draft" | "active" | "retired",
  currency = "SAR",
): Promise<string> {
  const row = plan();
  await store.subscription.insertPlan(
    {
      ...row,
      currency,
      status,
      activated_at: status === "draft" ? null : NOW,
      retired_at: status === "retired" ? NOW : null,
    },
    NO_SCOPE,
  );
  return row.plan_id;
}

/** A wallet in a currency of the caller's choosing. */
async function seedWalletIn(store: Persistence, currency: string): Promise<string> {
  const row = wallet();
  await store.money.insertWallet({ ...row, currency }, NO_SCOPE);
  return row.wallet_id;
}

/** A live subscription, with the period window the metering probes need. */
async function seedPeriod(
  store: Persistence,
  status: "pending" | "voided" = "pending",
): Promise<string> {
  const walletId = await seedWalletIn(store, "SAR");
  const planId = await seedPlanIn(store, "active");
  const sub = subscription(planId, walletId);
  await store.subscription.insertSubscription(sub, NO_SCOPE);
  const row = period(sub.subscription_id, { status });
  await store.subscription.insertPeriod(row, NO_SCOPE);
  return row.period_id;
}

/** Entries that move `amount` from a wallet to the captured clearing account. */
function captureEntries(transactionId: string, walletId: string, amount: number) {
  return [
    {
      entry_id: randomUUID(),
      transaction_id: transactionId,
      account_reference: `wallet:${walletId}`,
      amount_minor: -amount,
      currency: "SAR",
    },
    {
      entry_id: randomUUID(),
      transaction_id: transactionId,
      account_reference: "clearing:captured",
      amount_minor: amount,
      currency: "SAR",
    },
  ];
}

const CASES: readonly TriggerCase[] = [
  // ---- immediate: the transition rules ----------------------------------
  {
    trigger: "plan_terms_immutable",
    refusals: [
      {
        what: "reprices a plan that has already been offered, which would reprice every period already billed from it",
        says: "its commercial terms cannot change",
        async run(store) {
          const planId = await seedPlanIn(store, "active");
          const offered = await store.subscription.getPlan(planId);
          if (!offered) throw new Error("probe setup failed: plan vanished");
          return refuse(() =>
            store.subscription.updatePlan({ ...offered, amount_minor: 9_999 }, NO_SCOPE),
          );
        },
      },
      {
        what: "returns an offered plan to draft, which would let its terms be edited freely afterwards",
        says: "cannot return to draft",
        async run(store) {
          const planId = await seedPlanIn(store, "active");
          const offered = await store.subscription.getPlan(planId);
          if (!offered) throw new Error("probe setup failed: plan vanished");
          return refuse(() =>
            store.subscription.updatePlan(
              { ...offered, status: "draft", activated_at: null, retired_at: null },
              NO_SCOPE,
            ),
          );
        },
      },
      {
        what: "revives a retired plan, which would resume billing on terms that were withdrawn",
        says: "is retired and cannot return to",
        async run(store) {
          const planId = await seedPlanIn(store, "retired");
          const retired = await store.subscription.getPlan(planId);
          if (!retired) throw new Error("probe setup failed: plan vanished");
          return refuse(() =>
            store.subscription.updatePlan({ ...retired, status: "active", retired_at: null }, NO_SCOPE),
          );
        },
      },
    ],
  },
  {
    trigger: "plan_grant_immutable",
    refusals: [
      {
        what: "adds an entitlement to a plan already offered, which would change what past usage was measured against",
        says: "its grants cannot change",
        async run(store) {
          const planId = await seedPlanIn(store, "active");
          return refuse(() =>
            store.subscription.insertGrant(
              { plan_id: planId, feature_key: "parity.probe", limit_value: 10 },
              NO_SCOPE,
            ),
          );
        },
      },
    ],
  },
  {
    trigger: "subscription_currency_check",
    refusals: [
      {
        what: "bills a plan priced in one currency against a wallet held in another, which the ledger cannot settle",
        says: "bills a SAR plan against a USD wallet",
        async run(store) {
          const walletId = await seedWalletIn(store, "USD");
          const planId = await seedPlanIn(store, "active", "SAR");
          return refuse(() =>
            store.subscription.insertSubscription(subscription(planId, walletId), NO_SCOPE),
          );
        },
      },
      {
        what: "subscribes to a plan that was never offered, which would bill terms no one published",
        says: "so it cannot be subscribed to",
        async run(store) {
          const walletId = await seedWalletIn(store, "SAR");
          const planId = await seedPlanIn(store, "draft", "SAR");
          return refuse(() =>
            store.subscription.insertSubscription(subscription(planId, walletId), NO_SCOPE),
          );
        },
      },
    ],
  },
  {
    trigger: "usage_record_within_period",
    refusals: [
      {
        what: "meters usage outside the period's window, which would invoice it in a period it did not happen in",
        says: "falls outside period",
        async run(store) {
          const periodId = await seedPeriod(store);
          return refuse(() =>
            store.subscription.insertUsage(
              {
                usage_id: randomUUID(),
                period_id: periodId,
                feature_key: "parity.probe",
                quantity: 1,
                usage_reference: `usage-${randomUUID()}`,
                recorded_at: "2027-06-01T00:00:00.000Z",
                correlation_id: "corr-parity",
              },
              NO_SCOPE,
            ),
          );
        },
      },
      {
        what: "meters usage against a voided period, which is a period that will never be billed",
        says: "was voided and cannot accrue usage",
        async run(store) {
          const periodId = await seedPeriod(store, "voided");
          return refuse(() =>
            store.subscription.insertUsage(
              {
                usage_id: randomUUID(),
                period_id: periodId,
                feature_key: "parity.probe",
                quantity: 1,
                usage_reference: `usage-${randomUUID()}`,
                recorded_at: NOW,
                correlation_id: "corr-parity",
              },
              NO_SCOPE,
            ),
          );
        },
      },
    ],
  },
  {
    trigger: "reputation_signal_append_only",
    outcomes: [
      {
        what: "a second retraction of the same signal",
        expected: "stale",
        async run(store) {
          const organizationId = await seedOrganization(store);
          const row = signal(organizationId, `source-${randomUUID()}`);
          await store.reputation.insertIfAbsent(row, NO_SCOPE);
          const retraction = {
            organization_id: organizationId,
            source_system: row.source_system,
            source_reference: row.source_reference,
            retracted_at: LATER,
            reason: "parity probe",
          };
          const first = await store.reputation.retractIfStanding(retraction, NO_SCOPE);
          if (first !== "applied") throw new Error(`probe setup failed: first retraction ${first}`);
          return store.reputation.retractIfStanding(retraction, NO_SCOPE);
        },
      },
    ],
  },

  // ---- deferred: the constraint triggers ---------------------------------
  {
    trigger: "ledger_transaction_balance",
    refusals: [
      {
        what: "posts a transaction whose entries do not sum to zero, which is money appearing from nowhere",
        says: "is not balanced",
        async run(store) {
          const walletId = await seedWalletIn(store, "SAR");
          const transactionId = randomUUID();
          return refuse(() =>
            store.boundary.run(async (scope) => {
              const entries = captureEntries(transactionId, walletId, 1_000);
              await store.money.insertTransaction(
                {
                  transaction_id: transactionId,
                  kind: "credit",
                  business_reference: `credit:${transactionId}`,
                  authorization_id: null,
                  occurred_at: NOW,
                  entries: [entries[0]!, { ...entries[1]!, amount_minor: 999 }],
                },
                scope,
              );
            }),
          );
        },
      },
    ],
  },
  {
    trigger: "ledger_transaction_agrees_with_authorization",
    refusals: [
      {
        what: "posts a capture against a hold whose captured total the ledger does not account for",
        says: "captured but the ledger holds",
        async run(store) {
          const walletId = await seedWalletIn(store, "SAR");
          const authorizationId = await seedAuthorization(
            store,
            walletId,
            `hold:${randomUUID()}`,
            1_000,
          );
          const transactionId = randomUUID();
          return refuse(() =>
            store.boundary.run(async (scope) => {
              // Balanced, and the authorization still claims nothing captured:
              // the ledger now holds 1000 against a hold that says 0. Postgres
              // refuses this at commit, and so must the reference backend.
              await store.money.insertTransaction(
                {
                  transaction_id: transactionId,
                  kind: "capture",
                  business_reference: `capture:${authorizationId}`,
                  authorization_id: authorizationId,
                  occurred_at: NOW,
                  entries: captureEntries(transactionId, walletId, 1_000),
                },
                scope,
              );
            }),
          );
        },
      },
    ],
  },
  {
    trigger: "payment_authorization_agrees_with_ledger",
    refusals: [
      {
        what: "raises a hold's captured total with no ledger movement behind it, which is a capture that never happened",
        says: "captured but the ledger holds",
        async run(store) {
          const walletId = await seedWalletIn(store, "SAR");
          const authorizationId = await seedAuthorization(
            store,
            walletId,
            `hold:${randomUUID()}`,
            1_000,
          );
          return refuse(() =>
            store.boundary.run(async (scope) => {
              const held = await store.money.getAuthorization(authorizationId);
              if (!held) throw new Error("probe setup failed: authorization vanished");
              await store.money.updateAuthorization(
                { ...held, captured_minor: 1_000, status: "captured", captured_at: NOW },
                scope,
              );
            }),
          );
        },
      },
    ],
  },
  {
    trigger: "subscription_period_money_agrees",
    refusals: [
      {
        what: "settles a period for more than its hold captured, which would invoice money no one took",
        says: "but authorization",
        async run(store) {
          const walletId = await seedWalletIn(store, "SAR");
          const planId = await seedPlanIn(store, "active");
          const sub = subscription(planId, walletId);
          await store.subscription.insertSubscription(sub, NO_SCOPE);
          const authorizationId = await seedAuthorization(
            store,
            walletId,
            `hold:${randomUUID()}`,
            1_000,
          );
          const row = period(sub.subscription_id, { amount_minor: 1_000 });
          await store.subscription.insertPeriod(row, NO_SCOPE);
          return refuse(() =>
            store.boundary.run(async (scope) => {
              await store.subscription.updatePeriod(
                { ...row, status: "settled", settled_at: NOW, authorization_id: authorizationId },
                scope,
              );
            }),
          );
        },
      },
    ],
  },

  // ---- exempt: the writes no caller can express --------------------------
  {
    trigger: "audit_entry_no_mutation",
    absentOperations: [
      { port: "audit", method: "update" },
      { port: "audit", method: "delete" },
      { port: "audit", method: "amend" },
    ],
  },
  {
    trigger: "ledger_entry_no_mutation",
    absentOperations: [
      { port: "money", method: "updateEntry" },
      { port: "money", method: "deleteEntry" },
      { port: "money", method: "updateTransaction" },
    ],
  },
  {
    trigger: "usage_record_append_only",
    absentOperations: [
      { port: "subscription", method: "updateUsage" },
      { port: "subscription", method: "deleteUsage" },
    ],
  },
];

interface Backend {
  readonly name: string;
  open(clock: Clock): Promise<{ store: Persistence; close(): Promise<void> }>;
  truncate(): Promise<void>;
  triggers?(): Promise<
    readonly { trigger: string; table: string; deferrable: boolean; deferred: boolean }[]
  >;
}

const backends: Backend[] = [
  {
    name: "memory",
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
      const pool = new Pool({ connectionString: url, max: 4 });
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
    async triggers() {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: url, max: 1 });
      try {
        // From the catalog, not from the migration text: after nineteen
        // migrations only the database knows which triggers it is firing and
        // which of them it defers.
        const live = await pool.query<{
          tgname: string;
          relname: string;
          tgdeferrable: boolean;
          tginitdeferred: boolean;
        }>(
          `select t.tgname, c.relname, t.tgdeferrable, t.tginitdeferred
             from pg_trigger t
             join pg_class c on c.oid = t.tgrelid
            where not t.tgisinternal
              and c.relnamespace = 'public'::regnamespace`,
        );
        return live.rows.map((row) => ({
          trigger: row.tgname,
          table: row.relname,
          deferrable: row.tgdeferrable,
          deferred: row.tginitdeferred,
        }));
      } finally {
        await pool.end();
      }
    },
  });
}

for (const backend of backends) {
  describe(`trigger parity: ${backend.name}`, () => {
    let store: Persistence;
    let close: () => Promise<void>;

    beforeAll(async () => {
      const opened = await backend.open(new FixedClock(new Date(NOW)));
      store = opened.store;
      close = opened.close;
    });

    afterAll(async () => {
      await close?.();
    });

    beforeEach(async () => {
      await backend.truncate();
      if (backend.name === "memory") {
        const opened = await backend.open(new FixedClock(new Date(NOW)));
        store = opened.store;
      }
    });

    for (const triggerCase of CASES) {
      for (const probe of triggerCase.refusals ?? []) {
        it(`${triggerCase.trigger}: refuses a write that ${probe.what}`, async () => {
          const verdict = await probe.run(store);
          expect(
            verdict.refused,
            `${backend.name} accepted a write ${triggerCase.trigger} refuses`,
          ).toBe(true);
          if (!verdict.refused) return;
          expect(
            verdict.detail.includes(probe.says),
            `${backend.name} refused the write but not in Postgres' words ("${probe.says}"): ${verdict.detail}`,
          ).toBe(true);
        });
      }

      for (const probe of triggerCase.outcomes ?? []) {
        it(`${triggerCase.trigger}: reports "${probe.expected}" for ${probe.what}`, async () => {
          expect(await probe.run(store)).toBe(probe.expected);
        });
      }

      if (triggerCase.absentOperations) {
        it(`${triggerCase.trigger}: has no port operation that could reach it`, () => {
          const present = triggerCase.absentOperations!.filter(({ port, method }) => {
            const target = store[port] as unknown as Record<string, unknown> | undefined;
            return typeof target?.[method] === "function";
          });
          expect(
            present.map(({ port, method }) => `${String(port)}.${method}`),
            `${triggerCase.trigger} is exempt because no caller can express the write it refuses; the port now offers one, so the exemption no longer holds and the trigger needs a restatement and a probe`,
          ).toEqual([]);
        });
      }
    }
  });
}

describe("trigger parity coverage", () => {
  it("resolves every table an immediate rule reads", () => {
    // The design's one weakening: a rule whose read nobody registered is a
    // trigger that cannot be evaluated, and no probe would fail for it, because
    // the rule would return "permitted" rather than refuse.
    const keys = memoryPersistence(new FixedClock()).referenceKeys;
    expect(keys, "the reference bundle exposes no registry").toBeDefined();
    expect(
      keys ? unresolvedReads(keys) : ["no registry"],
      "a reference store did not hand its map to the bundle registry, so the triggers reading it cannot be enforced in memory",
    ).toEqual([]);
  });

  it("records a reason for every exemption", () => {
    const unexplained = Object.entries(TRIGGER_INVENTORY)
      .filter(([, where]) => where.kind === "exempt" && where.why.trim().length === 0)
      .map(([name]) => name);
    expect(unexplained).toEqual([]);
  });

  it("has one case per inventoried trigger and no duplicates", () => {
    const probed = CASES.map((triggerCase) => triggerCase.trigger);
    expect(probed.length, "two cases probe the same trigger").toBe(new Set(probed).size);
    const missing = inventoriedTriggers().filter((name) => !probed.includes(name));
    expect(
      missing,
      "a trigger is inventoried with no case, so nothing measures whether the reference backend enforces it",
    ).toEqual([]);
    const stale = probed.filter((name) => !(name in TRIGGER_INVENTORY));
    expect(stale, "a case names a trigger the inventory does not account for").toEqual([]);
  });

  it("probes what it enforces and exempts what it cannot", () => {
    const mismatched: string[] = [];
    for (const triggerCase of CASES) {
      const where = TRIGGER_INVENTORY[triggerCase.trigger];
      if (!where) continue;
      const probes = (triggerCase.refusals?.length ?? 0) + (triggerCase.outcomes?.length ?? 0);
      if (where.kind === "exempt") {
        if (probes > 0) mismatched.push(`${triggerCase.trigger}: exempt but probed`);
        if (!triggerCase.absentOperations?.length) {
          mismatched.push(`${triggerCase.trigger}: exempt with nothing asserted absent`);
        }
      } else if (probes === 0) {
        mismatched.push(`${triggerCase.trigger}: enforced but nothing probes it`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it("declares an immediate rule for every trigger it calls immediate", () => {
    const declared = new Set(
      Object.values(TRANSITION_RULES).flatMap((rules) => rules.map((rule) => rule.trigger)),
    );
    const claimed = Object.entries(TRIGGER_INVENTORY)
      .filter(([, where]) => where.kind === "immediate")
      .map(([name]) => name);
    expect(
      claimed.filter((name) => !declared.has(name)),
      "the inventory calls a trigger immediate but TRANSITION_RULES has no rule for it, so putRow enforces nothing",
    ).toEqual([]);
    expect(
      [...declared].filter((name) => TRIGGER_INVENTORY[name]?.kind !== "immediate"),
      "a transition rule enforces a trigger the inventory does not call immediate",
    ).toEqual([]);
  });
});

/**
 * The gates that need the live schema.
 *
 * Asked of `pg_trigger` for the same reason the other three families ask
 * `pg_constraint`: the migration text says what was intended and the catalog
 * says what is enforced.
 */
describe.skipIf(!url)("trigger parity against the live schema", () => {
  it("accounts for every trigger the live schema installs", async () => {
    const postgres = backends.find((candidate) => candidate.name === "postgres");
    const live = (await postgres?.triggers?.()) ?? [];
    expect(live.length, "no triggers read from the catalog: the gate would pass vacuously").toBe(12);
    const inventoried = new Set(inventoriedTriggers());
    const unaccounted = live
      .map((trigger) => trigger.trigger)
      .filter((name) => !inventoried.has(name))
      .sort();
    expect(
      unaccounted,
      "a migration installed a trigger with neither a restatement nor a recorded exemption; the reference backend is free to accept the transitions it refuses until one exists",
    ).toEqual([]);
    const liveNames = new Set(live.map((trigger) => trigger.trigger));
    expect(
      inventoriedTriggers().filter((name) => !liveNames.has(name)),
      "the inventory names a trigger the schema no longer installs",
    ).toEqual([]);
    const wrongTable = live
      .filter(
        (trigger) =>
          TRIGGER_INVENTORY[trigger.trigger] &&
          TRIGGER_INVENTORY[trigger.trigger]!.table !== trigger.table,
      )
      .map(
        (trigger) =>
          `${trigger.trigger}: fires on ${trigger.table}, inventoried against ${TRIGGER_INVENTORY[trigger.trigger]!.table}`,
      );
    expect(wrongTable, "the inventory disagrees with the catalog about what a trigger fires on").toEqual(
      [],
    );
  });

  it("agrees with the catalog about which triggers are deferred", async () => {
    const postgres = backends.find((candidate) => candidate.name === "postgres");
    const live = (await postgres?.triggers?.()) ?? [];
    const disagreements: string[] = [];
    for (const trigger of live) {
      const where = TRIGGER_INVENTORY[trigger.trigger];
      if (!where) continue;
      const deferredInSchema = trigger.deferrable && trigger.deferred;
      if (where.kind === "deferred" && !deferredInSchema) {
        // Enforcing it on the journal would then refuse at a point Postgres
        // does not, or accept something Postgres refuses at the write.
        disagreements.push(
          `${trigger.trigger}: the reference backend defers it, the schema fires it immediately`,
        );
      }
      if (where.kind !== "deferred" && deferredInSchema) {
        // The mirror image, and the more dangerous one: a `putRow` rule refuses
        // at the write a transition Postgres allows to be repaired before
        // commit, so the reference backend rejects a legal sequence.
        disagreements.push(
          `${trigger.trigger}: the schema defers it to commit, the reference backend enforces it at the write`,
        );
      }
    }
    expect(
      disagreements,
      "a migration changed a trigger's timing, so the reference backend now enforces it at the wrong point",
    ).toEqual([]);
  });
});
