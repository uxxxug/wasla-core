# Queue revival

Bringing a dead `outbox` row or `event_delivery` row back into the queue it fell
out of. B-27.

## The gap this closes

B-22 gave the outbound queues a `dead` status: a row that exhausted its attempts,
or was refused outright by a subscriber, stops being retried and waits for a
person. B-25 added a second route to the same state — a row abandoned by a dying
worker more times than its recovery budget allows. B-26 made the acknowledgement
that writes it fence-safe.

Across those three cycles nobody built the way out. `docs/replay.md` could bring
back an `inbound_event`; nothing could bring back an outbound one. The recovery
procedure was an `UPDATE` typed into a production console: unjournalled, unbounded,
free to touch a row that had already been published, and performed by whoever
happened to be awake. A terminal state with no exit is not durability, it is a
hole with a name.

## What a revival is

**A revival returns the row to `pending` and stops.**

It publishes nothing. The outbox relay then picks up the row and publishes it; the
delivery worker then picks up the delivery and POSTs it. Both do exactly what they
always do, to the envelope that was already stored.

That is the answer to the question B-27 was blocked on, and it is worth stating
plainly because the alternative was reasonable-sounding: reviving a dead outbox row
**re-publishes the original envelope unchanged** — same `event_id`, same
`occurred_at`, same payload, same signature — rather than emitting a fresh envelope
describing the same fact. A new envelope would need a second publish path, and
every consumer inbox and every subscriber that deduplicates on `event_id` would see
a month-old fact as news. The duplicate effect would be bought for nothing.

It also means there is exactly one publish path in CORE, which was the point of
the outbox in the first place.

## What it writes, and what it deliberately does not

Per row, matched on `status = 'dead'` so it is a transition and not an overwrite:

| Column | Revival | Why |
| --- | --- | --- |
| `status` | `dead` → `pending` | The exit. |
| `next_attempt_at` | now | The operator has decided the moment; the backoff the failure computed is no longer the relevant clock. |
| `claimed_at`, `claim_token` | cleared | A pending row still holding a claim is due and unclaimable at once. |
| `reclaims` | `0` | Counts worker deaths — evidence about the worker, not about this row. |
| `attempts` | **unchanged** | See below. |
| `last_error` | **unchanged** | The only on-row evidence of why the row died. |

`attempts` is preserved for three reasons that all point the same way. It drives
the backoff (`baseBackoffMs * 2 ** attempts`), it drives the derived `retrying`
reading (`pending` with `attempts > 0`), and it is the record of how many observed
failures this row caused. Zeroing it would falsify two readings and turn one
operator decision into an unbounded retry budget: die at five, revive, retry five,
die, revive.

The consequence, stated rather than hidden: **a row that died at `maxAttempts` gets
exactly one further attempt.** If that attempt fails the row is dead again and
needs another revival. This is not a limitation to be worked around — it is what
makes revival bounded by construction and puts every retry decision in the audit
journal beside the name of whoever took it.

## Refusals

- **A row that is not dead is never touched.** `selectDead` filters on the status
  and `revive` matches on it inside the same statement, so a `published` event
  cannot be republished by an operator pasting the wrong id — on either backend.
- **A delivery whose subscription is inactive, or gone, is refused** as
  `skipped_subscription_inactive` and left dead. Fan-out only queues a delivery for
  an `active` subscription, so deactivating one is how an operator stops CORE
  sending to a subscriber. The delivery worker does not re-check `active` — it only
  reads rows that already exist — so without this refusal revival would be the one
  path in CORE that POSTs to an endpoint somebody deliberately switched off, at the
  request of an operator looking at a dead-letter queue rather than at the
  subscription list. A delivery that was already `pending` when the subscription
  was deactivated is no longer a different case: since B-28 the worker suppresses it
  instead of sending it, so the whole loop is closed — deactivate, the queued rows
  are dead-lettered with the reason recorded, reactivate, revive, and the subscriber
  receives the original envelope. Reviving before reactivating is refused, so an
  operator working from the dead-letter queue cannot undo the switch by reviving
  past it.
- **A scope that does not narrow is refused.** The queue name is not narrowing:
  `--queue outbox --limit 1000` reads "revive everything that ever died", which is
  precisely the request that has to be spelled out rather than defaulted into. At
  least one filter besides the limit is mandatory, and an empty filter list is
  refused rather than interpreted.
- **The limit is mandatory and bounded** at 1..1000, the same ceiling replay uses,
  so an operator has one number to remember.

## Reporting and resuming

One row at a time, each its own statement, with no transaction around the loop: the
rows are independent, a failure at row 300 must not discard 299 correct revivals,
and per-row commits are what make the resume cursor mean anything.

The report mirrors `ReplayReport`: `revival_id`, `queue`, `dry_run`, the scope as
given, the actor, timestamps, `discovered`, `counts` per outcome, the per-row
`outcomes`, `stopped_early`, `failure`, `resume_after` and `more_available`. On
failure `resume_after` points **before** the row that failed, so resuming retries
it instead of stepping over the one row that did not work.

A run stops on the first failure, unlike a replay. A replay can fail on one event's
own merits and succeed on the next; the only way a revival's single-row status
update fails is that the database refused it, which the next row will meet too.
Carrying on would produce a long report of one error.

