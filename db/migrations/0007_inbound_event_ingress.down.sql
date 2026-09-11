-- Rollback for migration 0007.
BEGIN;

ALTER TABLE principal DROP COLUMN IF EXISTS service_name;

DROP INDEX IF EXISTS inbound_event_producer_idx;
DROP INDEX IF EXISTS inbound_event_due_idx;
DROP TABLE IF EXISTS inbound_event;

DELETE FROM schema_migrations WHERE version = '0007_inbound_event_ingress';

COMMIT;
