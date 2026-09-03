-- ────────────────────────────────────────────────────────────
--  My Trail Log — database schema
--  Requires PostgreSQL 14+ with PostGIS
-- ────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS postgis;

-- ── users ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  strava_id               BIGINT      UNIQUE NOT NULL,
  username                TEXT,
  first_name              TEXT,
  last_name               TEXT,
  profile_image_url       TEXT,
  strava_access_token     TEXT        NOT NULL,
  strava_refresh_token    TEXT        NOT NULL,
  strava_token_expires_at TIMESTAMPTZ NOT NULL,
  sync_status                 TEXT        NOT NULL DEFAULT 'idle',
  last_synced_at              TIMESTAMPTZ,
  strava_scope                TEXT,
  strava_description_updates  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── activities ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activities (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  strava_activity_id  BIGINT      UNIQUE NOT NULL,
  name                TEXT        NOT NULL,
  activity_type       TEXT        NOT NULL,
  distance            FLOAT       NOT NULL DEFAULT 0,
  moving_time         INTEGER     NOT NULL DEFAULT 0,
  start_date          TIMESTAMPTZ NOT NULL,
  polyline            TEXT,
  geometry            GEOMETRY(LineString, 4326),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── trails ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trails (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL,
  slug            TEXT        UNIQUE NOT NULL,
  description     TEXT,
  total_distance  FLOAT       NOT NULL DEFAULT 0,
  region          TEXT        NOT NULL,
  start_point     GEOMETRY(Point, 4326),
  end_point       GEOMETRY(Point, 4326),
  geometry        GEOMETRY(LineString, 4326) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── user_trail_progress ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_trail_progress (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trail_id              UUID        NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  completed_distance    FLOAT       NOT NULL DEFAULT 0,
  completion_percentage FLOAT       NOT NULL DEFAULT 0,
  completed_geometry    GEOMETRY(MultiLineString, 4326),
  activity_count        INTEGER     NOT NULL DEFAULT 0,
  first_activity_date   TIMESTAMPTZ,
  last_activity_date    TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, trail_id)
);

-- ── Spatial indexes (GIST) ───────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_activities_geometry
  ON activities USING GIST (geometry)
  WHERE geometry IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trails_geometry
  ON trails USING GIST (geometry);

CREATE INDEX IF NOT EXISTS idx_trails_start_point
  ON trails USING GIST (start_point)
  WHERE start_point IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trails_end_point
  ON trails USING GIST (end_point)
  WHERE end_point IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_progress_completed_geometry
  ON user_trail_progress USING GIST (completed_geometry)
  WHERE completed_geometry IS NOT NULL;

-- ── Regular indexes ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_activities_user_id
  ON activities (user_id);

CREATE INDEX IF NOT EXISTS idx_activities_strava_id
  ON activities (strava_activity_id);

CREATE INDEX IF NOT EXISTS idx_activities_user_date
  ON activities (user_id, start_date DESC);

CREATE INDEX IF NOT EXISTS idx_progress_user_id
  ON user_trail_progress (user_id);

CREATE INDEX IF NOT EXISTS idx_progress_trail_id
  ON user_trail_progress (trail_id);

-- ── user_trail_manual_segments ──────────────────────────────
CREATE TABLE IF NOT EXISTS user_trail_manual_segments (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trail_id        UUID        NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  segment_type    TEXT        NOT NULL CHECK (segment_type IN ('auto_gap_fill', 'manual')),
  -- Generic GEOMETRY, not GEOMETRY(LineString, 4326): trails.geometry
  -- itself is 63% MultiLineString (749/1,181 — genuinely multi-part
  -- trails with real breaks between sections, not a storage artifact —
  -- confirmed ST_LineMerge doesn't collapse any of them to a single
  -- line). "Mark whole trail complete" copies a trail's own geometry
  -- verbatim into this column, so it needs to accept whatever type the
  -- trail actually is. A LineString-only column made that INSERT throw
  -- Postgres 22023 for any MultiLineString trail — see the Rosie Dyball
  -- / Centenary Way investigation.
  geometry        GEOMETRY(Geometry, 4326) NOT NULL,
  start_fraction  FLOAT,
  end_fraction    FLOAT,
  gap_length_m    FLOAT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manual_segments_user_trail
  ON user_trail_manual_segments (user_id, trail_id);

CREATE INDEX IF NOT EXISTS idx_manual_segments_geometry
  ON user_trail_manual_segments USING GIST (geometry);

-- ── Additive migrations (idempotent) ────────────────────────

-- Widen user_trail_manual_segments.geometry from LineString-only to
-- generic Geometry — see the CREATE TABLE comment above. Guarded so it
-- only runs (and only takes an ALTER lock) when the column is still
-- restricted; a no-op on any database that's already been migrated or
-- freshly created from the CREATE TABLE above.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM geometry_columns
    WHERE f_table_name = 'user_trail_manual_segments'
      AND f_geometry_column = 'geometry'
      AND type = 'LINESTRING'
  ) THEN
    ALTER TABLE user_trail_manual_segments
      ALTER COLUMN geometry TYPE GEOMETRY(Geometry, 4326);
  END IF;
END
$$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS strava_scope               TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS strava_description_updates BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS include_cycling            BOOLEAN NOT NULL DEFAULT FALSE;

-- Controls how much detail writeTrailDescription puts in the Strava
-- activity description when strava_description_updates is on — see
-- src/lib/trail-descriptions.ts. 'full' (default) writes every matched
-- trail every time; 'new_only'/'new_with_totals' only write when an
-- activity covers genuinely new ground.
ALTER TABLE users ADD COLUMN IF NOT EXISTS description_mode TEXT NOT NULL DEFAULT 'full';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_description_mode_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_description_mode_check
      CHECK (description_mode IN ('full', 'new_only', 'new_with_totals'));
  END IF;
END
$$;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS strava_description_updated BOOLEAN NOT NULL DEFAULT FALSE;
-- Bounded-retry counter for writeTrailDescription failures — e.g. Strava
-- persistently returning 500 on GET for a specific old/malformed activity
-- (confirmed on Rosie's account: same handful of activities, same error,
-- every single attempt, not transient). Without this, a permanently-
-- failing activity never gets strava_description_updated set, so it sits
-- at the front of update-descriptions' backlog query forever — every
-- future run re-attempts the same doomed activities before reaching any
-- real progress. See recordDescriptionUpdateFailure in trail-descriptions.ts.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS description_update_attempts INTEGER NOT NULL DEFAULT 0;
-- Heartbeat updated on every page fetched during a sync chunk (see
-- src/lib/sync-engine.ts). Lets the dashboard self-heal check and the cron
-- sweep tell "still actively syncing right now" apart from "genuinely stuck"
-- (sync_status = 'syncing' but this timestamp has gone stale).
ALTER TABLE users ADD COLUMN IF NOT EXISTS sync_progress_at TIMESTAMPTZ;

-- Strava's athlete.measurement_preference ("feet" or "meters") — only
-- available via the detailed athlete endpoint, captured at OAuth connect
-- time. distance_unit is the dashboard's own km/mi toggle, persisted here
-- so server-side code (Strava description writes) has something to fall
-- back to when measurement_preference is unknown (NULL).
ALTER TABLE users ADD COLUMN IF NOT EXISTS measurement_preference TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS distance_unit          TEXT NOT NULL DEFAULT 'km';

-- Marks when computeTrailProgress last populated activity_trail_matches for
-- this (user, trail) pair — lets the backfill script (and future reruns)
-- skip pairs that are already done instead of recomputing them.
ALTER TABLE user_trail_progress ADD COLUMN IF NOT EXISTS activity_matches_computed_at TIMESTAMPTZ;

-- Durable, queryable record of every step of the sync -> matching pipeline
-- for a given user, replacing scattered console.log calls that only exist
-- in Vercel's ephemeral function logs. event is a short machine-readable
-- tag (e.g. 'sync_chunk_complete', 'matching_complete', 'sync_anomaly');
-- detail holds whatever structured context that step has (counts, trail ids,
-- error messages). Queried by /admin and the stale-sync cron sweep to show
-- exactly what happened for a given user without needing DB access.
CREATE TABLE IF NOT EXISTS sync_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event      TEXT NOT NULL,
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_log_user_id_created_at
  ON sync_log (user_id, created_at DESC);

-- Definitive "have we attempted this (user, trail) pair" record, written by
-- computeTrailProgress after each trail it processes — regardless of
-- whether a match was found. user_trail_progress alone can't answer this:
-- a trail with genuinely zero overlap never gets a row there (see the
-- south-downs-way / north-downs-way investigation — WHERE covered_geom IS
-- NOT NULL means no row is inserted for a legitimate no-match), so it's
-- indistinguishable from "never checked yet". A full-account backfill walk
-- (the /admin rematch route, scripts/resume-sync.mjs) queries trails NOT
-- in this table for a user to know what's actually left to do, instead of
-- a fragile client-held offset into an alphabetical scan that restarts
-- from the top on every crash.
CREATE TABLE IF NOT EXISTS trail_match_checks (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trail_id   UUID NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  matched    BOOLEAN NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, trail_id)
);

