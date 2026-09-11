-- WASLA CORE — migration 0010: plans, subscriptions, periods, entitlements, usage
-- Rollback: db/migrations/0010_subscriptions_and_entitlements.down.sql
--
-- ADR 0013 places subscription and entitlement in CORE. The ADR text itself is
-- the project's decision record and is not restated in this repository, so what
-- follows is derived from the constraints that ARE in the repository — the
-- ownership list in docs/data-ownership.md, ADR 0012/B-4 on pricing, ADR 0018
-- on product logic, and the invariants the money module already upholds. Where
-- a question is policy rather than structure it is recorded as a blocker in
-- ROADMAP.md rather than answered here by whichever choice was easiest.
--
-- The shape, and the two things it deliberately refuses to do:
--
--   1. There is no `entitlement` table. An entitlement is an ANSWER, computed
--      from the subscription's status, what its plan grants, and how much of
--      the current period has been used. A table of entitlement rows would be
--      a second source of truth for something already fully determined, and
--      the settlement cycle established what that costs: redundant state that
--      can drift from what it summarises is a liability. So entitlement is
--      derived, and CORE owns it by being the only place that can answer it.
--
--   2. Feature keys are DATA, never columns and never an enum. A column per
--      feature would put MARKET's and MOVE's product vocabulary into CORE's
--      schema and need a migration every time a product changed its mind,
--      which is exactly the god-service drift ADR 0018 exists to prevent.
--      CORE stores an opaque key and a number; it never interprets either.

BEGIN;

-- Range exclusion needs GiST support for the equality half of the key.
--
-- Worth the dependency: two periods of one subscription covering the same
-- instant means the owner is billed twice for it and entitlement has two
-- different answers. A deferred trigger doing an overlap query would NOT
-- close that hole — two concurrent transactions each see no overlap because
-- neither has committed, and both insert. That is the same class of defect as
-- B-12, and an index-backed exclusion constraint is the only thing here that
-- actually serialises the check.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── what is offered ───────────────────────────────────────────────────────

CREATE TABLE plan (
  plan_id uuid PRIMARY KEY,
  -- The stable key the operator and the other systems refer to. A plan whose
  -- terms change gets a NEW code, because the old one is still being billed.
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  currency char(3) NOT NULL,
  -- ADR 0012 / B-4: regulatory pricing policy is undecided, so CORE fixes no
  -- rate. This is whatever the operator configured, stored and charged
  -- verbatim. CORE has no opinion about the number.
  amount_minor bigint NOT NULL,
  billing_interval text NOT NULL,
  interval_count integer NOT NULL DEFAULT 1,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  retired_at timestamptz,

  CONSTRAINT plan_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  -- Zero is a legitimate price (a free tier is still a plan with entitlements
  -- and periods). Negative is not a price.
  CONSTRAINT plan_amount_non_negative CHECK (amount_minor >= 0),
  CONSTRAINT plan_interval_check CHECK (billing_interval IN ('day', 'week', 'month', 'year')),
  CONSTRAINT plan_interval_count_positive CHECK (interval_count > 0),
  CONSTRAINT plan_status_check CHECK (status IN ('draft', 'active', 'retired')),
  -- The timestamps and the status are two statements about the same fact.
  CONSTRAINT plan_status_timestamps CHECK (
    CASE status
      WHEN 'draft'   THEN activated_at IS NULL AND retired_at IS NULL
      WHEN 'active'  THEN activated_at IS NOT NULL AND retired_at IS NULL
      WHEN 'retired' THEN activated_at IS NOT NULL AND retired_at IS NOT NULL
    END
  )
);

