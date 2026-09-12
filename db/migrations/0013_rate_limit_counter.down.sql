-- Rollback for migration 0013.
--
-- Safe to run. The table holds counters for windows measured in minutes and
-- nothing else; dropping it forgets how much budget the current callers have
-- spent, which the next window would have forgotten anyway. No money, no
-- consent, no audit trail lives here.
BEGIN;

DROP INDEX IF EXISTS rate_limit_counter_window_idx;
DROP TABLE IF EXISTS rate_limit_counter;

DELETE FROM schema_migrations WHERE version = '0013_rate_limit_counter';

COMMIT;
