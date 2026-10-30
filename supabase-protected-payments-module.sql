ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS restaurants_modules_known;
ALTER TABLE restaurants ADD CONSTRAINT restaurants_modules_known CHECK (
  modules <@ ARRAY['orders','payment','delivery','team','promo_codes','daily_offer','broadcast','featured','stats','payments_protected']::text[]);

ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS restaurants_modules_needs_payment;
ALTER TABLE restaurants ADD CONSTRAINT restaurants_modules_needs_payment CHECK (
  'payment' = ANY(modules) OR NOT ('payments_protected' = ANY(modules)));

SELECT conname FROM pg_constraint WHERE conname IN ('restaurants_modules_known', 'restaurants_modules_needs_payment');
