-- Run in Supabase SQL editor AFTER this deploy is verified — breaks vendor signup,
-- admin restaurant management, and vendor self-edit if run early. Confirm all three
-- flows work first.

BEGIN;
ALTER TABLE restaurants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public can insert restaurants" ON restaurants;
DROP POLICY IF EXISTS "Public can update restaurants" ON restaurants;
COMMIT;
