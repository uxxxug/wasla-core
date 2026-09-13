# Selection parity: what a store selects *by*

Milestone 21. Companion to `docs/read-path-parity.md` (milestone 20), which
proved every shaped column is reachable and that one written row comes back the
same on both backends. Neither of those can see a **predicate**: which rows a
query picks out of many, and in which order it picks them.

Every queue operation in CORE is written twice — once as SQL in
`src/platform/eventing/pg-*.ts`, once as TypeScript in the reference stores —
and until this cycle nothing compared the two. That is the family with the worst
history in this repository: B-22 (a claim that only read), B-24 (a lease with no
`claimed_at`) and B-25 (a select-then-update recovery race) were all found here.

## What the gate does

`tests/selection-parity.test.ts` builds the **same population twice**, once in
the in-memory backend and once in Postgres, through the stores' own public APIs
— never by inserting rows behind the store's back, because a population built by
raw SQL would prove nothing about the code that writes rows.

- 6 outbox events, 6 inbound events, 6 deliveries, ids fixed
  (`00000000-0000-4000-8000-…`), one minute apart from a fixed clock, so
  `created_at`/`received_at` is a total order and any difference in ordering is
  visible instead of a tie.
- The rows are driven into real states through `claimDue`, `markPublished`,
  `markFailed`, `markDead`: one published, one failed and due later, one holding
  a live lease, one dead, two untouched.
- ~40 cases then run the same selection against both backends and compare the
  **ordered list of ids**: `all`, `byStatus`, `claimDue` (at several instants,
  with and without a limit), `reclaimExpired`, `selectDead`, `counts`, `select`,
  `forEvent`, `subscriptionsFor`.

Three properties keep the comparison honest:

1. **Each case declares how many rows it expects**, and that expectation is
   asserted on the reference backend in a test that runs *without* a database.
   A case that silently starts selecting nothing — the failure mode of every
   "list" test — fails instead of passing vacuously.
2. **Every case gets a freshly built population on both backends**, so the
   mutating selections (`claimDue`, `reclaimExpired`) cannot leak into each
   other and no case depends on the order the cases run in.
3. **A premise test** asserts the two backends hold the same population before
   any selection runs. Without it, an agreement would mean nothing and a
   disagreement would be blamed on the wrong code.

## The divergence it found

`InMemoryOutbox.claimDue` did not sort at all. It walked the insertion order of
a `Map`, while `PgOutboxStore.claimDue` ordered by `(next_attempt_at,
created_at)`. With one row failed and re-scheduled, the two backends claimed
*different rows for the same call*: the reference backend served the event that
was appended first, Postgres served the one that had been due longest. Under a
limit, that is not a cosmetic difference — it decides which work a worker gets
and which work waits.

The same gap was in all three `reclaimExpired` implementations, and the Postgres
ones ordered by `next_attempt_at` alone, which is not a total order over rows
that became due in the same millisecond: with a limit, which abandoned claims a
recovery run recovered was left to the query plan.

Fixed at the root, not in the test:

- `src/platform/eventing/queue-order.ts` — one comparator, `inDueOrder`, with
  the ordering rule and its reasoning written down once: longest-overdue first,
  then the row's own arrival as an explicit tiebreak.
- The three reference stores use it in both `claimDue` and `reclaimExpired`.
- The three Postgres recovery statements spell the same two keys in their
  `order by`.

## The scenario the ordinary cases could not see

A batch claim stamps one lease expiry on every row it takes, so after a single
claim, due order and insertion order agree — and a comparison between them
passes no matter which one a backend implements. Removing the ordering from a
reference `reclaimExpired` did not fail the suite.

So the test adds a **staggered-lease scenario**: three rows are claimed
together, the middle one is failed and claimed again later, and its lease
therefore runs out last. Due order is first, third, second; insertion order is
first, second, third. A recovery with `limit = 2` frees different rows under the
two orders. The reference backend is checked against the intended discipline
without a database, and against Postgres when one is present.

## Falsification

Every gate was broken on purpose and confirmed to fail, then restored:

| # | Break | Result |
|---|---|---|
| F1 | reference `outbox.claimDue` back to `Map` order | 2 failed |
| F2 | drop `claimed_at === null` from reference `delivery.claimDue` | 2 failed |
| F3 | Postgres `outbox.claimDue` ordered by `created_at` only | 1 failed |
| F4 | drop `claimed_at is null` from Postgres `delivery.claimDue` | 1 failed |
| F5 | reference `inbound.reclaimExpired` back to `Map` order | 2 failed |
| F6 | reference `delivery.reclaimExpired` back to `Map` order | 2 failed |
| F7 | reference `outbox.reclaimExpired` back to `Map` order | 2 failed |

F2 is worth recording: on the first attempt it did **not** fail. At every
instant the existing cases claimed at, the held row's lease had not run out, so
`next_attempt_at <= now` excluded it anyway and the `claimed_at` half of the
predicate was doing nothing observable. The fix was a case per queue that claims
*after* the lease has expired — the B-24 situation, where only `claimed_at`
keeps a held row from being served twice. That case is what F2 and F4 now fail.

Not falsifiable by construction: the secondary sort key added to the Postgres
recovery statements. Forcing two rows to become due in the same millisecond
through the stores' own APIs is not something the fixed clock can arrange here,
so that key is justified by the plan's freedom rather than by a failing test.

## Scope

Limited to the listing and claiming paths of `outbox`, `inbound_event` and
`event_delivery`. Selection in other tables (ledger, wallet, tenancy) is not
covered by this gate.
