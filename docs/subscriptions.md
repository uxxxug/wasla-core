# Subscriptions, plans and entitlement (ADR 0013)

CORE owns Plan, Subscription, Period, Entitlement and Usage
(`docs/data-ownership.md`). This document records what was built, and — more
importantly — which decisions were deliberately **not** made here.

## The question this module answers

`POST /v1/access/check` already answers "may this principal do this?" from
roles. That is a different question from "has this owner paid for this?", and
collapsing them would be a mistake with money attached: an unpaid subscription
would become indistinguishable from a missing role, so a billing failure would
read as a permissions bug and a permissions bug would read as a billing
failure. Entitlement is therefore its own decision, with its own vocabulary of
reasons, and it never answers a bare boolean.

`EntitlementReason` is the whole point of the design:

| reason | what it says |
|---|---|
| `granted` | a paid period covers the instant and the plan grants the feature |
| `no_subscription` | this owner has no subscription at all |
| `subscription_past_due` | subscribed, but a period could not be collected |
| `subscription_expired` | coverage ran out |
| `no_current_period` | subscribed, but no period covers this instant |
| `period_unpaid` | a period covers the instant and has not been paid |
| `not_in_plan` | the plan does not grant this feature |
| `limit_exhausted` | the grant is metered and the quota is used up |

## Entitlement is derived, never stored

There is no entitlement table. CORE owns entitlement by being the only place
that can answer the question, not by keeping a copy of the answer. A stored
verdict would be a second source of truth beside the subscription, the period
and the usage that produced it, and it would drift the moment any of the three
changed — which is exactly when the answer matters.

`checkEntitlement` reads the owner's subscriptions in `created_at` order,
returns the first allowance, and otherwise keeps the most informative refusal:
a refusal that found the feature in some plan explains more than one that never
saw it.

## Feature keys are data, not schema

A grant is a row: `(plan_id, feature_key, limit_value)`. `feature_key` is an
opaque string owned by whichever product consumes it. It is never a column and
never an enum, because ADR 0018 keeps product-specific logic out of CORE — the
moment CORE knows the name of a feature, CORE has an opinion about a product.

`limit_value` distinguishes two things that must not collapse:

- `null` — granted, not metered. There is no quota to exhaust.
- `0` — granted nothing. Explicitly none.

Treating them as the same value would make a revoked quota read as an unlimited
one. `POST /v1/plans` therefore refuses a grant with no `limit_value` at all
rather than defaulting it: the two candidate defaults are opposites.

## A plan's terms freeze when it activates

Draft plans are editable. Active plans are not: two triggers in migration 0010
(`plan_terms_are_immutable_once_active`, `plan_grants_are_immutable_once_active`)
refuse a price change, a grant insert and a grant delete. Changing a price means
publishing a new plan.

The reason is readability of settled history. If a price could be edited after
anyone had subscribed, the period would record 5000, the plan would record 9000,
and nothing would record which number the customer agreed to.

Retiring is one-way and closes the plan to **new** subscribers only.
Subscriptions already on it keep renewing at the price their own periods carry.

`amount_minor` is operator-configured data. CORE fixes no rate anywhere in code,
which is what ADR 0012 requires while regulatory pricing policy is undecided
(B-4).

## The period is the invoice

`subscription_period` copies `currency` and `amount_minor` from the plan when it
is created rather than reading through to the plan. The period is what was
charged, so what was charged has to be recorded on it; otherwise retiring a plan
would take the price of settled history with it.

Periods are half-open, `[starts_at, ends_at)`. An `EXCLUDE USING gist`
constraint refuses two overlapping periods for one subscription. A deferred
trigger was rejected for this: a trigger reads rows committed before it runs, so
two concurrent inserts each see nothing and both succeed. That is the same class
of hole as B-12, and an exclusion constraint is the thing that actually closes
it.

Adjacent periods are accepted, because half-open ranges that touch do not
overlap. Renewal starts the next period exactly where the last one ended, so
coverage has neither a gap nor an overlap to argue about.

## Collection is an ordinary payment authorization

