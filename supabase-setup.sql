-- StreetMenu Supabase Setup
-- Run this in your Supabase SQL Editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Restaurants table
CREATE TABLE IF NOT EXISTS restaurants (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  address TEXT,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  phone TEXT,
  whatsapp TEXT,
  logo_url TEXT,
  is_open BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Menu items table
CREATE TABLE IF NOT EXISTS menu_items (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC(10,2) NOT NULL,
  photo_url TEXT,
  category TEXT,
  is_available BOOLEAN DEFAULT true,
  is_daily_special BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Orders table
CREATE TABLE IF NOT EXISTS orders (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  items JSONB NOT NULL DEFAULT '[]',
  total_price NUMERIC(10,2) NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','confirmed','preparing','ready','completed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Row Level Security (allow public read for restaurants and menu_items)
ALTER TABLE restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- Policies: public read
CREATE POLICY "Public can read restaurants" ON restaurants FOR SELECT USING (true);
CREATE POLICY "Public can read menu_items" ON menu_items FOR SELECT USING (true);

-- Policies: public insert/update for demo (tighten for production)
CREATE POLICY "Public can insert restaurants" ON restaurants FOR INSERT WITH CHECK (true);
CREATE POLICY "Public can update restaurants" ON restaurants FOR UPDATE USING (true);
CREATE POLICY "Public can insert menu_items" ON menu_items FOR INSERT WITH CHECK (true);
CREATE POLICY "Public can update menu_items" ON menu_items FOR UPDATE USING (true);
CREATE POLICY "Public can delete menu_items" ON menu_items FOR DELETE USING (true);
CREATE POLICY "Public can insert orders" ON orders FOR INSERT WITH CHECK (true);
CREATE POLICY "Public can read orders" ON orders FOR SELECT USING (true);
CREATE POLICY "Public can update orders" ON orders FOR UPDATE USING (true);

-- Enable realtime for orders
ALTER PUBLICATION supabase_realtime ADD TABLE orders;

-- =========================================
-- SAMPLE DATA: 3 Restaurants in Zurich
-- =========================================

INSERT INTO restaurants (name, description, address, lat, lng, phone, whatsapp, logo_url, is_open) VALUES
(
  'Züri Street Grill',
  'Authentic Swiss street food meets global BBQ flavors. Bratwurst, burgers, and more — grilled fresh to order.',
  'Langstrasse 42, 8004 Zürich',
  47.3764,
  8.5254,
  '+41 44 123 45 67',
  '+41791234567',
  'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=800&auto=format&fit=crop',
  true
),
(
  'Spice Garden',
  'Vibrant Indian street food inspired by the markets of Mumbai and Delhi. Vegetarian-friendly with bold spices.',
  'Badenerstrasse 18, 8003 Zürich',
  47.3735,
  8.5272,
  '+41 44 987 65 43',
  '+41797654321',
  'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=800&auto=format&fit=crop',
  true
),
(
  'Pasta & Co.',
  'Fresh handmade pasta and classic Italian street food. Simple, honest, delicious.',
  'Niederdorfstrasse 7, 8001 Zürich',
  47.3795,
  8.5447,
  '+41 44 456 78 90',
  '+41794567890',
  'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=800&auto=format&fit=crop',
  false
);

-- Menu items for Züri Street Grill
INSERT INTO menu_items (restaurant_id, name, description, price, photo_url, category, is_available, is_daily_special)
SELECT id, 'Classic Züri Bratwurst', 'Pork bratwurst grilled over charcoal, served with Rösti and mustard', 14.50,
  'https://images.unsplash.com/photo-1627308595229-7830a5c91f9f?w=600&auto=format&fit=crop',
  'Mains', true, true
FROM restaurants WHERE name = 'Züri Street Grill';

INSERT INTO menu_items (restaurant_id, name, description, price, photo_url, category, is_available, is_daily_special)
SELECT id, 'Smash Burger', 'Double smashed patty, cheddar, caramelised onions, pickles & house sauce', 18.00,
  'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=600&auto=format&fit=crop',
  'Mains', true, false
FROM restaurants WHERE name = 'Züri Street Grill';

INSERT INTO menu_items (restaurant_id, name, description, price, photo_url, category, is_available, is_daily_special)
SELECT id, 'Crispy Fries', 'Golden fries with sea salt and your choice of dip', 6.50,
  'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=600&auto=format&fit=crop',
  'Sides', true, false
FROM restaurants WHERE name = 'Züri Street Grill';

INSERT INTO menu_items (restaurant_id, name, description, price, photo_url, category, is_available, is_daily_special)
SELECT id, 'Swiss Lemonade', 'Freshly squeezed lemon with elderflower syrup and sparkling water', 5.00,
  'https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=600&auto=format&fit=crop',
  'Drinks', true, false
FROM restaurants WHERE name = 'Züri Street Grill';

INSERT INTO menu_items (restaurant_id, name, description, price, photo_url, category, is_available, is_daily_special)
SELECT id, 'Grilled Halloumi Wrap', 'Grilled halloumi, roasted peppers, rocket, tzatziki in a soft tortilla', 15.50,
  'https://images.unsplash.com/photo-1626700051175-6818013e1d4f?w=600&auto=format&fit=crop',
  'Mains', true, false
FROM restaurants WHERE name = 'Züri Street Grill';

-- Menu items for Spice Garden
INSERT INTO menu_items (restaurant_id, name, description, price, photo_url, category, is_available, is_daily_special)
SELECT id, 'Butter Chicken Bowl', 'Slow-cooked chicken in rich tomato-cream sauce, served with basmati rice', 16.50,
  'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=600&auto=format&fit=crop',
  'Mains', true, true
FROM restaurants WHERE name = 'Spice Garden';

INSERT INTO menu_items (restaurant_id, name, description, price, photo_url, category, is_available, is_daily_special)
SELECT id, 'Samosa Chaat', 'Crispy samosas topped with yogurt, tamarind chutney, and sev', 9.00,
  'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=600&auto=format&fit=crop',
  'Starters', true, false
FROM restaurants WHERE name = 'Spice Garden';

INSERT INTO menu_items (restaurant_id, name, description, price, photo_url, category, is_available, is_daily_special)
SELECT id, 'Paneer Tikka', 'Marinated cottage cheese grilled in tandoor, served with mint chutney', 14.00,
  'https://images.unsplash.com/photo-1567188040759-fb8a883dc6d8?w=600&auto=format&fit=crop',
  'Starters', true, false
FROM restaurants WHERE name = 'Spice Garden';

INSERT INTO menu_items (restaurant_id, name, description, price, photo_url, category, is_available, is_daily_special)
SELECT id, 'Mango Lassi', 'Chilled yogurt drink blended with Alphonso mango pulp', 6.50,
  'https://images.unsplash.com/photo-1553361371-9b22f78e8b1d?w=600&auto=format&fit=crop',
  'Drinks', true, false
FROM restaurants WHERE name = 'Spice Garden';

INSERT INTO menu_items (restaurant_id, name, description, price, photo_url, category, is_available, is_daily_special)
SELECT id, 'Dal Makhani', 'Slow-cooked black lentils with butter and cream, with garlic naan', 13.00,
  'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=600&auto=format&fit=crop',
  'Mains', true, false
FROM restaurants WHERE name = 'Spice Garden';

-- Menu items for Pasta & Co.
INSERT INTO menu_items (restaurant_id, name, description, price, photo_url, category, is_available, is_daily_special)
SELECT id, 'Cacio e Pepe', 'Handmade tonnarelli with Pecorino Romano and black pepper', 17.00,
  'https://images.unsplash.com/photo-1608897013039-887f21d8c804?w=600&auto=format&fit=crop',
  'Pasta', true, true
FROM restaurants WHERE name = 'Pasta & Co.';

INSERT INTO menu_items (restaurant_id, name, description, price, photo_url, category, is_available, is_daily_special)
SELECT id, 'Truffle Tagliatelle', 'Fresh egg tagliatelle with black truffle cream and Parmigiano', 22.00,
  'https://images.unsplash.com/photo-1473093226555-0f688f89e0ca?w=600&auto=format&fit=crop',
  'Pasta', true, false
FROM restaurants WHERE name = 'Pasta & Co.';

INSERT INTO menu_items (restaurant_id, name, description, price, photo_url, category, is_available, is_daily_special)
SELECT id, 'Arancini', 'Crispy risotto balls filled with mozzarella and served with tomato dip', 10.50,
  'https://images.unsplash.com/photo-1541745537411-b8046dc6d66c?w=600&auto=format&fit=crop',
  'Starters', true, false
FROM restaurants WHERE name = 'Pasta & Co.';

INSERT INTO menu_items (restaurant_id, name, description, price, photo_url, category, is_available, is_daily_special)
SELECT id, 'Tiramisu', 'Classic Italian tiramisu with mascarpone and espresso', 9.00,
  'https://images.unsplash.com/photo-1571877227200-a0d98ea607e9?w=600&auto=format&fit=crop',
  'Desserts', true, false
FROM restaurants WHERE name = 'Pasta & Co.';

INSERT INTO menu_items (restaurant_id, name, description, price, photo_url, category, is_available, is_daily_special)
SELECT id, 'San Pellegrino', 'Sparkling Italian mineral water, 500ml', 4.00,
  'https://images.unsplash.com/photo-1563227812-0ea4c22e6cc8?w=600&auto=format&fit=crop',
  'Drinks', true, false
FROM restaurants WHERE name = 'Pasta & Co.';

-- Create storage bucket for photos (run separately or via Supabase dashboard)
-- INSERT INTO storage.buckets (id, name, public) VALUES ('photos', 'photos', true);
