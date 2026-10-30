-- I5 — a place's editorial headline (FR / EN), shown under its name on the
-- place page ("Deux spirales pour un seul Cameroun"). The name stays in
-- title_fr / title_en. Safe to re-run.
ALTER TABLE places ADD COLUMN IF NOT EXISTS headline_fr text;
ALTER TABLE places ADD COLUMN IF NOT EXISTS headline_en text;
