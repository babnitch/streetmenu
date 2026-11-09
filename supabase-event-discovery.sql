CREATE TABLE IF NOT EXISTS event_discovery_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('rss','sitemap')),
  feed_url text NOT NULL,
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved','paused','refused')),
  terms_checked_on date,
  terms_note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS event_discovery_sources_domain ON event_discovery_sources (lower(domain)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS event_discovery_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','failed')),
  pages_fetched int NOT NULL DEFAULT 0,
  candidates_new int NOT NULL DEFAULT 0,
  duplicates_skipped int NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]',
  report_sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS event_discovery_runs_started ON event_discovery_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS event_discovery_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES event_discovery_runs(id),
  source_id uuid REFERENCES event_discovery_sources(id),
  url text NOT NULL,
  domain text NOT NULL,
  category_hint text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','skipped','failed')),
  skip_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, url)
);
CREATE INDEX IF NOT EXISTS event_discovery_pages_pending ON event_discovery_pages (run_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS event_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES event_discovery_runs(id),
  source_key text NOT NULL,
  source_url text NOT NULL,
  source_domain text NOT NULL,
  other_urls text[] NOT NULL DEFAULT '{}',
  ticket_url text,
  title text NOT NULL,
  title_key text NOT NULL,
  start_date date NOT NULL,
  start_time text,
  end_date date,
  end_time text,
  venue text,
  city text NOT NULL,
  category text,
  price_fcfa int,
  price_is_from boolean NOT NULL DEFAULT false,
  organiser_name text,
  organiser_url text,
  organiser_phone text,
  organiser_email text,
  possible_duplicate_event_id uuid REFERENCES events(id),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','published','ignored')),
  contacted_at timestamptz,
  contacted_by uuid,
  published_event_id uuid REFERENCES events(id),
  published_at timestamptz,
  published_by uuid,
  ignored_at timestamptz,
  ignored_by uuid,
  ignore_reason text,
  found_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS event_candidates_source_key ON event_candidates (source_key);
CREATE INDEX IF NOT EXISTS event_candidates_queue ON event_candidates (status, found_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS event_candidates_city_date ON event_candidates (city, start_date) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature text NOT NULL,
  model text NOT NULL,
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  ok boolean NOT NULL DEFAULT true,
  performed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_usage_created ON ai_usage (created_at DESC);

ALTER TABLE event_discovery_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_discovery_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_discovery_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON event_discovery_sources, event_discovery_runs, event_discovery_pages, event_candidates, ai_usage FROM anon, authenticated;

INSERT INTO event_discovery_sources (domain, kind, feed_url, status, terms_checked_on, terms_note)
SELECT 'ayatickets.fr', 'rss', 'https://ayatickets.fr/rss', 'approved', DATE '2026-11-09', 'RSS + JSON-LD on /fr/event pages, allowed by robots.txt; never /search/. Facts and link only (copyright on content, §7).'
WHERE NOT EXISTS (SELECT 1 FROM event_discovery_sources WHERE lower(domain) = 'ayatickets.fr' AND deleted_at IS NULL);
INSERT INTO event_discovery_sources (domain, kind, feed_url, status, terms_checked_on, terms_note)
SELECT 'showwupp.com', 'sitemap', 'https://showwupp.com/sitemap.xml', 'paused', DATE '2026-11-09', 'Paused until written permission (terms §7: no reproduction without written permission).'
WHERE NOT EXISTS (SELECT 1 FROM event_discovery_sources WHERE lower(domain) = 'showwupp.com' AND deleted_at IS NULL);

SELECT vault.create_secret('https://streetmenu.vercel.app/api/internal/discover-events', 'discover_events_url', 'Target of the event-discovery cron jobs')
WHERE NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'discover_events_url');

SELECT cron.schedule('event-discovery-start', '0 0 * * *', $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'discover_events_url'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_api_secret')),
    body := '{"step":"start"}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
SELECT cron.schedule('event-discovery-step', '2-57/5 0-1 * * *', $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'discover_events_url'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_api_secret')),
    body := '{"step":"step"}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);
SELECT cron.schedule('event-discovery-report', '0 6 * * *', $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'discover_events_url'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_api_secret')),
    body := '{"step":"report"}'::jsonb,
    timeout_milliseconds := 120000
  );
$$);

NOTIFY pgrst, 'reload schema';
