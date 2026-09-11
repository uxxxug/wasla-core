-- 0006 — close two real holes found by executing 0001–0005 against a live engine
-- for the first time.
--
-- 1. The three trigger functions were created without a fixed search_path.
--    `ledger_transaction_is_balanced` resolves `ledger_entry` through the
--    caller's search_path, so a session that puts a schema containing a
--    different `ledger_entry` ahead of ours makes the balance check read the
--    wrong table and pass. That is the money invariant — a zero-sum ledger —
--    being decided by caller-controlled name resolution. The append-only
--    triggers only RAISE, so they are not exploitable today, but they carry
--    the same defect and are fixed together.
--
-- 2. Every table was readable by any role granted USAGE on the schema. On a
--    managed host that exposes the schema over HTTP (Supabase exposes `public`
--    to the `anon` role through PostgREST), identities, wallets, the ledger and
--    the audit trail were reachable without authenticating against CORE at all.
--    Row-level security with no policy is deny-by-default for every role except
--    the table owner.
--
-- CORE connects as the owner of these tables, so the application is
-- unaffected. Any non-owner role must be given explicit policies; there are
-- deliberately none.
--
-- Nothing here hardcodes a schema name: the search_path is pinned to whatever
-- schema the migration is applied in, so the migration stays correct when the
-- tables do not live in `public`.

BEGIN;

DO $migration$
DECLARE
  target_schema text := current_schema();
  fn text;
  tbl text;
BEGIN
  -- 1. Pin each trigger function to this schema and to pg_catalog.
  FOREACH fn IN ARRAY ARRAY[
    'audit_entry_is_append_only()',
    'ledger_entry_is_append_only()',
    'ledger_transaction_is_balanced()'
  ] LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%s SET search_path = %I, pg_catalog',
      target_schema, fn, target_schema
    );
  END LOOP;

  -- 2. Deny-by-default at the row level on every CORE table.
  FOREACH tbl IN ARRAY ARRAY[
    'identity', 'identity_link', 'principal', 'session',
    'organization', 'membership',
    'country', 'region', 'city', 'service_area',
    'wallet', 'ledger_transaction', 'ledger_entry', 'payment_authorization',
    'fulfillment',
    'outbox', 'inbox', 'idempotency_key', 'audit_entry', 'schema_migrations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', target_schema, tbl);
  END LOOP;
END
$migration$;

INSERT INTO schema_migrations (version) VALUES ('0006_harden_trigger_functions');

COMMIT;
