// The category pill on a card's image (U4), top-left, same style everywhere
// (home, Restaurants, Loisirs): a restaurant's cuisine (Grillades,
// Camerounaise…), an event's category (Concert…), or "Offre / Deal". No
// label → nothing.

export default function CardTag({ label }: { label?: string | null }) {
  if (!label) return null
  return (
    <span className="absolute top-2 left-2 z-[1] max-w-[75%] truncate bg-white/95 text-ink-primary text-[11px] font-bold px-2 py-0.5 rounded-full shadow-sm leading-tight">
      {label}
    </span>
  )
}
