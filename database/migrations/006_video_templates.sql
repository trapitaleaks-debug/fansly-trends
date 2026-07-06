-- 006: Video template system (Wave B style engine).
--
-- video_templates: visual layout templates (CapCut-style captions, green-screen memes,
-- overlay compositions). manifest jsonb drives the Remotion layout branch; content_tags
-- gate which videos a template may be applied to (empty = any); status 'live' gates
-- selection. source_r2_key = the user's uploaded CapCut export (reference only).
--
-- video_jobs.template_id: NULL = classic caption path (byte-identical pre-Wave-B render).

CREATE TABLE IF NOT EXISTS video_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('caption','meme','overlay')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live')),
  manifest jsonb,
  source_r2_key text,
  preview_r2_key text,
  content_tags text[] NOT NULL DEFAULT '{}',
  weight int NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS template_id uuid REFERENCES video_templates(id);

-- ROLLBACK: ALTER TABLE video_jobs DROP COLUMN template_id; DROP TABLE video_templates;
