-- Additive: the financial counterpart of the fulfillment execution state.
--
-- Execution state and money state were only comparable through a cross-module
-- join, and a hold that could not be brought to a terminal state left no trace
-- at all. `settlement_state` records where the money stands per fulfillment so
-- an inconsistency is queryable instead of invisible.
--
-- No column is dropped and no data is removed. Existing rows are backfilled
-- from what is already known about their hold.
BEGIN;

INSERT INTO schema_migrations (version) VALUES ('0005_fulfillment_settlement_state');

ALTER TABLE fulfillment
  ADD COLUMN IF NOT EXISTS settlement_state text NOT NULL DEFAULT 'none';

-- Backfill from the authorization the fulfillment already points at.
UPDATE fulfillment f
SET settlement_state = CASE
  WHEN f.payment_authorization_id IS NULL THEN 'none'
  WHEN a.status = 'captured' THEN 'captured'
  WHEN a.status = 'voided' THEN 'released'
  WHEN a.status = 'authorized' THEN 'held'
  ELSE 'none'
END
FROM payment_authorization a
WHERE a.authorization_id = f.payment_authorization_id;

UPDATE fulfillment
SET settlement_state = 'none'
WHERE payment_authorization_id IS NULL;

ALTER TABLE fulfillment DROP CONSTRAINT IF EXISTS fulfillment_settlement_state_check;
ALTER TABLE fulfillment
  ADD CONSTRAINT fulfillment_settlement_state_check
  CHECK (settlement_state IN ('none', 'held', 'captured', 'released', 'unsettled'));

-- A closed fulfillment may never still be holding money, and an open one may
-- never claim a terminal money state. The invariant is enforced by the
-- database, not only by the service.
ALTER TABLE fulfillment DROP CONSTRAINT IF EXISTS fulfillment_settlement_alignment_check;
ALTER TABLE fulfillment
  ADD CONSTRAINT fulfillment_settlement_alignment_check
  CHECK (
    (status IN ('coordinating', 'dispatched') AND settlement_state IN ('none', 'held'))
    OR (status = 'completed' AND settlement_state IN ('none', 'captured', 'unsettled'))
    OR (status IN ('failed', 'cancelled') AND settlement_state IN ('none', 'released', 'unsettled'))
  );

-- Supports the reconciliation read for inconsistent rows.
CREATE INDEX IF NOT EXISTS fulfillment_settlement_state_idx
  ON fulfillment (settlement_state)
  WHERE settlement_state = 'unsettled';

COMMIT;
