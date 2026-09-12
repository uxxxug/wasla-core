-- Additive: teach the fulfillment settlement state about a partially captured
-- hold.
--
-- Migration 0009 split `payment_authorization.amount_minor` into a consented
-- ceiling plus what actually moved, which made `partially_captured` a reachable
-- terminal status for a hold. The fulfillment side was never widened to match,
-- so a hold that moved part of its amount and released the rest was recorded
-- against the fulfillment as `released` — a value whose documented meaning is
-- that no money moved at all. Two rows, each individually legal, disagreeing
-- about whether money left the wallet.
--
-- The constraints here are what stop the service from writing that falsehood
-- again. `partially_captured` is allowed on a completed fulfillment (a job that
-- cost less than the ceiling) and on a failed or cancelled one (money moved for
-- work that did not complete). The second case is storable on purpose: it is
-- true, and CORE reports the truth rather than refusing to record it. The
-- reconciliation read is what flags it, because whether that money is refunded
-- or kept is a policy decision CORE has not been given (blocker B-20).
--
-- No column is added, no data is rewritten and no existing value changes
-- meaning. Rows written before this migration stay exactly as they are.
BEGIN;

INSERT INTO schema_migrations (version) VALUES ('0011_fulfillment_partial_settlement');

ALTER TABLE fulfillment DROP CONSTRAINT IF EXISTS fulfillment_settlement_state_check;
ALTER TABLE fulfillment
  ADD CONSTRAINT fulfillment_settlement_state_check
  CHECK (
    settlement_state IN ('none', 'held', 'captured', 'partially_captured', 'released', 'unsettled')
  );

-- A closed fulfillment may never still be holding money, and an open one may
-- never claim a terminal money state. Widened only by the new value.
ALTER TABLE fulfillment DROP CONSTRAINT IF EXISTS fulfillment_settlement_alignment_check;
ALTER TABLE fulfillment
  ADD CONSTRAINT fulfillment_settlement_alignment_check
  CHECK (
    (status IN ('coordinating', 'dispatched') AND settlement_state IN ('none', 'held'))
    OR (
      status = 'completed'
      AND settlement_state IN ('none', 'captured', 'partially_captured', 'unsettled')
    )
    OR (
      status IN ('failed', 'cancelled')
      AND settlement_state IN ('none', 'released', 'partially_captured', 'unsettled')
    )
  );

-- Supports the reconciliation read. `partially_captured` joins the predicate
-- because a failed or cancelled fulfillment carrying that state is exactly what
-- the read is meant to surface, and a partial index that does not cover it
-- would leave the query scanning the table for the case it exists to find.
DROP INDEX IF EXISTS fulfillment_settlement_state_idx;
CREATE INDEX IF NOT EXISTS fulfillment_settlement_state_idx
  ON fulfillment (settlement_state)
  WHERE settlement_state IN ('unsettled', 'partially_captured');

COMMIT;