-- DB-level backstop keeping trail_match_checks and user_trail_progress from
-- silently disagreeing with EACH OTHER (not with the user's real geometry —
-- that's what matchNextBatch's staleness re-check exists for, see
-- match-trails.ts; a trigger can't cheaply verify a multi-minute PostGIS
-- union/intersection on every write, that's the whole reason this is a
-- deferred batch process rather than inline). A plain FK can't express this:
-- trail_match_checks rows with matched=false are supposed to have no
-- user_trail_progress row (that's the whole point of the table, see its
-- comment above) — the invariant only holds one-directionally, matched=true
-- implies a progress row must exist, which is exactly what a trigger can
-- enforce and a column-level constraint can't.
--
-- Second Chris Rance investigation, 2026-08-19: the actual reported bug
-- (South Downs Way showing 0km despite real contributing activities) was
-- root-caused to trail_match_checks going stale, not these two tables
-- drifting from each other — but the two ARE two independently-written
-- bookkeeping tables (see computeTrailProgress in match-trails.ts: MATCH_SQL
-- writes user_trail_progress, a separate later statement writes
-- trail_match_checks), so nothing before this stopped a future code change
-- from writing one without the other. This trigger makes that impossible
-- rather than relying on every future caller remembering to do both.
CREATE OR REPLACE FUNCTION trigger_sync_trail_match_checks()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- No progress row left for this pair — clear the checkpoint too, so a
    -- deliberately-deleted (e.g. manually corrected) progress row is
    -- eligible to be picked up and recomputed again, instead of matchNextBatch
    -- treating a now-nonexistent match as still "checked, matched=true" forever.
    DELETE FROM trail_match_checks WHERE user_id = OLD.user_id AND trail_id = OLD.trail_id;
    RETURN OLD;
  END IF;

  INSERT INTO trail_match_checks (user_id, trail_id, matched, checked_at)
  VALUES (NEW.user_id, NEW.trail_id, TRUE, NOW())
  ON CONFLICT (user_id, trail_id) DO UPDATE SET matched = TRUE, checked_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_trail_progress_sync_checks ON user_trail_progress;
