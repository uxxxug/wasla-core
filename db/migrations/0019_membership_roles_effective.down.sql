-- Rollback for migration 0019.
--
-- This restores the constraint to its original, ineffective form:
--
--     CHECK (array_length(roles, 1) >= 1)
--
-- which is satisfied by an empty role list, because `array_length` returns NULL
-- for an array with no elements and a NULL CHECK passes. Rolling back therefore
-- does not remove a rule; it removes the *enforcement* of a rule the schema
-- still appears to state. That is worth naming plainly, because a reader of
-- `\d membership` after this rollback sees a constraint that looks like it
-- refuses role-less memberships and does not.
--
-- Nothing is lost and no row is rewritten. Every membership stored under 0019
-- has at least one role and remains valid under the restored definition, so the
-- rollback is safe in the direction that matters for data.
--
-- What changes is what CORE will accept afterwards. `tests/check-parity.test.ts`
-- will fail on `membership_roles_check` against a rolled-back database, because
-- the reference store keeps refusing the empty list while Postgres stops doing
-- so. That failure is correct: the two backends really do disagree again, and
-- the suite is meant to say so rather than to accommodate it.
--
-- Roll back only to reach a schema state older than 0019 as a whole. There is no
-- operational reason to want this constraint weaker.

BEGIN;

ALTER TABLE membership DROP CONSTRAINT IF EXISTS membership_roles_check;
ALTER TABLE membership
    ADD CONSTRAINT membership_roles_check
    CHECK (array_length(roles, 1) >= 1);

DELETE FROM schema_migrations WHERE version = '0019_membership_roles_effective';

COMMIT;
