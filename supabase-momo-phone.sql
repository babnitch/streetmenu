-- =============================================================================
-- Add momo_phone column to customers
-- Run this in Supabase SQL Editor
-- =============================================================================
-- Remembers the customer's preferred Mobile Money wallet number so we can
-- pre-fill the field on the next order. Stored as E.164 (e.g. +237670000000)
-- — the PawaPay client strips '+' and non-digits before sending to the API.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS momo_phone text;
