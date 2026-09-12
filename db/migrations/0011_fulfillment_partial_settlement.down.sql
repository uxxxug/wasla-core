-- Rollback for 0011_fulfillment_partial_settlement.
--
-- Reviewed and gated. Narrowing the value list back would leave any row already
-- recorded as `partially_captured` violating a constraint the database is about
-- to re-add, and there is no honest value to rewrite it to: `released` claims no
-- money moved when some did, and `captured` claims all of it did. Both are the
-- falsehood this migration exists to prevent.
--
-- So the rollback refuses while any such row exists. Resolve them first —
-- refund or retain the captured amount per the operator's decision, then close
-- the case with the settlement state that describes the outcome:
--   SELECT fulfillment_id, status, settlement_state, payment_authorization_id
--   FROM fulfillment WHERE settlement_state = 'partially_captured';
BEGIN;

DO $$
DECLARE
  blocking integer;
BEGIN
  SELECT count(*) INTO blocking
  FROM fulfillment
  WHERE settlement_state = 'partially_captured';

  IF blocking > 0 THEN
    RAISE EXCEPTION
      'refusing to roll back 0011: % fulfillment row(s) are settled as partially_captured and no earlier value states that truthfully',
      blocking;
  END IF;
END $$;

ALTER TABLE fulfillment DROP CONSTRAINT IF EXISTS fulfillment_settlement_state_check;
ALTER TABLE fulfillment
  ADD CONSTRAINT fulfillment_settlement_state_check
  CHECK (settlement_state IN ('none', 'held', 'captured', 'released', 'unsettled'));

ALTER TABLE fulfillment DROP CONSTRAINT IF EXISTS fulfillment_settlement_alignment_check;
ALTER TABLE fulfillment
  ADD CONSTRAINT fulfillment_settlement_alignment_check
  CHECK (
    (status IN ('coordinating', 'dispatched') AND settlement_state IN ('none', 'held'))
    OR (status = 'completed' AND settlement_state IN ('none', 'captured', 'unsettled'))
    OR (status IN ('failed', 'cancelled') AND settlement_state IN ('none', 'released', 'unsettled'))
  );

DROP INDEX IF EXISTS fulfillment_settlement_state_idx;
CREATE INDEX IF NOT EXISTS fulfillment_settlement_state_idx
  ON fulfillment (settlement_state)
  WHERE settlement_state = 'unsettled';

DELETE FROM schema_migrations WHERE version = '0011_fulfillment_partial_settlement';

COMMIT;
