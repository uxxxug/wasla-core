# Selection parity for the module read paths

Milestone 21 gated a **predicate** for the first time: which rows the three
eventing queues pick out of many, and in what order. This is the same gate
applied to everything else in the repository that returns a list — the
notification dispatcher, the money reads, the subscription plan/period/usage
reads, the identity and membership lookups, and the organization, fulfillment
and geography listings.

The gate is `tests/module-selection-parity.test.ts`.

## The question

Every listing in CORE is written twice: once as SQL in a `pg-repository.ts`, and
once as TypeScript over a `Map` in a reference repository. The SQL says
`order by created_at, notification_id`. The reference implementation said
`[...this.notifications.values()].filter(...)` — the insertion order of a `Map`.

Those two agree whenever rows are inserted in the order the SQL sorts them into,
which is exactly what a fixture does when it seeds a population in a loop. So
every existing test passed, on both backends, while the two implementations
disagreed about the order a caller receives. Under a `limit` they disagree about
which rows a caller sees **at all**.

## What makes the population discriminate

The fixture inserts every batch in the **reverse** of the order its listing must
return: newest-first for anything sorted by a timestamp, descending code order
for plans and regions, descending name for cities and service areas. Several
rows share a timestamp or a name so the tiebreak is exercised rather than
assumed.

That inversion is the whole measurement. A store that returns insertion order
now returns precisely the reverse of the right answer, and a sort key that is
not total now has a tie to get wrong.

Three properties per case:

1. **A declared row count**, asserted against the reference backend with no
   database. A case that silently stops selecting anything fails instead of
   passing vacuously.
2. **A declared order** for the listings this cycle is about, computed from the
   fixture definitions rather than read back out of a store. "Both backends
   agree" cannot mean "both are wrong in the same way".
3. **A premise test** proving the two backends hold the same population before
   any selection runs.

## The doctrine

`src/platform/persistence/list-order.ts` states it once:

> A reference listing sorts by the same keys as its SQL, and the key list must
> be total — it ends with the primary key.

`orderedBy(rows, ...keys)` returns a new array and never reorders the store;
`descending(key)` is for the listings whose SQL says `desc`. The comparator lives
in one file so a new repository inherits the discipline instead of re-deciding
it.

`src/platform/eventing/queue-order.ts` gained the same totality requirement: its
comparator now takes the row's own id as a third key, because
`(next_attempt_at, arrival)` is not total either — a batch written in one
transaction shares both timestamps, and a `limit` over a non-total order leaves
the tail of the batch to the `Map` on one side and to the query plan on the
other.

## What it found

**Nineteen reference listings returned insertion order.** Notification
(`forEvent`, `byStatus`, `list`, `claimDue`, `reclaimExpired`, `recipientsFor`,
`listRecipients`), money (`listAuthorizations`, `allAuthorizations`,
`transactions`), subscription (`listPlans`, `listGrants`,
`listSubscriptionsForOwner`, `listSubscriptionsByStatus`, `listUsage`), identity
(`listIdentities`, `listLinksForIdentity`, `listMemberships`), organization
(`list`), fulfillment (`all`) and all four geography listings now sort by the
keys their SQL declares.

**Seven Postgres orders were not total.** `notification.forEvent`,
`byStatus`, `list`, `claimDue` and `reclaimExpired`, and the subscription
owner/status and usage reads, ordered by a timestamp alone. Under a `limit` —
`notification.list` has one — the tie decided which page a caller saw, and the
plan decided the tie.

**A claim returned its batch in storage order.** This is the discovery of the
cycle and the one that no static reading would have produced. All four lease
queues claim with

```sql
update … set claim_token = …
where id in (select id from … order by next_attempt_at, … limit $2 for update skip locked)
returning …
```

The `select` is ordered. `update … returning` is not: it hands rows back in the
order it updated them, which is a heap scan. So the *selection* was correct and
the batch the worker then processed was in storage order — matching due order
only while rows happened to be inserted in the order they came due, which is
what every fixture did until this one inverted it. Milestone 21's own gate
passed for that reason.

`notification.claimDue` is where the inverted population caught it: Postgres
returned the three rows in insertion order, the reference backend in due order.
The other three queues had the identical statement shape and the identical
defect.

Fixed by carrying the due order out of the selection rather than trying to
recover it afterwards — the update overwrites `next_attempt_at` with the lease
expiry, so afterwards the due order is gone:

```sql
with due as (select id from … order by <due keys> limit $2 for update skip locked),
     ranked as (select d.id as due_id, row_number() over (order by <due keys>) as due_rank
                from due d join … on …),
     claimed as (update … from ranked r where …id = r.due_id
                 returning r.due_rank as due_rank, <columns>)
select <columns> from claimed order by due_rank
```

The window function is computed in a second CTE because `for update` and a
window function cannot appear in the same query level.

## Falsification

Five breaks, five caught:

| # | Break | Caught by |
|---|---|---|
| F1 | `notification.byStatus` reference listing back to `Map` order | the no-database order test |
| F2 | the Postgres outbox claim back to plain `update … returning` | the cross-backend claimed-batch order test |
| F3 | `notification.list` SQL order flipped from `desc` to `asc` | the cross-backend cases for `list()` and `list({limit: 2})` |
| F4 | the `limit` dropped from the reference `notification.list` | the declared-count test and the declared-order test |
| F5 | `geography.listCities` reference listing back to `Map` order | the no-database order test |

Each was restored from a backup immediately after the failure was observed, and
the suite re-measured.

## Not covered here

- **Ties in the queue comparator's third key.** Forcing two queue rows to share
  both `next_attempt_at` and their arrival timestamp through the stores' own
  APIs is not something the fixed clock arranges here; the key is stated in both
  implementations and gated by reading, not by a case.
- **Listings with no second caller**, such as `counts()` aggregations, which
  return a map rather than an order.

## Measurement

599 passed / 147 skipped without a database; 1161 in the main file set and 1 in
the cluster file with `DATABASE_URL` set. The known
`tests/migration-0011-lifecycle.test.ts` local oddity — the file reported FAIL in
the combined run while its single test passes, and passing standalone and in CI
— reappeared unchanged and is recorded rather than hidden.
