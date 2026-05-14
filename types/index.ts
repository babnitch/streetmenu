export interface Restaurant {
  id: string
  name: string
  description: string
  address: string
  city: string
  lat: number
  lng: number
  phone: string
  whatsapp: string
  logo_url: string
  is_open: boolean
  is_active: boolean
  created_at: string
  // Vendor signup fields (added via supabase-vendor-signup.sql)
  owner_name?: string
  neighborhood?: string
  cuisine_type?: string
  // Moderation fields (added via supabase-account-system.sql)
  status?: string
  deleted_at?: string | null
  suspended_at?: string | null
  suspended_by?: string | null
  image_url?: string | null
  // Payments (added via supabase-payments.sql)
  payment_enabled?: boolean
  pawapay_merchant_id?: string | null
  // Schedule + manual override (added via supabase-opening-hours.sql)
  manual_override?: 'open' | 'closed' | null
  manual_override_at?: string | null
  timezone?: string
  allow_orders_when_closed?: boolean
}

export interface MenuItem {
  id: string
  restaurant_id: string
  name: string
  description: string
  price: number
  photo_url: string
  category: string
  is_available: boolean
  is_daily_special: boolean
  created_at: string
}

export interface Order {
  id: string
  restaurant_id: string
  customer_name: string
  customer_phone: string
  items: CartItem[]
  total_price: number
  status: 'pending' | 'confirmed' | 'preparing' | 'ready' | 'completed'
  created_at: string
  // optional extended fields
  customer_id?: string
  voucher_code?: string
  discount_amount?: number
  restaurants?: { name: string; city: string }
  // Payments (added via supabase-payments.sql)
  order_type?: 'reservation' | 'paid_order'
  payment_status?: 'not_required' | 'pending' | 'paid' | 'failed' | 'refunded'
  payment_id?: string | null
  payment_method?: string | null
  payment_amount?: number | null
  payment_at?: string | null
  manual_payment_phone?: string | null
}

export interface Voucher {
  id: string
  code: string
  discount_type: 'percent' | 'fixed'
  discount_value: number
  min_order: number
  max_uses: number | null
  uses_count: number
  expires_at: string | null
  is_active: boolean
  city: string | null
  created_at: string
  // Optional — set when the row was selected with a restaurants join.
  // Drives the "applicable restaurant" line on customer voucher cards.
  restaurant_id?: string | null
  restaurants?: { name: string } | null
}

export interface CustomerVoucher {
  id: string
  customer_id: string
  voucher_id: string
  claimed_at: string
  used_at: string | null
  vouchers?: Voucher
}

export interface CartItem {
  id: string
  name: string
  price: number
  quantity: number
  photo_url?: string
}

export interface Event {
  id: string
  title: string
  description: string
  date: string
  time: string
  venue: string
  city: string
  neighborhood: string
  category: string
  price: number | null
  cover_photo: string
  whatsapp: string
  organizer_name: string
  is_active: boolean
  created_at: string
  lat?: number | null
  lng?: number | null
  // Reservations & ticketing — populated by supabase-event-reservations.sql.
  // Optional so older rows still typecheck during the migration window.
  payment_enabled?: boolean
  ticket_price?: number | null
  max_tickets?: number | null
  tickets_sold?: number | null
  organizer_id?: string | null
  event_status?: 'upcoming' | 'ongoing' | 'completed' | 'cancelled'
}

export interface EventReservation {
  id:                 string
  event_id:           string
  customer_id:        string | null
  customer_name:      string
  customer_phone:     string
  quantity:           number
  total_price:        number
  payment_status:     'not_required' | 'pending' | 'paid' | 'failed'
  payment_id:         string | null
  payment_method:     string | null
  reservation_status: 'confirmed' | 'cancelled' | 'attended'
  created_at:         string
  updated_at:         string
  // Joined view when /api/customer/reservations or admin queries include it
  events?: Pick<Event, 'id' | 'title' | 'date' | 'time' | 'venue' | 'city' | 'cover_photo' | 'ticket_price' | 'event_status'> | null
}
