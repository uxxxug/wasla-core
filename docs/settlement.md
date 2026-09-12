# Settlement

How CORE settles money after a hold: partial capture, refunds, and what it
deliberately does not do yet. Written from CORE's side only; MARKET and MOVE
appear here only as callers and consumers.

## What was wrong before

`payment_authorization.amount_minor` carried two meanings at once — the amount
the payer consented to, and the amount that would move. Capture was therefore
all-or-nothing, and a balance could only treat a hold as fully held or fully
gone.

Settlement is not like that. A job quoted at 6 000 that costs 4 000 must capture
4 000. A completed job that is later disputed must give money back. Neither was
expressible, so the only options were to capture the wrong amount, or to void
and re-authorize — which throws away the payer's consent and can then fail for
want of funds that were, a moment earlier, already held.

## The three amounts

| Column | Meaning | Movement |
| --- | --- | --- |
| `amount_minor` | the ceiling the payer consented to | immutable |
| `captured_minor` | how much has actually moved out | grows, never shrinks |
| `refunded_minor` | how much has moved back | grows, never shrinks |

The amount still reserved is **derived**, not stored:

```
remaining hold = status = 'authorized' ? amount_minor - captured_minor : 0
```

Storing it would give the system two places to be wrong, and nothing to say
which one to believe.

`balance()` sums that remainder, not the authorization's full amount. This is
the money bug closest to the surface: a partial capture has already left the
wallet and is therefore in `posted_minor`, so counting the whole hold as well
deducts the same money twice and refuses authorizations the wallet can afford.
`tests/settlement.test.ts` asserts it on both backends.

## A refund is not a void

Conflating them is the worst error available in this module.

| | void | refund |
| --- | --- | --- |
| what it releases | money that never moved | money that already moved |
| ledger effect | none | a balanced reversal |
| bounded by | what is still held | what was captured |
| changes status to | `voided` / `partially_captured` | nothing |

A refund does **not** un-capture. The authorization stays `captured` or
`partially_captured` and `captured_minor` is never reduced, so the history shows
money going out and coming back rather than never having left. It does not
restore the hold either: the funds return to the posted balance and are simply
spendable again.

Ledger direction is the exact reverse of a capture:

```
capture   clearing:captured  +amount    wallet:<id>        -amount
refund    wallet:<id>        +amount    clearing:captured  -amount
```

## The fourth status

`partially_captured` exists because the other three cannot describe the outcome
without lying. When a hold moved some money and then released the rest,
`captured` overstates what moved and `voided` claims nothing moved when some
did — and the status is what a reconciliation would trust.

While `captured_minor < amount_minor` the row stays `authorized`, because part
of a consent being unused is not a reason to discard the rest. A hold only
leaves `authorized` when it is fully captured, explicitly closed, or expired.

## Idempotency keys

`ledger_transaction.business_reference` is UNIQUE, and that is what makes
settlement exactly-once.

- **Full capture** — no explicit reference needed. The key is
  `capture:<authorization_id>`, bit-for-bit what it was before this work, so an
  in-flight retry from before the migration still resolves to the same
  transaction instead of charging twice.
- **Partial capture** — `capture_reference` is **required**, and CORE refuses
  without it. A partial capture is by definition one of several, so a key
  derived from the authorization alone cannot tell a retry from an additional
  capture. Guessing would mean either charging twice or silently dropping a
  legitimate second capture. The key becomes
  `capture:<authorization_id>:<capture_reference>`.
- **Refund** — `refund_reference` is **always** required. There is no such
  thing as "the" refund of an authorization, so there is no key to derive. The
  key becomes `refund:<authorization_id>:<refund_reference>`.

## The aggregates cannot drift from the ledger

`captured_minor` and `refunded_minor` are summaries of the ledger, and a
summary that can disagree with what it summarises is a liability. Migration
0009 therefore does two things:

1. `ledger_transaction.authorization_id` becomes a real foreign key, so "which
   authorization did this money movement belong to" stops being a parsed
   `business_reference` string. A credit has no authorization; a capture or
   refund cannot exist without one (`ledger_transaction_authorization_presence`).
2. Two **deferred constraint triggers** enforce agreement from both sides —
   `ledger_transaction_agrees_with_authorization` and
   `payment_authorization_agrees_with_ledger`. They sum per kind rather than
   netting, so two errors of equal size cannot cancel out and hide each other.

