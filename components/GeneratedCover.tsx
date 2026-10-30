// Generated cover (I1): for a listing with no photo (admin-managed
// restaurants, events and places), a branded cover drawn with CSS only —
// Tchop & Ndjoka colours, the name, the area, the category. No image file,
// no fake food photo, nothing to download (fine in low-data mode). A real
// photo replaces it as soon as one is uploaded.

const ICON: Record<string, string> = { restaurant: '🍽️', event: '🎉', place: '📍' }

export default function GeneratedCover({ kind, title, area, category, size = 'card', className = '' }: {
  kind: 'restaurant' | 'event' | 'place'
  title: string
  area?: string | null
  category?: string | null
  size?: 'card' | 'hero'
  className?: string
}) {
  const hero = size === 'hero'
  return (
    <div className={`absolute inset-0 overflow-hidden bg-gradient-to-br from-brand via-brand-dark to-brand-darker text-white ${className}`} aria-hidden="true">
      {/* soft dots — the brand texture */}
      <div className="absolute inset-0 opacity-15 [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:14px_14px]" />
      <span className={`absolute ${hero ? 'right-6 top-5 text-6xl' : 'right-2.5 top-2 text-2xl'} opacity-25`}>{ICON[kind]}</span>
      <div className={`absolute inset-x-0 bottom-0 ${hero ? 'p-6' : 'p-2.5'}`}>
        {category && hero && <p className="text-xs font-bold uppercase tracking-wider opacity-80">{category}</p>}
        <p className={`${hero ? 'text-3xl' : 'text-sm'} font-black leading-tight line-clamp-2 drop-shadow-sm`}>{title}</p>
        {area && <p className={`${hero ? 'text-sm mt-1' : 'text-[11px]'} opacity-90 truncate`}>📍 {area}</p>}
        <p className={`${hero ? 'text-[11px] mt-2' : 'text-[8px] mt-0.5'} font-semibold tracking-widest opacity-60`}>TCHOP &amp; NDJOKA</p>
      </div>
    </div>
  )
}
