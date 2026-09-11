-- Rollback for 0001_core_foundation.
-- Safe only while CORE holds no production data. Once CORE is the source of
-- truth for identity, this script MUST NOT be run: use a forward-fix migration.

BEGIN;

DROP TABLE IF EXISTS membership;
DROP TABLE IF EXISTS session;
DROP TABLE IF EXISTS principal;
DROP TABLE IF EXISTS identity_link;
DROP TABLE IF EXISTS identity;
DROP TABLE IF EXISTS organization;

DROP TRIGGER IF EXISTS audit_entry_no_mutation ON audit_entry;
DROP FUNCTION IF EXISTS audit_entry_is_append_only();
DROP TABLE IF EXISTS audit_entry;

DROP TABLE IF EXISTS idempotency_key;
DROP TABLE IF EXISTS inbox;
DROP TABLE IF EXISTS outbox;

DELETE FROM schema_migrations WHERE version = '0001_core_foundation';

COMMIT;
