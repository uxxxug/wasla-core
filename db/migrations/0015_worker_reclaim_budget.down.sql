-- Rollback for migration 0015.
--
-- Safe to run, with the same ordering rule as 0014: roll the *code* back first.
--
-- The column carries no durable fact about any event, delivery, payment or
-- tenant. It counts how many times a worker died holding a row — an operational
-- tally that only this limit reads. Dropping it forgets those tallies and nothing
-- else.
--
-- After the drop the three queues behave exactly as they did between B-24 and
-- B-25: an abandoned claim is still visible and still recovered, but the recovery
-- is unbounded again, so a payload that kills its worker every time is retried for
-- ever and never dead-lettered. That is a regression in containment, not in
-- safety — no row is lost, no row is processed twice.
--
-- The ordering rule is because code written against 0015 writes
-- `reclaims = reclaims + 1` in its reclaim statement and reads the value back to
-- decide between pending and dead. Running that code against a rolled-back schema
-- fails on every reclaim pass, which leaves abandoned rows held for ever — worse
-- than the behaviour being rolled back to. Roll back the deployment, then run this.
--
-- Rows this migration's code already dead-lettered stay dead. That is deliberate:
-- each one was abandoned more times than the budget allowed, which is a fact about
-- the payload that survives the schema. Reviving them is an operator decision and
-- must not be a side effect of a rollback.

BEGIN;

ALTER TABLE outbox         DROP CONSTRAINT IF EXISTS outbox_reclaims_check;
ALTER TABLE inbound_event  DROP CONSTRAINT IF EXISTS inbound_event_reclaims_check;
ALTER TABLE event_delivery DROP CONSTRAINT IF EXISTS event_delivery_reclaims_check;

ALTER TABLE outbox         DROP COLUMN IF EXISTS reclaims;
ALTER TABLE inbound_event  DROP COLUMN IF EXISTS reclaims;
ALTER TABLE event_delivery DROP COLUMN IF EXISTS reclaims;

DELETE FROM schema_migrations WHERE version = '0015_worker_reclaim_budget';

COMMIT;