A period is collected through `MoneyService`, against the same ledger as
everything else. Its `business_reference` is **derived** from the period:
`subscription-period:<period_id>`. Since `payment_authorization.business_reference`
and `ledger_transaction.business_reference` are both UNIQUE, a crash between
authorizing and capturing cannot produce a second hold or a second movement —
the retry finds what already exists. That derived reference, not any check in
the service, is what makes collection exactly-once; the early return in
`chargePeriod` only avoids repeating work, and `tests/subscription.test.ts`
says so explicitly.

Settlement uses `money.captureWithin(uow, …)`, so the ledger movement and the
billing record commit together (B-11). Migration 0010 adds a
`DEFERRABLE INITIALLY DEFERRED` constraint trigger that refuses, at COMMIT, any
settled period whose amount and currency disagree with the authorization that
settled it.

Two consequences worth stating:

- **Signup and first charge are separate units of work.** If they shared a
  transaction, an empty wallet would roll the subscription away, leaving nothing
  to retry and inviting the caller to sign the same owner up twice. So
  `POST /v1/subscriptions` answers 201 with `collected: false` when the first
  charge is refused.
- **A refusal is recorded in its own transaction** (B-9). Evidence that CORE
  refused must not roll back with the thing it refused.

A refused collection returns `collected: false` instead of throwing, so one
empty wallet cannot abort a renewal sweep and turn one customer's billing
problem into an outage for everyone behind them in the list.

## Cancelled and expired are different facts

`cancelled` means the owner asked to stop while coverage continued; `expired`
means coverage ran out. Both are published. Collapsing them — the same argument
as `partially_captured` in migration 0009 — would make it impossible to tell a
customer who left from one whose payment failed.

A cancelled subscription keeps entitling until the period it already paid for
ends. If the current period was never paid, it is voided instead and there is no
coverage to keep.

## Usage is append-only, and recorded past the limit

`SubscriptionRepository` has no `updateUsage` and no `deleteUsage`. Append-only
is expressed by the absence of the operation rather than by a guard inside one,
and migration 0010 backs it with triggers that refuse UPDATE and DELETE on
`usage_record` outright. `usage_record_once UNIQUE (period_id, feature_key,
usage_reference)` is what makes at-least-once reporting count once.

Usage over the grant's limit is still recorded. Dropping over-quota consumption
would leave the billing and dispute basis incomplete; refusing further work is
the entitlement decision's job, not the recorder's.

No usage event is published. It is high-volume bookkeeping with no consumer
outside CORE, and the event stream carries business facts (ADR 0009). Nor is
there an event for a draft plan: nothing outside CORE can act on terms that can
still change.

## What is deliberately absent

**There is no entitlement-check endpoint.** ADR 0008 requires a new ADR before
any new synchronous path between systems is written, and an endpoint MARKET or
MOVE would call on every request is exactly that. `checkEntitlement` is
implemented, tested on both backends, and reachable in-process only. The
endpoint is recorded in `ROADMAP.md` as waiting on an owner decision.

The same applies to **usage reported by MARKET or MOVE**. The right shape is an
inbound event through the already-approved `POST /v1/events`, which needs a
contract from the producing system; `POST /v1/subscriptions/{id}/usage` is an
operator route, not a product integration path.

Policy decisions recorded as blockers rather than invented: proration on
mid-period cancellation or plan change, a grace window for `past_due`, trial
periods, quota rollover versus reset, and comped or overridden entitlement.
CORE's recorded default — that `past_due` entitles nothing — was chosen because
it is the reversible direction: a grace window can be granted retroactively,
while service already given cannot be recalled.

## Sources

Internal decision records: ADR 0008 (ownership boundaries and synchronous
paths), ADR 0009 (events carry business facts), ADR 0012 (regulatory pricing
undecided), ADR 0013 (subscription / entitlement in CORE), ADR 0018 (no
product-specific logic in CORE), and `docs/data-ownership.md`. The ADR bodies
are maintained as the project's decision record outside this repository; only
their titles and the register in `docs/adr/README.md` are available here, which
is why every policy gap above is recorded as a blocker instead of being filled
in.
