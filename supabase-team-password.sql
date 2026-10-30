-- Platform team: a member created (or reset) with a temporary password must
-- choose their own at first login. Safe to re-run.
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
