-- Rollback for migration 0014.
--
-- Safe to run, with one ordering rule: roll the *code* back first.
--
-- The column carries no durable fact of its own. It records that a worker is
-- holding a row at this instant, which is by construction transient — every
-- acknowledgement clears it and every abandoned claim is reclaimed. Dropping it
-- forgets who is currently holding what; it forgets nothing about any event,
-- delivery, payment or tenant.
--
-- After the drop the three queues behave exactly as they did before B-24: the
-- lease lives on `next_attempt_at` alone, an abandoned claim becomes due again
-- when its lease runs out, and `reclaimed` goes back to being uncountable for
-- these three workers. That is a regression in visibility, not in safety.
--
-- The ordering rule is because code written against 0014 issues
-- `claimed_at IS NULL` in its claim query and `set claimed_at = null` in its
-- acknowledgements. Running that code against a rolled-back schema fails on
-- every claim, which stops all three queues. Roll back the deployment, then run
-- this. Rows left with `claimed_at` set when this runs are unaffected: their
-- `next_attempt_at` is still the lease expiry, so the pre-B-24 claim query picks
-- them up when it runs out.

BEGIN;

DROP INDEX IF EXISTS outbox_lease_idx;
DROP INDEX IF EXISTS inbound_event_lease_idx;
DROP INDEX IF EXISTS event_delivery_lease_idx;

ALTER TABLE outbox         DROP CONSTRAINT IF EXISTS outbox_claim_check;
ALTER TABLE inbound_event  DROP CONSTRAINT IF EXISTS inbound_event_claim_check;
ALTER TABLE event_delivery DROP CONSTRAINT IF EXISTS event_delivery_claim_check;

ALTER TABLE outbox         DROP COLUMN IF EXISTS claimed_at;
ALTER TABLE inbound_event  DROP COLUMN IF EXISTS claimed_at;
ALTER TABLE event_delivery DROP COLUMN IF EXISTS claimed_at;

DELETE FROM schema_migrations WHERE version = '0014_worker_claim_visibility';

COMMIT;
