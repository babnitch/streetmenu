-- =============================================================================
-- Event date ranges — start + end date/time
-- Run by hand in Supabase SQL Editor. Idempotent — safe to re-run.
-- =============================================================================
-- An event can now span several days (a festival Jan 17 18:00 → Jan 19 23:00
-- shows on each day it covers) and is "past" only once its LAST day is over.
--
-- events.date / events.time keep their meaning and are the START. They are
-- deliberately not renamed: ~60 call sites read `date`, and a rename would
-- have to land in the same instant as this hand-run SQL.
--
--   end_date            DATE NULL — last day of the event. NULL = single-day
--                       (the event ends on `date`). The API stores NULL
--                       whenever end_date equals date, so every single-day
--                       row has the same shape.
--   end_time            TEXT NULL — HH:MM, same free-text shape as events.time.
--                       end >= start on the same day is validated in the API,
--                       not here, because legacy events.time is not guaranteed
--                       to be HH:MM.
--   effective_end_date  DATE, generated COALESCE(end_date, date). What every
--                       "is it past?" / "is it on day X?" query filters on.
--                       Never written by application code.
--
-- Backward compatible, no backfill: existing rows get end_date NULL and read as
-- single-day. Why NULL-means-single-day rather than backfill + trigger: a
-- trigger cannot tell an old-code edit that moved `date` (end_date should
-- follow) from a new-code edit that deliberately kept end_date, so it would
-- silently corrupt end dates. A DEFAULT cannot reference another column.
--
-- Events on day X:     date <= X AND effective_end_date >= X
-- Not yet past:        effective_end_date >= today
-- =============================================================================

ALTER TABLE events ADD COLUMN IF NOT EXISTS end_date DATE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS end_time TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS effective_end_date DATE
  GENERATED ALWAYS AS (COALESCE(end_date, date)) STORED;

-- A range can never end before it starts. NULL (single-day) always passes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname  = 'events_end_date_not_before_start'
       AND conrelid = 'public.events'::regclass
  ) THEN
    ALTER TABLE events ADD CONSTRAINT events_end_date_not_before_start
      CHECK (end_date IS NULL OR end_date >= date);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_events_effective_end_date ON events(effective_end_date);

-- Make PostgREST see the new columns immediately.
NOTIFY pgrst, 'reload schema';