-- A plan's commercial terms freeze when it goes active.
--
-- Not caution — a subscription points at a plan, and every period it has
-- already been billed for was priced from that plan. Letting the amount change
-- afterwards would silently re-describe settled history at a price nobody was
-- ever charged, and the ledger would disagree with the plan it came from. The
-- way to change a price is a new plan; existing subscriptions keep pointing at
-- the one they agreed to. Retiring only stops NEW subscriptions.
CREATE FUNCTION plan_terms_are_immutable_once_active() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- A retired plan is a closed book. Reviving one would let it be subscribed
  -- to again under terms that were withdrawn, and there would be no record
  -- that it had ever stopped.
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'plan % is retired and cannot return to %', OLD.plan_id, NEW.status;
  END IF;
  IF NEW.status = 'draft' AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'plan % has been offered and cannot return to draft', OLD.plan_id;
  END IF;
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF NEW.currency <> OLD.currency
     OR NEW.amount_minor <> OLD.amount_minor
     OR NEW.billing_interval <> OLD.billing_interval
     OR NEW.interval_count <> OLD.interval_count
     OR NEW.code <> OLD.code THEN
    RAISE EXCEPTION
      'plan % is %; its commercial terms cannot change because periods have already been priced from them - publish a new plan instead',
      OLD.plan_id, OLD.status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER plan_terms_immutable
BEFORE UPDATE ON plan
FOR EACH ROW EXECUTE FUNCTION plan_terms_are_immutable_once_active();

-- ── what a plan grants ────────────────────────────────────────────────────

CREATE TABLE plan_grant (
  plan_id uuid NOT NULL REFERENCES plan(plan_id) ON DELETE CASCADE,
  -- Opaque to CORE. MARKET and MOVE own the vocabulary; CORE owns the answer.
  feature_key text NOT NULL,
  -- NULL means "granted, not metered" — a capability with no quota.
  -- 0 means "explicitly none", which is a different statement and must stay
  -- distinguishable from it. A boolean feature and a quota of zero are not
  -- the same grant and collapsing them would make a revoked quota look like
  -- an unlimited one.
  limit_value bigint,

  PRIMARY KEY (plan_id, feature_key),
  CONSTRAINT plan_grant_feature_key_present CHECK (length(trim(feature_key)) > 0),
  CONSTRAINT plan_grant_limit_non_negative CHECK (limit_value IS NULL OR limit_value >= 0)
);

-- A grant freezes with the plan, for the same reason the amount does: usage
-- was already measured against the limit that was in force.
CREATE FUNCTION plan_grants_are_immutable_once_active() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  plan_status text;
  target_plan uuid;
BEGIN
  target_plan := COALESCE(NEW.plan_id, OLD.plan_id);
  SELECT status INTO plan_status FROM plan WHERE plan_id = target_plan;
  IF plan_status IS NULL OR plan_status = 'draft' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION
    'plan % is %; its grants cannot change because usage has already been measured against them - publish a new plan instead',
    target_plan, plan_status;
END;
$$;

CREATE TRIGGER plan_grant_immutable
BEFORE INSERT OR UPDATE OR DELETE ON plan_grant
FOR EACH ROW EXECUTE FUNCTION plan_grants_are_immutable_once_active();

-- ── who is subscribed ─────────────────────────────────────────────────────

CREATE TABLE subscription (
  subscription_id uuid PRIMARY KEY,
  -- Same owner shape as `wallet`, deliberately: a subscription is billed to a
  -- wallet, and an owner that could subscribe but not hold a wallet would be
  -- a subscription nobody can charge.
  owner_type text NOT NULL,
  owner_id uuid NOT NULL,
  plan_id uuid NOT NULL REFERENCES plan(plan_id),
  wallet_id uuid NOT NULL REFERENCES wallet(wallet_id),
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  cancel_reason text,
  ended_at timestamptz,

  CONSTRAINT subscription_owner_type_check CHECK (owner_type IN ('identity', 'organization')),
  -- `cancelled` and `expired` are not the same fact and must not collapse into
  -- one. `cancelled` says the owner asked to stop and coverage runs to the end
  -- of the period already paid for; `expired` says coverage ran out. Same
  -- argument as `partially_captured` in 0009: the status is what a
  -- reconciliation trusts, so it must not overstate or understate what
  -- happened.
  --
  -- `past_due` exists because "the charge did not settle" is a fact CORE knows
  -- and must not silently resolve. Whether a past-due subscription keeps its
  -- entitlement is a policy decision nobody has made, so the state is recorded
  -- explicitly and the decision is left visible instead of being guessed.
  CONSTRAINT subscription_status_check
    CHECK (status IN ('active', 'past_due', 'cancelled', 'expired')),
  CONSTRAINT subscription_cancel_fields CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL)
  ),
  CONSTRAINT subscription_cancel_reason_required CHECK (
    status <> 'cancelled' OR (cancel_reason IS NOT NULL AND length(trim(cancel_reason)) > 0)
  ),
  CONSTRAINT subscription_ended_fields CHECK (
    (status IN ('cancelled', 'expired')) OR ended_at IS NULL
  )
);

