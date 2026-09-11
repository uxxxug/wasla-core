-- Rollback for 0004_fulfillment_lifecycle. Reviewed and gated: dropping these
-- columns discards dispatch/cancellation metadata, so run only on a database
-- where 0004 has not yet been used by application traffic.
BEGIN;

UPDATE fulfillment SET status = 'failed' WHERE status IN ('dispatched', 'cancelled');

ALTER TABLE fulfillment DROP CONSTRAINT IF EXISTS fulfillment_status_check;
ALTER TABLE fulfillment
  ADD CONSTRAINT fulfillment_status_check
  CHECK (status IN ('coordinating', 'completed', 'failed'));

DROP INDEX IF EXISTS fulfillment_status_idx;
DROP INDEX IF EXISTS fulfillment_authorization_idx;

ALTER TABLE fulfillment
  DROP COLUMN IF EXISTS payment_authorization_id,
  DROP COLUMN IF EXISTS closure_reason;

DELETE FROM schema_migrations WHERE version = '0004_fulfillment_lifecycle';

COMMIT;
