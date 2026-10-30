'use client'

// The credit on a photo from Wikimedia Commons (or elsewhere): "Photo :
// {author}, {licence}, via Wikimedia Commons", linked to the file page.
// Rendered only together with the photo (so hidden in Mode économique).

import { useBi } from '@/lib/languageContext'

export default function PhotoCredit({ credit, url, compact = false }: { credit: string | null | undefined; url: string | null | undefined; compact?: boolean }) {
  const bi = useBi()
  if (!credit) return null
  const commons = !!url && /commons\.wikimedia\.org/.test(url)
  const text = `${bi('Photo', 'Photo')} : ${credit}${commons ? ', via Wikimedia Commons' : ''}`
  const cls = `absolute bottom-0 right-0 max-w-full truncate bg-black/55 text-white ${compact ? 'text-[9px] px-1.5 py-0.5 rounded-tl-md' : 'text-[11px] px-2 py-1 rounded-tl-lg'}`
  // On a card (itself a link) the credit is plain text; on the page, a link.
  return url && !compact
    ? <a href={url} target="_blank" rel="noopener noreferrer" className={`${cls} hover:underline`} title={text}>{text}</a>
    : <span className={cls} title={text}>{text}</span>
}
