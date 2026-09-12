# Event normalisation and historical replay

Milestone 6. What CORE can now do that it could not before: take an event it
accepted months ago, read it under today's contract, decide whether it may be
applied, prove that a rehearsal changed nothing, apply it, and be asked
afterwards what happened.

Two things are documented here because they are two different problems that were
solved together: **normalisation** (how a stored envelope becomes something a
consumer may act on) and **replay** (how a chosen set of stored envelopes is
offered to consumers again, safely).

## Why there was a problem

Since migration 0007, `inbound_event` keeps every envelope CORE has ever
accepted. Until this milestone, the only thing that could act on one of those
rows was `InboundDispatcher`, and it only looks at rows that are `pending` and
due. So a row that went `dead` after exhausting its attempts — or one accepted
while a consumer had a defect — was **durable and unreachable at the same time**.
The data was kept for a recovery that had no mechanism.

The second problem was quieter and worse. Each of the four fulfillment consumers
validated its own payload, in its own way, at the moment it ran. Unifying that
into one layer immediately exposed two real defects that had been live:

- the `move.job.rejected` consumer accepted payloads with no `rejected_at`, a
  field the published contract marks required;
- a `move.job.completed` test fixture carried a `reason` key that the contract
  forbids (`additionalProperties: false`), and the consumer took it.

Neither was caught because there was no single place responsible for deciding
what an event *is*. That place is now `src/platform/eventing/normalize.ts`.

## Four stages, kept distinct

The design turns on refusing to blur these:

| Stage | What it is | Where |
|---|---|---|
| **raw inbound** | Bytes a producer sent. Untrusted in shape and content | request body, or an `inbound_event` row from any past version of CORE |
| **validated envelope** | Structurally an `EventEnvelope`: the transport fields exist and are well-formed. Says nothing about the payload | `assertEnvelope` |
| **canonical event** | One shape, one meaning, for one event type — regardless of which version arrived | `normalize()` → `CanonicalEvent` |
| **consumer effect** | What a handler does about it: a fulfillment, a capture, a notification | the module's `service.ts` |

A consumer now receives a `CanonicalEvent` and asks for its payload by expected
type. It does not see `version`, and it does not branch on it. **The reason for
the layer is exactly that:** if every consumer interprets versions itself, then
"what does this event mean" has as many answers as there are consumers, and they
drift silently. Version knowledge lives in one registry, in one file.

## The canonical event

```
CanonicalEvent {
  event_id        // the producer's identity for the fact; the idempotency key
  event_type      // must be a type CORE handles, or the event is refused
  version         // as it arrived; recorded, never propagated to consumers
  producer        // which system asserted it
  occurred_at     // when the producer says it happened (ISO 8601, UTC)
  received_at     // when CORE accepted it — CORE's own fact
  correlation_id  // threads the audit trail
  causation_id
  entity_type / entity_id
  organization_id // string | null — null means "the envelope does not say"
  payload         // canonical, per type and version
  envelope        // the original, verbatim
}
```

`envelope` is retained deliberately: replay republishes the original bytes, not
a reconstruction. A reconstruction would be a new event with a new identity, and
the inbox would let it through.

## Normalisation rules

`normalize(raw, receivedAt)` is total and pure: it returns
`{ ok: true, event }` or `{ ok: false, rejection, detail }` and throws nothing.
It is used in two places — at the ingress edge (where a rejection becomes a 400
to the producer) and inside replay (where it becomes a reported outcome).

Per event type, a private `RULES` registry holds a normaliser per version plus a
tenant extractor. Every normaliser enforces:

- **required fields present**, by name;
- **no unknown fields** — `additionalProperties: false` is honoured in code, not
  only in the JSON schema, because the schema is not what runs;
- **timestamps normalised** to ISO 8601 UTC, so two producers with different
  offset conventions cannot produce two spellings of one instant;
- **absent optional ≡ null**: `payment_authorization_id` missing and
  `payment_authorization_id: null` normalise to the same thing. This is the one
  real backwards-compatibility case in the current contract set, and it is the
  additive-optional pattern rather than a version bump.

Four rejection reasons, and they are reported, never repaired:

