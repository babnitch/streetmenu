CREATE TABLE IF NOT EXISTS restaurant_change_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id),
  changes jsonb NOT NULL,
  changed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  seen_at timestamptz,
  seen_by uuid,
  deleted_at timestamptz,
  deleted_by uuid
);
CREATE INDEX IF NOT EXISTS restaurant_change_notices_open ON restaurant_change_notices (created_at DESC) WHERE seen_at IS NULL AND deleted_at IS NULL;
ALTER TABLE restaurant_change_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON restaurant_change_notices FROM anon, authenticated;
NOTIFY pgrst, 'reload schema';
