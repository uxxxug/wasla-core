-- WASLA CORE — migration 0019: make membership_roles_check actually refuse an empty role list
-- Forward only, additive. No table here is owned by MOVE or MARKET.
-- Rollback: db/migrations/0019_membership_roles_effective.down.sql
--
-- What was wrong.
--
-- `membership_roles_check` was written as:
--
--     CHECK (array_length(roles, 1) >= 1)
--
-- and it enforced nothing. `array_length('{}'::text[], 1)` is NULL, not 0,
-- because an empty array has no first dimension; `NULL >= 1` is NULL; and a
-- CHECK constraint that evaluates to NULL is satisfied. So the one row the
-- constraint existed to refuse — a membership granting no roles — was the exact
-- row it let through, for every migration since 0001.
--
-- Why that matters beyond tidiness.
--
-- A membership is how a principal is attached to an organization, and the roles
-- are the whole of what the attachment permits. A membership with no roles reads
-- as belonging without permission: `listMemberships` returns it, so an operator
-- reviewing who has access sees the principal on the organization, while every
-- authorisation check answers no. The two readings disagree, and the disagreement
-- is invisible in both.
--
-- How it surfaced.
--
-- `tests/check-parity.test.ts` probes every CHECK the schema declares against
-- both backends. The reference store refused the empty list — the rule table
-- restates it in JavaScript, where an empty array's length is 0 — and Postgres
-- accepted it. The parity suite exists to catch a permissive reference store; it
-- caught a permissive database instead, which is the more useful failure of the
-- two and the reason the probe runs against both.
--
-- The fix.
--
-- `coalesce(array_length(roles, 1), 0) >= 1` — NULL becomes 0 and the comparison
-- resolves to false, so the row is refused. Replacing the constraint under the
-- same name is deliberate: the name appears in the reference store's refusal
-- message, in the parity case, and in operator runbooks, and renaming it would
-- make all three stale to fix a definition that was wrong.
--
-- ADD CONSTRAINT validates the existing rows, so this migration fails rather
-- than silently passing if any role-less membership was already stored. That is
-- the intended behaviour: such a row is the defect this constraint describes, and
-- deciding which roles it should have is not a decision a migration can make.

BEGIN;

ALTER TABLE membership DROP CONSTRAINT IF EXISTS membership_roles_check;
ALTER TABLE membership
    ADD CONSTRAINT membership_roles_check
    CHECK (coalesce(array_length(roles, 1), 0) >= 1);

INSERT INTO schema_migrations (version) VALUES ('0019_membership_roles_effective')
ON CONFLICT (version) DO NOTHING;

COMMIT;
