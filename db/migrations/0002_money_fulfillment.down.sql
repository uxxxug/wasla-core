-- Safe only before CORE money or fulfillment data becomes authoritative.
BEGIN;
DROP TABLE IF EXISTS fulfillment;
DROP TABLE IF EXISTS payment_authorization;
DROP TRIGGER IF EXISTS ledger_transaction_balance ON ledger_entry;
DROP FUNCTION IF EXISTS ledger_transaction_is_balanced();
DROP TRIGGER IF EXISTS ledger_entry_no_mutation ON ledger_entry;
DROP FUNCTION IF EXISTS ledger_entry_is_append_only();
DROP TABLE IF EXISTS ledger_entry;
DROP TABLE IF EXISTS ledger_transaction;
DROP TABLE IF EXISTS wallet;
DELETE FROM schema_migrations WHERE version = '0002_money_fulfillment';
COMMIT;