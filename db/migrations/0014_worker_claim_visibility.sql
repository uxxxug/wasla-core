-- WASLA CORE — migration 0014: make a claim visible on the three eventing queues
-- Forward only, additive. No table here is owned by MOVE or MARKET.
-- Rollback: db/migrations/0014_worker_claim_visibility.down.sql
--
-- Why this column exists (blocker B-24).
--
-- Migration 0012 gave `notification` a `claimed_at` and a `claim_token`, so the
-- notification worker can tell a row it is holding from a row waiting for its
-- scheduled retry. The three older queues — `outbox`, `inbound_event`,
-- `event_delivery` — cannot. When B-22 made every claim write a lease, the lease
-- was deliberately parked on `next_attempt_at` to avoid a schema change:
--
--     claim:  next_attempt_at = now + lease
--     retry:  next_attempt_at = now + backoff
--
-- One column, two meanings, and nothing on the row says which. The consequences
-- are not theoretical:
--
--  1. `core_worker_outcomes_total{outcome="reclaimed"}` is unreportable for three
--     of the four workers. A worker that dies mid-attempt is invisible: its row
--     simply becomes due again, indistinguishable from a row that failed politely
--     and asked to be retried. Processes dying under load and events failing
--     under load produce identical metrics, so the operator cannot tell a crash
--     loop from a bad payload.
--  2. Nobody can ask what is in flight. "What is stuck" is the question an
--     operator opens the replay CLI to answer, and the tables could not answer
--     it: a pending row with a future `next_attempt_at` is either being worked on
--     right now or sleeping off a backoff, and there is no way to know which.
--
-- So: one nullable timestamp per queue, and no new status.
--
-- Why `claimed_at` and not a `processing` status. A status would have to be added
-- to three CHECK constraints and would change what every existing reader means by
-- `status = 'pending'` — including `counts()`, the readiness probe, the replay
-- selector and `byStatus`. A row being worked on is still pending work; it has
-- not reached a new state, it has an owner. A nullable timestamp records exactly
-- that and nothing else, and every existing query keeps its current meaning.
--
-- Why no `claim_token` here. A token is for fencing — refusing a late
-- acknowledgement from a worker whose lease has already been taken over — and
-- fencing requires every acknowledgement to carry the token, which means changing
-- `markPublished`, `markFailed`, `markDead`, `markProcessed` and `markDelivered`
-- across two backends and all of their callers. That is a bigger and separately
-- reviewable change, and it is not what B-24 asks for; B-24 asks for a claim that
-- can be counted and an abandoned claim that can be recovered. The absence is
-- recorded as its own blocker rather than left implied.
--
-- Existing rows.
--
-- Every existing row gets NULL, which reads as "not held by anybody". That is the
-- correct answer for the overwhelming majority (pending-and-waiting, published,
-- processed, delivered, dead) and it is the *safe* answer for the handful that
-- may genuinely be in flight while this migration runs: such a row keeps its
-- future `next_attempt_at`, so it stays invisible to the claim query until its
-- lease would have run out anyway, and is then claimed exactly as it is today.
-- Nothing is lost, nothing is processed twice that could not already be, and no
-- worker has to be stopped to apply this. The one cost is that claims held across
-- the migration are not counted when they are taken over — a single sample of a
-- counter, on a deploy.

BEGIN;

-- `claimed_at IS NOT NULL` means a worker took this row and has not acknowledged
-- it yet; `next_attempt_at` is then the lease expiry rather than a retry
-- schedule. Cleared by every acknowledgement and by a reclaim, so it never
-- outlives the attempt it describes.
ALTER TABLE outbox         ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
ALTER TABLE inbound_event  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
ALTER TABLE event_delivery ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

-- A terminal row is not held by anybody. Without this the column could silently
-- accumulate rows that look permanently in flight, and the depth gauge for
-- "abandoned" would climb for ever with nothing to reclaim — the failure mode a
-- visibility change is supposed to remove, not create.
ALTER TABLE outbox
    ADD CONSTRAINT outbox_claim_check
    CHECK (claimed_at IS NULL OR status = 'pending');
ALTER TABLE inbound_event
    ADD CONSTRAINT inbound_event_claim_check
    CHECK (claimed_at IS NULL OR status = 'pending');
ALTER TABLE event_delivery
    ADD CONSTRAINT event_delivery_claim_check
    CHECK (claimed_at IS NULL OR status = 'pending');

-- Reclaim path: pending rows somebody is holding, oldest lease first. Mirrors
-- notification_lease_idx. Partial, so it indexes only rows in flight — normally a
-- handful — rather than the whole queue.
CREATE INDEX IF NOT EXISTS outbox_lease_idx
    ON outbox (next_attempt_at)
    WHERE status = 'pending' AND claimed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbound_event_lease_idx
    ON inbound_event (next_attempt_at)
    WHERE status = 'pending' AND claimed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_delivery_lease_idx
    ON event_delivery (next_attempt_at)
    WHERE status = 'pending' AND claimed_at IS NOT NULL;

-- The poll path now also requires `claimed_at IS NULL`. The existing
-- `*_due_idx` indexes stay as they are and still serve it: they are already
-- partial on `status = 'pending'` and ordered by `next_attempt_at`, and the
-- additional predicate is evaluated on the rows they return. Adding a second,
-- more specific due index would duplicate an index that is written on every
-- append for a filter that eliminates a handful of rows.

INSERT INTO schema_migrations (version) VALUES ('0014_worker_claim_visibility')
ON CONFLICT (version) DO NOTHING;

COMMIT;