| Rejection | Meaning |
|---|---|
| `envelope_malformed` | not an envelope at all |
| `unknown_event_type` | CORE has no rule for this type |
| `unsupported_version` | the type is known, this version is not |
| `payload_malformed` | required field missing, unknown field present, or a field of the wrong shape |

**An event that cannot be normalised safely fails loudly and stays exactly as it
is.** Its `inbound_event` row is not touched — not its status, not its attempt
count. Guessing would be far worse than stopping: a refusal costs an operator an
investigation, whereas a guessed `organization_id` or a defaulted amount settles
money against the wrong party. The rejection detail names the offending *keys*,
never their values, so the report can be pasted into a ticket.

### Honest statement about versions

Only version 1 exists for all four inbound types today. The multi-version
dispatch path is therefore exercised only by the `unsupported_version` refusal.
This milestone did **not** test a real version-1-to-version-2 migration, because
there is no version 2 to migrate from. The structure is in place; the claim is
"a second version has one obvious place to go", not "a version migration has
been proven".

## Replay scope

There is no "replay everything". `assertNarrow` refuses a scope unless at least
one filter narrows it, and `limit` is mandatory and bounded to 1…1000.

Available filters: `event_ids`, `event_types`, `producer`, `statuses`,
`received_from`/`received_to`, `occurred_from`/`occurred_to`,
`organization_id`, `after` (a cursor), `limit`.

`statuses` defaults to `["pending", "dead"]` — the rows a replay exists to
rescue. Asking for `processed` rows is allowed but must be explicit, because
that is the only way to offer an already-handled event to consumers again.

The reason for compulsory narrowing is reviewability: an operator, and later an
auditor, must be able to read the command and know what it will touch before it
runs. A scope of "everything" cannot be reviewed, so it is not offered.

## Ordering

The total order is **`(received_at, event_id)`** — CORE's own receipt time,
tie-broken by the event id so the order is deterministic and a cursor can be
exact.

`occurred_at` is deliberately *not* the ordering key. It is the producer's
claim, and a producer with a skewed clock would then be able to reorder CORE's
history retroactively. `received_at` is the only timestamp CORE observed itself.
Paging uses a row-value cursor, `(received_at, event_id) > (:at, :id)`, matching
the sort exactly, so no event can be visited twice or skipped between pages.

There is no sequence column, so ordering is not *globally* total across
concurrent inserts sharing a timestamp — the event id makes it deterministic,
not semantically meaningful. Where real ordering matters, it is enforced by the
domain rather than by the replay: **an old event cannot move a fulfillment
backwards**, because the consumers use conditional transitions on the current
status. A stale acceptance arriving after a cancellation records what it can and
does not reopen closed work.

## Dry-run guarantees

`plan()` is the rehearsal. It returns the same report shape as a real run —
which events were found, in which order, which consumers each would reach, what
the outcome would be — and it writes nothing.

"Writes nothing" is not asserted by reading the code. It is proved by running
the identical service on a connection that **cannot** write:
`ReadOnlyQueryable` wraps a pool and runs every statement inside
`begin transaction read only`, so a write is refused by PostgreSQL itself with
SQLSTATE `25006`. The test asserts both directions on a real database:
`plan()` succeeds, and `run()` on the same scope fails with `25006` — and
afterwards nothing has changed in `fulfillment`, `inbound_event`, `inbox`,
`outbox`, `notification`, the ledger or `audit_entry`.

**A dry-run writes no audit entry either.** That is a real trade, made
deliberately: journaling a rehearsal would mean the rehearsal writes, which
destroys the only guarantee that makes a rehearsal worth having. A rehearsal is
therefore invisible after the fact; the run it precedes is not.

## Idempotency: redelivery vs. replay

These are different operations and the tool keeps them apart.

- **Redelivery** is a producer sending the same `event_id` again. Handled at
  ingress: the row already exists, nothing is re-queued, the producer is told it
  was accepted. Unchanged by this milestone.
- **Replay** is CORE deciding to offer a stored event to consumers again. The
  inbox is per `(consumer, event_id)`, so a consumer that already handled the
  event does nothing and one that never did, does.

Two modes, and only one of them can cause a second execution:

