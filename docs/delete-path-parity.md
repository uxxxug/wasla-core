# `ON DELETE` and delete-path parity

Milestone 17. What the four earlier parity cycles — uniqueness, checks, foreign
keys, triggers — deliberately left behind, and why closing it looks like a set
of gates rather than a set of new features.

## What was actually wrong

Nothing in the code was wrong. Every one of the four cycles ended with the same
sentence in its "what this cycle did not do": the reference backend models no
referential action, and the delete halves of the four append-only triggers are
*unreachable* rather than enforced. Unreachable was true when each cycle
measured it. The defect was that **nothing kept it true**. A migration could add
`ON DELETE SET NULL` tomorrow, or a store could grow a `deleteUsage`, and every
exemption that read "no caller can express this write" would silently become
false while the whole suite stayed green.

An exemption that is only checked when a human remembers to re-measure it is a
comment, not a guarantee.

## Measured first, from the catalog and the source

| Question | Answer |
|---|---|
| Foreign keys in the schema | **30** |
| `ON DELETE NO ACTION` | **29** |
| `ON DELETE CASCADE` | **1** — `plan_grant_plan_id_fkey` |
| `ON UPDATE` other than `NO ACTION` | **0** |
| Tables that are a foreign-key parent, so a delete there orphans or cascades | **15 of 32** |
| Places in `src/` that remove a row | **3** |

The three: `inbox`/`pg-inbox` releasing a consumer's claim, the rate-limit
counter pruning closed windows, and `InMemoryTransactionBoundary` unwinding a
write on rollback. `inbox` and `rate_limit_counter` are neither the parent nor
the child of any key and carry no trigger; the rollback path is not a delete a
caller can reach.

## What was added

`src/platform/persistence/delete-actions.ts` — two declarations and nothing
else:

- `REFERENTIAL_ACTIONS`, the `ON DELETE` and `ON UPDATE` action of all 30 keys.
  29 are `NO ACTION`, which the reference backend models correctly *by doing
  nothing*: `NO ACTION` means the database refuses a delete that would orphan a
  child, and in memory there is no delete to refuse. The one `CASCADE` is
  declared **`modelled: false`** with its reason, because pretending otherwise
  would be the more dangerous mistake — it would read as done.
- `DELETE_PATHS`, the three places a row is removed, each with the reason it
  cannot break a referential rule or an append-only trigger.

`tests/delete-parity.test.ts` — four gates that hold the declarations to the
world, one gate that reads the live schema, and two outcome probes:

| Gate | What it fails on |
|---|---|
| An action for every key | A key with no declared action, or an action declared for a key that does not exist |
| Unmodelled means unreachable | An unmodelled action with no reason, or one whose parent table a delete path now touches |
| No delete of an unmodelled parent | A port growing `deletePlan`/`removePlan`/`purgePlan` |
| Row removal only where declared | Any file in `src/` containing `delete from`, `truncate`, `.delete(` or `.clear(` that `DELETE_PATHS` does not name — and any declared file that no longer removes a row |
| Every removal-shaped operation classified | A new `release`/`prune`/`forget`/`evict`/`purge`-shaped method on any port until somebody says whether it deletes a row or releases a lease |
| Against the live schema | A declaration that disagrees with `confdeltype`/`confupdtype`; a delete path touching a table that has gained a key in either direction or a trigger |

The classification gate is the one that matters most in practice. `clear` and
`truncate` appear nowhere in `src/` today and are scanned for anyway: a gate that
only catches the delete somebody has already written is not a gate. Four ports
expose `reclaimExpired`, which *sounds* like a delete and is an `UPDATE` — each
is recorded as a lease release with the reason the row itself must survive
(an outbox envelope is the record of what CORE published; an inbound event is
what replay reads; a delivery's attempt history is the evidence B-27 revival
works on).

## The one delete a caller can reach, probed on both backends

Four gates say what cannot happen. Two probes say what does happen, because
"the only reachable delete behaves the same in both backends" is an outcome and
an outcome has to be run:

- releasing a claim lets the next attempt claim the same event again, and `seen`
  goes back to false — on memory and on Postgres;
- releasing a claim that does not exist is a no-op rather than an error.
  Delivery is at-least-once and `release` is called from failure paths, so a
  duplicate release is normal traffic. Postgres deletes zero rows; the reference
  backend must not throw where Postgres shrugs.

## Falsified before being trusted

Each gate was broken on purpose and watched to fail:

| Change | Result |
|---|---|
| `city_country_code_fkey` declared `ON DELETE SET NULL` | live-schema gate failed: `ON DELETE no action in the schema, set null declared` |
| The cascade declared `modelled: true` | two failures — the mismatch and the "would pass vacuously" guard |
| A `plan` entry added to `DELETE_PATHS` | three failures — reachable unmodelled action, a declared file that removes nothing, and a delete path on a table with keys and triggers |
| `inbox.purgeEverything` added to the memory store | classification gate failed on `inbox.purgeEverything` |
| `InMemoryInboxStore.release` made a no-op | the behaviour probe failed, and so did the stale-declaration half of the source gate |

## What this cycle did not do

- **It added no delete path.** Audit entries, ledger entries, usage records and
  reputation signals are append-only by design and the schema has triggers
  saying so. Adding a delete so a cascade could be observed would weaken the
  design to make a test prettier.
- **It did not model the one cascade.** `plan_grant_plan_id_fkey` stays
  unmodelled, and is now unmodelled *and enforced as unreachable*, which is a
  weaker claim honestly checked rather than a stronger claim asserted.
- **It does not catch a delete written in raw SQL text loaded at run time.** The
  source gate reads `src/**/*.ts`; a `delete` assembled from fragments or read
  from a file at run time would pass it. Every query in this repository is a
  literal in a `.ts` file, and the gate's scope is exactly that fact.
- **It says nothing about column-level parity** — `NOT NULL`, defaults and
  types. Measured while here: 270 columns, **212 `NOT NULL`**, **49 with
  defaults**, and the reference backend enforces nullability only where a text
  rule happens to mention it. That is the next family, recorded as milestone 18.
