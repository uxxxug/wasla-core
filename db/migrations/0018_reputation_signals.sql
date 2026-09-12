-- WASLA CORE — migration 0018: reputation signals
-- Rollback: db/migrations/0018_reputation_signals.down.sql
--
-- ADR 0015 places reputation and trust signals in CORE and review *content* in
-- MARKET. The ADR text is the project's decision record and is not restated in
-- this repository, so the shape below is derived from the constraints that ARE
-- here: the ownership list in docs/data-ownership.md (CORE owns "reputation and
-- trust signals"), ADR 0018 on product logic staying out of CORE, ADR 0009 on
-- events carrying business facts, and the design the subscription cycle already
-- proved. Every question that is policy rather than structure is recorded as a
-- blocker in ROADMAP.md instead of being answered here by whichever choice was
-- easiest to code.
--
-- One table, and four things it deliberately refuses to do:
--
--   1. There is no `reputation_score` table, and no score column anywhere. A
--      standing is an ANSWER, fully determined by the signals recorded against
--      a subject. Storing it would be a second source of truth for something
--      already derivable, and this repository has paid that bill twice already
--      (settlement state versus the ledger, entitlement versus the plan). So
--      standing is computed, and CORE owns it by being the only place that can
--      answer it.
--
--   2. A signal is append-only, like `audit_entry` and `usage_record`. A
--      reputation record that can be edited after the fact is a record that can
--      be rewritten, and then nothing decided from it can be defended. The one
--      permitted after-the-fact change is a retraction, which is an additive
--      marker on the row rather than an edit of what it says: the signal still
--      records that MARKET once reported this rating, and the marker records
--      that MARKET withdrew it. Both facts are true and neither replaces the
--      other.
--
--   3. The subject of a signal is an `identity` or an `organization` — never a
--      driver, a store, an order or a job. Those are MOVE's and MARKET's
--      entities and CORE does not name them (docs/data-ownership.md). A rating
--      about work done is recorded against the CORE identity that did the work.
--
--   4. `signal_kind` is a closed vocabulary, but the *weight* of a kind is not
--      in the database and not in CORE. Weighting, decay and thresholds are
--      product policy (ADR 0018) and are recorded as blockers B-31…B-33. CORE
--      stores what was reported and counts it; it does not decide what a
--      reputation is worth.
--
-- Tenancy: a signal names its organization, and a standing is per tenant. CORE
-- owns tenancy and B-23 established that a fact which does not name its tenant
-- cannot be routed, authorized or filtered by anybody. Whether a subject's
-- standing should also aggregate across tenants is a decision nobody has made,
-- so this schema makes the per-tenant reading the only one it can express
-- rather than inventing a global one (blocker B-34).

BEGIN;

CREATE TABLE reputation_signal (
  reputation_signal_id uuid PRIMARY KEY,
  -- Tenant scope. Not nullable: a signal CORE cannot attribute to a tenant is a
  -- signal no operator may read and no RLS policy can constrain.
  organization_id uuid NOT NULL REFERENCES organization(organization_id),
  -- Same owner shape as `wallet` and `subscription`, deliberately: the things
  -- CORE can hold money for are the things CORE can hold a standing for, and a
  -- third shape would be a third place to keep in step.
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  signal_kind text NOT NULL,
  -- The reported value, when the kind carries one. `NULL` is the honest value
  -- for a kind that is a count rather than a measure (a completed job, a
  -- dispute), and is not the same as zero.
  rating_value integer,
  -- Which system reported the fact, and its own reference for it. Opaque to
  -- CORE: `source_reference` is MARKET's review id, and CORE never parses,
  -- validates or resolves it. Together with the tenant it is the exactly-once
  -- key — the same technique the money module uses for a capture reference, and
  -- the reason a redelivered event cannot inflate a rating count.
  source_system text NOT NULL,
  source_reference text NOT NULL,
  -- The producer's claim about when the fact happened, kept apart from CORE's
  -- own receipt time. Ordering a standing by the producer's clock would let one
  -- system's skew reorder another's, so reads that need an order use
  -- `recorded_at`; `occurred_at` is reported, never trusted for ordering.
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL,
  -- Retraction marker. Additive, single-valued, and conditional on being absent
  -- when written (B-29's marker pattern): the row keeps saying what was
  -- reported, and the marker says it was withdrawn.
  retracted_at timestamptz,
  retraction_reason text,

  CONSTRAINT reputation_signal_subject_type_check
    CHECK (subject_type IN ('identity', 'organization')),
  -- The closed vocabulary. A kind CORE has never heard of is refused rather
  -- than stored: an unknown kind counts towards nothing, so accepting it would
  -- silently discard a fact a producer believes it delivered.
  CONSTRAINT reputation_signal_kind_check
    CHECK (signal_kind IN (
      'service_rating',
      'completion',
      'cancellation',
      'dispute',
      'compliment',
      'complaint'
    )),
  -- A rating is 1…5 and the other kinds carry no value at all. Both halves are
  -- enforced, because a `service_rating` with no number cannot be averaged and
  -- a `dispute` with a 4 in it would be counted as satisfaction by any reader
  -- that trusts the column.
  --
  -- Written as a CASE, and that is not a style choice. The obvious form
  --
  --   (signal_kind = 'service_rating' AND rating_value BETWEEN 1 AND 5)
  --     OR (signal_kind <> 'service_rating' AND rating_value IS NULL)
  --
  -- was written first and a test caught it accepting a `service_rating` with a
  -- NULL `rating_value`: `NULL BETWEEN 1 AND 5` is NULL, the second branch is
  -- false, `NULL OR false` is NULL, and a CHECK only rejects FALSE. The exact
  -- row the constraint exists to refuse was the one row it let through. A CASE
  -- returns a boolean on every input, so the constraint is total.
  CONSTRAINT reputation_signal_rating_shape CHECK (
    CASE
      WHEN signal_kind = 'service_rating'
        THEN rating_value IS NOT NULL AND rating_value BETWEEN 1 AND 5
      ELSE rating_value IS NULL
    END
  ),
  CONSTRAINT reputation_signal_source_system_present
    CHECK (length(trim(source_system)) > 0),
  CONSTRAINT reputation_signal_source_reference_present
    CHECK (length(trim(source_reference)) > 0),
  CONSTRAINT reputation_signal_correlation_present
    CHECK (length(trim(correlation_id)) > 0),
  -- Both-or-neither, the same rule migration 0017 used for its marker: a
  -- retraction without a reason is unreviewable, and a reason without a
  -- timestamp does not say the signal was withdrawn.
  --
  -- A CASE for the same reason as the rating shape: `length(trim(NULL)) > 0` is
  -- NULL, not false, so the disjunctive form accepted a retraction with a
  -- timestamp and no reason — precisely the unreviewable withdrawal it was
  -- written to prevent.
  CONSTRAINT reputation_signal_retraction_fields CHECK (
    CASE
      WHEN retracted_at IS NULL THEN retraction_reason IS NULL
      ELSE retraction_reason IS NOT NULL AND length(trim(retraction_reason)) > 0
    END
  ),
  -- Exactly-once ingestion. Scoped by tenant because `source_reference` is the
  -- producing system's identifier and CORE cannot assume it is unique across
  -- tenants — assuming it were would let one tenant's review id block another's.
  CONSTRAINT reputation_signal_source_unique
    UNIQUE (organization_id, source_system, source_reference)
);

-- Append-only, with retraction as the single exception.
--
-- `usage_record` refuses every UPDATE outright. This table cannot: a producer
-- that withdraws a review has stated a fact CORE must be able to record, and
-- the alternative — a compensating negative signal — would mean a derived
-- average silently mixes a rating with its own reversal and no reader could
-- tell the difference between "withdrawn" and "rated twice". So one transition
-- is permitted, in one direction, once. Everything else raises.
CREATE FUNCTION reputation_signal_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reputation_signal is append-only; DELETE is not permitted';
  END IF;
  IF OLD.retracted_at IS NOT NULL THEN
    RAISE EXCEPTION
      'reputation signal % was already retracted at %; a retraction is single-valued',
      OLD.reputation_signal_id, OLD.retracted_at;
  END IF;
  IF NEW.reputation_signal_id <> OLD.reputation_signal_id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.subject_type <> OLD.subject_type
     OR NEW.subject_id <> OLD.subject_id
     OR NEW.signal_kind <> OLD.signal_kind
     OR NEW.rating_value IS DISTINCT FROM OLD.rating_value
     OR NEW.source_system <> OLD.source_system
     OR NEW.source_reference <> OLD.source_reference
     OR NEW.occurred_at <> OLD.occurred_at
     OR NEW.recorded_at <> OLD.recorded_at
     OR NEW.correlation_id <> OLD.correlation_id THEN
    RAISE EXCEPTION
      'reputation_signal is append-only; only the retraction marker may be written after insert';
  END IF;
  IF NEW.retracted_at IS NULL THEN
    RAISE EXCEPTION 'a reputation signal may not be un-retracted';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reputation_signal_append_only
BEFORE UPDATE OR DELETE ON reputation_signal
FOR EACH ROW EXECUTE FUNCTION reputation_signal_is_append_only();

-- A standing is read per (tenant, subject), which is the only read this table
-- has, so that is the index. No index on `signal_kind`: a subject's signal
-- count is small and bounded by how much work it actually did, and an index
-- nobody's query plan needs is write cost for nothing.
CREATE INDEX reputation_signal_subject_idx
  ON reputation_signal (organization_id, subject_type, subject_id, recorded_at);

-- ── security ──────────────────────────────────────────────────────────────
--
-- Migration 0006 enabled deny-by-default RLS from a hardcoded list, so a new
-- table does not inherit it. Enabled explicitly here for the same reason
-- migrations 0008, 0010, 0012 and 0013 did it: the risk is recorded in
-- ROADMAP.md and the schema test catches an omission, but only after the table
-- exists.
ALTER TABLE reputation_signal ENABLE ROW LEVEL SECURITY;

-- Migration 0006 pins every trigger function's search_path so a session cannot
-- shadow a referenced object with one from a schema it controls. The new
-- function is pinned here rather than in a later migration, or 0006's guarantee
-- quietly stops covering the whole set.
DO $harden$
DECLARE
  target_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.reputation_signal_is_append_only() SET search_path = %I, pg_catalog',
    target_schema, target_schema
  );
END
$harden$;

INSERT INTO schema_migrations (version) VALUES ('0018_reputation_signals')
ON CONFLICT (version) DO NOTHING;

COMMIT;