Ordering is `(occurred_at, event_id)` for the outbox and `(created_at,
delivery_id)` for deliveries, compared as row values rather than column by column,
so paging cannot repeat or skip a row that shares a timestamp with another. The
outbox orders by `occurred_at` because the in-memory backend has no `created_at`
and the two backends must agree (B-12).

## Idempotence

Running the same revival twice is the cheapest mistake available, so it is
harmless and legible: the rows are no longer dead, so they are not discovered, and
nothing is published twice. A row that stopped being dead between the select and
the update is reported as `skipped_not_dead` rather than passed over silently —
"somebody else already did it" is an answer the operator needs.

## Authority and audit

`events.revive`, held by `platform_admin` alone. Its own permission rather than a
reuse of `events.replay`, because the two reach different systems: a replay
re-drives CORE's own consumers, a revival causes a signed POST to leave the
building for a partner's webhook. `events.submit` was not an option — every service
caller holds it, so reusing it would have handed MARKET and MOVE the ability to
re-send CORE's dead-lettered events.

Two journal entries per run, `queue_revival.started` before the first write and
`queue_revival.finished` after the last, both naming the actor. The start entry
exists so that a run which dies half way still leaves evidence that it began and
with what scope. The finish entry carries the counts, the failure, the resume
cursor, and the first 50 ids actually brought back — bounded, because a
thousand-row run must not write a thousand-line audit entry, and included at all
because those ids are what somebody investigating a duplicate downstream effect
needs in order to explain why an old event was published again. No payloads, in the
report or the journal.

`plan()` is a dry run that **writes nothing at all** — no status change and no
audit entry either, the same absolute guarantee `ReplayService.plan` gives. A dry
run that journals itself is a dry run that writes.

Two revivals exclude each other through an advisory lock, refused rather than
queued: a revival that waits runs later, against a state the operator who ordered
it never looked at. The lock uses **its own key**, separate from replay's, because
the two touch different tables — refusing an urgent revival because somebody is
replaying last month's inbound events would be exclusion that protects nothing.

## Operating it

A CLI, and a separate one from `replay`, for the reason replay is a CLI at all:
this is an internal action performed a handful of times a year, and an HTTP route
would be permanent surface area needing its own rate limits, contract and exposure
review. Sharing the replay command behind a flag was the alternative and was
rejected — the two take different filters, different cursors and a different
permission, and one parser covering both is where an operator typos `--mode
reapply` at a queue that has no modes.

```bash
# What would happen. Writes nothing.
REVIVE_TOKEN=… DATABASE_URL=… npm run revive -- \
  --queue outbox --event-types core.fulfillment.completed --limit 50

# Do it.
REVIVE_TOKEN=… DATABASE_URL=… npm run revive -- \
  --queue event-delivery --subscription <id> --limit 50 --execute

# Continue where the last page stopped.
REVIVE_TOKEN=… DATABASE_URL=… npm run revive -- \
  --queue event-delivery --subscription <id> --limit 50 --execute \
  --after-created-at 2026-09-01T10:00:00.000Z --after-delivery-id <id>
```

- **Dry run unless `--execute`**, because the safe thing must be what happens when
  an argument is forgotten.
- The token comes from `REVIVE_TOKEN`, never from an argument: a token in `argv` is
  a token in the shell history and in every `ps` listing on the host. Shell access
  is not authority, and the journal has to name a person.
- Both halves of a cursor or neither. Half a cursor is not a cursor: resuming from
  a timestamp without its tiebreak repeats or skips every row sharing it.
- Exit code 1 on any failure or early stop, so a wrapper script cannot mistake a
  partial revival for a finished one.
- Outbox filters: `--event-ids`, `--event-types`, `--producer`, `--entity-type`,
  `--entity-id`, `--occurred-from`, `--occurred-to`.
  Delivery filters: `--delivery-ids`, `--event-ids`, `--subscription`,
  `--created-from`, `--created-to`.

## Tests

`tests/queue-revival.test.ts`, on both backends: the original envelope arriving
unchanged at a bus consumer and at a subscriber, `attempts` and `last_error`
surviving while the claim and the reclaim budget are cleared, a published row
refusing to be resurrected both through the service and directly through the store,
an inactive subscription refusing a delivery, a plan writing nothing including no
audit entry, every refusal of a scope, the journal's counts and ids, a second run
doing nothing, cursor paging over two rows, the advisory lock refusing a
concurrent run, revival and replay not blocking each other, the permission held by
`platform_admin` alone, and the parser's defaults and refusals.

Three mutations were applied to confirm those tests can fail: dropping `status =
'dead'` from the update, zeroing `attempts` on revival, and removing the
inactive-subscription refusal. Each was caught on both backends.

## What this did not do

- **No schema change and no migration.** Revival is a status transition over
  columns that already exist.
- **No new index.** The selection is bounded and operator-driven, not on a request
  path; an index for a command run by hand would be a migration in search of a
  problem.
- **No HTTP route**, for the reason above.
- **No automatic revival.** Nothing sweeps the dead-letter queue on a timer. A row
  reached `dead` because repeating it stopped being safe to decide automatically,
  and a scheduled revival would be the retry loop B-25 existed to bound, wearing a
  different hat.
- **Nothing in MOVE or MARKET.** A revived outbox row re-runs fan-out against
  currently-active subscriptions; a revived delivery reaches a subscriber that must
  already be idempotent on `event_id`, which CORE has required since B-11.
