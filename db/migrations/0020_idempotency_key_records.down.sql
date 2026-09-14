-- Rollback for migration 0020.
--
-- This returns `idempotency_key` to the shape 0001 gave it: `key` as the whole
-- primary key, a nullable `response_body`, and no record of the method, the
-- request or the status. It is a true inverse of the forward migration and
-- nothing else is touched.
--
-- What rolling back costs, stated plainly.
--
-- The table stops being able to record an answer, so the five routes that
-- collapse a retry against an `Idempotency-Key` — `POST /v1/organizations`,
-- the three geography creates and `POST /v1/subscriptions` — stop collapsing
-- anything: every insert fails on the missing columns, the router keeps its
-- answer and logs `retry_not_recorded`, and the next retry runs the handler
-- again. That is a second organization, a second city, or a second recurring
-- charge, which is the condition milestone 32 was reserved to remove. Roll back
-- only to reach a schema state older than 0020 as a whole.
--
-- Rows are dropped with the columns, and that is the reason this rollback is
-- honest about being destructive rather than clever: the records only exist to
-- answer a retry within 24 hours, no other table references them, and a
-- half-restored record — a key with no fingerprint — would be worse than none,
-- because the next request under that key would be answered from a record that
-- cannot be compared against it.
--
-- `tests/check-parity.test.ts` will fail on `idempotency_key_response_status_ck`
-- against a rolled-back database, because the reference store keeps refusing a
-- non-2xx record while Postgres stops doing so. That failure is correct: the
-- two backends really do disagree again.

BEGIN;

ALTER TABLE idempotency_key DROP CONSTRAINT IF EXISTS idempotency_key_response_status_ck;

ALTER TABLE idempotency_key DROP CONSTRAINT IF EXISTS idempotency_key_pkey;
ALTER TABLE idempotency_key
    ADD CONSTRAINT idempotency_key_pkey PRIMARY KEY (key);

ALTER TABLE idempotency_key DROP COLUMN IF EXISTS response_status;
ALTER TABLE idempotency_key DROP COLUMN IF EXISTS request_fingerprint;
ALTER TABLE idempotency_key DROP COLUMN IF EXISTS method;

DELETE FROM schema_migrations WHERE version = '0020_idempotency_key_records';

COMMIT;
