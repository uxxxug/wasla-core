-- Rollback for migration 0009.
--
-- Going back means the amounts collapse into one again, so any authorization
-- that used the new expressiveness cannot be represented. Rather than round
-- money to fit, this refuses: a partially captured or refunded row has to be
-- resolved deliberately before the schema can lose the columns that describe
-- it. Silently rewriting it would destroy the only record of what moved.
BEGIN;

DO $rollback$
DECLARE
  offenders bigint;
BEGIN
  SELECT count(*) INTO offenders
  FROM payment_authorization
  WHERE status = 'partially_captured'
     OR refunded_minor > 0
     OR (captured_minor > 0 AND captured_minor < amount_minor);
  IF offenders > 0 THEN
    RAISE EXCEPTION
      'cannot roll back 0009: % authorization(s) are partially captured or refunded', offenders;
  END IF;
END
$rollback$;

DROP TRIGGER IF EXISTS payment_authorization_agrees_with_ledger ON payment_authorization;
DROP TRIGGER IF EXISTS ledger_transaction_agrees_with_authorization ON ledger_transaction;
DROP FUNCTION IF EXISTS payment_authorization_amounts_agree();
DROP FUNCTION IF EXISTS payment_authorization_matches_ledger();

DROP INDEX IF EXISTS payment_authorization_open_remainder_idx;
DROP INDEX IF EXISTS ledger_transaction_authorization_idx;

ALTER TABLE ledger_transaction DROP CONSTRAINT IF EXISTS ledger_transaction_authorization_presence;
ALTER TABLE ledger_transaction DROP COLUMN IF EXISTS authorization_id;
ALTER TABLE ledger_transaction DROP CONSTRAINT IF EXISTS ledger_transaction_kind_check;
ALTER TABLE ledger_transaction
  ADD CONSTRAINT ledger_transaction_kind_check CHECK (kind IN ('credit', 'capture'));

ALTER TABLE payment_authorization DROP CONSTRAINT IF EXISTS payment_authorization_void_reason_required;
ALTER TABLE payment_authorization DROP CONSTRAINT IF EXISTS payment_authorization_status_amounts;
ALTER TABLE payment_authorization DROP CONSTRAINT IF EXISTS payment_authorization_refund_ceiling;
ALTER TABLE payment_authorization DROP CONSTRAINT IF EXISTS payment_authorization_capture_ceiling;
ALTER TABLE payment_authorization DROP COLUMN IF EXISTS refunded_minor;
ALTER TABLE payment_authorization DROP COLUMN IF EXISTS captured_minor;

ALTER TABLE payment_authorization DROP CONSTRAINT IF EXISTS payment_authorization_status_check;
ALTER TABLE payment_authorization
  ADD CONSTRAINT payment_authorization_status_check
  CHECK (status IN ('authorized', 'captured', 'voided'));
ALTER TABLE payment_authorization
  ADD CONSTRAINT payment_authorization_void_reason_required
  CHECK (status <> 'voided' OR void_reason IS NOT NULL);

COMMIT;