This is the same argument `ledger_transaction_is_balanced` already makes: an
invariant this important belongs in the database, not only in whichever service
happens to be doing the writing. It is not theoretical — reverting the service's
ceiling check makes both backends refuse the over-capture at the storage layer,
by name, with the service's own check removed.

Deferral matters: the authorization row and its ledger rows are written in one
transaction and either order is legitimate, so an eager check would reject a
state the transaction was about to make consistent.

## The in-memory store enforces the same rules

`InMemoryMoneyRepository` restates 0009's CHECK constraints and runs the same
ledger-agreement check. This looks redundant next to a service that already
upholds them, and that is the point: they are there to catch the service
getting it wrong. A memory backend more permissive than Postgres is a backend
that certifies bugs, which is exactly what B-12 was.

To express a deferred constraint in memory, `MemoryJournal` gained `defer(key,
check)` and the in-memory boundary runs those checks just before the scope
completes — the same moment Postgres fires a `DEFERRABLE INITIALLY DEFERRED`
trigger. Without it the memory store would have to judge the world half way
through a transaction and would either accept what production refuses or refuse
what production accepts. Outside a transaction there is nothing to defer to, so
the check runs immediately, which matches autocommit.

## Known backend difference

`transactions()` on Postgres orders by `(occurred_at, transaction_id)` and the
in-memory store returns insertion order. Under a fixed clock two captures share
an `occurred_at`, so the two backends disagree on which comes first. CORE makes
**no ordering promise between two transactions at the same instant**, so there
is nothing to unify; the settlement tests key their assertions on the ledger
reference instead of position. An ordered assertion here would pass on one
backend, fail on the other, and test nothing CORE guarantees. Same resolution
as the delivery-ordering note in `docs/outbound-delivery.md`.

## Rolling back 0009

`0009_partial_capture_and_refunds.down.sql` **refuses to run** while any
authorization is partially captured or refunded:

```
cannot roll back 0009: N authorization(s) are partially captured or refunded
```

The down migration has to drop `captured_minor` and `refunded_minor`, and there
is no value of the old single-meaning `amount_minor` that tells the truth about
a hold where 2 500 of 6 000 moved. Rounding it to either number would make the
database state a lie about money. Refusing is the only honest option, and the
operator's route is to settle or refund the affected authorizations first.

Verified by reproducing the state on a real database and running the down
migration against it.

## The fulfillment side of the fourth status

Migration 0009 gave the hold a fourth status, but the fulfillment row that binds
money to execution was left with the old vocabulary
(`none | held | captured | released | unsettled`). The two disagreed for a whole
cycle, and the disagreement was silent.

`settlement_state = 'released'` is a claim with a precise documented meaning:
**the hold was voided and no money moved**. Three paths wrote it for a hold that
had already moved part of the payer's money, because
`FulfillmentPaymentPort.voidWithin` returned `unknown` — fulfillment had no way
to ask how much had moved, so it assumed nothing had:

| path | what happened | what CORE recorded |
| --- | --- | --- |
| `move.job.rejected` / `cancel` after a partial capture | the remainder was released, 2 500 of 6 000 stayed gone | `released` |
| intake of an order whose hold had already closed part-captured | refused, correctly | `released`, reason `payment_hold_not_authorized` |
| `move.job.completed` on a hold already closed | capture refused, outcome flipped to `failed` | `released` |

In all three the reconciliation read was blind: `isFinanciallyConsistent`
returned `true`, `listFinanciallyInconsistent()` returned nothing, and the
closure event told MARKET the money had been returned when it had not.

Migration 0011 and the fulfillment service now carry `partially_captured` end to
end. The port publishes a shape (`{ status, captured_minor }`) instead of
`unknown`, and `release()` derives the state from what money reports rather than
from what the call site hoped:

```
captured_minor > 0  ->  partially_captured
otherwise           ->  released
```

### The same fix, applied to the success path (2026-09-12)

The release path reported an amount; the capture path did not. `captureWithin`
answered `Promise<unknown>`, `settle()` discarded it, and
`core.fulfillment.completed` published `captured_minor: null`. So the one closure
a payer had certainly paid for was the one closure that named no figure, while a
cancellation after a partial capture named one — exactly backwards.

