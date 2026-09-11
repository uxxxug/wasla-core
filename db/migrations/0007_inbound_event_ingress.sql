-- WASLA CORE — migration 0007: durable ingress for external events
-- Forward only, additive. No table here is owned by MOVE or MARKET.
-- Rollback: db/migrations/0007_inbound_event_ingress.down.sql
--
-- Why this table exists.
--
-- Until now the only way an event could reach a CORE consumer was the
-- in-process `LocalEventBus`. MARKET and MOVE are separate services in
-- separate repositories, so in production nothing could actually drive the
-- coordination CORE exists to perform. The vertical slice was real, but it was
-- only reachable from inside CORE's own process.
--
-- This is the inbound mirror of `outbox`, and it exists for the same reason.
-- Accepting an event over HTTP and then processing it in the same request would
-- mean a crash after the 2xx loses the event, and the producer has no way to
-- know: it was told the event was accepted. So ingress does one thing — record
-- the envelope durably and commit — and a dispatcher moves it onto the bus
-- afterwards. The event is safe the moment the producer is told it is.
--
-- `event_id` is the primary key, which is what makes redelivery free: a
-- producer retrying after a timeout collides on insert and CORE answers that
-- the event is already held, without processing it twice.

BEGIN;

CREATE TABLE IF NOT EXISTS inbound_event (
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
                    CHECK (status IN ('pending', 'processed', 'dead')),
    attempts        integer NOT NULL DEFAULT 0,
    last_error      text,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    received_at     timestamptz NOT NULL DEFAULT now(),
    processed_at    timestamptz,
    -- A processed row must say when, and a pending row must not claim to have
    -- been processed. Without this the table can misreport its own progress.
    CONSTRAINT inbound_event_processed_at_check
        CHECK ((status = 'processed') = (processed_at IS NOT NULL))
);

-- Dispatcher poll path, mirroring outbox_due_idx.
CREATE INDEX IF NOT EXISTS inbound_event_due_idx
    ON inbound_event (next_attempt_at)
    WHERE status = 'pending';

-- Operator view: what arrived from a given producer, in order.
CREATE INDEX IF NOT EXISTS inbound_event_producer_idx
    ON inbound_event (producer, received_at DESC);

-- ─────────────────────── the caller's identity ───────────────────────
--
-- Which prefix a caller may submit has to be derived from the credential, not
-- from anything in the request. A header naming the producer would let a MOVE
-- credential assert MARKET's facts, and `core.*` is worse: an outside caller
-- able to announce a capture that never happened would be forging the facts
-- every downstream consumer treats as authoritative.
--
-- So a service caller is a principal that IS that service. The column is
-- UNIQUE because two principals claiming to be MARKET makes "who sent this"
-- unanswerable, and NULL for every human principal.
ALTER TABLE principal
    ADD COLUMN IF NOT EXISTS service_name text UNIQUE
    CONSTRAINT principal_service_name_check CHECK (service_name <> '');

-- Deny-by-default at the row level, as migration 0006 does for every other
-- CORE table. The list in 0006 is hardcoded, so a new table escapes the policy
-- unless it opts in here; `tests/db-schema.test.ts` is what noticed that this
-- one had, and it is the reason that test compares against the live catalogue
-- rather than a number.
ALTER TABLE inbound_event ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations (version) VALUES ('0007_inbound_event_ingress')
ON CONFLICT (version) DO NOTHING;

COMMIT;
