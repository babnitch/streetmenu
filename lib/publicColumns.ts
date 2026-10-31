// What the public (browser) key may read from restaurants and events.
//
// The database grants the public key ONLY these columns
// (supabase-public-reads.sql), so a browser read must name them — select('*')
// would be refused. Everything else (owner, refusal / suspension reasons,
// payout numbers, organiser ids, the bookings number, commission) is read on
// the server with supabaseAdmin. Adding a column here also needs a GRANT in
// a new supabase-*.sql file; scripts/suites/db-public-key-reads.ts checks
// both lists against the database.

export const PUBLIC_RESTAURANT_COLUMNS = [
  'id', 'name', 'description', 'address', 'lat', 'lng', 'phone', 'whatsapp',
  'logo_url', 'image_url', 'blur_hash', 'is_open', 'created_at', 'updated_at',
  'city', 'neighborhood', 'cuisine_type', 'is_active', 'status', 'deleted_at',
  'payment_enabled', 'payment_mode', 'whatsapp_payment_enabled', 'broadcast_enabled',
  'manual_override', 'manual_override_at', 'timezone', 'allow_orders_when_closed',
  'prep_time_min', 'prep_time_max', 'delivery_enabled', 'delivery_fee', 'delivery_extra_min',
  'modules', 'menu_type', 'managed_by_platform', 'riders_mode',
  'instagram_url', 'facebook_url', 'tiktok_url', 'website_url',
] as const

/** Server-only restaurant columns: never readable with the public key. */
export const PRIVATE_RESTAURANT_COLUMNS = [
  'customer_id', 'owner_name', 'suspended_at', 'suspended_by', 'suspension_reason',
  'rejected_at', 'rejected_by', 'rejection_reason', 'pawapay_merchant_id',
  'payout_phone', 'payout_phone_pending',
] as const

export const PUBLIC_EVENT_COLUMNS = [
  'id', 'title', 'description', 'date', 'time', 'end_date', 'end_time', 'effective_end_date',
  'venue', 'city', 'neighborhood', 'category', 'price', 'price_is_from', 'cover_photo', 'blur_hash',
  'whatsapp', 'organizer_name', 'is_active', 'event_status', 'is_featured', 'created_at', 'updated_at',
  'restaurant_id', 'place_id', 'payment_enabled', 'payment_mode', 'whatsapp_payment_enabled',
  'ticket_price', 'max_tickets', 'tickets_sold', 'requires_confirmation', 'reservations_open',
  'managed_by_platform', 'booking_mode', 'info_link',
] as const

/** Server-only event columns: never readable with the public key. */
export const PRIVATE_EVENT_COLUMNS = [
  'submitted_by', 'organizer_id', 'notify_phone', 'commission_rate', 'commission_amount',
  'auto_approved', 'rejected_at', 'rejected_by', 'rejection_reason',
] as const

/** For supabase-js .select(). */
export const PUBLIC_RESTAURANT_SELECT = PUBLIC_RESTAURANT_COLUMNS.join(', ')
export const PUBLIC_EVENT_SELECT = PUBLIC_EVENT_COLUMNS.join(', ')
