'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useBi } from '@/lib/languageContext'
import { useMode } from '@/lib/modeContext'

// ModeToggle — the single source for switching between Client and Restaurant
// modes. Lives on the /account page (top banner + profile tab). Pure
// customers and admins don't see it because `hasRestaurantRole` stays false
// for them.
//
// Variant controls the visual treatment:
//   - "banner"  — a prominent full-width card with help text; used at the
//                 top of /account so vendors can't miss it.
//   - "compact" — a thin two-option switch for use inside the profile tab.
export default function ModeToggle({ variant = 'compact' }: { variant?: 'banner' | 'compact' }) {
  const { mode, setMode, hasRestaurantRole, loading } = useMode()
  const router   = useRouter()
  const pathname = usePathname() ?? ''
  const bi       = useBi()

  if (loading || !hasRestaurantRole) return null

  function switchTo(next: 'client' | 'restaurant') {
    if (next === mode) return
    setMode(next)
    // Navigate to the mode's home. Skip if we're already on a matching
    // surface — deep links (e.g. /dashboard/menu) shouldn't bounce.
    if (next === 'restaurant' && !pathname.startsWith('/dashboard')) {
      router.push('/dashboard')
    } else if (next === 'client' && pathname.startsWith('/dashboard')) {
      router.push('/')
    }
  }

  if (variant === 'banner') {
    return (
      <div className="bg-white rounded-2xl shadow-sm p-4 mb-4 border border-divider">
        <p className="text-xs text-ink-tertiary font-semibold mb-1">
          {bi('Mode actuel', 'Current mode')}
        </p>
        <p className="text-sm text-ink-secondary mb-3">
          {mode === 'restaurant'
            ? bi(
                'Vous gérez votre restaurant. Passez en mode Client pour commander.',
                'You\'re managing your restaurant. Switch to Client to order food.',
              )
            : bi(
                'Vous parcourez en tant que client. Passez en mode Restaurant pour gérer votre équipe.',
                'You\'re browsing as a customer. Switch to Restaurant to manage your team.',
              )}
        </p>
        <SegmentedToggle mode={mode} onChange={switchTo} size="lg" bi={bi} />
      </div>
    )
  }

  return <SegmentedToggle mode={mode} onChange={switchTo} size="sm" bi={bi} />
}

function SegmentedToggle({
  mode, onChange, size, bi,
}: {
  mode: 'client' | 'restaurant'
  onChange: (m: 'client' | 'restaurant') => void
  size: 'sm' | 'lg'
  bi: (fr: string, en: string) => string
}) {
  const pad = size === 'lg' ? 'px-4 py-2.5 text-sm' : 'px-3 py-1.5 text-xs'
  return (
    <div className="inline-flex bg-surface-muted rounded-full p-1 w-full">
      <ToggleOption
        active={mode === 'client'}
        onClick={() => onChange('client')}
        pad={pad}
        label={bi('🍽️ Client', '🍽️ Client')}
      />
      <ToggleOption
        active={mode === 'restaurant'}
        onClick={() => onChange('restaurant')}
        pad={pad}
        label={bi('🏪 Restaurant', '🏪 Restaurant')}
      />
    </div>
  )
}

function ToggleOption({
  active, onClick, pad, label,
}: {
  active: boolean
  onClick: () => void
  pad: string
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 rounded-full font-semibold transition-all ${pad} ${
        active ? 'bg-brand text-white shadow-sm' : 'text-ink-secondary hover:text-ink-primary'
      }`}
    >
      {label}
    </button>
  )
}
