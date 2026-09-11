-- Rollback for 0005_fulfillment_settlement_state.
--
-- Reviewed and gated: dropping this column discards the record of which
-- fulfillments were left financially unsettled. Export
--   SELECT fulfillment_id, payment_authorization_id, settlement_state
--   FROM fulfillment WHERE settlement_state = 'unsettled';
-- before running this rollback, otherwise those cases become invisible again.
BEGIN;

ALTER TABLE fulfillment DROP CONSTRAINT IF EXISTS fulfillment_settlement_alignment_check;
ALTER TABLE fulfillment DROP CONSTRAINT IF EXISTS fulfillment_settlement_state_check;

DROP INDEX IF EXISTS fulfillment_settlement_state_idx;

ALTER TABLE fulfillment DROP COLUMN IF EXISTS settlement_state;

DELETE FROM schema_migrations WHERE version = '0005_fulfillment_settlement_state';

COMMIT;
