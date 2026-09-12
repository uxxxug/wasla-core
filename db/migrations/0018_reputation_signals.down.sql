-- Rollback of 0018_reputation_signals.
--
-- This rollback REFUSES to run once any signal has been recorded, the way
-- 0009's and 0010's refuse once money history would be falsified by dropping
-- the tables. The reason is the same in kind and different in substance: a
-- reputation signal is a report another system made about a person or an
-- organization, it is append-only precisely because nobody may rewrite it, and
-- CORE cannot ask MARKET to send it again — the producer has already been told
-- the fact was accepted and deduplicates on its own reference, so a re-send
-- would be refused as a duplicate of a row that no longer exists.
--
-- To roll back past a recorded signal, export the table first and decide where
-- the exported facts live. An empty table rolls back freely, which is the case
-- this script exists for: an unhealthy deploy that never ingested anything.

BEGIN;

DO $guard$
DECLARE
  recorded bigint;
BEGIN
  SELECT count(*) INTO recorded FROM reputation_signal;
  IF recorded > 0 THEN
    RAISE EXCEPTION
      'refusing to roll back 0018: % reputation signal(s) exist; they are append-only reports CORE cannot ask their producers to re-send',
      recorded;
  END IF;
END
$guard$;

DROP TRIGGER IF EXISTS reputation_signal_append_only ON reputation_signal;

DROP TABLE IF EXISTS reputation_signal;

DROP FUNCTION IF EXISTS reputation_signal_is_append_only();

DELETE FROM schema_migrations WHERE version = '0018_reputation_signals';

COMMIT;