| Mode | Behaviour |
|---|---|
| `pending_only` (default) | publish and let the inbox decide. Safe against any scope, because whether an effect already happened is the inbox's question to answer |
| `reapply` | clear this event's inbox entries for its consumers first, so handlers run again. Explicit, named, documented — never a side effect |

`reapply` is for a consumer whose handler was wrong and has been fixed. It is
**not** a way around idempotency: the handlers still enforce their own
invariants, so a re-executed capture is refused by the ledger rather than
permitted by the replay.

What replay never does: rewrite an `event_id`, or wrap the envelope in a new one.
That is the cheapest possible way to cause a double effect — the inbox has never
seen the new id — which is exactly why the stored envelope is republished byte
for byte. A test submits a deliberately re-wrapped duplicate to show that even
then, the fulfillment's uniqueness on the order reference is what holds.

## Financial safety

There is no replay-specific branch anywhere in the money path. That is the
argument: the guarantee is not "replay is careful", it is "replay has no
privileges", and the invariants that protect the live path protect it unchanged.

Tested on real PostgreSQL, over the full lifecycle — wallet, credit, authorize,
`market.order.created` with a hold, `move.job.accepted`, `move.job.completed`:

- after the first replay: `settlement_state = captured`, held 0, available 6 000;
- after replaying the same two events again (dragged back into scope on purpose,
  so the inbox is the only thing standing between the replay and a second
  capture): `skipped_duplicate` × 2, and the balance, the authorization row and
  the settlement state are byte-identical;
- a replayed `move.job.rejected` releases the hold once; a `reapply` of it does
  not credit the wallet a second time;
- no second ledger entry, no second capture, no second release, no second
  settlement.

## Failure semantics

Replay does **not** wrap the run in one transaction. Thousands of events in one
transaction would make resumption impossible and would hold locks for the length
of the run. Each event is published on its own, and the report is the record.

Default behaviour is `stopOnError: true`, and it stops at the first failure
because later facts must not be applied on top of an earlier one that never was.
The report then says:

- **which** event failed (`failure.event_id`) and **why** (`failure.reason`);
- what preceded it — applied, and visible in `outcomes`;
- what followed it — not started, and still `pending`;
- **where to resume**: `resume_after` points *before* the failing event, so a
  resume retries it rather than stepping over the one event that did not work.

The failing row keeps the dispatcher's own schedule: `attempts`,
`next_attempt_at` and `status` are left untouched. Replay does not spend the live
queue's retry budget, so a failed replay cannot delay ordinary delivery.

`continue-on-error` exists for the different question "how bad is it" — survey
every failure in a scope without stopping. It is opt-in.

Resumption is tested end to end on both backends: a consumer that fails on the
middle of three events, then the defect is fixed, then a re-run from
`resume_after` — and the retried event does not produce a second effect for the
consumer that had already succeeded on it.

## Concurrency

One replay at a time, enforced by a lock, and a second one is **refused rather
than queued** — a replay waiting behind another would eventually run against a
state the operator never inspected.

- in-memory: `InProcessReplayLock`, documented as single-process only;
- PostgreSQL: `PgAdvisoryReplayLock`, a session-scoped `pg_try_advisory_lock` on
  a dedicated client, so the exclusion holds **between processes**. Tested with
  a genuinely separate connection pool, which is what a second CORE instance is;
  an in-process lock would let both through.

The lock is released in a `finally`, tested by making the very first store call
throw: one unexpected error must not lock replay out until a restart.

## Tenant isolation

`organization_id` on a canonical event comes from the payload via the type's
tenant extractor, and it is `string | null` where null means **the envelope does
not say**.

When a scope names an organization, three outcomes are possible:

- the event carries that organization → in scope;
- it carries a different one → `skipped_tenant_mismatch`, untouched;
- it carries none → `skipped_tenant_unknown`, untouched, reason citing **B-23**.

CORE *could* resolve `move.*` closure events to a tenant by looking up the
fulfillment, and deliberately does not. The envelope is the evidence; resolving
tenancy by inference is how one organization's history ends up replayed under
another's scope. An explicit refusal beats a plausible link — the same principle
as B-23, which is the underlying cause: the three closure contracts carry no
`organization_id`. Widening them is a versioned change to contracts MOVE and
MARKET consume, so it stays a recorded dependency rather than something replay
works around.

