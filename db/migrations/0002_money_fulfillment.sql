-- Additive CORE-owned money and fulfillment coordination schema.
-- Authored and verified only; not executed against a database.

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('0002_money_fulfillment');

CREATE TABLE wallet (
  wallet_id uuid PRIMARY KEY,
  owner_type text NOT NULL CHECK (owner_type IN ('identity', 'organization')),
  owner_id uuid NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN ('active', 'frozen', 'closed')),
  created_at timestamptz NOT NULL,
  UNIQUE (owner_type, owner_id, currency)
);

CREATE TABLE ledger_transaction (
  transaction_id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('credit', 'capture')),
  business_reference text NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL
);

CREATE TABLE ledger_entry (
  entry_id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES ledger_transaction(transaction_id),
  account_reference text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE FUNCTION ledger_entry_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entry is append-only';
END;
$$;
CREATE TRIGGER ledger_entry_no_mutation
BEFORE UPDATE OR DELETE ON ledger_entry
FOR EACH ROW EXECUTE FUNCTION ledger_entry_is_append_only();

CREATE FUNCTION ledger_transaction_is_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_id uuid;
BEGIN
  target_id := COALESCE(NEW.transaction_id, OLD.transaction_id);
  IF EXISTS (
    SELECT 1 FROM ledger_entry WHERE transaction_id = target_id
    GROUP BY currency HAVING SUM(amount_minor) <> 0
  ) THEN
    RAISE EXCEPTION 'ledger transaction % is not balanced', target_id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ledger_transaction_balance
AFTER INSERT ON ledger_entry DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ledger_transaction_is_balanced();

CREATE TABLE payment_authorization (
  authorization_id uuid PRIMARY KEY,
  wallet_id uuid NOT NULL REFERENCES wallet(wallet_id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN ('authorized', 'captured', 'voided')),
  business_reference text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  captured_at timestamptz,
  voided_at timestamptz
);

CREATE TABLE fulfillment (
  fulfillment_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organization(organization_id),
  market_order_reference text NOT NULL UNIQUE,
  move_job_reference text UNIQUE,
  status text NOT NULL CHECK (status IN ('coordinating', 'completed', 'failed')),
  created_at timestamptz NOT NULL,
  completed_at timestamptz
);

COMMIT;