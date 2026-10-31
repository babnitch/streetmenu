BEGIN;

DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

GRANT SELECT (id, name, description, address, lat, lng, phone, whatsapp, logo_url, image_url, blur_hash, is_open, created_at, updated_at, city, neighborhood, cuisine_type, is_active, status, deleted_at, payment_enabled, payment_mode, whatsapp_payment_enabled, broadcast_enabled, manual_override, manual_override_at, timezone, allow_orders_when_closed, prep_time_min, prep_time_max, delivery_enabled, delivery_fee, delivery_extra_min, modules, menu_type, managed_by_platform, riders_mode, instagram_url, facebook_url, tiktok_url, website_url) ON restaurants TO anon, authenticated;
CREATE POLICY public_active_read ON restaurants FOR SELECT TO anon, authenticated USING (is_active = true AND status IN ('active', 'approved') AND deleted_at IS NULL);

GRANT SELECT (id, title, description, date, time, end_date, end_time, effective_end_date, venue, city, neighborhood, category, price, price_is_from, cover_photo, blur_hash, whatsapp, organizer_name, is_active, event_status, is_featured, created_at, updated_at, restaurant_id, place_id, payment_enabled, payment_mode, whatsapp_payment_enabled, ticket_price, max_tickets, tickets_sold, requires_confirmation, reservations_open, managed_by_platform, booking_mode, info_link) ON events TO anon, authenticated;
CREATE POLICY public_active_read ON events FOR SELECT TO anon, authenticated USING (is_active = true);

GRANT SELECT ON menu_items, restaurant_hours, event_ticket_tiers, broadcast_pricing, promotion_pricing, ref_values TO anon, authenticated;
CREATE POLICY public_read ON menu_items FOR SELECT TO anon, authenticated USING (deleted_at IS NULL);
CREATE POLICY public_read ON restaurant_hours FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY public_read ON event_ticket_tiers FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY public_read ON broadcast_pricing FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY public_read ON promotion_pricing FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY public_read ON ref_values FOR SELECT TO anon, authenticated USING (visible);

COMMIT;

SELECT
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS policies,
  (SELECT count(*) FROM pg_tables t WHERE schemaname = 'public' AND NOT t.rowsecurity) AS tables_without_rls,
  (SELECT string_agg(DISTINCT table_name, ' ' ORDER BY table_name) FROM information_schema.role_table_grants WHERE grantee = 'anon' AND table_schema = 'public') AS anon_tables,
  (SELECT count(*) FROM information_schema.column_privileges WHERE grantee = 'anon' AND table_schema = 'public' AND table_name IN ('restaurants', 'events')) AS anon_columns,
  (SELECT count(*) FROM information_schema.routine_privileges WHERE grantee IN ('anon', 'PUBLIC', 'authenticated') AND routine_schema = 'public') AS anon_functions;
