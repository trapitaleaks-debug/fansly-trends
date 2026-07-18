-- Emergency "Fill to 8" button status/result (single-row, id='singleton', upserted each run).
-- The UI polls this to show live phase + the per-model summary after a run completes.
CREATE TABLE IF NOT EXISTS emergency_fill_runs (
  id          text PRIMARY KEY DEFAULT 'singleton',
  running     boolean NOT NULL DEFAULT false,
  phase       text,                         -- 'sweeping' | 'filling' | 'done' | 'error'
  started_at  timestamptz,
  finished_at timestamptz,
  totals      jsonb NOT NULL DEFAULT '{}',  -- { modelsBelow, filled, shortfall, nearDupes }
  per_model   jsonb NOT NULL DEFAULT '[]',  -- [{ handle, needed, filled, nearDupes, note }]
  error       text
);
