-- WASLA CORE — migration 0017: record work that was executed after CORE cancelled
-- Forward only, additive. No table here is owned by MOVE or MARKET.
-- Rollback: db/migrations/0017_execution_after_cancellation.down.sql
--
-- Why these columns exist (blocker B-29).
--
-- MOVE executes for minutes. A cancellation can arrive during those minutes, and
-- CORE handles it correctly: the fulfillment closes as `cancelled`, the money hold
-- is released, and MARKET is told. What then arrives is `move.job.completed` with
-- `outcome = 'completed'` for a job CORE has already given up on: the work was
-- performed after the order was cancelled, and the payer's money has been handed
-- back.
--
-- CORE used to answer that report with a 409 and store nothing. Two consequences,
-- both worse than the race itself:
--
--   1. The inbound dispatcher retries a thrown error, and this one can never
--      succeed, because a cancelled fulfillment never reopens. So the report was
--      retried five times across hours of backoff and then dead-lettered — the
--      most important message MOVE can send, buried in a queue table as an error
--      string.
--   2. The fulfillment row read `cancelled` + `released`, which is a *consistent*
--      pair. `listFinanciallyInconsistent` and `listPendingFinancialDecision` both
--      returned empty. CORE's own reconciliation reads asserted that nothing was
--      owed and nothing was pending, while a driver had delivered an order for
--      free. Being wrong is bad; being confidently, queryably wrong is worse.
--
-- What CORE can and cannot decide here.
--
-- It cannot decide the money. Re-capturing a voided hold is not possible and would
-- not be legitimate if it were: the payer consented to a purchase that CORE then
-- told them was cancelled. Whether MOVE is paid out of band, whether the payer is
-- re-charged, and who absorbs the loss are the same class of question as B-20 and
-- CORE has not been given an answer to any of them.
--
-- What it can do is stop losing the fact. These two columns are that fact and
-- nothing more: a cancelled fulfillment whose work was reported done anyway, and
-- the job that reported it. `financialDisposition` reads them and answers
-- `decision_required`, so the case lands in the queue that exists for money
-- questions CORE cannot answer, instead of in the silence it used to land in.
--
-- Why on `fulfillment` and not in a table of its own.
--
-- It is a fact about one fulfillment, it is single-valued, and the reads that must
-- surface it (`listFinanciallyInconsistent`, `listPendingFinancialDecision`, and the
-- HTTP views over them) already read this row. A side table would need a join in
-- every one of them and would let the two get out of step; there is nothing here a
-- second table would carry that a column does not.
--
-- Existing rows.
--
-- Every existing row gets NULL, which reads as "no such report was received". That
-- is the correct answer for every row, including the cancelled ones: the reports
-- this migration exists for were rejected and never stored, so CORE genuinely does
-- not know about them. Any still sitting in `inbound_event` with status `dead` and
-- the error `fulfillment was cancelled` can be revived (B-27) once this is
-- deployed, and the new path will record them properly. That is a deliberate
-- operator action and is documented in docs/settlement.md, not a
-- backfill performed here: this migration invents no history.

BEGIN;

-- When MOVE reported the work as completed for a fulfillment CORE had already
-- cancelled. This is MOVE's `completed_at`, not the moment CORE learned it: the
-- question an operator asks is when the work was done relative to the
-- cancellation, and CORE's receipt time answers a different question.
ALTER TABLE fulfillment
    ADD COLUMN IF NOT EXISTS executed_after_cancellation_at timestamptz;

-- Which job reported it. Kept beside the timestamp rather than relying on
-- `move_job_reference`, because that column is null whenever the cancellation beat
-- MOVE's acceptance — which is precisely the ordering that produces this case most
-- often. Losing the job reference would leave an operator with a fact they cannot
-- take to MOVE.
ALTER TABLE fulfillment
    ADD COLUMN IF NOT EXISTS executed_after_cancellation_job_reference text;

-- Both or neither. A timestamp with no job, or a job with no timestamp, is half a
-- fact and no reader could act on it.
ALTER TABLE fulfillment
    DROP CONSTRAINT IF EXISTS fulfillment_execution_after_cancellation_check;
ALTER TABLE fulfillment
    ADD CONSTRAINT fulfillment_execution_after_cancellation_check
    CHECK (
        (executed_after_cancellation_at IS NULL)
        = (executed_after_cancellation_job_reference IS NULL)
    );

-- The marker only means anything on a cancelled row: on open work the completion
-- is the ordinary path, and on a completed or failed row it would be a different
-- claim entirely (MOVE contradicting its own earlier report), which this column is
-- not the place to record. A cancellation is terminal, so no legitimate write can
-- move a marked row out of that status.
ALTER TABLE fulfillment
    DROP CONSTRAINT IF EXISTS fulfillment_execution_after_cancellation_status_check;
ALTER TABLE fulfillment
    ADD CONSTRAINT fulfillment_execution_after_cancellation_status_check
    CHECK (executed_after_cancellation_at IS NULL OR status = 'cancelled');

-- No index. Both reconciliation reads scan the whole table already (they filter in
-- the service, not in SQL), and a partial index on a column that is null for
-- essentially every row would be a write cost with no reader today. When those
-- reads become SQL predicates, the index belongs in that migration, where its
-- query exists to justify it.

INSERT INTO schema_migrations (version) VALUES ('0017_execution_after_cancellation')
ON CONFLICT (version) DO NOTHING;

COMMIT;
