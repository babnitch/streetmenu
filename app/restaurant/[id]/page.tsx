'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Image from 'next/image'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { Restaurant, MenuItem } from '@/types'
import { useCart } from '@/lib/cartContext'
import { useLanguage, useBi } from '@/lib/languageContext'
import { formatPrepTime } from '@/lib/prepTime'
import { formatDeliveryTime, rememberFulfilment, rememberedFulfilment, type Fulfilment } from '@/lib/delivery'
import { percentOffLabel } from '@/lib/offers'
import { formatFCFA, formatAmount } from '@/lib/money'
import { loginHref } from '@/lib/lastPhone'
import { takesOrders, deliversNow } from '@/lib/modules'
import { isDailyMenu, restaurantWeekday, isServedOn, servedDays, availableOnText } from '@/lib/menuDays'
import TopNav from '@/components/TopNav'
import BannerAd from '@/components/BannerAd'
import ReportButton from '@/components/ReportButton'

interface OpenInfo { open: boolean; next_kind?: string; next_at?: string }

// /restaurant/[id] — the menu, Uber-style (V4):
//   photo with ← and ⋯ (favourites, restaurant info) · name · type, area ·
//   "Ouvert jusqu'à HH:MM" / "Fermé" · Livraison | À emporter switch (only
//   when the restaurant delivers) · fee and time boxes · categories ·
//   dishes with "+" on the photo · floating cart.
// Without the Commandes module (Vitrine, M2): the same menu with prices but
// no "+", switch or cart — "Commander par WhatsApp" and "Appeler" instead.
// Ratings, hours, address and "Donner mon avis" live on /restaurant/[id]/info.
// Menu par jour (D3): today's dishes as usual (plat du jour as a badge), then
// "Autres jours" greyed with "Disponible le samedi" and no "+".
export default function MenuPage() {
  const bi = useBi()
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const { addItem, items, totalItems, totalPrice } = useCart()
  const { t, locale } = useLanguage()

  const [restaurant, setRestaurant] = useState<Restaurant | null>(null)
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [openInfo, setOpenInfo] = useState<OpenInfo | null>(null)
  const [freeDelivery, setFreeDelivery] = useState(false)
  const [loading, setLoading] = useState(true)
  const [activeCategory, setActiveCategory] = useState<string>('all')
  const [fulfilment, setFulfilment] = useState<Fulfilment>('delivery')

  // Old links (the bot's "rate" message) pointed at /restaurant/[id]#rate.
  useEffect(() => {
    if (window.location.hash === '#rate') router.replace(`/restaurant/${id}/info#rate`)
  }, [id, router])

  useEffect(() => {
    async function fetchData() {
      const [{ data: rest }, { data: menu }, statusRes, offersRes] = await Promise.all([
        supabase.from('restaurants').select('*').eq('id', id).single(),
        supabase.from('menu_items').select('*').eq('restaurant_id', id).eq('is_available', true).order('is_daily_special', { ascending: false }),
        fetch(`/api/restaurants/open-status?ids=${id}`, { cache: 'no-store' }).then(r => r.json()).catch(() => null),
        // Today's offers (V2): the dish costs its offer price, the menu
        // price shows struck through. The server charges the same price.
        fetch(`/api/offers/today?restaurant_id=${id}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null),
      ])
      if (rest) {
        setRestaurant(rest)
        const remembered = rememberedFulfilment(id)
        setFulfilment(deliversNow(rest) ? (remembered ?? 'delivery') : 'pickup')
      }
      if (menu) {
        const prices: Record<string, number> = offersRes?.prices ?? {}
        setMenuItems((menu as MenuItem[]).map(m => {
          const o = prices[m.id]
          return o != null && o < m.price ? { ...m, price: o, regular_price: m.price } : m
        }))
      }
      setFreeDelivery(offersRes?.free_delivery === true)
      const s = statusRes?.status?.[id]
      if (s) setOpenInfo(s)
      setLoading(false)
    }
    fetchData()
  }, [id])

  // Menu par jour: today's dishes are the menu; the rest wait for their day.
  const daily = isDailyMenu(restaurant)
  const todayDow = restaurant ? restaurantWeekday(restaurant) : 0
  const todays = daily ? menuItems.filter(m => isServedOn(m, todayDow, 'daily')) : menuItems
  const otherDays = daily ? menuItems.filter(m => !isServedOn(m, todayDow, 'daily')) : []
  // À la carte keeps its "Spécialités du jour" section; Menu par jour shows
  // the plat du jour as a badge on today's dishes instead.
  const specials = daily ? [] : todays.filter(m => m.is_daily_special)
  const nonSpecials = daily ? todays : todays.filter(m => !m.is_daily_special)
  // Categories match whatever the capitals ("Plats principaux" = "Plats Principaux").
  const catKey = (c: string | null | undefined) => (c ?? '').trim().toLowerCase()
  const uniqueCategories = Array.from(
    new Map(nonSpecials.filter(m => catKey(m.category)).map(m => [catKey(m.category), m.category.trim()])).values(),
  )
  const showCategoryTabs = uniqueCategories.length >= 2
  const categories = showCategoryTabs ? ['all', ...uniqueCategories] : []
  const filtered = activeCategory === 'all' ? nonSpecials : nonSpecials.filter(m => catKey(m.category) === catKey(activeCategory))
  const getItemQty = (itemId: string) => items.find(i => i.id === itemId)?.quantity ?? 0
  const add = (item: MenuItem) => addItem({ id: item.id, name: item.name, price: item.price, quantity: 1, photo_url: item.photo_url }, id, restaurant?.name)

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
          <Link href="/restaurants" className="text-brand-dark underline">{t('menu.goBack')}</Link>
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
          <Link href="/restaurants" className="text-brand-dark underline">{t('menu.goBack')}</Link>
        </div>
      </div>
    )
  }

  const isOpen = openInfo?.open ?? restaurant.is_open
  const statusLine = isOpen
    ? (openInfo?.next_kind === 'closes' && openInfo.next_at
        ? bi(`Ouvert jusqu'à ${openInfo.next_at}`, `Open until ${openInfo.next_at}`)
        : bi('Ouvert', 'Open'))
    : bi('Fermé', 'Closed')

  const canOrder = takesOrders(restaurant)
  const delivers = deliversNow(restaurant)
  const waNumber = (restaurant.whatsapp || restaurant.phone || '').replace(/\D/g, '')
  const callNumber = (restaurant.phone || restaurant.whatsapp || '').replace(/[^\d+]/g, '')
  const waText = bi(`Bonjour ${restaurant.name}, je voudrais commander : `, `Hello ${restaurant.name}, I'd like to order: `)
  const isDelivery = delivers && fulfilment === 'delivery'
  const fee = freeDelivery ? 0 : Number(restaurant.delivery_fee ?? 0)
  const timeLabel = isDelivery
    ? formatDeliveryTime(restaurant.prep_time_min, restaurant.prep_time_max, restaurant.delivery_extra_min)
    : formatPrepTime(restaurant.prep_time_min, restaurant.prep_time_max)

  const pick = (f: Fulfilment) => { setFulfilment(f); rememberFulfilment(id, f) }

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />

      {/* Photo with ← and ⋯ */}
      <div className="relative h-52 md:h-64 bg-gradient-to-br from-brand-light to-brand-badge md:max-w-2xl md:mx-auto md:mt-4 md:rounded-2xl">
        <div className="absolute inset-0 md:rounded-2xl overflow-hidden">
          {(restaurant.image_url || restaurant.logo_url) ? (
            <Image src={(restaurant.image_url || restaurant.logo_url)!} alt={restaurant.name} fill className="object-cover" sizes="(min-width: 768px) 672px, 100vw" priority />
          ) : (
            <span className="absolute inset-0 flex items-center justify-center text-6xl" aria-hidden="true">🍽️</span>
          )}
        </div>
        <button
          onClick={() => router.back()}
          className="absolute top-4 left-4 bg-surface/95 backdrop-blur-sm rounded-full w-10 h-10 flex items-center justify-center text-ink-primary shadow-card hover:bg-surface transition-colors"
          aria-label={bi('Retour', 'Back')}
        >
          ←
        </button>
        <MoreMenu restaurantId={id} />
      </div>

      <div className="px-4 max-w-2xl mx-auto">
        <h1 className="text-2xl font-black text-ink-primary leading-tight mt-4">{restaurant.name}</h1>
        <p className="text-sm text-ink-secondary mt-0.5">
          {[restaurant.cuisine_type, restaurant.neighborhood].filter(Boolean).join(' · ')}
        </p>
        <p className={`text-sm font-semibold mt-1 ${isOpen ? 'text-green-700' : 'text-red-600'}`}>
          {isOpen ? '🟢' : '🔴'} {statusLine}
          <Link href={`/restaurant/${id}/info`} className="ml-2 font-normal text-ink-tertiary underline">
            {bi('Infos', 'Info')}
          </Link>
        </p>

        {/* Vitrine (no Commandes module): order straight with the restaurant. */}
        {!canOrder && (waNumber || callNumber) && (
          <div className="mt-4 grid grid-cols-1 gap-2">
            {waNumber && (
              <a href={`https://wa.me/${waNumber}?text=${encodeURIComponent(waText)}`} target="_blank" rel="noopener noreferrer"
                className={`flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white py-3 rounded-full font-semibold text-sm transition-colors`}>
                💬 {bi('Commander par WhatsApp', 'Order on WhatsApp')}
              </a>
            )}
            {callNumber && (
              <a href={`tel:${callNumber}`}
                className={`flex items-center justify-center gap-2 bg-surface border border-divider hover:bg-surface-muted text-ink-primary py-3 rounded-full font-semibold text-sm transition-colors`}>
                📞 {bi('Appeler', 'Call')}
              </a>
            )}
          </div>
        )}

        {/* Livraison | À emporter — only when the restaurant delivers. */}
        {canOrder && delivers && (
          <div className="mt-4 grid grid-cols-2 gap-1 bg-surface-muted rounded-full p-1" role="radiogroup" aria-label={bi('Mode de retrait', 'Fulfilment')}>
            {(['delivery', 'pickup'] as const).map(f => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={fulfilment === f}
                onClick={() => pick(f)}
                className={`py-2 rounded-full text-sm font-semibold transition-colors ${
                  fulfilment === f ? 'bg-surface text-ink-primary shadow-sm' : 'text-ink-secondary hover:text-ink-primary'
                }`}
              >
                {f === 'delivery' ? bi('Livraison', 'Delivery') : bi('À emporter', 'Take-away')}
              </button>
            ))}
          </div>
        )}

        {/* Two boxes: fee and time. */}
        {canOrder && <div className="mt-3 grid grid-cols-2 gap-3">
          <InfoBox
            value={isDelivery ? (fee > 0 ? formatFCFA(fee) : bi('Offerte', 'Free')) : bi('Sans frais', 'No fee')}
            label={isDelivery ? bi('Frais de livraison', 'Delivery fee') : bi('À emporter', 'Take-away')}
            highlight={isDelivery && fee === 0}
          />
          <InfoBox
            value={timeLabel ?? '—'}
            label={isDelivery ? bi('Livraison', 'Delivery time') : bi('Prêt en', 'Ready in')}
          />
        </div>}

        <div className="mt-4">
          <BannerAd city={restaurant.city} />
        </div>
      </div>

      {/* Sticky categories — only when the menu spans ≥2 of them. */}
      {showCategoryTabs && (
        <div className="sticky top-12 md:top-14 z-10 bg-surface border-b border-divider mt-4">
          <div className="max-w-2xl mx-auto flex gap-2 px-4 py-3 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {categories.map(cat => {
              const active = activeCategory === cat
              return (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={`flex-shrink-0 px-4 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap transition-colors ${
                    active ? 'bg-ink-primary text-white' : 'bg-surface-muted text-ink-secondary hover:text-ink-primary'
                  }`}
                >
                  {cat === 'all' ? t('menu.all') : cat.charAt(0).toUpperCase() + cat.slice(1)}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="px-4 pb-40 md:pb-32 max-w-2xl mx-auto">
        {specials.length > 0 && activeCategory === 'all' && (
          <section className="mt-6">
            <h2 className="text-lg font-bold text-ink-primary">⭐ {t('menu.specials')}</h2>
            <div className="divide-y divide-divider">
              {specials.map(item => (
                <DishRow key={item.id} item={item} qty={getItemQty(item.id)} onAdd={canOrder ? () => add(item) : undefined}
                  addLabel={bi(`Ajouter ${item.name}`, `Add ${item.name}`)} />
              ))}
            </div>
          </section>
        )}

        {filtered.length > 0 && (
          <section className="mt-6">
            {activeCategory === 'all' && specials.length > 0 && (
              <h2 className="text-lg font-bold text-ink-primary">{t('menu.menu')}</h2>
            )}
            <div className="divide-y divide-divider">
              {filtered.map(item => (
                <DishRow key={item.id} item={item} qty={getItemQty(item.id)} onAdd={canOrder ? () => add(item) : undefined}
                  addLabel={bi(`Ajouter ${item.name}`, `Add ${item.name}`)}
                  badge={daily && item.is_daily_special ? bi('⭐ Plat du jour', '⭐ Dish of the day') : undefined} />
              ))}
            </div>
          </section>
        )}

        {daily && todays.length === 0 && otherDays.length > 0 && (
          <p className="mt-6 text-sm text-ink-secondary text-center">{bi('Aucun plat aujourd\'hui.', 'No dish today.')}</p>
        )}

        {/* Menu par jour: the dishes of other days, greyed, no "+". */}
        {otherDays.length > 0 && activeCategory === 'all' && (
          <section className="mt-8" aria-labelledby="other-days">
            <h2 id="other-days" className="text-lg font-bold text-ink-secondary">{bi('Autres jours', 'Other days')}</h2>
            <div className="divide-y divide-divider opacity-60">
              {otherDays.map(item => (
                <DishRow key={item.id} item={item} qty={0} addLabel=""
                  note={availableOnText(servedDays(item, 'daily'), locale === 'fr' ? 'fr' : 'en')} />
              ))}
            </div>
          </section>
        )}

        {menuItems.length === 0 && (
          <div className="text-center py-16 text-ink-tertiary">
            <div className="text-4xl mb-3">🍽️</div>
            <p className="text-sm">{t('menu.noItems')}</p>
          </div>
        )}

        <div className="mt-8">
          <ReportButton targetType="restaurant" targetId={id} label={bi('Signaler ce restaurant', 'Report this restaurant')} />
        </div>
      </div>

      {/* Floating cart — above the mobile BottomNav. */}
      {canOrder && totalItems > 0 && (
        <div className="fixed left-4 right-4 max-w-xl mx-auto z-20 bottom-20 md:bottom-4">
          <Link
            href="/order"
            className="flex items-center justify-between bg-brand hover:bg-brand-dark text-white px-5 py-4 rounded-full shadow-card transition-colors"
          >
            <span className="bg-white/25 rounded-full px-2 py-0.5 text-sm font-bold min-w-7 text-center">{totalItems}</span>
            <span className="font-semibold text-sm">{t('menu.viewCart')}</span>
            <span className="font-semibold">{formatFCFA(totalPrice)}</span>
          </Link>
        </div>
      )}
    </div>
  )
}

function InfoBox({ value, label, highlight }: { value: string; label: string; highlight?: boolean }) {
  return (
    <div className="border border-divider rounded-2xl px-4 py-3">
      <p className={`text-base font-bold ${highlight ? 'text-brand-dark' : 'text-ink-primary'}`}>{value}</p>
      <p className="text-xs text-ink-tertiary">{label}</p>
    </div>
  )
}

// ⋯ on the photo: favourites and restaurant info.
function MoreMenu({ restaurantId }: { restaurantId: string }) {
  const bi = useBi()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [favorite, setFavorite] = useState<boolean | null>(null) // null = logged out / unknown
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/customer/favorites?restaurant_id=${restaurantId}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d) setFavorite(!!d.favorite) })
      .catch(() => null)
    return () => { cancelled = true }
  }, [restaurantId])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])

  async function toggleFavorite() {
    if (favorite === null) { router.push(loginHref(`/restaurant/${restaurantId}`)); return }
    setBusy(true)
    try {
      const res = favorite
        ? await fetch(`/api/customer/favorites?restaurant_id=${restaurantId}`, { method: 'DELETE' })
        : await fetch('/api/customer/favorites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ restaurant_id: restaurantId }) })
      if (res.status === 401) { router.push(loginHref(`/restaurant/${restaurantId}`)); return }
      if (res.ok) setFavorite(!favorite)
    } finally {
      setBusy(false)
      setOpen(false)
    }
  }

  return (
    <div ref={ref} className="absolute top-4 right-4">
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={bi('Plus d\'options', 'More options')}
        aria-expanded={open}
        className="bg-surface/95 backdrop-blur-sm rounded-full w-10 h-10 flex items-center justify-center text-ink-primary text-lg font-bold shadow-card hover:bg-surface transition-colors"
      >
        ⋯
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-2 w-60 bg-surface rounded-2xl shadow-card border border-divider overflow-hidden z-30">
          <button role="menuitem" onClick={toggleFavorite} disabled={busy}
            className="w-full text-left px-4 py-3 text-sm text-ink-primary hover:bg-surface-muted flex items-center gap-3">
            <span aria-hidden="true">{favorite ? '♥' : '♡'}</span>
            {favorite ? bi('Retirer des favoris', 'Remove from favourites') : bi('Ajouter aux favoris', 'Add to favourites')}
          </button>
          <Link role="menuitem" href={`/restaurant/${restaurantId}/info`}
            className="w-full px-4 py-3 text-sm text-ink-primary hover:bg-surface-muted flex items-center gap-3 border-t border-divider">
            <span aria-hidden="true">ℹ️</span>
            {bi('Infos du restaurant', 'Restaurant info')}
          </Link>
        </div>
      )}
    </div>
  )
}

