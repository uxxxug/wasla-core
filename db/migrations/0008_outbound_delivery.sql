-- WASLA CORE — migration 0008: outbound delivery to external subscribers
-- Forward only, additive. No table here is owned by MOVE or MARKET.
-- Rollback: db/migrations/0008_outbound_delivery.down.sql
--
-- Why this exists.
--
-- Migration 0007 gave MARKET and MOVE a way to reach CORE. This is the other
-- half: CORE's own events reached only in-process subscribers, so nothing
-- outside the process could learn that a fulfillment had been created,
-- dispatched or cancelled. The coordination loop had an entrance and no exit.
--
-- Two tables, because two different things fail.
--
-- `event_subscription` is configuration: who wants which event type, and
-- where. It is deliberately data rather than code — CORE must not contain a
-- hardcoded MOVE or MARKET endpoint (ADR 0018), and an operator has to be able
-- to move an endpoint without a deploy.
--
-- `event_delivery` is one row per (event, subscription), and it is the unit of
-- work. Per-subscriber rows are what make one subscriber being down unable to
-- hold up another, and what make "delivered to MOVE but not yet to MARKET" a
-- state the system can actually represent instead of losing.

BEGIN;

CREATE TABLE IF NOT EXISTS event_subscription (
    subscription_id text PRIMARY KEY,
    -- The external system, e.g. the same name its service credential carries.
    subscriber      text NOT NULL,
    event_type      text NOT NULL,
    endpoint_url    text NOT NULL CHECK (endpoint_url <> ''),
    -- Shared secret CORE signs each body with, so the receiver can tell a real
    -- CORE event from anything else that can reach its endpoint. Stored because
    -- HMAC needs the plaintext; never returned by any read path, never logged,
    -- and redacted by the audit scrubber. See docs/outbound-delivery.md.
    signing_secret  text NOT NULL CHECK (signing_secret <> ''),
    active          boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- One subscription per subscriber per event type. Two would mean the same
    -- event delivered twice to the same system with no way to tell which
    -- endpoint is current.
    UNIQUE (subscriber, event_type)
);

-- Fan-out lookup: every active subscription for an event type.
CREATE INDEX IF NOT EXISTS event_subscription_type_idx
    ON event_subscription (event_type)
    WHERE active;

CREATE TABLE IF NOT EXISTS event_delivery (
    delivery_id     text PRIMARY KEY,
    event_id        uuid NOT NULL REFERENCES outbox (event_id),
    subscription_id text NOT NULL REFERENCES event_subscription (subscription_id),
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'delivered', 'dead')),
    attempts        integer NOT NULL DEFAULT 0,
    last_error      text,
    -- HTTP status of the last attempt, when there was a response at all.
    -- NULL means the attempt never got one: timeout, DNS, refused connection.
    last_status     integer,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    delivered_at    timestamptz,
    -- The same guarantee the ingress side gets from its primary key: an event
    -- is queued for a subscriber exactly once, however many times the relay
    -- that queues it is retried.
    UNIQUE (event_id, subscription_id),
    CONSTRAINT event_delivery_delivered_at_check
        CHECK ((status = 'delivered') = (delivered_at IS NOT NULL))
);

-- Worker poll path, mirroring outbox_due_idx and inbound_event_due_idx.
CREATE INDEX IF NOT EXISTS event_delivery_due_idx
    ON event_delivery (next_attempt_at)
    WHERE status = 'pending';

-- Operator view: what is stuck, and for whom.
CREATE INDEX IF NOT EXISTS event_delivery_subscription_idx
    ON event_delivery (subscription_id, status, created_at DESC);

-- Deny-by-default at the row level. Migration 0006 does this from a hardcoded
-- list, so every new table has to opt in here; see ROADMAP.md > Risks.
ALTER TABLE event_subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_delivery ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations (version) VALUES ('0008_outbound_delivery')
ON CONFLICT (version) DO NOTHING;

COMMIT;
