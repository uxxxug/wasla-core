-- Rollback of 0010_subscriptions_and_entitlements.
--
-- This rollback REFUSES to run once any period has been settled, the way
-- 0009's refuses once a hold has been partially captured. A settled period is
-- money that moved against a hold and a record of what it paid for; dropping
-- the table would leave a captured authorization in the ledger with nothing
-- left to say why it was captured, and no rollback can put that back. Usage is
-- append-only for the same reason and is checked with it.
--
-- To roll back past a settled period, decide what happens to the money first.

BEGIN;

DO $guard$
DECLARE
  settled bigint;
  used bigint;
BEGIN
  SELECT count(*) INTO settled FROM subscription_period WHERE status = 'settled';
  SELECT count(*) INTO used FROM usage_record;
  IF settled > 0 OR used > 0 THEN
    RAISE EXCEPTION
      'refusing to roll back 0010: % settled period(s) and % usage record(s) exist; dropping them would orphan captured money and destroy an append-only billing basis',
      settled, used;
  END IF;
END
$guard$;

DROP TRIGGER IF EXISTS usage_record_within_period ON usage_record;
DROP TRIGGER IF EXISTS usage_record_append_only ON usage_record;
DROP TRIGGER IF EXISTS subscription_period_money_agrees ON subscription_period;
DROP TRIGGER IF EXISTS subscription_currency_check ON subscription;
DROP TRIGGER IF EXISTS plan_grant_immutable ON plan_grant;
DROP TRIGGER IF EXISTS plan_terms_immutable ON plan;

DROP TABLE IF EXISTS usage_record;
DROP TABLE IF EXISTS subscription_period;
DROP TABLE IF EXISTS subscription;
DROP TABLE IF EXISTS plan_grant;
DROP TABLE IF EXISTS plan;

DROP FUNCTION IF EXISTS usage_record_period_is_open();
DROP FUNCTION IF EXISTS usage_record_is_append_only();
DROP FUNCTION IF EXISTS subscription_period_agrees_with_money();
DROP FUNCTION IF EXISTS subscription_currency_agrees();
DROP FUNCTION IF EXISTS plan_grants_are_immutable_once_active();
DROP FUNCTION IF EXISTS plan_terms_are_immutable_once_active();

-- btree_gist is deliberately NOT dropped. It is a database-level object that
-- another migration or another schema may already depend on, and dropping a
-- shared extension to undo one table is a wider blast radius than the change
-- it is reversing.

DELETE FROM schema_migrations WHERE version = '0010_subscriptions_and_entitlements';

COMMIT;