// One dish: text on the left, photo on the right with "+" on it.
// No onAdd (Vitrine, other days): the photo has no "+". `badge` (plat du
// jour) and `note` ("Disponible le samedi") show under the name.
function DishRow({ item, qty, onAdd, addLabel, badge, note }: { item: MenuItem; qty: number; onAdd?: () => void; addLabel: string; badge?: string; note?: string }) {
  return (
    <div className="flex gap-3 py-4">
      <div className="flex-1 min-w-0">
        <h3 className="font-semibold text-ink-primary text-[15px] leading-tight">{item.name}</h3>
        {badge && <span className="inline-block mt-1 text-[11px] font-bold text-brand-darker bg-brand-light px-2 py-0.5 rounded-full">{badge}</span>}
        {note && <p className="mt-1 text-xs font-semibold text-ink-secondary">{note}</p>}
        <p className="mt-1 flex items-baseline gap-1.5 flex-wrap text-sm">
          <span className="font-semibold text-ink-primary">{formatFCFA(item.price)}</span>
          {item.regular_price != null && (
            <>
              <span className="text-xs text-ink-tertiary line-through">{formatAmount(item.regular_price)}</span>
              <span className="text-[11px] font-bold text-white bg-brand rounded-full px-1.5 py-0.5">
                {percentOffLabel(item.regular_price, item.price)}
              </span>
            </>
          )}
        </p>
        {item.description && <p className="text-xs text-ink-secondary mt-1 line-clamp-2">{item.description}</p>}
      </div>
      <div className="relative w-28 h-28 flex-shrink-0 rounded-xl overflow-hidden bg-brand-light">
        {item.photo_url
          ? <Image src={item.photo_url} alt={item.name} fill className="object-cover" sizes="112px" />
          : <span className="absolute inset-0 flex items-center justify-center text-3xl" aria-hidden="true">🍽️</span>}
        {onAdd && <button
          onClick={onAdd}
          aria-label={addLabel}
          className={`absolute bottom-1.5 right-1.5 min-w-9 h-9 px-2 rounded-full shadow-card flex items-center justify-center text-lg font-bold transition-colors ${
            qty > 0 ? 'bg-ink-primary text-white text-sm' : 'bg-surface text-ink-primary hover:bg-surface-muted'
          }`}
        >
          {qty > 0 ? qty : '+'}
        </button>}
      </div>
    </div>
  )
}
