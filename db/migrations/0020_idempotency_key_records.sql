-- WASLA CORE — migration 0020: make idempotency_key able to record an answer
-- Forward only, additive. No table here is owned by MOVE or MARKET.
-- Rollback: db/migrations/0020_idempotency_key_records.down.sql
--
-- What was wrong.
--
-- The table has existed since 0001 and has never held a row. Nothing in `src/`
-- inserts into it, nothing selects from it, and `tests/runtime-table-parity.test.ts`
-- records it by name as "written by nothing at all". It was a table shaped like
-- an intention: `key`, `scope`, `response_body`, `created_at`, `expires_at`.
--
-- Meanwhile the behaviour it was meant to support was absent, and measurably
-- so. Re-issuing each of the response gate's 29 write-route requests a second
-- time, byte-identical, against the state the first pass left, created a
-- second organization, a second city, a second service area and a second
-- subscription. The subscription is the expensive one: a duplicate is a second
-- recurring charge against the same wallet. `POST /v1/geography/countries`,
-- which the reservation also expected to duplicate, did not — it upserts on
-- the code the caller sends, so the repeat overwrote the row instead of adding
-- one, which is a quieter form of the same defect and is why it is keyed too.
--
-- What the shape could not do.
--
-- Three things are missing from the 0001 columns, and each of them is the
-- difference between a record and a guess:
--
--  1. **No fingerprint of the request.** Without it, a key reused for a
--     *different* request cannot be told from a genuine retry, so the store
--     could only either replay the first answer for a second, different
--     request — telling a caller its new request succeeded when it never ran —
--     or refuse every reuse.
--  2. **No status.** `response_body` alone cannot reproduce an answer: a `201`
--     and a `200` carrying the same body are different answers, and the created
--     resource's status is exactly what a retrying caller is trying to learn.
--  3. **No method.** `scope` was one text column with nothing saying what goes
--     in it. A key is only unique within one route, and `POST /v1/x` and
--     `DELETE /v1/x` are two routes.
--
-- The fix.
--
-- `method` and `request_fingerprint` and `response_status` become columns;
-- `scope` holds the route **template** (`/v1/organizations`), so the two facts
-- that scope a record are two columns rather than one composed string that
-- nothing can index or read back apart. The primary key becomes
-- `(method, scope, key)`, which is what makes the same key on two routes two
-- records instead of a collision, and is the conflict target of the insert.
--
-- `response_body` stays nullable, and that is a decision rather than an
-- omission. Making it NOT NULL would mean a bodyless answer had to be stored
-- as JSON `null` — which Postgres accepts in a `jsonb NOT NULL` column, because
-- JSON null is a value and not SQL NULL, and which the reference backend
-- cannot express at all: its rows are JavaScript objects, where the two nulls
-- are one value, so `assertColumns` would refuse the row Postgres stores. A
-- constraint the two backends enforce differently is the defect B-12 names, so
-- the column stays nullable and SQL NULL means exactly one thing on both
-- sides: the recorded answer carried no body. The table has never held a row,
-- so no existing data had to be considered either way — the one migration in
-- this schema where that is literally true.
--
-- `response_status` is constrained to 2xx. Refusals are deliberately not
-- recorded: a caller whose request was refused for being invalid must be able
-- to correct it and send it again under the same key, and a recorded `400`
-- would answer the corrected request with the old refusal. That rule lives in
-- the router, and this CHECK is what stops a future change from quietly
-- breaking it — the strongest available enforcement, in the place that cannot
-- be bypassed by any code path.
--
-- Row-level security is already enabled on this table by migration 0006, which
-- enables it from a hardcoded list that includes `idempotency_key`; there is
-- nothing to opt in to here.

BEGIN;

ALTER TABLE idempotency_key ADD COLUMN IF NOT EXISTS method text;
ALTER TABLE idempotency_key ADD COLUMN IF NOT EXISTS request_fingerprint text;
ALTER TABLE idempotency_key ADD COLUMN IF NOT EXISTS response_status integer;

-- The table is empty (see above), so these are unconditional rather than
-- backfilled. If a row did exist, the migration would fail here rather than
-- invent a method, a fingerprint or a status for it — and failing is correct,
-- because none of the three can be derived from what 0001 stored.
ALTER TABLE idempotency_key ALTER COLUMN method SET NOT NULL;
ALTER TABLE idempotency_key ALTER COLUMN request_fingerprint SET NOT NULL;
ALTER TABLE idempotency_key ALTER COLUMN response_status SET NOT NULL;

COMMENT ON COLUMN idempotency_key.key IS
  'The Idempotency-Key header the caller sent. Unique within one route, not globally.';
COMMENT ON COLUMN idempotency_key.method IS
  'The HTTP method of the recorded request: half of what scopes a key to a route.';
COMMENT ON COLUMN idempotency_key.scope IS
  'The route template the record belongs to, e.g. /v1/organizations. The template and not the path: the path of a parameterised route carries identifiers that are part of the request, not of the route.';
COMMENT ON COLUMN idempotency_key.request_fingerprint IS
  'SHA-256 over method, route template and the canonical JSON of the parsed body. Equal fingerprints mean the same request and the recorded answer is replayed; a different one means the key was reused and the request is refused with 409.';
COMMENT ON COLUMN idempotency_key.response_status IS
  'The HTTP status of the recorded answer. Constrained to 2xx: refusals are never recorded, so that a caller can correct an invalid request and resend it under the same key.';
COMMENT ON COLUMN idempotency_key.response_body IS
  'The answer as sent, replayed byte for byte. Nullable, and SQL NULL means the recorded answer carried no body at all; JSON null is never written, because the reference backend cannot tell the two apart.';

ALTER TABLE idempotency_key
    ADD CONSTRAINT idempotency_key_response_status_ck
    CHECK (response_status >= 200 AND response_status < 300);

-- The key alone was the primary key, which would have made one caller's key on
-- one route collide with another caller's identical key on a different one.
ALTER TABLE idempotency_key DROP CONSTRAINT IF EXISTS idempotency_key_pkey;
ALTER TABLE idempotency_key
    ADD CONSTRAINT idempotency_key_pkey PRIMARY KEY (method, scope, key);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('0020_idempotency_key_records', now())
ON CONFLICT (version) DO NOTHING;

COMMIT;
