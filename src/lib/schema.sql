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
  geometry        GEOMETRY(LineString, 4326) NOT NULL,
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
ALTER TABLE users ADD COLUMN IF NOT EXISTS strava_scope               TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS strava_description_updates BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS include_cycling            BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS strava_description_updated BOOLEAN NOT NULL DEFAULT FALSE;
-- Heartbeat updated on every page fetched during a sync chunk (see
-- src/lib/sync-engine.ts). Lets the dashboard self-heal check and the cron
-- sweep tell "still actively syncing right now" apart from "genuinely stuck"
-- (sync_status = 'syncing' but this timestamp has gone stale).
ALTER TABLE users ADD COLUMN IF NOT EXISTS sync_progress_at TIMESTAMPTZ;

-- Marks when computeTrailProgress last populated activity_trail_matches for
-- this (user, trail) pair — lets the backfill script (and future reruns)
-- skip pairs that are already done instead of recomputing them.
ALTER TABLE user_trail_progress ADD COLUMN IF NOT EXISTS activity_matches_computed_at TIMESTAMPTZ;

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
