-- WASLA CORE — migration 0009: settlement beyond a single all-or-nothing hold
-- Rollback: db/migrations/0009_partial_capture_and_refunds.down.sql
--
-- What was wrong with the old model.
--
-- `payment_authorization.amount_minor` carried two meanings at once: the
-- amount the payer consented to, and the amount that would move. Capture was
-- therefore all-or-nothing, and `balance()` could treat a hold as either fully
-- held or fully gone. Real settlement is not like that. A job quoted at 6000
-- that costs 4000 must capture 4000; a completed job that is later disputed
-- must give money back. Neither was expressible, so the only honest options
-- were to capture the wrong amount or to void and re-authorize — which loses
-- the payer's consent and can fail for want of funds that were already held.
--
-- The two meanings are now separate columns, and the separation is the point:
--
--   amount_minor    the ceiling the payer consented to. Immutable.
--   captured_minor  how much has actually moved. Grows, never shrinks.
--   refunded_minor  how much has moved back. Grows, never shrinks.
--
-- The amount still reserved is `amount_minor - captured_minor`, derived rather
-- than stored, so it cannot disagree with itself.
--
-- A refund is NOT a void, and conflating them would be the worst error
-- available here. A void releases money that never moved and posts nothing to
-- the ledger; a refund moves money that already moved and posts a balanced
-- reversal. Their limits differ too: a void is bounded by what is still held,
-- a refund by what was captured. A refund also does not un-capture — the
-- history must show money going out and coming back, not that it never left.

BEGIN;

-- ── the amounts ───────────────────────────────────────────────────────────

ALTER TABLE payment_authorization
  ADD COLUMN captured_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN refunded_minor bigint NOT NULL DEFAULT 0;

ALTER TABLE payment_authorization
  -- You may never capture more than was consented to. This is the entire
  -- meaning of an authorization; without it the column is a suggestion.
  ADD CONSTRAINT payment_authorization_capture_ceiling
    CHECK (captured_minor >= 0 AND captured_minor <= amount_minor),
  -- You may never give back more than you took.
  ADD CONSTRAINT payment_authorization_refund_ceiling
    CHECK (refunded_minor >= 0 AND refunded_minor <= captured_minor);

-- ── the status ────────────────────────────────────────────────────────────
--
-- A partial capture leaves a remainder that is still capturable, so the row
-- stays `authorized`. Closing it needs a fourth status, because the existing
-- three cannot describe the outcome without lying: `captured` would overstate
-- what moved, and `voided` would claim nothing moved when some did.

ALTER TABLE payment_authorization DROP CONSTRAINT payment_authorization_status_check;
ALTER TABLE payment_authorization
  ADD CONSTRAINT payment_authorization_status_check
  CHECK (status IN ('authorized', 'captured', 'partially_captured', 'voided'));

-- The status and the amounts are two statements about the same fact, so the
-- database refuses to hold a pair that disagree. An `authorized` row with
-- nothing left to capture, or a `voided` row that moved money, is not a state
-- this system has.
ALTER TABLE payment_authorization
  ADD CONSTRAINT payment_authorization_status_amounts
  CHECK (
    CASE status
      WHEN 'authorized'         THEN captured_minor < amount_minor
      WHEN 'captured'           THEN captured_minor = amount_minor
      WHEN 'partially_captured' THEN captured_minor > 0 AND captured_minor < amount_minor
      WHEN 'voided'             THEN captured_minor = 0
    END
  );

-- Both closures that return money need to say why it came back.
ALTER TABLE payment_authorization DROP CONSTRAINT payment_authorization_void_reason_required;
ALTER TABLE payment_authorization
  ADD CONSTRAINT payment_authorization_void_reason_required
  CHECK (status NOT IN ('voided', 'partially_captured') OR void_reason IS NOT NULL);

-- The index that drives the expiry sweep is deliberately left alone. A hold
-- with a live remainder is still `authorized`, and the other three statuses
-- are all closed, so `WHERE status = 'authorized'` already selects exactly
-- the rows the sweep must consider. Recreating it would change nothing.

-- ── the ledger ────────────────────────────────────────────────────────────

ALTER TABLE ledger_transaction DROP CONSTRAINT ledger_transaction_kind_check;
ALTER TABLE ledger_transaction
  ADD CONSTRAINT ledger_transaction_kind_check
  CHECK (kind IN ('credit', 'capture', 'refund'));

-- Which authorization a movement belongs to becomes a foreign key.
--
-- It was previously recoverable only by parsing `business_reference`, which
-- meant the aggregate columns above could drift from the ledger with nothing
-- to notice. Money that can drift from its own audit trail is money nobody
-- can reconcile. A credit has no authorization, and a capture or refund
-- cannot exist without one.
ALTER TABLE ledger_transaction
  ADD COLUMN authorization_id uuid REFERENCES payment_authorization(authorization_id);