`MoneyService` now also exposes `captureHoldWithin`, which returns the
`PaymentAuthorization` rather than the `LedgerTransaction`, mirroring
`voidWithin`. This distinction is the whole point: the transaction is **one
capture leg**, the authorization carries the **running total**. A hold of 6 000
captured 2 500 out of band and then closed by CORE for the 3 500 remainder has a
final leg of 3 500 and a total of 6 000; publishing the leg would have been a
true number about the wrong thing, and an understatement of what the payer paid.

`settle()` therefore reports `captured_minor` from the authorization, and derives
the settlement state the same way `release()` does:

```
status = 'captured'  ->  captured
otherwise            ->  partially_captured
```

The second branch is a guard, not a live path: today `settle()` captures the
whole remaining hold, so a `captured` status is the only outcome reached. It is
written as a derivation anyway, because the alternative is a hardcoded
`captured` that would silently misreport the day a partial-capture settlement
policy arrives (blocker B-20).

`captured_minor` stays **optional** on both closure contracts. An order with no
hold at all completes without it, and that must not become `0` — absent means
"CORE observed no amount", whereas zero would assert that nothing moved.

### Why a failed fulfillment may hold it, and why it is still "inconsistent"

`fulfillment_settlement_alignment_check` **accepts** `partially_captured` against
`failed` and `cancelled`. Nothing is broken when it happens: the money state is
terminal and truthful. But the payer has paid for work that did not complete, and
whether that money is refunded, kept as a cancellation fee or split is a policy
decision CORE has not been given (blocker B-20).

So the schema stores it and `isFinanciallyConsistent` reports it as inconsistent.
Those are not in conflict — one is about what is recordable, the other about what
needs a human. Refusing to store it would only force the service back to writing
`released`, which is the falsehood this work removed. Surfacing it is the
reversible direction: an operator can act on a case CORE reported and cannot act
on one it hid.

Against `completed`, `partially_captured` is fully consistent — a job that cost
less than the consented ceiling is the ordinary outcome of a capture in legs.

### Rolling back 0011

Same refusal as 0009, for the same reason: narrowing the value list back leaves
no honest value for an existing row. `released` would claim no money moved and
`captured` would claim all of it did. The rollback refuses while any row is
`partially_captured` and points the operator at the query that lists them.

## Every path that can close with money in the middle (B-20)

The table is the whole point of this section: for each way a fulfillment can
reach a terminal state, what the money looks like, and whether anyone still owes
a decision. `held` below is the part of the hold that is still reserved and not
yet drawn.

`captured` is what money reports on the authorization; `remaining held` is the
consented ceiling minus it, and reaches 0 the moment the hold closes, because a
closed hold reserves nothing regardless of what it captured.

