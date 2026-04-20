'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useBi } from '@/lib/languageContext'
import { useMode } from '@/lib/modeContext'

// Slim bar shown just below the TopNav for users with a restaurant_team
// entry. Flipping the toggle persists the choice via ModeContext and
// navigates to the matching home — /dashboard for restaurant mode, / for
// client mode. Pure customers and admins don't see this bar (the provider
// sets hasRestaurantRole=false for them).
export default function ModeSwitcher() {
  const { mode, setMode, hasRestaurantRole, loading } = useMode()
  const router   = useRouter()
  const pathname = usePathname() ?? ''
  const bi       = useBi()

  if (loading || !hasRestaurantRole) return null

  function switchTo(next: 'client' | 'restaurant') {
    if (next === mode) return
    setMode(next)
    // Navigate to the matching surface so the switch always lands the user
    // somewhere useful. Skip the navigation if they're already on the right
    // route (e.g. /dashboard/settings shouldn't bounce to /dashboard).
    if (next === 'restaurant' && !pathname.startsWith('/dashboard')) {
      router.push('/dashboard')
    } else if (next === 'client' && pathname.startsWith('/dashboard')) {
      router.push('/')
    }
  }

  return (
    <div className="sticky top-14 z-20 bg-surface border-b border-divider">
      <div className="max-w-6xl mx-auto px-3 sm:px-4 py-2 flex justify-center">
        <div className="inline-flex rounded-full bg-surface-muted p-1 text-xs font-semibold shadow-inner overflow-hidden">
          <ModePill
            active={mode === 'client'}
            onClick={() => switchTo('client')}
            label={bi('🍽️ Client', '🍽️ Client')}
          />
          <ModePill
            active={mode === 'restaurant'}
            onClick={() => switchTo('restaurant')}
            label={bi('🏪 Restaurant', '🏪 Restaurant')}
          />
        </div>
      </div>
    </div>
  )
}

function ModePill({
  active, onClick, label,
}: {
  active: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-4 py-1.5 rounded-full transition-all duration-200 ${
        active
          ? 'bg-brand text-white shadow-sm'
          : 'text-ink-secondary hover:text-ink-primary'
      }`}
    >
      {label}
    </button>
  )
}
