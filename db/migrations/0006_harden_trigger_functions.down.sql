-- Rollback 0006. Restores the pre-0006 posture: mutable function search_path
-- and no row-level security. This reopens both holes 0006 closes, so it exists
-- for completeness of the migration contract, not as a recommended state.

BEGIN;

DO $rollback$
DECLARE
  target_schema text := current_schema();
  fn text;
  tbl text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'audit_entry_is_append_only()',
    'ledger_entry_is_append_only()',
    'ledger_transaction_is_balanced()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s RESET search_path', target_schema, fn);
  END LOOP;

  FOREACH tbl IN ARRAY ARRAY[
    'identity', 'identity_link', 'principal', 'session',
    'organization', 'membership',
    'country', 'region', 'city', 'service_area',
    'wallet', 'ledger_transaction', 'ledger_entry', 'payment_authorization',
    'fulfillment',
    'outbox', 'inbox', 'idempotency_key', 'audit_entry', 'schema_migrations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I.%I DISABLE ROW LEVEL SECURITY', target_schema, tbl);
  END LOOP;
END
$rollback$;

DELETE FROM schema_migrations WHERE version = '0006_harden_trigger_functions';

COMMIT;
