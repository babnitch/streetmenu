'use client'

import Image from 'next/image'
import { useDataMode } from '@/lib/dataMode'

// An event poster in a portrait frame (4:5 by default — the recommended
// 1080 × 1350 upload). Any image shape fits whole: it is shown "contained"
// over a blurred, cropped copy of itself, so older 16:9 covers are not cut.
// No image (or low-data mode): a branded placeholder with the category's
// emoji and the event name.

export const CATEGORY_EMOJI: Record<string, string> = {
  Concert: '🎵', Festival: '🎪', 'BT/Club': '🪩', Sport: '⚽', Culture: '🎭',
  Gastronomie: '🍲', Enfants: '🧸', Business: '💼', Autre: '🎉',
}

export default function EventPoster({
  src, title, category, sizes = '(max-width: 768px) 50vw, 300px', className = '', rounded = 'rounded-2xl', priority = false,
}: {
  src: string | null | undefined
  title: string
  category?: string | null
  sizes?: string
  className?: string
  rounded?: string
  priority?: boolean
}) {
  const { isLowData } = useDataMode()
  const emoji = CATEGORY_EMOJI[category ?? ''] ?? '🎉'
  const show = !!src && !isLowData

  return (
    <div className={`relative overflow-hidden ${rounded} bg-gradient-to-br from-brand to-brand-darker ${className}`}>
      {show ? (
        <>
          <Image src={src!} alt="" fill sizes={sizes} className="object-cover scale-110 blur-xl opacity-60" aria-hidden="true" />
          <Image src={src!} alt={title} fill sizes={sizes} className="object-contain" priority={priority} />
        </>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center p-3 text-center text-white">
          <span className="text-4xl mb-2" aria-hidden="true">{emoji}</span>
          <span className="text-sm font-bold leading-tight line-clamp-3 drop-shadow">{title}</span>
          <span className="absolute bottom-2 text-[10px] font-semibold opacity-80 tracking-wide">TCHOP &amp; NDJOKA</span>
        </div>
      )}
    </div>
  )
}
