ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS orders_paused_at timestamptz, ADD COLUMN IF NOT EXISTS orders_paused_until timestamptz;
GRANT SELECT (orders_paused_at, orders_paused_until) ON restaurants TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
