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
  // joined field from foreign key
  restaurants?: { name: string; city: string }
}

export interface CartItem {
  id: string
  name: string
  price: number
  quantity: number
  photo_url?: string
}
