-- trends_models: one row per Fansly model profile
CREATE TABLE IF NOT EXISTS trends_models (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fansly_username   TEXT UNIQUE NOT NULL,
  fansly_url        TEXT,
  branding_file_md  TEXT,
  hashtags          TEXT[] DEFAULT '{}',
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- trends_suggestions: AI-generated content suggestions per model
CREATE TABLE IF NOT EXISTS trends_suggestions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id         UUID NOT NULL REFERENCES trends_models(id) ON DELETE CASCADE,
  post_id          UUID NOT NULL REFERENCES trends_posts(id) ON DELETE CASCADE,
  reasoning        TEXT NOT NULL,
  branding_section TEXT NOT NULL,
  what_to_change   TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'done', 'dismissed')),
  notes            TEXT,
  generated_at     TIMESTAMPTZ DEFAULT NOW(),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (model_id, post_id)
);

CREATE INDEX IF NOT EXISTS trends_suggestions_model_status ON trends_suggestions(model_id, status);
CREATE INDEX IF NOT EXISTS trends_suggestions_model_generated ON trends_suggestions(model_id, generated_at DESC);
