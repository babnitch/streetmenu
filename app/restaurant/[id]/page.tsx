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
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <div className="text-center">
          <div className="text-5xl mb-4 animate-bounce">🍜</div>
          <p className="text-brand-dark font-semibold">{t('menu.loading')}</p>
        </div>
      </div>
    )
  }

  if (!restaurant) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <div className="text-center">
          <p className="text-ink-secondary mb-4">{t('menu.notFound')}</p>
          <Link href="/" className="text-brand-dark underline">{t('menu.goBack')}</Link>
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
      <div className="min-h-screen bg-surface flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <div className="text-5xl mb-4">🏪</div>
          <p className="text-ink-primary font-semibold mb-1">Ce restaurant n&apos;est pas disponible</p>
          <p className="text-ink-secondary text-sm mb-4">This restaurant is not available.</p>
          <Link href="/" className="text-brand-dark underline">{t('menu.goBack')}</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />

      {/* Hero — 200px height, image + dark gradient, name overlaid bottom-left */}
      <div className="relative h-48 bg-gradient-to-br from-brand-light to-brand-badge">
        {(restaurant.image_url || restaurant.logo_url) && (
          <Image
            src={(restaurant.image_url || restaurant.logo_url)!}
            alt={restaurant.name}
            fill
            className="object-cover"
            sizes="100vw"
            priority
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
        <button
          onClick={() => router.back()}
          className="absolute top-4 left-4 bg-surface/95 backdrop-blur-sm rounded-full w-10 h-10 flex items-center justify-center text-ink-primary shadow-card hover:bg-surface transition-colors"
          aria-label="Back"
        >
          ←
        </button>
        <div className="absolute bottom-4 left-4 right-4 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-white leading-tight truncate">{restaurant.name}</h1>
            <p className="text-white/85 text-sm truncate">
              {[restaurant.cuisine_type, restaurant.neighborhood, restaurant.city].filter(Boolean).join(' · ')}
            </p>
          </div>
          <span className={`flex-shrink-0 text-xs font-semibold px-2.5 py-1 rounded-full ${
            restaurant.is_open ? 'bg-brand-light text-brand-darker' : 'bg-ink-primary text-white'
          }`}>
            {restaurant.is_open ? '🟢 Ouvert / Open' : '🔴 Fermé / Closed'}
          </span>
        </div>
      </div>

      {/* Sticky category tabs */}
      <div className="sticky top-0 z-10 bg-surface border-b border-divider">
        <div className="max-w-2xl mx-auto flex gap-2 px-4 py-3 overflow-x-auto">
          {categories.map(cat => {
            const active = activeCategory === cat
            return (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`flex-shrink-0 px-4 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap transition-colors ${
                  active
                    ? 'bg-ink-primary text-white'
                    : 'bg-surface-muted text-ink-secondary hover:text-ink-primary'
                }`}
              >
                {cat === 'all' ? t('menu.all') : cat.charAt(0).toUpperCase() + cat.slice(1)}
              </button>
            )
          })}
        </div>
      </div>

      <div className="px-4 pb-32 max-w-2xl mx-auto">
        {/* Daily Specials */}
        {specials.length > 0 && activeCategory === 'all' && (
          <div className="mt-6">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-lg">⭐</span>
              <h2 className="text-lg font-bold text-ink-primary">{t('menu.specials')}</h2>
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
          <div className="mt-6">
            {activeCategory === 'all' && specials.length > 0 && (
              <h2 className="text-lg font-bold text-ink-primary mb-3">{t('menu.menu')}</h2>
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
          <div className="text-center py-16 text-ink-tertiary">
            <div className="text-4xl mb-3">🍽️</div>
            <p className="text-sm">{t('menu.noItems')}</p>
          </div>
        )}
      </div>

      {/* Floating cart CTA — bottom-anchored, brand primary, full width */}
      {totalItems > 0 && (
        <div className="fixed bottom-4 left-4 right-4 max-w-xl mx-auto z-20">
          <Link
            href="/order"
            className="flex items-center justify-between bg-brand hover:bg-brand-dark text-white px-5 py-4 rounded-full shadow-card transition-colors"
          >
            <span className="bg-white/25 rounded-full px-2 py-0.5 text-sm font-bold min-w-7 text-center">{totalItems}</span>
            <span className="font-semibold text-sm">{t('menu.viewCart')}</span>
            <span className="font-semibold">{totalPrice.toLocaleString()} FCFA</span>
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
    <div className={`bg-surface rounded-2xl overflow-hidden border border-divider ${isSpecial ? 'ring-2 ring-brand' : ''}`}>
      {isSpecial && (
        <div className="bg-brand text-white text-xs font-semibold px-3 py-1">
          {dailyBadge}
        </div>
      )}
      <div className="flex gap-3 p-3">
        {item.photo_url ? (
          <div className="relative w-20 h-20 rounded-xl overflow-hidden flex-shrink-0">
            <Image src={item.photo_url} alt={item.name} fill className="object-cover" sizes="80px" />
          </div>
        ) : (
          <div className="w-20 h-20 rounded-xl bg-brand-light flex items-center justify-center flex-shrink-0 text-3xl">
            🍽️
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-ink-primary text-sm leading-tight">{item.name}</h3>
          {item.description && (
            <p className="text-xs text-ink-secondary mt-0.5 line-clamp-2">{item.description}</p>
          )}
          <div className="flex items-center justify-between mt-2 gap-3">
            <span className="font-bold text-brand-dark text-sm">{item.price.toLocaleString()} FCFA</span>
            <button
              onClick={onAdd}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors flex-shrink-0 ${
                qty > 0
                  ? 'bg-brand text-white hover:bg-brand-dark'
                  : 'bg-brand-light text-brand-darker hover:bg-brand-badge'
              }`}
            >
              {qty > 0 ? `${qty} · ${addedLabel}` : `+ ${addLabel}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
