-- =============================================================================
-- Manual payment marker
-- Run this in Supabase SQL Editor
-- =============================================================================
-- Vendors can mark an order paid when the customer pays in cash, hands them
-- a phone with a MoMo receipt, or otherwise settles outside the in-app
-- PawaPay flow. We record the wallet number used (if any) so the vendor
-- has a paper trail for the offline transfer. payment_method holds one of
-- 'cash' | 'mtn_momo' | 'orange_money'; the existing PawaPay correspondent
-- codes (MTN_MOMO_CMR etc.) live in the same column so a non-null payment_id
-- is the reliable "this was app-paid" signal.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS manual_payment_phone text;
