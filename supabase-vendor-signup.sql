-- Run this in your Supabase SQL editor to support the vendor self-signup flow
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS owner_name TEXT,
  ADD COLUMN IF NOT EXISTS neighborhood TEXT,
  ADD COLUMN IF NOT EXISTS cuisine_type TEXT;
