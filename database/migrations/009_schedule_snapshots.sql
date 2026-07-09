-- 009: Fansly scheduled posts monitor (on-demand scrape results per model).
-- One row per model (upserted on each "Refresh Schedules" sweep).
-- scheduled_count = posts with at least one #hashtag in caption within next 48h.
-- posts = [{scheduledAt: ISO string, caption: string}] for the collapsible row.

CREATE TABLE IF NOT EXISTS schedule_snapshots (
  model_id uuid PRIMARY KEY REFERENCES trends_models(id) ON DELETE CASCADE,
  scraped_at timestamptz NOT NULL DEFAULT now(),
  scheduled_count integer NOT NULL DEFAULT 0,
  posts jsonb NOT NULL DEFAULT '[]',
  error text
);

-- ROLLBACK: DROP TABLE schedule_snapshots;
