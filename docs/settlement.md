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
