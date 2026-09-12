-- WASLA CORE — migration 0013: ingress rate-limit counters
-- Forward only, additive. No table here is owned by MOVE or MARKET.
-- Rollback: db/migrations/0013_rate_limit_counter.down.sql
--
-- Why a table at all.
--
-- A rate limiter that lives in one process's memory limits one process. Two
-- instances behind a load balancer would each allow the full budget, so the
-- effective limit becomes the policy multiplied by however many instances happen
-- to be running — a number nobody chose and nobody can see. CORE's deployment
-- topology is still undecided (B-5), which is precisely the reason the limit must
-- not silently depend on it.
--
-- Why one row per window instead of a log of requests.
--
-- A sliding window needs one row per request, kept for the window length: state
-- that grows with traffic, on the path of every request, to smooth a boundary
-- effect nobody has complained about. A fixed window needs one row per
-- (subject, class, window) and is incremented by a single statement whose result
-- is the decision. The known cost is that a caller may spend its budget at the
-- end of one window and again at the start of the next; the bound is twice the
-- limit, and that is an acceptable price for protecting CORE from a runaway
-- caller.
--
-- Why the subject is a hash.
--
-- The subject is either a bearer credential or a client address. Both identify a
-- caller, and neither belongs in a table that exists to count. The hash is
-- sufficient to count (equal callers hash equally), useless to an attacker who
-- reads the table (a hash cannot be presented as a credential), and keeps the
-- column fixed-width. It is the same discipline `session.token_hash` follows.
--
-- Why this is not in the request's transaction.
--
-- The increment runs on its own, before any handler. A refused request must not
-- be able to roll back the counter that refused it, and a domain write must not
-- be able to roll back the fact that the caller spent budget.
BEGIN;

CREATE TABLE IF NOT EXISTS rate_limit_counter (
  -- 'credential' when a bearer token was presented, 'network' when the caller
  -- could only be identified by address. Kept separate so a flood of invalid
  -- tokens cannot share a budget with anonymous callers.
  subject_kind    TEXT        NOT NULL,
  subject_hash    TEXT        NOT NULL,
  -- Route class, not route: the policy is per class, and per-route limits would
  -- be a configuration surface with one entry per endpoint.
  rate_class      TEXT        NOT NULL,
  window_start    TIMESTAMPTZ NOT NULL,
  hits            BIGINT      NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL,
  CONSTRAINT rate_limit_counter_subject_kind_ck
    CHECK (subject_kind IN ('credential', 'network')),
  CONSTRAINT rate_limit_counter_rate_class_ck
    CHECK (rate_class IN ('ingress_events', 'write', 'read', 'unmatched')),
  CONSTRAINT rate_limit_counter_hits_ck CHECK (hits >= 0),
  -- The primary key is the conflict target of the upsert, which is what makes
  -- "increment and read the new value" one atomic step for concurrent callers.
  PRIMARY KEY (subject_kind, subject_hash, rate_class, window_start)
);

-- Pruning old windows scans by time, not by subject.
CREATE INDEX IF NOT EXISTS rate_limit_counter_window_idx
  ON rate_limit_counter (window_start);

-- Deny-by-default at the row level. Migration 0006 does this from a hardcoded
-- list, so every new table has to opt in here; see ROADMAP.md > Risks. It applies
-- here for the same reason as everywhere else even though a counter row names
-- nobody: the invariant is "every table", and a table exempted because its
-- contents looked harmless is how the invariant stops being one.
ALTER TABLE rate_limit_counter ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('0013_rate_limit_counter', now())
ON CONFLICT (version) DO NOTHING;

COMMIT;