ALTER TABLE ledger_transaction
  ADD CONSTRAINT ledger_transaction_authorization_presence
  CHECK ((kind = 'credit') = (authorization_id IS NULL));

CREATE INDEX ledger_transaction_authorization_idx
  ON ledger_transaction (authorization_id)
  WHERE authorization_id IS NOT NULL;

-- ── the agreement between them ────────────────────────────────────────────
--
-- `captured_minor` and `refunded_minor` are aggregates of the ledger, and
-- redundant state that can drift is a liability. This is the same argument
-- `ledger_transaction_is_balanced` already makes: an invariant this important
-- belongs in the database, not only in whichever service happens to write.
--
-- Deferred, so the order of writes inside one transaction does not matter —
-- the authorization may be updated before or after its ledger rows exist.
CREATE FUNCTION payment_authorization_matches_ledger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_id uuid;
  row_record payment_authorization;
  ledger_captured bigint;
  ledger_refunded bigint;
BEGIN
  target_id := NEW.authorization_id;
  IF target_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO row_record FROM payment_authorization WHERE authorization_id = target_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- A capture posts +amount to clearing:captured; a refund posts -amount to
  -- the same account. Summing per kind rather than netting them means two
  -- errors of equal size cannot cancel out and hide each other.
  SELECT
    COALESCE(SUM(e.amount_minor) FILTER (WHERE t.kind = 'capture'), 0),
    COALESCE(-SUM(e.amount_minor) FILTER (WHERE t.kind = 'refund'), 0)
    INTO ledger_captured, ledger_refunded
  FROM ledger_transaction t
  JOIN ledger_entry e ON e.transaction_id = t.transaction_id
  WHERE t.authorization_id = target_id
    AND e.account_reference = 'clearing:captured';

  IF row_record.captured_minor <> ledger_captured THEN
    RAISE EXCEPTION
      'authorization % claims % captured but the ledger holds %',
      target_id, row_record.captured_minor, ledger_captured;
  END IF;
  IF row_record.refunded_minor <> ledger_refunded THEN
    RAISE EXCEPTION
      'authorization % claims % refunded but the ledger holds %',
      target_id, row_record.refunded_minor, ledger_refunded;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_transaction_agrees_with_authorization
AFTER INSERT ON ledger_transaction DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION payment_authorization_matches_ledger();

-- The same check from the other side: an update that inflates the aggregates
-- without posting the matching ledger rows is refused.
CREATE FUNCTION payment_authorization_amounts_agree() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ledger_captured bigint;
  ledger_refunded bigint;
BEGIN
  SELECT
    COALESCE(SUM(e.amount_minor) FILTER (WHERE t.kind = 'capture'), 0),
    COALESCE(-SUM(e.amount_minor) FILTER (WHERE t.kind = 'refund'), 0)
    INTO ledger_captured, ledger_refunded
  FROM ledger_transaction t
  JOIN ledger_entry e ON e.transaction_id = t.transaction_id
  WHERE t.authorization_id = NEW.authorization_id
    AND e.account_reference = 'clearing:captured';

  IF NEW.captured_minor <> ledger_captured THEN
    RAISE EXCEPTION
      'authorization % claims % captured but the ledger holds %',
      NEW.authorization_id, NEW.captured_minor, ledger_captured;
  END IF;
  IF NEW.refunded_minor <> ledger_refunded THEN
    RAISE EXCEPTION
      'authorization % claims % refunded but the ledger holds %',
      NEW.authorization_id, NEW.refunded_minor, ledger_refunded;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER payment_authorization_agrees_with_ledger
AFTER INSERT OR UPDATE ON payment_authorization DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION payment_authorization_amounts_agree();

-- Migration 0006 pinned every trigger function's search_path so a session
-- cannot shadow a referenced object with one from a schema it controls. Two
-- new functions have to be pinned the same way, here rather than in a later
-- migration, or 0006's guarantee quietly stops covering the whole set.
DO $harden$
DECLARE
  target_schema text := current_schema();
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'payment_authorization_matches_ledger()',
    'payment_authorization_amounts_agree()'
  ] LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%s SET search_path = %I, pg_catalog',
      target_schema, fn, target_schema
    );
  END LOOP;
END
$harden$;

-- `balance()` now sums the remainder of every open hold on one wallet, so the
-- lookup it does is wallet_id restricted to open rows. Indexing exactly that
-- keeps the balance read from touching closed holds, which accumulate without
-- limit while the open ones stay few.
CREATE INDEX payment_authorization_open_remainder_idx
  ON payment_authorization (wallet_id)
  WHERE status = 'authorized';

INSERT INTO schema_migrations (version) VALUES ('0009_partial_capture_and_refunds')
ON CONFLICT (version) DO NOTHING;

COMMIT;