CREATE TRIGGER user_trail_progress_sync_checks
  AFTER INSERT OR UPDATE OR DELETE ON user_trail_progress
  FOR EACH ROW EXECUTE FUNCTION trigger_sync_trail_match_checks();

-- Pre-computed ST_SimplifyPreserveTopology(geometry, 0.001), materialized
-- and indexed rather than recomputed inline on every query. Several spatial
-- pre-filter queries (finishSync's nearbyTrails lookup, backfill-cycling)
-- need to check a batch of activities against the FULL trails table, and
-- computing the simplification for all ~1,180 trails inline on every call
-- is itself expensive — confirmed via direct reproduction to still hit
-- Postgres's statement timeout (57014) even with the simplification
-- applied, because there's no way to index an on-the-fly computed column.
-- Root-caused during the Rosie Dyball investigation: finishSync's
-- nearbyTrails query (raw, unindexed, uncached) silently killed the whole
-- serverless function on any sync chunk with more than a handful of new
-- activities, before it could log anything or run any matching.
-- Untyped GEOMETRY, not GEOMETRY(LineString, 4326): trails.geometry itself
-- carries no enforced subtype despite its CREATE TABLE definition above
-- (schema drift — 749 of 1,180 live rows are actually MultiLineString, not
-- LineString), and ST_SimplifyPreserveTopology on a MultiLineString input
-- returns a MultiLineString, which a LineString-typed column would reject.
ALTER TABLE trails ADD COLUMN IF NOT EXISTS simplified_geometry GEOMETRY(Geometry, 4326);

UPDATE trails SET simplified_geometry = ST_SimplifyPreserveTopology(geometry, 0.001)
WHERE simplified_geometry IS NULL;

CREATE INDEX IF NOT EXISTS idx_trails_simplified_geometry
  ON trails USING GIST (simplified_geometry);

-- Keeps simplified_geometry correct automatically on every future insert/
-- update, so no import or edit script needs to remember to set it itself.
CREATE OR REPLACE FUNCTION trigger_set_simplified_geometry()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.simplified_geometry = ST_SimplifyPreserveTopology(NEW.geometry, 0.001);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trails_set_simplified_geometry
  BEFORE INSERT OR UPDATE OF geometry ON trails
  FOR EACH ROW EXECUTE FUNCTION trigger_set_simplified_geometry();

-- Global (app-wide, not per-user) daily counter for the historical
-- description-update backlog scan in update-descriptions/route.ts. Strava's
-- rate limit is enforced per-application across all users combined, so this
-- caps that one feature's share of it, leaving the rest of the daily quota
-- free for normal syncs/webhooks/new-activity processing. One row per UTC
-- day; a new day just gets a fresh row (see reserveBackfillSlot).
CREATE TABLE IF NOT EXISTS backfill_api_usage (
  usage_date  DATE PRIMARY KEY,
  calls_used  INTEGER NOT NULL DEFAULT 0
);

-- Cached candidate list for description updates: which activities sit near
-- which matched trails. Populated incrementally by computeTrailProgress
-- (see src/lib/match-trails.ts) so update-descriptions/route.ts can look
-- this up directly instead of re-running spatial queries against every
-- matched trail on every request — that recompute was what made the
-- discovery step take 5+ minutes for power users and blow Vercel's 60s cap.
-- A coarse (simplified-geometry) candidate list is fine here: the exact
-- per-activity trail overlap is still verified by getActivityTrailMatches
-- at write time, so a false-positive candidate just costs one skipped check.
CREATE TABLE IF NOT EXISTS activity_trail_matches (
  activity_id UUID        NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  trail_id    UUID        NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (activity_id, trail_id)
);

CREATE INDEX IF NOT EXISTS idx_activity_trail_matches_user_id
  ON activity_trail_matches (user_id);

CREATE TABLE IF NOT EXISTS trail_requests (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  trail_name TEXT        NOT NULL,
  region     TEXT,
  url        TEXT,
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── invite_codes ─────────────────────────────────────────────
-- Single-use beta access codes. used_by is set atomically at signup time
-- (see the strava/callback transaction) so two people racing on the same
-- code can't both claim it.
CREATE TABLE IF NOT EXISTS invite_codes (
  code       TEXT        PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  used_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_used_by
  ON invite_codes (used_by);

-- ── waitlist ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS waitlist (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT        UNIQUE NOT NULL,
  signed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Free-trial / subscription tracking ──────────────────────
-- Added 2026-09-02 when the invite-code gate came off (app approved for
-- 999 users) — every new signup now starts a 1-month free trial instead of
-- needing a code. trial_started_at/trial_ends_at are set explicitly by the
-- strava/callback INSERT (see upsertUserSql there), not by a column
-- DEFAULT, so a returning user's ON CONFLICT DO UPDATE never touches them
-- and a brand new row always gets an intentional value rather than
-- whatever NOW() happens to be at ALTER-TABLE time.
-- No paywall enforcement yet (item 5 of the 2026-09-02 request) — this is
-- purely tracking + a dashboard countdown until Stripe is wired up.
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'trial';
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_started_at    TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at       TIMESTAMPTZ;

-- 'grace_period' added 2026-09-16 (see trial-expiry-handling comment
-- below) — dropped and recreated rather than guarded with IF NOT EXISTS
-- since the allowed set itself changed, not just its presence. Cheap
-- metadata-only operation, safe to rerun every migration.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_subscription_status_check;
ALTER TABLE users ADD CONSTRAINT users_subscription_status_check
  CHECK (subscription_status IN ('trial', 'active', 'expired', 'grace_period'));

-- One-time backfill for accounts that predate the trial system (the 10
-- invite-only beta testers) — founding testers get permanent free access,
-- not a trial. Guarded on trial_started_at IS NULL, which only a
-- pre-trial-system row can ever have (every row inserted from here on sets
-- it explicitly at signup) — safe to leave in as a no-op on every future
-- migration run rather than needing to be deleted after first use.
UPDATE users SET subscription_status = 'active'
WHERE trial_started_at IS NULL AND subscription_status != 'active';

-- ── Trial expiry handling (2026-09-16) ───────────────────────
-- contact_email is deliberately separate from anything Strava gives us
-- (Strava doesn't expose the athlete's email at all) — collected explicitly
-- so trial-lifecycle reminders/expiry notices have somewhere to go. Nullable
-- at the DB level: a user can reach the dashboard's email-activation gate
-- (see /activate) without one for a moment mid-signup, and the 10 existing
-- 'active' beta testers are never required to supply one. Reminder emails
-- are simply skipped for anyone with contact_email NULL (see
-- trial-lifecycle.ts) — the grace_period -> deletion cleanup itself is NOT
-- conditional on having an email, only the courtesy reminders are.
ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_email TEXT;

-- ── deleted_users (2026-09-30) ────────────────────────────────
-- Records every strava_id whose account has ever been deleted — via the
-- self-service /api/account/delete route, or trial-lifecycle.ts's 14-day
-- grace_period cleanup — so a returning athlete reconnecting later isn't
-- given a second free trial (see strava/callback/route.ts's
-- deleted_users check). Deliberately just the two columns asked for: no FK
-- to users(id), since the whole point is that row is gone by the time this
-- one matters. ON CONFLICT DO UPDATE on insert (see account-deletion.ts)
-- refreshes deleted_at if the same strava_id is ever recorded twice
-- (shouldn't normally happen — a deleted account can't be deleted again —
-- but harmless if it ever does).
CREATE TABLE IF NOT EXISTS deleted_users (
  strava_id  BIGINT      PRIMARY KEY,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Row-Level Security ──────────────────────────────────────
-- The server connects as the postgres role which has BYPASSRLS in Supabase,
-- so all server-side queries are unaffected. These settings block direct
-- client access via the anon/authenticated roles.
ALTER TABLE users                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE trails                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_trail_progress        ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_trail_manual_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE trail_requests             ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_trail_matches     ENABLE ROW LEVEL SECURITY;
ALTER TABLE backfill_api_usage         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_log                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE trail_match_checks         ENABLE ROW LEVEL SECURITY;
ALTER TABLE invite_codes               ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE deleted_users              ENABLE ROW LEVEL SECURITY;

-- Pre-populated beta codes for early testers. Fixed values + ON CONFLICT DO
-- NOTHING so re-running this idempotent migration never rotates or
-- duplicates them.
INSERT INTO invite_codes (code) VALUES
  ('MTL-G2EPAR'),
  ('MTL-Y7SQYV'),
  ('MTL-DYBSNN'),
  ('MTL-3PNCNQ'),
  ('MTL-2SFT57')
ON CONFLICT (code) DO NOTHING;

-- Trails are public reference data — allow anyone to read them
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'trails' AND policyname = 'trails_select_public'
  ) THEN
    CREATE POLICY "trails_select_public" ON trails FOR SELECT USING (true);
  END IF;
END
$$;

-- spatial_ref_sys is a PostGIS extension table (coordinate system definitions),
-- owned by the extension rather than the app role, so ALTER fails with
-- insufficient_privilege on Supabase's non-superuser app connection. Caught
-- here so it doesn't abort the rest of this script (schema.sql runs as one
-- implicit transaction via migrate.mjs) — apply it manually via the Supabase
-- SQL Editor (as a superuser) if you need RLS enforced on this table too.
DO $$
BEGIN
  BEGIN
    ALTER TABLE spatial_ref_sys ENABLE ROW LEVEL SECURITY;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping spatial_ref_sys RLS — requires superuser; apply manually via Supabase SQL Editor';
  END;
END
$$;
DO $$
BEGIN
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = 'spatial_ref_sys' AND policyname = 'spatial_ref_sys_select_public'
    ) THEN
      CREATE POLICY "spatial_ref_sys_select_public"
        ON spatial_ref_sys FOR SELECT USING (true);
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping spatial_ref_sys policy — requires superuser; apply manually via Supabase SQL Editor';
  END;
END
$$;

-- ── updated_at trigger ───────────────────────────────────────
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE OR REPLACE TRIGGER trails_updated_at
  BEFORE UPDATE ON trails
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE OR REPLACE TRIGGER progress_updated_at
  BEFORE UPDATE ON user_trail_progress
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
