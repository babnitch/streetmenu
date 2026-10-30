'use client'

// A place card (I4): its photo, or the generated cover; the category pill
// (U4 style); the title and the area.

import Link from 'next/link'
import Image from 'next/image'
import { useLanguage } from '@/lib/languageContext'
import { useDataMode } from '@/lib/dataMode'
import { pick, placeCategoryLabel, type PublicPlace } from '@/lib/places'
import GeneratedCover from '@/components/GeneratedCover'
import CardTag from '@/components/CardTag'
import PhotoCredit from '@/components/PhotoCredit'
import { CompactRow, dot } from '@/components/CompactRow'
import { placeCategory } from '@/lib/places'

export default function PlaceCard({ place, compact = false }: { place: PublicPlace; compact?: boolean }) {
  const { locale } = useLanguage()
  const { isLowData } = useDataMode()
  const title = pick(place, 'title', locale)
  // Mode économique: a text row (category · price), no photo.
  if (isLowData) {
    return <CompactRow href={`/lieux/${place.id}`} icon={placeCategory(place.category)?.icon ?? '🏛️'} title={title}
      line={dot(place.area, placeCategoryLabel(place.category, locale), place.price)} />
  }
  return (
    <Link href={`/lieux/${place.id}`} className={`group block bg-white rounded-2xl border border-divider overflow-hidden shadow-sm hover:shadow-md transition-shadow ${compact ? 'w-44 flex-shrink-0 snap-start' : ''}`}>
      <div className={`relative ${compact ? 'h-28' : 'aspect-[16/9]'} bg-surface-muted`}>
        {place.cover_url && !isLowData
          ? <><Image src={place.cover_url} alt="" fill sizes={compact ? '176px' : '(max-width: 768px) 100vw, 50vw'} className="object-cover" />
              <PhotoCredit credit={place.photo_credit} url={place.photo_credit_url} compact /></>
          : <GeneratedCover kind="place" title={title} area={place.area} />}
        <CardTag label={placeCategoryLabel(place.category, locale)} />
      </div>
      <div className="px-3 py-2">
        <p className="text-sm font-semibold text-ink-primary line-clamp-2">{title}</p>
        {place.area && <p className="text-[11px] text-ink-tertiary truncate">📍 {place.area}</p>}
      </div>
    </Link>
  )
}
