-- Run in Supabase SQL editor AFTER this deploy is verified — breaks vendor
-- menu create/edit/delete/availability if run early. Confirm those flows work first.
-- Leaves public_read as the only SELECT policy; customer-facing menu keeps working.
BEGIN;
DROP POLICY IF EXISTS "Public can insert menu_items" ON menu_items;
DROP POLICY IF EXISTS "Public can update menu_items" ON menu_items;
DROP POLICY IF EXISTS "Public can delete menu_items" ON menu_items;
DROP POLICY IF EXISTS "Public can read menu_items"   ON menu_items;
COMMIT;
