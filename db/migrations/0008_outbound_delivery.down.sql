-- Rollback for migration 0008.
BEGIN;

DROP INDEX IF EXISTS event_delivery_subscription_idx;
DROP INDEX IF EXISTS event_delivery_due_idx;
DROP TABLE IF EXISTS event_delivery;

DROP INDEX IF EXISTS event_subscription_type_idx;
DROP TABLE IF EXISTS event_subscription;

DELETE FROM schema_migrations WHERE version = '0008_outbound_delivery';

COMMIT;
