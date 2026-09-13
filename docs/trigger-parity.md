# Trigger parity between the reference backend and Postgres

The fourth and last family of B-12. Uniqueness closed 24 rules, the check
constraints 100, the foreign keys 30 — three declarative families, each closed
by one predicate table applied on one write path. The schema also installs
**12 triggers**, measured from `pg_trigger` rather than from the migration text,
and they are a different kind of rule.

## Why a trigger is not another row rule

A `CHECK` reads the row being written. A foreign key reads one other row. A
trigger can do three things neither can:

1. **Judge a transition.** `plan_terms_immutable` refuses a change from one
   perfectly legal row to another perfectly legal row: nothing about the new
   plan is wrong, it is wrong *given what the plan was*.
2. **Read other tables.** `subscription_currency_check` compares the plan's
   currency with the wallet's. `usage_record_within_period` compares a usage
   record with its period's window.
3. **Run at commit.** Four of the twelve are `CONSTRAINT TRIGGER ...
   DEFERRABLE INITIALLY DEFERRED`, because the rows they compare are written in
   one transaction and either write order is legitimate.

So this cycle has two mechanisms rather than one:
`src/platform/persistence/transition-rules.ts` declares the immediate rules and
`putRow` applies them — after the check constraints and the foreign keys, the
order Postgres uses, so a refusal quotes the constraint the database would
quote. The deferred four stay on the transaction journal in the stores that
already defer, because a write-time refusal would reject a legal sequence.

The same file carries `TRIGGER_INVENTORY`: every trigger named exactly once,
with where it is accounted for — `immediate`, `deferred` (naming the store that
defers it), or `exempt` (with the reason). `tests/trigger-parity.test.ts` reads
`pg_trigger` at run time and fails when the schema installs a trigger the
inventory does not account for, so a migration cannot add one and leave the
reference backend permissive.

## The twelve

| Trigger | Table | Timing | Where the reference backend enforces it |
|---|---|---|---|
| `plan_terms_immutable` | `plan` | `BEFORE UPDATE` | immediate rule |
| `plan_grant_immutable` | `plan_grant` | `BEFORE INSERT/UPDATE/DELETE` | immediate rule (reads `plan`) |
| `subscription_currency_check` | `subscription` | `BEFORE INSERT/UPDATE` | immediate rule (reads `plan`, `wallet`) — **added this cycle** |
| `usage_record_within_period` | `usage_record` | `BEFORE INSERT` | immediate rule (reads `subscription_period`) |
| `reputation_signal_append_only` | `reputation_signal` | `BEFORE UPDATE/DELETE` | immediate rule; the path both backends narrow away is probed by outcome |
| `ledger_transaction_balance` | `ledger_entry` | constraint, deferred | `deferBalance` on the journal — **added this cycle** |
| `ledger_transaction_agrees_with_authorization` | `ledger_transaction` | constraint, deferred | `deferLedgerAgreement` |
| `payment_authorization_agrees_with_ledger` | `payment_authorization` | constraint, deferred | `deferLedgerAgreement` |
| `subscription_period_money_agrees` | `subscription_period` | constraint, deferred | `deferMoneyAgreement` |
| `audit_entry_no_mutation` | `audit_entry` | `BEFORE UPDATE/DELETE` | exempt: the port has no mutation |
| `ledger_entry_no_mutation` | `ledger_entry` | `BEFORE UPDATE/DELETE` | exempt: entries are only written with their transaction |
| `usage_record_append_only` | `usage_record` | `BEFORE UPDATE/DELETE` | exempt: no `updateUsage`, no `deleteUsage` |

## The two gaps measurement exposed

**`subscription_currency_check` was restated in no store at all.** Both of its
refusals — a plan priced in one currency billed against a wallet in another, and
a subscription to a plan that was never offered — were enforced by
`SubscriptionService` and nowhere below it. Every test that reached the
repository directly could therefore create a subscription production refuses,
and the service was the only thing between a currency mismatch and the ledger.
It is now a transition rule, so the refusal belongs to the write path rather
than to one caller.

**`ledger_transaction_balance` was not enforced by the reference store either.**
`assertBalanced` was called by `MoneyService` alone. A caller reaching
`insertTransaction` directly could post entries summing to -1 — money appearing
from nowhere — and the reference backend accepted it while Postgres refuses at
commit. Found by writing the probe, not by reading the code: the probe failed on
the memory half on its first run. It is now deferred onto the journal, keyed by
transaction id, so it refuses where Postgres refuses.

## Where the two backends still differ, named rather than hidden

- **The balance rule's timing.** Postgres defers it to commit and sums per
  currency. The reference store defers it to commit too, but it also refuses a
  transaction that mixes currencies, which Postgres would accept if each
  currency balanced to zero on its own. Stricter, deliberately: CORE has no
  multi-currency transaction, and `ledger_entry_currency_matches_transaction` is
  the schema saying so.
- **Insert versus update.** `putRow` sees only whether a row already exists
  under the key, so a repeated insert is read as an update and judged by the
  update rules. Postgres refuses that write too, as a primary-key violation —
  a different family's refusal, not a missing one. Never more permissive, and
  the wording differs.
- **Timestamp rendering.** `usage_record_within_period` quotes the period
  window in its message. Postgres renders a `timestamptz` its own way and the
  reference backend quotes the ISO string it was given, so the probes match the
  stable part of the message and not the instants.
- **`reputation_signal_append_only` cannot be probed by refusal.**
  `retractIfStanding` narrows on `retracted_at is null` in memory and in SQL, so
  a second retraction is not a write either backend refuses — it is a `stale`
  verdict. Both backends are asserted to return `stale`. The rule is declared
  anyway, for writes a future caller could express: an un-retraction, a second
  retraction, or a change to a frozen field.

## The one weakening, inherited from the foreign-key cycle

A rule that reads another table can only be evaluated if that table is
registered with the bundle. A store built alone in a unit test has no registry,
and the rule is skipped rather than evaluated against an absent row. That is
measured, not trusted: `unresolvedReads()` is asserted empty for the
`memoryPersistence` bundle, so a store that forgets to register a map fails the
suite instead of quietly enforcing nothing.

## What is not claimed

- **`DELETE` parity is not probed.** No reference store deletes a row outside a
  transaction rollback, so the delete halves of the four append-only triggers
  are unreachable rather than enforced. Each exemption names the port
  operations that must stay absent, and the suite asserts their absence, so
  adding `deleteUsage` to the port fails the exemption.
- **`ON DELETE CASCADE` still is not modelled** — carried over from
  `docs/foreign-key-parity.md`, unchanged.
- **The deferred probes assert the refusal at the commit point** and do not
  assert *which* statement inside the transaction Postgres blames, because a
  deferred constraint trigger fires at commit and blames the transaction.
