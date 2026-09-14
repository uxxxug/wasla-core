-- WASLA CORE — migration 0021: make an idempotency record claimable before the work
-- Forward only, additive. No table here is owned by MOVE or MARKET.
-- Rollback: db/migrations/0021_idempotency_key_claims.down.sql
--
-- What was wrong, measured before anything was written.
--
-- Migration 0020 gave `idempotency_key` the columns needed to record an answer,
-- and the router records one *after* the handler has answered. Milestone 32's
-- own module comment states the bound that leaves open, and B-43 is that bound:
-- two identical keyed requests in flight at the same moment both find no record
-- and both reach the handler.
--
-- Re-measured on this branch before a line of this migration existed, by firing
-- five byte-identical `POST /v1/organizations` requests concurrently through
-- `core.router.handle` under one `Idempotency-Key` and counting rows:
--
--   reference backend   5 organizations from 5 requests, 0 replays, 5 distinct ids
--   PostgreSQL round 1  1 organization,  4 replays
--   PostgreSQL round 2  5 organizations, 0 replays
--   PostgreSQL round 3  5 organizations, 0 replays
--   PostgreSQL round 4  4 organizations, 1 replay
--   PostgreSQL round 5  4 organizations, 1 replay
--
-- Nineteen duplicate tenants out of the five the caller asked for, and — the
-- part worth keeping — the outcome is a function of scheduling, not of the
-- request. The same five bytes produced one row in one round and five in the
-- next. That is the defect: not "retries can duplicate" but "whether a retry
-- duplicates is decided by how the event loop happened to interleave".
--
-- (The reservation in ROADMAP row 33 recorded "five in four of five rounds".
-- This re-measurement disagrees with it in the detail and agrees with it in the
-- finding; the reservation's text is left as written and this is the correction,
-- additively, because a measurement that moves between runs is exactly the
-- property being removed.)
--
-- Why recording later cannot be fixed by recording harder.
--
-- The record is evidence that work was done. A gate over *evidence* can only
-- ever collapse the second request after the first has finished, so the window
-- between "nothing recorded yet" and "answer recorded" is the width of the
-- handler — a transaction, several inserts, an outbox publish. Any number of
-- twins fit inside it. Making the window narrower makes the defect rarer and
-- keeps it, which is worse than keeping it openly.
--
-- So the row stops being evidence and becomes a **claim**: it is written before
-- the handler runs, and the single writer that wins the insert is the only
-- request allowed to do the work. This is the shape `worker-claim-atomicity`
-- already gates for the outbox, inbox, delivery and notification workers, one
-- level up: `insert … on conflict do nothing` is the arbiter, and it is the
-- database's own primary key doing the arbitration rather than a read followed
-- by a write.
--
-- What the columns are for.
--
--  * `state` — `claimed` or `completed`. A claimed row says "a request is doing
--    this now"; a completed row says "this is the answer". Two states and no
--    third: a `released` state would be a row that means nothing, and the way
--    to say "nobody is doing this and there is no answer" is for the row not to
--    exist.
--  * `claim_token` — who owns the claim. Not decoration: an abandoned claim can
--    be taken over (see below), and without a fence the request that abandoned
--    it could wake up and complete a claim that is no longer its own, writing
--    its answer over the new owner's. Fencing by token makes `complete` and
--    `release` no-ops for a claim that has moved on, which is what the outbox
--    lease does with `claimed_by`.
--  * `claimed_at` — when the current owner took it, which is the only thing
--    that can tell a live claim from an abandoned one.
--  * `completed_at` — when the answer was recorded. `created_at` no longer
--    means that: the row now exists before the answer does.
--
-- `response_status` loses its NOT NULL, and that is the price of the shape: a
-- claimed row has no status yet because the work has not been done. The 2xx
-- constraint is re-stated to allow NULL and `idempotency_key_state_record_ck`
-- is what stops NULL from meaning anything else — a claimed row must have no
-- status, no body and no completion time, and a completed row must have a
-- status and a completion time. The pair of constraints together says exactly
-- what the old single NOT NULL said, for both states, in the one place no code
-- path can bypass.
--
-- Abandoned claims, and why there is no sweeper.
--
-- A process that claims and dies leaves a row that would block its own key
-- until `expires_at` — 24 hours. Recovery is bounded instead: a claim older
-- than the claim horizon is taken over by the next request that tries to claim
-- the same key, atomically, in the same statement that would have inserted it
-- (`on conflict … do update … where`). That is a bounded schedule in the sense
-- that matters — the wait is bounded and needs no operator — and it is
-- deliberately not a worker: a sweeper would be a second process, a second
-- deployment concern and a second source of truth about which claims are dead,
-- to recover rows that are only interesting at the moment somebody asks for
-- them again. Nothing is recovered that nobody is waiting for, which is the
-- correct amount of work to do.
--
-- Row-level security is already enabled on this table by migration 0006.

