-- WASLA CORE — migration 0001: foundation (eventing, audit, identity, organization)
-- Forward only, additive. No table here is owned by MOVE or MARKET.
-- Rollback: db/migrations/0001_core_foundation.down.sql
--
-- STATUS: authored and reviewed. NOT yet executed against any database —
-- no CORE database has been provisioned. See ROADMAP.md > Blockers.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────── eventing ───────────────────────────

CREATE TABLE IF NOT EXISTS outbox (
    event_id        uuid PRIMARY KEY,
    event_type      text NOT NULL,
    version         integer NOT NULL CHECK (version >= 1),
    producer        text NOT NULL,
    occurred_at     timestamptz NOT NULL,
    correlation_id  text NOT NULL,
    causation_id    text,
    entity_type     text NOT NULL,
    entity_id       text NOT NULL,
    payload         jsonb NOT NULL,
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'published', 'dead')),
    attempts        integer NOT NULL DEFAULT 0,
    last_error      text,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Relay poll path.
CREATE INDEX IF NOT EXISTS outbox_due_idx
    ON outbox (next_attempt_at)
    WHERE status = 'pending';

-- Per-entity ordering when a consumer needs it.
CREATE INDEX IF NOT EXISTS outbox_entity_idx ON outbox (entity_type, entity_id, occurred_at);

CREATE TABLE IF NOT EXISTS inbox (
    consumer     text NOT NULL,
    event_id     uuid NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer, event_id)
);

CREATE TABLE IF NOT EXISTS idempotency_key (
    key            text PRIMARY KEY,
    scope          text NOT NULL,
    response_body  jsonb,
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idempotency_key_expiry_idx ON idempotency_key (expires_at);

-- ──────────────────────────── audit ─────────────────────────────

CREATE TABLE IF NOT EXISTS audit_entry (
    audit_id       uuid PRIMARY KEY,
    occurred_at    timestamptz NOT NULL DEFAULT now(),
    actor_type     text NOT NULL CHECK (actor_type IN ('principal', 'system', 'service')),
    actor_id       uuid,
    action         text NOT NULL,
    entity_type    text NOT NULL,
    entity_id      text NOT NULL,
    correlation_id text NOT NULL,
    metadata       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_entry (entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_correlation_idx ON audit_entry (correlation_id);

-- Audit is append-only: block UPDATE and DELETE at the database level.
CREATE OR REPLACE FUNCTION audit_entry_is_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_entry is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_entry_no_mutation ON audit_entry;
CREATE TRIGGER audit_entry_no_mutation
    BEFORE UPDATE OR DELETE ON audit_entry
    FOR EACH ROW EXECUTE FUNCTION audit_entry_is_append_only();

-- ────────────────────── organization / tenancy ──────────────────

CREATE TABLE IF NOT EXISTS organization (
    organization_id uuid PRIMARY KEY,
    name            text NOT NULL,
    status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    country_code    char(2) NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    source_system   text NOT NULL,
    legacy_id       text
);

-- Provenance for migration and reconciliation: a legacy row is imported once.
CREATE UNIQUE INDEX IF NOT EXISTS organization_legacy_idx
    ON organization (source_system, legacy_id)
    WHERE legacy_id IS NOT NULL;

-- ───────────────────────── identity & access ────────────────────

CREATE TABLE IF NOT EXISTS identity (
    identity_id           uuid PRIMARY KEY,
    status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'suspended', 'merged')),
    -- Set only by an explicit, audited merge. Never written automatically.
    canonical_identity_id uuid REFERENCES identity (identity_id),
    display_name          text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    source_system         text NOT NULL,
    legacy_id             text,
    CONSTRAINT identity_merged_requires_canonical
        CHECK (status <> 'merged' OR canonical_identity_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS identity_legacy_idx
    ON identity (source_system, legacy_id)
    WHERE legacy_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS identity_link (
    identity_link_id uuid PRIMARY KEY,
    identity_id      uuid NOT NULL REFERENCES identity (identity_id),
    channel_type     text NOT NULL
                     CHECK (channel_type IN ('telegram', 'phone', 'email', 'web', 'partner_api')),
    external_id      text NOT NULL,
    verified_at      timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    -- A channel account belongs to exactly one identity.
    UNIQUE (channel_type, external_id)
);

CREATE INDEX IF NOT EXISTS identity_link_identity_idx ON identity_link (identity_id);

CREATE TABLE IF NOT EXISTS principal (
    principal_id uuid PRIMARY KEY,
    identity_id  uuid NOT NULL REFERENCES identity (identity_id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (identity_id)
);

CREATE TABLE IF NOT EXISTS session (
    session_id   uuid PRIMARY KEY,
    principal_id uuid NOT NULL REFERENCES principal (principal_id),
    -- Only the hash is stored. The plaintext token is returned once, at issue.
    token_hash   text NOT NULL UNIQUE,
    channel_type text NOT NULL,
    issued_at    timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz
);

CREATE INDEX IF NOT EXISTS session_principal_idx ON session (principal_id);
CREATE INDEX IF NOT EXISTS session_active_idx ON session (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS membership (
    membership_id   uuid PRIMARY KEY,
    principal_id    uuid NOT NULL REFERENCES principal (principal_id),
    organization_id uuid NOT NULL REFERENCES organization (organization_id),
    roles           text[] NOT NULL CHECK (array_length(roles, 1) >= 1),
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (principal_id, organization_id)
);

CREATE INDEX IF NOT EXISTS membership_org_idx ON membership (organization_id);

INSERT INTO schema_migrations (version)
VALUES ('0001_core_foundation')
ON CONFLICT (version) DO NOTHING;

COMMIT;