| # | Path | Trigger | Execution | Hold (money) | captured | remaining held | `settlement_state` | `financial_disposition` | Decision owed? |
|---|------|---------|-----------|--------------|----------|----------------|--------------------|--------------------------|----------------|
| 1 | intake refused, hold missing | `core.market.order.created` with an unknown authorization | `failed` | — | — | — | `none` | `no_money` | no |
| 2 | intake refused, hold already fully captured | order arrives after money left | `failed` | `captured` | full | 0 | `unsettled` | `inconsistent` | no — **engineer**: money moved for work never coordinated |
| 3 | intake refused, hold closed after a partial capture | order arrives after a leg was drawn and the rest released | `failed` | `partially_captured` | part | 0 | `partially_captured` | `decision_required` | **yes** |
| 4 | intake refused, hold voided or expired-out | hold no longer authorized, nothing captured | `failed` | `voided` | 0 | 0 | `released` | `settled` | no |
| 5 | intake refused, hold expired but still open | past `expires_at`, nothing captured | `failed` | `voided` by CORE | 0 | 0 | `released` | `settled` | no |
| 6 | intake refused, hold expired with a captured leg | past `expires_at`, a leg already drawn | `failed` | `partially_captured` | part | 0 | `partially_captured` | `decision_required` | **yes** |
| 7 | MOVE rejects the job | `move.job.rejected`, nothing captured | `failed` | `voided` | 0 | 0 | `released` | `settled` | no |
| 8 | MOVE rejects the job after a leg was drawn | `move.job.rejected`, a leg already captured | `failed` | `partially_captured` | part | 0 | `partially_captured` | `decision_required` | **yes** |
| 9 | MOVE completes, capture succeeds | `move.job.completed` with `outcome=completed` | `completed` | `captured` | full | 0 | `captured` | `settled` | no |
| 10 | MOVE completes for less than the ceiling | — **not reachable today**, see below | `completed` | `partially_captured` | part | 0 | `partially_captured` | `settled` | no — work delivered and paid for |
| 11 | MOVE completes, capture refused, release clean | hold no longer capturable, nothing had moved | `failed` (`payment_settlement_failed:…`) | `voided` | 0 | 0 | `released` | `settled` | no |
| 12 | **MOVE completes, capture refused, part had moved** | the reference case: 6 000 reserved, 2 500 drawn, hold closed | `failed` | `partially_captured` | 2 500 | 0 | `partially_captured` | `decision_required` | **yes** |
| 13 | MOVE completes, capture refused, release also fails | money unreachable on both calls | `failed` | unknown | unknown | unknown | `unsettled` | `inconsistent` | no — **engineer** |
| 14 | MOVE reports failure | `move.job.completed` with `outcome=failed`, nothing captured | `failed` | `voided` | 0 | 0 | `released` | `settled` | no |
| 15 | MOVE reports failure after a leg was drawn | same, with money already moved | `failed` | `partially_captured` | part | 0 | `partially_captured` | `decision_required` | **yes** |
| 16 | cancelled before execution closes | `POST /cancel`, nothing captured | `cancelled` | `voided` | 0 | 0 | `released` | `settled` | no |
| 17 | **cancelled after a leg was drawn** | `POST /cancel` with 2 500 already moved | `cancelled` | `partially_captured` | 2 500 | 0 | `partially_captured` | `decision_required` | **yes** |
| 18 | any of the above, delivered twice | duplicate or retried event, or a second `cancel` | unchanged | unchanged | unchanged | unchanged | unchanged | unchanged | no — the first outcome stands |
| 19 | hold expires while execution is still open | the expiry sweep runs, no MOVE event yet | `coordinating`/`dispatched` | `voided` or `partially_captured` | 0 or part | 0 | `held` (stale) | `awaiting_execution` | see the gap below |

Row 10 is the one row no code path can produce yet. `settle` captures the whole
remaining hold because nothing tells it a smaller figure: `move.job.completed`
carries no executed amount. The schema and the consistency rule accept the pair
so the row is representable the day MOVE sends one — that is the second contract
dependency in the ROADMAP, not something CORE can decide. Until then a completed
job always draws the full ceiling.

Rows 3, 6, 8, 12, 15 and 17 are the same fact reached six ways: money left the
payer and the work was not delivered. CORE records it and stops. It does not
refund, does not keep the money against a cancellation fee, and does not mark
the operation finished — because it has not been told which of those is right.

### What CORE will not do while a decision is owed

- No transition writes `released` when `captured_minor > 0`. `released` is a
  claim that no money moved.
- Both closure events carry `financial_decision_required: true` in those rows,
  so `core.fulfillment.cancelled` cannot be read as "the customer was refunded".
- `isFinanciallyConsistent` returns false, so the case stays in the
  reconciliation read instead of disappearing into the finished pile.
- `GET /v1/fulfillments/reconciliation/pending-financial-decision` lists exactly
  these rows, separately from defects, so the queue can be counted.
- Nothing in CORE emits a refund. `refundWithin` exists and is only ever called
  by an explicit request that names its reference — never inferred from a
  fulfillment outcome.

### The disposition, and why a boolean was not enough

`financial_disposition` is derived from the two states on every read and never
stored, so it cannot drift from them:

| disposition | meaning | who acts |
|---|---|---|
| `no_money` | no hold guards this fulfillment | nobody |
| `awaiting_execution` | a hold guards open work | nobody yet |
| `settled` | money reached a terminal state that agrees with the outcome | nobody |
| `decision_required` | money moved, work did not complete, policy unknown | the business (B-20) |
| `inconsistent` | the two states contradict each other, or `unsettled` | an engineer |

`isFinanciallyConsistent` collapsed the last two into one `false`, which put a
CORE defect and an unanswered business question in the same queue. They need
different people.

### Closed: row 19, a stale hold on open work

If a hold stops being able to settle its execution while the execution is still
open — the expiry sweep closed it, an operator voided it, or it was captured out
of band — the fulfillment row keeps `settlement_state = 'held'` and stays open.
When a MOVE event eventually arrives the outcome is truthful (rows 12 and 15
handle it). If none arrives, the row sits open forever, and neither of the two
reconciliation reads above can see the problem, because both look only at the
fulfillment row while the contradiction is between two modules.

