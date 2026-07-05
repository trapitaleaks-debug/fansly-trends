-- 004: Gate phantom-post reconciliation on scrape freshness.
--
-- Problem: reconcile_phantom_posts trusts scheduled_posts unconditionally. When the seed
-- scrape fails/skips a model (sidebar miss, wrong model active, tab not rendered), its
-- scheduled_posts rows are stale/missing → genuinely-landed 'posted' jobs get re-queued →
-- they re-post → duplicate posts on FanCore (the 6-posts-a-day bug).
--
-- Fix: seed-scheduled-posts.ts stamps trends_models.last_seed_scrape_at ONLY after an
-- authoritative per-model outcome; the RPC only reconciles models scraped within 2 hours.
-- Stamps start NULL → reconcile is a safe no-op for every model until its first clean scrape.

ALTER TABLE trends_models ADD COLUMN IF NOT EXISTS last_seed_scrape_at timestamptz;

CREATE OR REPLACE FUNCTION public.reconcile_phantom_posts(max_attempts integer DEFAULT 4)
 RETURNS integer
 LANGUAGE sql
AS $function$
  WITH phantom AS (
    SELECT vj.id,
      row_number() OVER (PARTITION BY vj.model_id, vj.post_id ORDER BY vj.scheduled_for) AS rn
    FROM video_jobs vj
    JOIN trends_models m ON m.id = vj.model_id
    WHERE vj.status = 'posted'
      AND vj.scheduled_for >= now()
      AND vj.post_fail_count < max_attempts
      -- Only trust scheduled_posts for models whose scrape is verifiably fresh (see header).
      AND m.last_seed_scrape_at > now() - interval '2 hours'
      AND NOT EXISTS (
        SELECT 1 FROM scheduled_posts sp
        WHERE sp.model_id = m.model_number AND sp.scheduled_for = vj.scheduled_for
      )
      AND NOT EXISTS (
        SELECT 1 FROM video_jobs vj2
        WHERE vj2.model_id = vj.model_id AND vj2.post_id = vj.post_id
          AND vj2.status NOT IN ('posted','error')
      )
  ),
  upd AS (
    -- Clear scheduled_for so the re-post is re-slotted by getNextSlot into a clean 4/day position
    -- (the old slot came from the buggy scheduler). Keeps the model's schedule at 4/day on recovery.
    UPDATE video_jobs SET status = 'approved', started_at = NULL, error_message = NULL, scheduled_for = NULL
    WHERE id IN (SELECT id FROM phantom WHERE rn = 1)
    RETURNING id
  )
  SELECT count(*)::int FROM upd;
$function$;

-- ROLLBACK: restore the pre-004 function body (identical minus the freshness predicate):
--   CREATE OR REPLACE FUNCTION public.reconcile_phantom_posts(max_attempts integer DEFAULT 4)
--    RETURNS integer LANGUAGE sql AS $fn$
--     WITH phantom AS (
--       SELECT vj.id, row_number() OVER (PARTITION BY vj.model_id, vj.post_id ORDER BY vj.scheduled_for) AS rn
--       FROM video_jobs vj JOIN trends_models m ON m.id = vj.model_id
--       WHERE vj.status = 'posted' AND vj.scheduled_for >= now() AND vj.post_fail_count < max_attempts
--         AND NOT EXISTS (SELECT 1 FROM scheduled_posts sp WHERE sp.model_id = m.model_number AND sp.scheduled_for = vj.scheduled_for)
--         AND NOT EXISTS (SELECT 1 FROM video_jobs vj2 WHERE vj2.model_id = vj.model_id AND vj2.post_id = vj.post_id AND vj2.status NOT IN ('posted','error'))
--     ),
--     upd AS (UPDATE video_jobs SET status = 'approved', started_at = NULL, error_message = NULL, scheduled_for = NULL
--             WHERE id IN (SELECT id FROM phantom WHERE rn = 1) RETURNING id)
--     SELECT count(*)::int FROM upd;
--   $fn$;
-- The last_seed_scrape_at column is harmless to leave in place.
