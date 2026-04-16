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
}
