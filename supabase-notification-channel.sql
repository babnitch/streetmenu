-- Notification channel preference (forward-looking).
--
-- Adds customers.notification_channel so we can later let users pick where
-- they receive order/event notifications. For now everything still goes over
-- WhatsApp (free); this column is not yet read anywhere — it exists so the
-- schema is ready when channel selection ships.
--
-- Run before deploying the SMS-fallback verification change.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS notification_channel text NOT NULL DEFAULT 'whatsapp';

-- Guard against unexpected values so future readers can trust the column.
ALTER TABLE customers
  DROP CONSTRAINT IF EXISTS customers_notification_channel_check;
ALTER TABLE customers
  ADD CONSTRAINT customers_notification_channel_check
  CHECK (notification_channel IN ('whatsapp', 'sms'));
