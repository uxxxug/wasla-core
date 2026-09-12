-- Rollback of 0016.
--
-- Order matters, and it is the opposite of the forward order: roll the
-- application back first, then run this. Code that stamps `claim_token` on a
-- claim, or matches on it in an acknowledgement, fails every statement against a
-- schema without the column — which stops all three queues rather than merely
-- losing the fence.
--
-- Constraints before columns, so dropping the column cannot leave a constraint
-- referring to something that no longer exists.
--
-- What is lost: nothing durable. The token only ever describes a claim that is
-- currently held. Rows claimed at the moment this runs keep `claimed_at`, so
-- recovery still finds and frees them; they simply stop being fenced, which is
-- the state the system was in before 0016. Rows already dead-lettered or
-- published are untouched.

BEGIN;

ALTER TABLE event_delivery DROP CONSTRAINT IF EXISTS event_delivery_claim_token_check;
ALTER TABLE inbound_event DROP CONSTRAINT IF EXISTS inbound_event_claim_token_check;
ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_claim_token_check;

ALTER TABLE event_delivery DROP COLUMN IF EXISTS claim_token;
ALTER TABLE inbound_event DROP COLUMN IF EXISTS claim_token;
ALTER TABLE outbox DROP COLUMN IF EXISTS claim_token;

DELETE FROM schema_migrations WHERE version = '0016_worker_claim_fencing';

COMMIT;