-- A subscription bills a wallet in the plan's currency. A plan priced in SAR
-- charged against a USD wallet is not a thing that has an answer, and the
-- ledger refuses mixed currencies anyway — better to refuse it at the point
-- where someone could still choose differently.
CREATE FUNCTION subscription_currency_agrees() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  plan_currency char(3);
  wallet_currency char(3);
  plan_state text;
BEGIN
  SELECT currency, status INTO plan_currency, plan_state FROM plan WHERE plan_id = NEW.plan_id;
  SELECT currency INTO wallet_currency FROM wallet WHERE wallet_id = NEW.wallet_id;
  IF plan_currency <> wallet_currency THEN
    RAISE EXCEPTION
      'subscription % bills a % plan against a % wallet',
      NEW.subscription_id, trim(plan_currency), trim(wallet_currency);
  END IF;
  -- A draft plan has not been offered yet and a retired one is no longer
  -- offered. Existing subscriptions on a retired plan keep running; this only
  -- refuses new ones.
  IF TG_OP = 'INSERT' AND plan_state <> 'active' THEN
    RAISE EXCEPTION 'plan % is %, so it cannot be subscribed to', NEW.plan_id, plan_state;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER subscription_currency_check
BEFORE INSERT OR UPDATE ON subscription
FOR EACH ROW EXECUTE FUNCTION subscription_currency_agrees();

CREATE INDEX subscription_owner_idx ON subscription (owner_type, owner_id);
CREATE INDEX subscription_plan_idx ON subscription (plan_id);
CREATE INDEX subscription_wallet_idx ON subscription (wallet_id);

-- ── the billing interval, which is what money attaches to ─────────────────

