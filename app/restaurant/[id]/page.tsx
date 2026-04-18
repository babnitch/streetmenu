'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Image from 'next/image'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { Restaurant, MenuItem } from '@/types'
import { useCart } from '@/lib/cartContext'
import { useLanguage } from '@/lib/languageContext'
import TopNav from '@/components/TopNav'

export default function MenuPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { addItem, items, totalItems, totalPrice } = useCart()
  const { t } = useLanguage()

  const [restaurant, setRestaurant] = useState<Restaurant | null>(null)
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [loading, setLoading] = useState(true)
  const [activeCategory, setActiveCategory] = useState<string>('all')

  useEffect(() => {
    async function fetchData() {
      const [{ data: rest }, { data: menu }] = await Promise.all([
        supabase.from('restaurants').select('*').eq('id', id).single(),
        supabase.from('menu_items').select('*').eq('restaurant_id', id).eq('is_available', true).order('is_daily_special', { ascending: false }),
      ])
      if (rest) setRestaurant(rest)
      if (menu) setMenuItems(menu)
      setLoading(false)
    }
    fetchData()
  }, [id])

  const categories = ['all', ...Array.from(new Set(menuItems.map(m => m.category))).filter(Boolean)]
  const specials = menuItems.filter(m => m.is_daily_special)
  const filtered = activeCategory === 'all'
    ? menuItems.filter(m => !m.is_daily_special)
    : menuItems.filter(m => m.category === activeCategory && !m.is_daily_special)

  const getItemQty = (itemId: string) => items.find(i => i.id === itemId)?.quantity ?? 0

  if (loading) {
    return (
      <div className="min-h-screen bg-orange-50 flex items-center justify-center">
        <div className="text-center">
          <div className="text-5xl mb-4 animate-bounce">🍜</div>
          <p className="text-orange-500 font-semibold">{t('menu.loading')}</p>
        </div>
      </div>
    )
  }

  if (!restaurant) {
    return (
      <div className="min-h-screen bg-orange-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-500 mb-4">{t('menu.notFound')}</p>
          <Link href="/" className="text-orange-500 underline">{t('menu.goBack')}</Link>
        </div>
      </div>
    )
  }

  const unavailable =
    !!restaurant.deleted_at ||
    restaurant.status === 'suspended' ||
    restaurant.status === 'deleted' ||
    restaurant.status === 'pending'

  if (unavailable) {
    return (
      <div className="min-h-screen bg-orange-50 flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <div className="text-5xl mb-4">🏪</div>
          <p className="text-gray-700 font-semibold mb-1">Ce restaurant n&apos;est pas disponible</p>
          <p className="text-gray-500 text-sm mb-4">This restaurant is not available.</p>
          <Link href="/" className="text-orange-500 underline">{t('menu.goBack')}</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-orange-50">
      <TopNav />
      {/* Hero */}
      <div className="relative h-40 bg-gradient-to-br from-orange-400 to-orange-600">
        {(restaurant.image_url || restaurant.logo_url) && (
          <Image src={(restaurant.image_url || restaurant.logo_url)!} alt={restaurant.name} fill className="object-cover opacity-60" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
        <button
          onClick={() => router.back()}
          className="absolute top-4 left-4 bg-white/90 backdrop-blur-sm rounded-full w-9 h-9 flex items-center justify-center text-gray-700 shadow-md hover:bg-white transition-colors"
        >
          ←
        </button>
        <div className="absolute bottom-4 left-4 right-4">
          <div className="flex items-end justify-between">
            <div>
              <h1 className="text-2xl font-bold text-white">{restaurant.name}</h1>
              <p className="text-white/80 text-sm">{restaurant.address}</p>
            </div>
            <span className={`text-xs font-semibold px-3 py-1 rounded-full ${
              restaurant.is_open ? 'bg-green-500 text-white' : 'bg-gray-400 text-white'
            }`}>
              {restaurant.is_open ? t('menu.open') : t('menu.closed')}
            </span>
          </div>
        </div>
      </div>

      {/* Categories */}
      <div className="sticky top-0 z-10 bg-white shadow-sm">
        <div className="flex gap-2 px-4 py-3 overflow-x-auto scrollbar-hide">
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`flex-shrink-0 px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                activeCategory === cat
                  ? 'bg-orange-500 text-white'
                  : 'bg-orange-50 text-gray-600 hover:bg-orange-100'
              }`}
            >
              {cat === 'all' ? t('menu.all') : cat.charAt(0).toUpperCase() + cat.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 pb-32 max-w-2xl mx-auto">
        {/* Daily Specials */}
        {specials.length > 0 && activeCategory === 'all' && (
          <div className="mt-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-lg">⭐</span>
              <h2 className="text-lg font-bold text-gray-900">{t('menu.specials')}</h2>
            </div>
            <div className="space-y-3">
              {specials.map(item => (
                <MenuItemCard
                  key={item.id}
                  item={item}
                  qty={getItemQty(item.id)}
                  onAdd={() => addItem({ id: item.id, name: item.name, price: item.price, quantity: 1, photo_url: item.photo_url }, id)}
                  isSpecial
                  dailyBadge={t('menu.dailyBadge')}
                  addLabel={t('menu.add')}
                  addedLabel={t('menu.added')}
                />
              ))}
            </div>
          </div>
        )}

        {/* Regular Items */}
        {filtered.length > 0 && (
          <div className="mt-5">
            {activeCategory === 'all' && specials.length > 0 && (
              <h2 className="text-lg font-bold text-gray-900 mb-3">{t('menu.menu')}</h2>
            )}
            <div className="space-y-3">
              {filtered.map(item => (
                <MenuItemCard
                  key={item.id}
                  item={item}
                  qty={getItemQty(item.id)}
                  onAdd={() => addItem({ id: item.id, name: item.name, price: item.price, quantity: 1, photo_url: item.photo_url }, id)}
                  dailyBadge={t('menu.dailyBadge')}
                  addLabel={t('menu.add')}
                  addedLabel={t('menu.added')}
                />
              ))}
            </div>
          </div>
        )}

        {menuItems.length === 0 && (
          <div className="text-center py-16 text-gray-400">
            <div className="text-4xl mb-3">🍽️</div>
            <p>{t('menu.noItems')}</p>
          </div>
        )}
      </div>

      {/* Floating Cart */}
      {totalItems > 0 && (
        <div className="fixed bottom-6 left-4 right-4 max-w-md mx-auto z-20">
          <Link
            href="/order"
            className="flex items-center justify-between bg-orange-500 hover:bg-orange-600 text-white px-5 py-4 rounded-2xl shadow-xl shadow-orange-300 transition-colors"
          >
            <span className="bg-white/25 rounded-lg px-2 py-0.5 text-sm font-bold">{totalItems}</span>
            <span className="font-semibold">{t('menu.viewCart')}</span>
            <span className="font-semibold">CHF {totalPrice.toFixed(2)}</span>
          </Link>
        </div>
      )}
    </div>
  )
}

function MenuItemCard({
  item,
  qty,
  onAdd,
  isSpecial = false,
  dailyBadge,
  addLabel,
  addedLabel,
}: {
  item: MenuItem
  qty: number
  onAdd: () => void
  isSpecial?: boolean
  dailyBadge: string
  addLabel: string
  addedLabel: string
}) {
  return (
    <div className={`bg-white rounded-2xl overflow-hidden shadow-sm ${isSpecial ? 'ring-2 ring-orange-400' : ''}`}>
      {isSpecial && (
        <div className="bg-gradient-to-r from-orange-400 to-orange-500 text-white text-xs font-semibold px-3 py-1">
          {dailyBadge}
        </div>
      )}
      <div className="flex gap-3 p-3">
        {item.photo_url ? (
          <div className="relative w-20 h-20 rounded-xl overflow-hidden flex-shrink-0">
            <Image src={item.photo_url} alt={item.name} fill className="object-cover" />
          </div>
        ) : (
          <div className="w-20 h-20 rounded-xl bg-orange-50 flex items-center justify-center flex-shrink-0 text-3xl">
            🍽️
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-gray-900 text-sm leading-tight">{item.name}</h3>
          {item.description && (
            <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{item.description}</p>
          )}
          <div className="flex items-center justify-between mt-2">
            <span className="font-bold text-orange-500">CHF {item.price.toFixed(2)}</span>
            <button
              onClick={onAdd}
              className={`rounded-full px-3 py-1 text-sm font-semibold transition-colors ${
                qty > 0
                  ? 'bg-orange-500 text-white'
                  : 'bg-orange-100 text-orange-600 hover:bg-orange-200'
              }`}
            >
              {qty > 0 ? `${qty} ${addedLabel}` : addLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