## Auditability

**No new table.** Two entries in the existing audit trail, on entity
`event_replay` keyed by `replay_id`:

- `event_replay.started` — who, when, the mode, the full scope;
- `event_replay.finished` — the counts per outcome, plus up to 20
  `failed_event_ids`.

Counts and identifiers only. Never a payload: an event can describe a real
person's order, and the audit trail is read by more people than the database is.
The existing scrubber redacts token-shaped keys as it does everywhere else.

A counters table was considered and rejected. Audit already carries the truth,
and a second table describing what replay did would become a competing account
of what the domain state is. **Replay is not a source of truth about the
domain** — the domain is. Replay records only its own activity.

## Operating surface: CLI, not an endpoint

```
npm run replay -- --event-types market.order.created --limit 100
npm run replay -- --event-ids <id> --mode reapply --execute
```

Flags: `--event-ids --event-types --producer --statuses --received-from
--received-to --occurred-from --occurred-to --organization --after-received-at
--after-event-id --limit --mode --execute --continue-on-error`.

Decisions, and why:

- **Dry-run is the default.** `--execute` is required to write. The dangerous
  form of the command is the longer one to type.
- **CLI rather than HTTP.** This is an internal operational tool with no external
  consumer, so it takes the smallest surface that works. There is deliberately
  **no replay endpoint on the ingress**: ingress is reachable by MARKET and MOVE
  with service credentials, and a replay route there would let a producer replay
  CORE's history. B-5 (deployment topology undecided) also means an HTTP surface
  has nowhere it could be safely placed yet.
- **Authorized, not merely local.** `REPLAY_TOKEN` is authenticated and then
  checked for the `events.replay` permission, which is granted to
  `platform_admin` **only** — never to `service`. Every service credential holds
  `events.submit`; if replay reused it, MARKET and MOVE could each replay
  everything. Asserted in a test, not assumed.
- **Credentials come from the environment, never from argv**, so a token does not
  end up in shell history or a process list.
- **Rate control** is the lock plus the bounded `limit`: at most one run, at most
  1000 events, so there is no way to ask the tool for an unbounded amount of work.
- Exit code 1 on any failure or early stop, so a wrapper script cannot mistake a
  partial run for a clean one.

## Tests

`tests/event-normalisation.test.ts` — 17 tests.
`tests/replay.test.ts` — 24 in memory, 46 with `DATABASE_URL` set (both
backends plus the two PostgreSQL-only suites).

The dangerous cases, all of which run on real PostgreSQL: dry-run zero-mutation
snapshot and the read-only-connection proof; double replay causing no double
effect; the full financial lifecycle with no second capture, release or ledger
entry; a re-wrapped duplicate; an out-of-order stale event causing no regression;
ordering by receipt rather than by the producer's clock; failure with a
diagnosable report and a working resume; cursor paging; tenant unknown and
tenant mismatch; unnormalisable rows left untouched; cross-pool advisory-lock
exclusion; lock release on an unexpected error; the authorisation boundary; and
the CLI parser's defaults and its refusals.

The CLI's entry point lives in `main.ts` rather than behind an
"am I the entry point" guard in `cli.ts`. The guard was tried first, on
`process.argv[1]`, and the runner replaces that with its own path — so the
command printed nothing and exited 0. Usage errors throw a `CliUsageError`
instead of calling `process.exit` inside a parser, which is what makes the parser
testable. The surface was also exercised end to end against a real database with a
real `platform_admin` token: dry-run, `--execute`, a second `--execute` finding
nothing, and four journal entries naming the principal.

## What this milestone did not do

- **B-24** was not touched: no `claimed_at`, no `processing` status, no schema
  columns, no migrations. Replay needed none of them, and inventing them here
  would have pre-empted a decision that needs its own cycle.
- **B-23**, **D-6**, **D-7**, **D-8** remain external dependencies. Replay
  records where B-23 bites (tenant-scoped replay of `move.*`) rather than
  working around it.
- No new index on `inbound_event`. The selection is bounded and operator-driven,
  not on a request path; adding an index for a tool that runs by hand would be a
  migration in search of a problem.
