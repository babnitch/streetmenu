'use client'

import { Restaurant } from '@/types'
import Link from 'next/link'
import Image from 'next/image'
import { useLanguage } from '@/lib/languageContext'

interface Props {
  restaurant: Restaurant
  onClose: () => void
}

export default function RestaurantSidebar({ restaurant, onClose }: Props) {
  const { t } = useLanguage()

  return (
    <div className="flex flex-col h-full">
      {/* Header image / logo */}
      <div className="relative h-40 bg-gradient-to-br from-orange-400 to-orange-600 flex-shrink-0">
        {restaurant.logo_url ? (
          <Image
            src={restaurant.logo_url}
            alt={restaurant.name}
            fill
            className="object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-6xl">🍽️</span>
          </div>
        )}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 bg-white/90 backdrop-blur-sm rounded-full w-8 h-8 flex items-center justify-center text-gray-600 hover:bg-white shadow-md transition-colors"
        >
          ✕
        </button>
        <div className="absolute bottom-3 left-3">
          <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
            restaurant.is_open
              ? 'bg-green-500 text-white'
              : 'bg-gray-500 text-white'
          }`}>
            {restaurant.is_open ? t('sidebar.openNow') : t('sidebar.closed')}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 p-4 overflow-y-auto">
        <h2 className="text-xl font-bold text-gray-900 mb-1">{restaurant.name}</h2>
        <p className="text-sm text-gray-500 flex items-center gap-1 mb-3">
          <span>📍</span> {restaurant.address}
        </p>
        {restaurant.description && (
          <p className="text-sm text-gray-600 leading-relaxed mb-4">{restaurant.description}</p>
        )}

        {restaurant.phone && (
          <a
            href={`tel:${restaurant.phone}`}
            className="flex items-center gap-2 text-sm text-gray-600 mb-2 hover:text-orange-500 transition-colors"
          >
            <span>📞</span> {restaurant.phone}
          </a>
        )}

        {restaurant.whatsapp && (
          <a
            href={`https://wa.me/${restaurant.whatsapp.replace(/\D/g, '')}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm text-green-600 mb-4 hover:text-green-700 transition-colors"
          >
            <span>💬</span> {t('sidebar.whatsapp')}
          </a>
        )}
      </div>

      {/* CTA */}
      <div className="p-4 border-t border-orange-100 flex-shrink-0">
        <Link
          href={`/restaurant/${restaurant.id}`}
          className="block w-full bg-orange-500 hover:bg-orange-600 text-white text-center py-3 rounded-xl font-semibold shadow-md shadow-orange-200 transition-colors"
        >
          {t('sidebar.viewMenu')}
        </Link>
      </div>
    </div>
  )
}