CREATE TABLE subscription_period (
  period_id uuid PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES subscription(subscription_id),
  sequence integer NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  -- Copied from the plan when the period is created, not looked up through it.
  -- This is the invoice: what was charged has to be recorded on the thing that
  -- was charged, or a retired plan would take the price of settled history
  -- with it. Immutable once written, so it cannot drift from the plan the way
  -- a running aggregate could.
  currency char(3) NOT NULL,
  amount_minor bigint NOT NULL,
  status text NOT NULL,
  -- The hold this period was charged through. The money module already does
  -- exactly-once capture keyed on a business reference, so a period charge is
  -- an authorization like any other rather than a second money path.
  authorization_id uuid REFERENCES payment_authorization(authorization_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  uncollectible_reason text,

  CONSTRAINT subscription_period_sequence_positive CHECK (sequence > 0),
  CONSTRAINT subscription_period_ordered CHECK (ends_at > starts_at),
  CONSTRAINT subscription_period_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT subscription_period_amount_non_negative CHECK (amount_minor >= 0),
  -- `pending` has not been charged yet; `settled` moved the money;
  -- `uncollectible` was attempted and refused, which is why a subscription is
  -- past due and must stay auditable rather than looking like it was never
  -- tried; `voided` was cancelled before it was ever charged.
  CONSTRAINT subscription_period_status_check
    CHECK (status IN ('pending', 'settled', 'uncollectible', 'voided')),
  CONSTRAINT subscription_period_sequence_unique UNIQUE (subscription_id, sequence),
  -- A settled period must say what settled it and when; anything else must not
  -- claim it did. Without this a period could read `settled` with no money
  -- behind it, which is the one thing a billing record may never do.
  --
  -- The zero-amount case is stated exactly rather than by loosening the rule.
  -- A free plan is still a plan with grants and periods, and its period has
  -- nothing to collect, so requiring an authorization would make a free tier
  -- unrepresentable. Requiring one for every period whether or not money was
  -- due would be the same defect in reverse. So: a settled period has an
  -- authorization if and only if it was for a non-zero amount. `settled`
  -- therefore still means "everything that was owed has moved" in both cases.
  CONSTRAINT subscription_period_settlement_fields CHECK (
    CASE status
      WHEN 'settled' THEN
        settled_at IS NOT NULL
        AND (amount_minor = 0) = (authorization_id IS NULL)
      ELSE settled_at IS NULL
    END
  ),
  -- An unsettled period has nothing to point at either. Attaching a hold to a
  -- period that is not settled by it would make the unique index below claim
  -- the hold is spent when it is not.
  CONSTRAINT subscription_period_authorization_only_when_settled CHECK (
    status = 'settled' OR authorization_id IS NULL
  ),
  CONSTRAINT subscription_period_uncollectible_reason CHECK (
    (status = 'uncollectible') =
      (uncollectible_reason IS NOT NULL AND length(trim(uncollectible_reason)) > 0)
  ),
  -- Two periods of one subscription covering the same instant would bill the
  -- owner twice for it and give entitlement two different answers. Adjacent
  -- periods are fine: the range is half-open, so one ending exactly where the
  -- next starts does not overlap.
  CONSTRAINT subscription_period_no_overlap
    EXCLUDE USING gist (
      subscription_id WITH =,
      tstzrange(starts_at, ends_at, '[)') WITH &&
    )
);

CREATE INDEX subscription_period_subscription_idx
  ON subscription_period (subscription_id, starts_at DESC);
-- The renewal sweep looks for periods that have ended, the way the hold expiry
-- sweep looks for expired authorizations.
CREATE INDEX subscription_period_due_idx ON subscription_period (ends_at);

-- A period's amount must equal what the ledger actually moved for it.
--
-- The same argument as 0009's aggregate triggers, from a different direction:
-- a period claiming to be settled for 5000 while the authorization behind it
-- captured 3000 is a billing record that disagrees with the money. Deferred,
-- because the period row and the capture are written in one transaction in
-- whichever order the service finds convenient.
CREATE FUNCTION subscription_period_agrees_with_money() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  captured bigint;
  auth_currency char(3);
BEGIN
  -- A zero-amount period has no authorization by construction (see the CHECK
  -- above), and there is nothing for the ledger to agree with.
  IF NEW.status <> 'settled' OR NEW.authorization_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT captured_minor, currency INTO captured, auth_currency
  FROM payment_authorization WHERE authorization_id = NEW.authorization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'period % is settled against authorization % which does not exist',
      NEW.period_id, NEW.authorization_id;
  END IF;

  IF captured <> NEW.amount_minor THEN
    RAISE EXCEPTION
      'period % is settled for % but authorization % captured %',
      NEW.period_id, NEW.amount_minor, NEW.authorization_id, captured;
  END IF;
  IF trim(auth_currency) <> trim(NEW.currency) THEN
    RAISE EXCEPTION
      'period % is priced in % but was settled in %',
      NEW.period_id, trim(NEW.currency), trim(auth_currency);
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER subscription_period_money_agrees
AFTER INSERT OR UPDATE ON subscription_period DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION subscription_period_agrees_with_money();

-- One authorization settles one period. Without this the same hold could be
-- used to mark several periods paid, and each of them would individually
-- agree with the money.
CREATE UNIQUE INDEX subscription_period_authorization_unique
  ON subscription_period (authorization_id)
  WHERE authorization_id IS NOT NULL;

-- ── metered consumption ───────────────────────────────────────────────────

CREATE TABLE usage_record (
  usage_id uuid PRIMARY KEY,
  period_id uuid NOT NULL REFERENCES subscription_period(period_id),
  feature_key text NOT NULL,
  quantity bigint NOT NULL,
  -- The reporter's idempotency key. Usage arrives from another system over an
  -- at-least-once channel, so the same consumption will be reported twice; the
  -- unique key is what makes it count once. Same mechanism as the ledger's
  -- unique business reference.
  usage_reference text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text,

  CONSTRAINT usage_record_feature_key_present CHECK (length(trim(feature_key)) > 0),
  -- Consumption is not negative. A correction is a policy decision nobody has
  -- made, and allowing a negative quantity would decide it silently.
  CONSTRAINT usage_record_quantity_positive CHECK (quantity > 0),
  CONSTRAINT usage_record_reference_present CHECK (length(trim(usage_reference)) > 0),
  CONSTRAINT usage_record_once UNIQUE (period_id, feature_key, usage_reference)
);

CREATE INDEX usage_record_period_feature_idx ON usage_record (period_id, feature_key);

-- Usage is append-only, exactly like `ledger_entry`.
--
-- It is the basis of an entitlement decision and, where a plan meters, of a
-- charge. A usage row that can be edited or deleted after the fact is a
-- billing basis that can be rewritten, and then nothing that was decided from
-- it can be re-derived or defended.
CREATE FUNCTION usage_record_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'usage_record is append-only; % is not permitted', TG_OP;
END;
$$;

CREATE TRIGGER usage_record_append_only
BEFORE UPDATE OR DELETE ON usage_record
FOR EACH ROW EXECUTE FUNCTION usage_record_is_append_only();

-- Usage belongs to a period that was actually open when it happened. Recording
-- consumption against a voided or future period would put it outside every
-- limit it was supposed to be measured against.
CREATE FUNCTION usage_record_period_is_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  period subscription_period;
BEGIN
  SELECT * INTO period FROM subscription_period WHERE period_id = NEW.period_id;
  IF period.status = 'voided' THEN
    RAISE EXCEPTION 'period % was voided and cannot accrue usage', NEW.period_id;
  END IF;
  IF NEW.recorded_at < period.starts_at OR NEW.recorded_at >= period.ends_at THEN
    RAISE EXCEPTION
      'usage recorded at % falls outside period % (% to %)',
      NEW.recorded_at, NEW.period_id, period.starts_at, period.ends_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER usage_record_within_period
BEFORE INSERT ON usage_record
FOR EACH ROW EXECUTE FUNCTION usage_record_period_is_open();

-- ── security ──────────────────────────────────────────────────────────────
--
-- Migration 0006 enabled deny-by-default RLS from a hardcoded list, so a new
-- table does not inherit it. Enabled explicitly here for the same reason
-- migration 0008 did it: the risk is recorded in ROADMAP.md and the schema
-- test catches an omission, but only after the table exists.
ALTER TABLE plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_period ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_record ENABLE ROW LEVEL SECURITY;

-- Migration 0006 pins every trigger function's search_path so a session cannot
-- shadow a referenced object with one from a schema it controls. The six new
-- functions are pinned here rather than in a later migration, or 0006's
-- guarantee quietly stops covering the whole set.
DO $harden$
DECLARE
  target_schema text := current_schema();
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'plan_terms_are_immutable_once_active()',
    'plan_grants_are_immutable_once_active()',
    'subscription_currency_agrees()',
    'subscription_period_agrees_with_money()',
    'usage_record_is_append_only()',
    'usage_record_period_is_open()'
  ] LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%s SET search_path = %I, pg_catalog',
      target_schema, fn, target_schema
    );
  END LOOP;
END
$harden$;

INSERT INTO schema_migrations (version) VALUES ('0010_subscriptions_and_entitlements')
ON CONFLICT (version) DO NOTHING;

COMMIT;
