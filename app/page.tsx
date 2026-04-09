'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import dynamicImport from 'next/dynamic'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { Restaurant } from '@/types'
import RestaurantSidebar from '@/components/RestaurantSidebar'
import { useCart } from '@/lib/cartContext'

const Map = dynamicImport(() => import('@/components/Map'), { ssr: false })

export default function HomePage() {
  const [restaurants, setRestaurants] = useState<Restaurant[]>([])
  const [selected, setSelected] = useState<Restaurant | null>(null)
  const [loading, setLoading] = useState(true)
  const { totalItems } = useCart()

  useEffect(() => {
    async function fetchRestaurants() {
      const { data } = await supabase.from('restaurants').select('*')
      if (data) setRestaurants(data)
      setLoading(false)
    }
    fetchRestaurants()
  }, [])

  const handleSelect = useCallback((r: Restaurant) => {
    setSelected(r)
  }, [])

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-orange-50">
      {/* Top Bar */}
      <div className="absolute top-0 left-0 right-0 z-20 pointer-events-none">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="bg-white/95 backdrop-blur-sm rounded-2xl px-4 py-2 shadow-lg pointer-events-auto">
            <h1 className="text-lg font-bold text-orange-500 tracking-tight">
              🍜 StreetMenu
            </h1>
          </div>
          <div className="flex items-center gap-2 pointer-events-auto">
            {totalItems > 0 && (
              <Link
                href="/order"
                className="bg-orange-500 text-white rounded-2xl px-4 py-2 shadow-lg flex items-center gap-2 font-semibold text-sm hover:bg-orange-600 transition-colors"
              >
                🛒 Cart ({totalItems})
              </Link>
            )}
            <Link
              href="/dashboard"
              className="bg-white/95 backdrop-blur-sm text-gray-600 rounded-2xl px-4 py-2 shadow-lg text-sm font-medium hover:bg-white transition-colors"
            >
              Dashboard
            </Link>
          </div>
        </div>
      </div>

      {/* Map */}
      <div className="absolute inset-0 z-0">
        {!loading && (
          <Map
            restaurants={restaurants}
            onSelectRestaurant={handleSelect}
            selectedId={selected?.id ?? null}
          />
        )}
        {loading && (
          <div className="w-full h-full flex items-center justify-center bg-orange-50">
            <div className="text-center">
              <div className="text-5xl mb-4 animate-bounce">🍜</div>
              <p className="text-orange-500 font-semibold">Loading restaurants...</p>
            </div>
          </div>
        )}
      </div>

      {/* Restaurant count badge */}
      {!loading && restaurants.length > 0 && !selected && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
          <div className="bg-white/95 backdrop-blur-sm rounded-full px-4 py-2 shadow-lg text-sm text-gray-600 font-medium">
            {restaurants.filter(r => r.is_open).length} open · {restaurants.length} restaurants nearby
          </div>
        </div>
      )}

      {/* Sidebar */}
      {selected && (
        <>
          {/* Backdrop on mobile */}
          <div
            className="fixed inset-0 z-30 bg-black/40 md:hidden"
            onClick={() => setSelected(null)}
          />
          <div className="fixed bottom-0 left-0 right-0 z-40 md:absolute md:top-16 md:left-4 md:bottom-4 md:right-auto md:w-80 bg-white rounded-t-3xl md:rounded-2xl shadow-2xl overflow-hidden">
            <div className="md:hidden w-12 h-1 bg-gray-200 rounded-full mx-auto mt-3 mb-1" />
            <div className="h-[70vh] md:h-full">
              <RestaurantSidebar
                restaurant={selected}
                onClose={() => setSelected(null)}
              />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
