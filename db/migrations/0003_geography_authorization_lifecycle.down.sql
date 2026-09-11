-- Safe only before CORE geography reference data or hold expiry becomes authoritative.
BEGIN;
DROP INDEX IF EXISTS payment_authorization_expiry_idx;
ALTER TABLE payment_authorization DROP CONSTRAINT IF EXISTS payment_authorization_void_reason_required;
ALTER TABLE payment_authorization DROP COLUMN IF EXISTS void_reason;
ALTER TABLE payment_authorization DROP COLUMN IF EXISTS expires_at;
DROP INDEX IF EXISTS service_area_country_idx;
DROP TABLE IF EXISTS service_area;
DROP INDEX IF EXISTS city_region_idx;
DROP TABLE IF EXISTS city;
DROP TABLE IF EXISTS region;
DROP TABLE IF EXISTS country;
DELETE FROM schema_migrations WHERE version = '0003_geography_authorization_lifecycle';
COMMIT;
