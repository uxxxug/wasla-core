-- Rollback for migration 0021.
--
-- This returns `idempotency_key` to the shape 0020 left: a table of recorded
-- answers with a mandatory 2xx status and no claim. It is a true inverse of the
-- forward migration and nothing else is touched.
--
-- What rolling back costs, stated plainly.
--
-- B-43 comes back. The router's `claim`/`complete`/`release` calls all fail on
-- the missing columns: `claim` cannot insert, so every keyed request is refused
-- with a 500 rather than duplicating — which is a worse outage than the defect
-- but not a silent one. There is no half-working state where claims are skipped
-- and answers are still recorded, and that is deliberate: a store that quietly
-- fell back to record-after-the-fact would restore the concurrency defect with
-- the protection *appearing* to be in place, which is the one outcome this
-- cycle exists to make impossible.
--
-- Claimed rows are deleted, not completed. A claimed row is a request that was
-- in flight at the moment of the rollback: it has no answer to keep, and
-- leaving it would leave a row the 0020 shape cannot describe — `state` is
-- gone, so nothing could tell it from a record whose status is missing. The
-- request that owned it gets its answer either way; what it loses is the
-- ability to have that answer replayed, which is the same thing every caller
-- loses by rolling back past 0020.
--
-- `tests/check-parity.test.ts` will fail on `idempotency_key_state_ck` and
-- `idempotency_key_state_record_ck` against a rolled-back database, because the
-- reference store keeps enforcing both while Postgres stops. That failure is
-- correct: the two backends really do disagree again.

BEGIN;

-- In-flight claims first: the NOT NULL restored below cannot hold for them,
-- and there is nothing in them worth keeping.
DELETE FROM idempotency_key WHERE state = 'claimed';

ALTER TABLE idempotency_key DROP CONSTRAINT IF EXISTS idempotency_key_state_record_ck;
ALTER TABLE idempotency_key DROP CONSTRAINT IF EXISTS idempotency_key_state_ck;

ALTER TABLE idempotency_key DROP CONSTRAINT IF EXISTS idempotency_key_response_status_ck;
ALTER TABLE idempotency_key
    ADD CONSTRAINT idempotency_key_response_status_ck
    CHECK (response_status >= 200 AND response_status < 300);

ALTER TABLE idempotency_key ALTER COLUMN response_status SET NOT NULL;

ALTER TABLE idempotency_key DROP COLUMN IF EXISTS completed_at;
ALTER TABLE idempotency_key DROP COLUMN IF EXISTS claimed_at;
ALTER TABLE idempotency_key DROP COLUMN IF EXISTS claim_token;
ALTER TABLE idempotency_key DROP COLUMN IF EXISTS state;

COMMENT ON COLUMN idempotency_key.response_status IS
  'The HTTP status of the recorded answer. Constrained to 2xx: refusals are never recorded, so that a caller can correct an invalid request and resend it under the same key.';

DELETE FROM schema_migrations WHERE version = '0021_idempotency_key_claims';

COMMIT;
