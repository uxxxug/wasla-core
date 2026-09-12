-- Rollback for migration 0012.
--
-- Safe to run, unlike 0011's: nothing here is a truth CORE cannot rebuild. A
-- notification row is a record of an attempt to tell somebody about an event
-- that is still in `outbox`, and the recipient configuration is operational
-- config. Dropping them loses delivery history, not money and not consent.
BEGIN;

DROP INDEX IF EXISTS notification_tenant_idx;
DROP INDEX IF EXISTS notification_lease_idx;
DROP INDEX IF EXISTS notification_due_idx;
DROP TABLE IF EXISTS notification;

DROP INDEX IF EXISTS notification_recipient_type_idx;
DROP TABLE IF EXISTS notification_recipient;

DELETE FROM schema_migrations WHERE version = '0012_notifications';

COMMIT;
