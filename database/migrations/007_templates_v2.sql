-- 007: Templates v2 taxonomy + custom text templates.
--
-- video_templates.niches: styles/memes can target model niches in addition to content tags.
-- Eligibility = (content_tags empty OR && idea.tags) AND (niches empty OR && model.niches).
--
-- trends_posts.is_custom: user-authored text templates live as trends_posts rows (source of
-- the caption text) + a trends_ideas row (niches/tags) so they flow through the SAME matching
-- as harvested trending posts. is_custom=true rows are excluded from the trends Feed.
--
-- Selection model (user decision 06.07): a job first rolls meme-vs-caption using the
-- trends_settings 'meme_share' percentage; caption videos then pick a STYLE (kind='caption')
-- or classic. Styles combine with text templates; memes NEVER carry a style.

ALTER TABLE video_templates ADD COLUMN IF NOT EXISTS niches text[] NOT NULL DEFAULT '{}';
ALTER TABLE trends_posts ADD COLUMN IF NOT EXISTS is_custom boolean NOT NULL DEFAULT false;
INSERT INTO trends_settings (key, value) VALUES ('meme_share', '25'::jsonb) ON CONFLICT (key) DO NOTHING;

-- ROLLBACK: ALTER TABLE video_templates DROP COLUMN niches;
--           ALTER TABLE trends_posts DROP COLUMN is_custom;
--           DELETE FROM trends_settings WHERE key='meme_share';
