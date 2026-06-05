-- FanslyTrends schema
-- Run in Supabase SQL editor: https://supabase.com/dashboard/project/krkezzuuyxfsihumbgut/sql

CREATE TABLE IF NOT EXISTS trends_posts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fansly_post_id      TEXT UNIQUE NOT NULL,
  creator_username    TEXT NOT NULL,
  creator_fansly_url  TEXT,
  caption             TEXT,
  hashtags            TEXT[] DEFAULT '{}',
  likes_initial       INTEGER DEFAULT 0,
  likes_current       INTEGER DEFAULT 0,
  growth_24h_pct      DECIMAL(10,2),
  video_r2_key        TEXT,
  thumbnail_r2_key    TEXT,
  video_duration      INTEGER,
  is_explicit         BOOLEAN DEFAULT true,
  post_date           TIMESTAMPTZ,
  scraped_at          TIMESTAMPTZ DEFAULT NOW(),
  last_velocity_check TIMESTAMPTZ,
  archived_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trends_snapshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id       UUID REFERENCES trends_posts(id) ON DELETE CASCADE,
  likes         INTEGER NOT NULL,
  snapshot_type TEXT NOT NULL CHECK (snapshot_type IN ('6h', '24h')),
  taken_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trends_ideas (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    UUID REFERENCES trends_posts(id) ON DELETE CASCADE,
  folder     TEXT,
  tags       TEXT[] DEFAULT '{}',
  notes      TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trends_blacklist (
  username TEXT PRIMARY KEY,
  added_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trends_posts_likes_idx      ON trends_posts(likes_current DESC);
CREATE INDEX IF NOT EXISTS trends_posts_growth_idx     ON trends_posts(growth_24h_pct DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS trends_posts_scraped_idx    ON trends_posts(scraped_at DESC);
CREATE INDEX IF NOT EXISTS trends_posts_active_idx     ON trends_posts(archived_at) WHERE archived_at IS NULL;
