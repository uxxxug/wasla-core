-- Rollback for migration 0017.
--
-- Roll the *code* back first, as with 0014 and 0015. Code written against 0017
-- writes these two columns in `markExecutedAfterCancellation` and reads them in
-- `financialDisposition`; run it against a rolled-back schema and every
-- post-cancellation completion report fails on the write, which puts the report
-- back in the retry-and-dead-letter loop this migration removed.
--
-- What is forgotten by the drop, and what is not.
--
-- The columns carry one fact per row: a fulfillment CORE cancelled whose work MOVE
-- reported as done anyway. Dropping them forgets that fact for every row that
-- carries it, and those cases stop appearing in `listPendingFinancialDecision`.
-- Nothing else is lost — no money moved because of this marker and none will be
-- unmoved by removing it, since the money was released by the cancellation long
-- before the marker was written.
--
-- The trail survives the drop in two places, which is why this rollback is
-- acceptable at all: `core.fulfillment.executed_after_cancellation` was published to
-- the outbox and has been consumed by whoever subscribes to it, and the audit entry
-- `fulfillment.executed_after_cancellation` names the fulfillment and the job. An
-- operator who needs the list after a rollback reads the audit log, not this table.
--
-- After the drop, behaviour returns to what B-29 describes: a completion report for
-- a cancelled fulfillment is refused with a 409, retried by the dispatcher until it
-- exhausts its attempts, and dead-lettered — and the fulfillment reads as a settled
-- cancellation with nothing pending on anyone.

BEGIN;

ALTER TABLE fulfillment
    DROP CONSTRAINT IF EXISTS fulfillment_execution_after_cancellation_status_check;
ALTER TABLE fulfillment
    DROP CONSTRAINT IF EXISTS fulfillment_execution_after_cancellation_check;

ALTER TABLE fulfillment DROP COLUMN IF EXISTS executed_after_cancellation_job_reference;
ALTER TABLE fulfillment DROP COLUMN IF EXISTS executed_after_cancellation_at;

DELETE FROM schema_migrations WHERE version = '0017_execution_after_cancellation';

COMMIT;