BEGIN;

ALTER TABLE idempotency_key ADD COLUMN IF NOT EXISTS state text;
ALTER TABLE idempotency_key ADD COLUMN IF NOT EXISTS claim_token uuid;
ALTER TABLE idempotency_key ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
ALTER TABLE idempotency_key ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- Any row already here was written by milestone 32's router, which wrote only
-- after a 2xx — so it is a completed record by construction, and the moment it
-- was created is the only honest value for both the claim and the completion.
-- A token is minted for it because the fence has to hold for old rows too: a
-- NULL token would make `complete` and `release` match on `claim_token is null`
-- and fence nothing.
UPDATE idempotency_key
   SET state = 'completed',
       claim_token = COALESCE(claim_token, gen_random_uuid()),
       claimed_at = COALESCE(claimed_at, created_at),
       completed_at = COALESCE(completed_at, created_at)
 WHERE state IS NULL;

ALTER TABLE idempotency_key ALTER COLUMN state SET NOT NULL;
ALTER TABLE idempotency_key ALTER COLUMN state SET DEFAULT 'claimed';
ALTER TABLE idempotency_key ALTER COLUMN claim_token SET NOT NULL;
ALTER TABLE idempotency_key ALTER COLUMN claimed_at SET NOT NULL;
ALTER TABLE idempotency_key ALTER COLUMN claimed_at SET DEFAULT now();

-- The claim exists before the answer does, so the answer's columns have to be
-- absent for the length of the work. What stops that from weakening the 0020
-- rule is the state constraint below, not this line.
ALTER TABLE idempotency_key ALTER COLUMN response_status DROP NOT NULL;

COMMENT ON COLUMN idempotency_key.state IS
  'claimed while a request is doing the work, completed once the answer is recorded. There is no third state: "nobody is doing this and there is no answer" is the absence of the row.';
COMMENT ON COLUMN idempotency_key.claim_token IS
  'Owner of the current claim. complete and release match on it, so a request whose abandoned claim was taken over cannot write its answer over the new owner''s.';
COMMENT ON COLUMN idempotency_key.claimed_at IS
  'When the current owner took the claim. A claim older than the claim horizon is taken over by the next request for the same key, which is how an abandoned claim is recovered without a sweeper.';
COMMENT ON COLUMN idempotency_key.completed_at IS
  'When the answer was recorded. created_at no longer means this: the row now exists before the answer does.';
COMMENT ON COLUMN idempotency_key.response_status IS
  'The HTTP status of the recorded answer, NULL while the claim is still being worked. Constrained to 2xx when present: refusals are never recorded, so that a caller can correct an invalid request and resend it under the same key. A handler that refuses releases the claim instead, which deletes the row.';

ALTER TABLE idempotency_key
    ADD CONSTRAINT idempotency_key_state_ck
    CHECK (state IN ('claimed', 'completed'));

-- Restated rather than dropped: the 2xx rule is unchanged for a recorded
-- answer, and NULL is now reachable because a claim precedes its answer.
ALTER TABLE idempotency_key DROP CONSTRAINT IF EXISTS idempotency_key_response_status_ck;
ALTER TABLE idempotency_key
    ADD CONSTRAINT idempotency_key_response_status_ck
    CHECK (response_status IS NULL OR (response_status >= 200 AND response_status < 300));

-- The constraint that makes the nullability above safe. Without it "no status"
-- would be a state a completed record could reach.
ALTER TABLE idempotency_key
    ADD CONSTRAINT idempotency_key_state_record_ck
    CHECK (
      (state = 'claimed'
         AND response_status IS NULL
         AND response_body IS NULL
         AND completed_at IS NULL)
      OR
      (state = 'completed'
         AND response_status IS NOT NULL
         AND completed_at IS NOT NULL)
      OR
      -- A state outside the vocabulary is `idempotency_key_state_ck`'s refusal
      -- to raise, not this one's. Without this clause both constraints would be
      -- violated by the same bad row and Postgres would be free to name either,
      -- while the reference backend names one — which `check-parity` measures as
      -- a divergence and would be right to.
      state NOT IN ('claimed', 'completed')
    );

INSERT INTO schema_migrations (version, applied_at)
VALUES ('0021_idempotency_key_claims', now())
ON CONFLICT (version) DO NOTHING;

COMMIT;
