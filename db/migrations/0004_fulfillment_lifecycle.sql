-- Additive fulfillment lifecycle: dispatch, cancellation and the money hold
-- that guards execution. No data is removed and no column is dropped.
BEGIN;

INSERT INTO schema_migrations (version) VALUES ('0004_fulfillment_lifecycle');

ALTER TABLE fulfillment
  ADD COLUMN IF NOT EXISTS payment_authorization_id uuid REFERENCES payment_authorization(authorization_id),
  ADD COLUMN IF NOT EXISTS closure_reason text;

ALTER TABLE fulfillment DROP CONSTRAINT IF EXISTS fulfillment_status_check;
ALTER TABLE fulfillment
  ADD CONSTRAINT fulfillment_status_check
  CHECK (status IN ('coordinating', 'dispatched', 'completed', 'failed', 'cancelled'));

CREATE INDEX IF NOT EXISTS fulfillment_status_idx ON fulfillment (status);
CREATE INDEX IF NOT EXISTS fulfillment_authorization_idx ON fulfillment (payment_authorization_id);

COMMIT;
