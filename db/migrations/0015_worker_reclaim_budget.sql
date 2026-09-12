-- WASLA CORE — migration 0015: give an abandoned claim its own budget
-- Forward only, additive. No table here is owned by MOVE or MARKET.
-- Rollback: db/migrations/0015_worker_reclaim_budget.down.sql
--
-- Why this column exists (blocker B-25).
--
-- Migration 0014 made an abandoned claim visible and recoverable: `reclaimExpired`
-- returns a row whose worker died to the pending pool and counts the recovery.
-- What it deliberately did not do was charge that recovery against `attempts`,
-- because nobody observed the work fail. Charging it would mean five ordinary
-- deploys dead-letter five perfectly healthy events at `maxAttempts = 5`.
--
-- The cost of that choice is the mirror image, and it is the only unbounded
-- failure mode left in these queues: a payload that kills the worker *every*
-- time — an out-of-memory on one oversized event, an infinite loop on one
-- malformed field — is recovered, re-claimed, killed, recovered, for ever. It has
-- no attempt limit, it never reaches a terminal state, and so the one state that
-- summons a human is the one state it can never reach. It is visible (each pass
-- rewrites `last_error` and increments the `reclaimed` counter) but nothing stops
-- it.
--
-- Two failure modes need two budgets. `attempts` counts observed failures and
-- drives the retry backoff. `reclaims` counts abandonments — attempts nobody saw
-- end — and drives nothing except this limit. Neither can starve the other:
-- a rolling restart cannot consume the retry budget of a healthy event, and a
-- poison payload cannot hide behind an untouched `attempts` for ever.
--
-- Why a separate counter and not `attempts`.
--
-- `attempts` has two existing readers that would both be wrong if a reclaim
-- incremented it. The relay computes its backoff as `baseBackoffMs * 2 **
-- attempts`, so a row that was abandoned twice and never actually failed would
-- start its first real retry four times later than intended. And `counts()`
-- derives `retrying` as `status = 'pending' AND attempts > 0`, so an abandoned
-- row would be reported as retrying when nothing has been tried. Adding a second
-- meaning to `attempts` is cheaper to write and more expensive to own.
--
-- Note that `notification` solves the same problem the other way, by charging the
-- attempt at claim time (`attempts = attempts + 1` inside its claim), so its
-- abandonment budget and its failure budget are the same number. That is
-- consistent within that table and is not being changed here: doing the same to
-- these three queues would alter the meaning of `attempts` and the backoff curve
-- of every existing row, which is exactly what B-22 declined to do under cover of
-- a concurrency fix.
--
-- Existing rows.
--
-- Every existing row gets 0, which reads as "has never been abandoned". That is
-- the correct answer for every row that exists when this runs, including any row
-- genuinely in flight: if its worker then dies, the recovery is its first, which
-- is exactly what an operator would say about it. No backfill, no downtime, and no
-- worker has to be stopped.
--
-- The budget itself lives in the workers (`maxReclaims`, default 3), not in the
-- schema, for the same reason `maxAttempts` does: it is an operational tuning
-- decision, and a limit in a CHECK constraint could not be changed without a
-- migration and would make a row already over the new limit unwritable.

BEGIN;

-- How many times a worker took this row and never came back. Incremented only by
-- the reclaim path; never by a claim, a failure or an acknowledgement, so it stays
-- readable as "abandonments" and nothing else. Not reset when the row is retried:
-- the budget is for the lifetime of the row, since a payload that kills a worker
-- will keep killing it whatever the row does in between.
ALTER TABLE outbox         ADD COLUMN IF NOT EXISTS reclaims integer NOT NULL DEFAULT 0;
ALTER TABLE inbound_event  ADD COLUMN IF NOT EXISTS reclaims integer NOT NULL DEFAULT 0;
ALTER TABLE event_delivery ADD COLUMN IF NOT EXISTS reclaims integer NOT NULL DEFAULT 0;

-- A negative count is not a smaller number, it is a bug in whatever wrote it.
-- Cheap to assert here and impossible to assert anywhere else.
ALTER TABLE outbox
    ADD CONSTRAINT outbox_reclaims_check CHECK (reclaims >= 0);
ALTER TABLE inbound_event
    ADD CONSTRAINT inbound_event_reclaims_check CHECK (reclaims >= 0);
ALTER TABLE event_delivery
    ADD CONSTRAINT event_delivery_reclaims_check CHECK (reclaims >= 0);

-- No new index. The reclaim query selects on `(status, claimed_at, next_attempt_at)`
-- and is already served by the `*_lease_idx` indexes added in 0014; `reclaims` is
-- only ever read and written on rows that query has already found, and indexing a
-- counter that is never a search key would be a write cost with no reader.

INSERT INTO schema_migrations (version) VALUES ('0015_worker_reclaim_budget')
ON CONFLICT (version) DO NOTHING;

COMMIT;
