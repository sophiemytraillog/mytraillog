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

CREATE TABLE IF NOT EXISTS trail_requests (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  trail_name TEXT        NOT NULL,
  region     TEXT,
  url        TEXT,
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
