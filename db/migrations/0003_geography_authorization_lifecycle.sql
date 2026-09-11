-- Additive CORE-owned geography reference data and payment-hold lifecycle.
-- Authored and verified only; not executed against a database (B-1).

BEGIN;

INSERT INTO schema_migrations (version) VALUES ('0003_geography_authorization_lifecycle');

CREATE TABLE country (
  country_code char(2) PRIMARY KEY CHECK (country_code ~ '^[A-Z]{2}$'),
  name text NOT NULL,
  default_currency char(3) NOT NULL CHECK (default_currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK (status IN ('active', 'inactive'))
);

CREATE TABLE region (
  region_id uuid PRIMARY KEY,
  country_code char(2) NOT NULL REFERENCES country(country_code),
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'inactive')),
  UNIQUE (country_code, code)
);

CREATE TABLE city (
  city_id uuid PRIMARY KEY,
  region_id uuid NOT NULL REFERENCES region(region_id),
  country_code char(2) NOT NULL REFERENCES country(country_code),
  name text NOT NULL,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  status text NOT NULL CHECK (status IN ('active', 'inactive'))
);
CREATE INDEX city_region_idx ON city (region_id);

-- A named operating area: centre + radius. Reference geography only —
-- no live position, route, ETA or dispatch state is stored in CORE.
CREATE TABLE service_area (
  service_area_id uuid PRIMARY KEY,
  city_id uuid NOT NULL REFERENCES city(city_id),
  country_code char(2) NOT NULL REFERENCES country(country_code),
  name text NOT NULL,
  centre_latitude double precision NOT NULL CHECK (centre_latitude BETWEEN -90 AND 90),
  centre_longitude double precision NOT NULL CHECK (centre_longitude BETWEEN -180 AND 180),
  radius_metres integer NOT NULL CHECK (radius_metres > 0 AND radius_metres <= 500000),
  status text NOT NULL CHECK (status IN ('active', 'inactive'))
);
CREATE INDEX service_area_country_idx ON service_area (country_code);

-- Payment hold lifecycle (ADR 0005): expiry and an auditable void reason.
ALTER TABLE payment_authorization ADD COLUMN expires_at timestamptz;
ALTER TABLE payment_authorization ADD COLUMN void_reason text;
ALTER TABLE payment_authorization
  ADD CONSTRAINT payment_authorization_void_reason_required
  CHECK (status <> 'voided' OR void_reason IS NOT NULL);
CREATE INDEX payment_authorization_expiry_idx
  ON payment_authorization (expires_at)
  WHERE status = 'authorized';

COMMIT;
