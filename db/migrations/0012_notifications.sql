-- WASLA CORE — migration 0012: notifications to people over channels
-- Forward only, additive. No table here is owned by MOVE or MARKET.
-- Rollback: db/migrations/0012_notifications.down.sql
--
-- Why this exists, and how it differs from migration 0008.
--
-- 0008 gave CORE a way to reach systems: `event_subscription` +
-- `event_delivery`, HMAC-signed HTTP to an endpoint MOVE or MARKET operates.
-- That is machine-to-machine integration. It cannot notify a person: a person
-- is not an endpoint, has no signing secret, and is reached on a channel
-- (Telegram, email, SMS) that CORE models as an identity link (ADR 0016) rather
-- than as a URL.
--
-- Milestone 4 is that missing half. Telegram existed only as `channel_type` on
-- an identity link — a way in, never a way out.
--
-- Two tables, for the same reason 0008 has two.
--
-- `notification_recipient` is configuration: who is notified about which event
-- type, on which channel. Data rather than code, because "the operations team
-- gets fulfillment failures on Telegram" is an operational decision that must
-- not need a deploy, and because CORE must not contain a hardcoded address.
--
-- `notification` is one row per (event, recipient), and it is the unit of work.
-- It carries its own delivery state so that one channel being down cannot hold
-- up another, and so that "handed to the provider but not confirmed delivered"
-- is a state the system can represent instead of guessing.

BEGIN;

CREATE TABLE IF NOT EXISTS notification_recipient (
    recipient_id    text PRIMARY KEY,
    -- NULL means platform-wide: notified about this event type whatever tenant
    -- produced it. Set means only that tenant's events.
    organization_id uuid REFERENCES organization (organization_id),
    event_type      text NOT NULL CHECK (event_type LIKE 'core.%'),
    -- Who, as an identity CORE owns. Never a raw address: an address belongs to
    -- a channel link, and a link can be re-verified, replaced or revoked
    -- without the recipient configuration having to be rewritten (ADR 0016).
    identity_id     uuid NOT NULL REFERENCES identity (identity_id),
    channel         text NOT NULL CHECK (channel IN ('telegram', 'email', 'phone')),
    active          boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- One configuration per person per channel per event type. Two would mean
    -- the same person notified twice for one event with no way to say which
    -- row is current.
    UNIQUE (organization_id, event_type, identity_id, channel)
);

-- Fan-out lookup: every active recipient for an event type.
CREATE INDEX IF NOT EXISTS notification_recipient_type_idx
    ON notification_recipient (event_type)
    WHERE active;

CREATE TABLE IF NOT EXISTS notification (
    notification_id text PRIMARY KEY,
    event_id        uuid NOT NULL REFERENCES outbox (event_id),
    recipient_id    text NOT NULL REFERENCES notification_recipient (recipient_id),
    organization_id uuid REFERENCES organization (organization_id),
    channel         text NOT NULL CHECK (channel IN ('telegram', 'email', 'phone')),
    -- Resolved from the identity's verified channel link at fan-out time and
    -- frozen here. Not resolved per attempt on purpose: a retry must go to the
    -- address the notification was created for, or a re-verified link would
    -- silently redirect an in-flight message and history would no longer say
    -- where it went.
    -- Nullable for exactly one case: a recipient whose identity has no verified
    -- link on that channel any more by the time the event is relayed. That
    -- notification is born `failed`, because "we could not reach this person"
    -- is an operational fact worth keeping, and inventing a placeholder address
    -- to satisfy a NOT NULL would be a lie stored in the column an operator
    -- reads first.
    address         text CHECK (address <> ''),
    -- Which message this is, from a closed set. The body is rendered from named
    -- event fields, never from a dump of an internal record.
    template        text NOT NULL,
    subject         text,
    body            text NOT NULL CHECK (body <> ''),
    data            jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Stable across every attempt, handed to the provider so a provider that
    -- honours idempotency keys collapses a repeat. CORE does not assume any
    -- provider does; see docs/notifications.md.
    idempotency_key text NOT NULL UNIQUE,
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'accepted', 'delivered', 'failed')),
    attempts        integer NOT NULL DEFAULT 0,
    last_error      text,
    -- What the provider called the message, when it said. Kept so an operator
    -- can take a CORE notification id to a provider console.
    provider_message_id text,
    -- Fencing token, set when a worker claims the row and cleared when the
    -- attempt is acknowledged. A worker whose lease expired holds a stale
    -- token, so its late acknowledgement matches no row and cannot overwrite
    -- the result of the attempt that replaced it.
    claim_token     text,
    claimed_at      timestamptz,
    -- Doubles as the lease: a claim pushes it forward, so an abandoned claim
    -- becomes visible again by the same clock that schedules a retry.
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- Handed over to the channel. Delivery is not confirmed by this alone.
    accepted_at     timestamptz,
    -- The channel confirmed the message reached the recipient.
    delivered_at    timestamptz,
    failed_at       timestamptz,
    -- One notification per event per recipient, whatever happens to the relay
    -- that queues it. The same guarantee event_delivery gets from its own
    -- unique pair, and the reason re-running the fan-out is free.
    UNIQUE (event_id, recipient_id),
    -- A claim token exists exactly while a worker holds the row.
    -- No address means the row cannot be anything but failed. Named for the
    -- rule rather than the column: PostgreSQL already calls the inline
    -- `address <> ''` check `notification_address_check`.
    CONSTRAINT notification_address_when_failed_check
        CHECK (address IS NOT NULL OR status = 'failed'),
    CONSTRAINT notification_claim_check
        CHECK ((status = 'processing') = (claim_token IS NOT NULL)),
    -- The timestamps and the status cannot disagree.
    CONSTRAINT notification_accepted_check
        CHECK ((status IN ('accepted', 'delivered')) = (accepted_at IS NOT NULL)),
    CONSTRAINT notification_delivered_check
        CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
    CONSTRAINT notification_failed_check
        CHECK ((status = 'failed') = (failed_at IS NOT NULL))
);

-- Worker poll path, mirroring outbox_due_idx, inbound_event_due_idx and
-- event_delivery_due_idx.
CREATE INDEX IF NOT EXISTS notification_due_idx
    ON notification (next_attempt_at)
    WHERE status = 'pending';

-- Reclaim path: rows whose lease has run out.
CREATE INDEX IF NOT EXISTS notification_lease_idx
    ON notification (next_attempt_at)
    WHERE status = 'processing';

-- Operator view: what is stuck, and for whom.
CREATE INDEX IF NOT EXISTS notification_tenant_idx
    ON notification (organization_id, status, created_at DESC);

-- Deny-by-default at the row level. Migration 0006 does this from a hardcoded
-- list, so every new table has to opt in here; see ROADMAP.md > Risks.
ALTER TABLE notification_recipient ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations (version) VALUES ('0012_notifications')
ON CONFLICT (version) DO NOTHING;

COMMIT;
