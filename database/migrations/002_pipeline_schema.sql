-- Pipeline schema
-- Run in Supabase SQL editor: https://supabase.com/dashboard/project/krkezzuuyxfsihumbgut/sql

CREATE TABLE IF NOT EXISTS pipeline_models (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle                   TEXT UNIQUE NOT NULL,
  fancore_model_id         TEXT,
  niche_tags               TEXT[] DEFAULT '{}',
  signature_tag            TEXT,
  nsfw_flag                BOOLEAN DEFAULT true,
  source_photos_r2_prefix  TEXT,
  reference_image_r2_key   TEXT,
  kie_ref_urls             TEXT[] DEFAULT '{}',
  kie_ref_uploaded_at      TIMESTAMPTZ,
  best_post_times          JSONB DEFAULT '{"morning":"10:00","evening":"18:00"}'::jsonb,
  active                   BOOLEAN DEFAULT false,
  created_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id     UUID REFERENCES pipeline_models(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'generating'
               CHECK (status IN ('generating','pending_approval','approved','posting','posted','failed')),
  briefs       JSONB DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  approved_at  TIMESTAMPTZ,
  posted_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS pipeline_videos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  slot            INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 6),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','skipped','rejected','posted')),
  brief           JSONB,
  final_r2_key    TEXT,
  thumbnail_r2_key TEXT,
  source_post_id  TEXT REFERENCES trends_posts(fansly_post_id) ON DELETE SET NULL,
  scheduled_for   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pipeline_analytics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  video_id        UUID REFERENCES pipeline_videos(id) ON DELETE CASCADE,
  views           INTEGER DEFAULT 0,
  follow_gain     INTEGER DEFAULT 0,
  hashtags_used   TEXT[] DEFAULT '{}',
  top_hashtag     TEXT,
  overlay_formula TEXT,
  recorded_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pipeline_runs_model_idx    ON pipeline_runs(model_id);
CREATE INDEX IF NOT EXISTS pipeline_runs_status_idx   ON pipeline_runs(status);
CREATE INDEX IF NOT EXISTS pipeline_videos_run_idx    ON pipeline_videos(run_id);
CREATE INDEX IF NOT EXISTS pipeline_videos_status_idx ON pipeline_videos(status);
