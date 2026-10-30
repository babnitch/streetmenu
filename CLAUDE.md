# Tchop & Ndjoka — rules for every change

## Soft deletion (business data is never hard-deleted)

- Never `DELETE` a business row (restaurants, menu items, events, orders,
  reservations, vouchers, team members, places, payments, ledger…).
  "Delete" = set `deleted_at` (+ `deleted_by`, and a reason where useful), or
  a status that says so (`event_status='rejected'`, `admin_users.status='removed'`).
- Every list, search, lookup and public read filters these rows out
  (`.is('deleted_at', null)` / the status), including RLS policies. A deleted
  row can't be edited or brought back by another route.
- Old records that point at a deleted row keep working (an order keeps its
  dish, a used voucher code stays taken).
- Write an audit row (`writeAudit`) for every soft delete.
- New tables for business data get `deleted_at timestamptz` + `deleted_by uuid`
  from the start (SQL in a new `supabase-*.sql` file).
- Exceptions, hard-deleted on purpose: temporary data (`verification_codes`,
  `signup_sessions`, login challenges) and test fixtures in teardown.
- Legal deletion requests keep **anonymising** personal data (lib/dataDeletion.ts),
  not deleting rows.