Classified deliberately, because it is none of the three things it resembles:

- not `inconsistent`: the row is not false. It says work is open, and it is; it
  says a hold guarded it, and one did when the row was written.
- not `decision_required`: that queue means money moved for work that did not
  complete. Here the work has not finished at all yet.
- not a new status: "open but unfunded" would be a second, staler copy of the
  money state living in the fulfillment table — exactly the duplication
  `financial_disposition` exists to avoid. Detection must not create state.

So it is a liveness condition, and CORE reports it:
`listStaleHolds` / `GET /v1/fulfillments/reconciliation/stale-holds` compares
every open funded fulfillment against its authorization through the same
`inspectHold` predicate that guards intake, so the sweep cannot drift from the
rule the write path applies. Each row carries why the hold is unusable, how much
of it already moved, and the `settlement_state` the fulfillment would take if it
closed now — which tells an operator in advance which of these will land in the
`decision_required` queue.

What CORE does **not** do is act on it. Re-authorising, abandoning the execution,
or completing the work unfunded are three different commercial answers, and
choosing one is the same class of decision as D-1…D-5. Recorded as dependency
**D-6**: who decides the fate of open work whose funding disappeared, and does
MOVE stop working on it. Until then the queue is reported, never drained
automatically, and the read mutates nothing — `tests/fulfillment-stale-holds.test.ts`
asserts that on both backends.

### One terminal closure, one closing event

Every terminal path closes through one conditional write. The write applies only
while the row is still in a status it is allowed to leave, and the store — not the
service — decides whether it applied, by reporting how many rows it matched:

```sql
update fulfillment set ... where fulfillment_id = $1 and status = any($8::text[])
```

A transition that matches nothing is `stale`. `stale` aborts the transaction, so
the money mutation staged before it and the outbox row staged after it are both
rolled back, and the loser then answers from the row that actually committed
using the same resolver the sequential repeat uses. This is why a concurrent
duplicate and a redelivered duplicate cannot give different answers.

| Terminal path | Left states | Closing event | Concurrency-proven |
| --- | --- | --- | --- |
| completion (`completed`) | `coordinating`, `dispatched` | `core.fulfillment.completed` | yes |
| completion (`failed`) | `coordinating`, `dispatched` | `core.fulfillment.failed` | yes |
| MOVE rejection | `coordinating`, `dispatched` | `core.fulfillment.failed` | yes |
| cancellation | any open status | `core.fulfillment.cancelled` | yes |
| intake refusal (unusable hold) | none — created closed | `core.fulfillment.failed` | yes |
| intake refusal (unresolvable hold) | none — created closed | `core.fulfillment.failed` | yes |
| partial capture + terminal outcome | `coordinating`, `dispatched` | outcome event with `financial_decision_required` | yes |
| stale hold on open work | none — stays open | none, by design (D-6) | n/a |

The two intake refusals are terminal at creation, so their invariant is the
uniqueness of `market_order_reference` rather than a status predicate: the insert
is `on conflict do nothing`, the loser reads back the winner, and only one closure
event exists. The unresolvable-hold refusal additionally cannot store the
reference MARKET declared — `fulfillment.payment_authorization_id` is a foreign
key to a hold CORE does not have — so the column is left null and the declared
reference is kept on the audit entry as `unresolved_hold_reference`. Before that,
this documented path could not commit on PostgreSQL at all, and only worked
in memory.

## Not implemented: multiple holds per fulfillment

Deliberately left out, recorded as an external dependency rather than invented.

`fulfillment.payment_authorization_id` is a single column and MARKET only ever
sends one authorization id. Supporting several holds against one fulfillment
needs MARKET to decide what it means — whether the holds are alternatives or
additive, which one a partial capture draws from, and what a total means when
they are in different currencies. None of that is CORE's decision, and a join
table nobody feeds is worse than no join table.

The sketch, for when that decision exists: a `fulfillment_authorization` join
table replacing the single column, with the settlement service capturing across
holds in an explicit order the caller supplies, since "which hold does this
2 000 come out of" changes who is owed what. Nothing in this milestone blocks
that; the amounts split here are what make it expressible at all.
