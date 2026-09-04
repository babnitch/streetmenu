'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useBi } from '@/lib/languageContext'
import { useMode } from '@/lib/modeContext'

// ModeToggle — THE switcher for Client ⇄ Restaurant. The /account page used
// to carry a second, in-place one as a menu row; this component is now the
// only implementation, rendered as a row on mobile and a banner in the
// desktop profile tab. Pure customers and admins don't see it because
// `hasRestaurantRole` stays false for them.
//
// Switching NAVIGATES to the mode's home — restaurant → /dashboard (orders),
// client → /. Flipping in place was the old bug: from /account neither
// branch below matched, so the mode changed and the user stayed put,
// looking at a page that hadn't moved.
//
// Variant controls the visual treatment:
//   - "banner"  — a full-width card with help text; the desktop profile tab.
//   - "row"     — a MenuRow-shaped list item; the mobile account menu.
//   - "compact" — a thin two-option switch.
export default function ModeToggle({ variant = 'compact' }: { variant?: 'banner' | 'row' | 'compact' }) {
  const { mode, setMode, hasRestaurantRole, loading, setDashboardTab } = useMode()
  const router   = useRouter()
  const pathname = usePathname() ?? ''
  const bi       = useBi()

  if (loading || !hasRestaurantRole) return null

  function switchTo(next: 'client' | 'restaurant') {
    if (next === mode) return
    setMode(next)

    // Navigate to the mode's home, but only when that would actually move
    // us. Being already on the destination is the one case where staying
    // put is correct — pushing the route we're on would be a redundant
    // navigation, and on '/' it costs a full feed refetch.
    if (next === 'restaurant') {
      // Set the tab either way: when we're already on /dashboard this IS
      // the visible effect of the switch, and Next skips a re-render for a
      // same-route push, so the tab must come from context (see navConfig).
      setDashboardTab('orders')
      if (!pathname.startsWith('/dashboard')) router.push('/dashboard')
    } else if (pathname !== '/') {
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

  // Row variant — matches the MenuRow shape used by the mobile account
  // menu (icon well, label, description, chevron) so it sits in that list
  // without looking like a transplant. One tap flips to the other mode;
  // there's only ever one other mode, so a segmented control would be two
  // controls for a binary choice.
  if (variant === 'row') {
    const toRestaurant = mode !== 'restaurant'
    return (
      <button
        type="button"
        onClick={() => switchTo(toRestaurant ? 'restaurant' : 'client')}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-brand-light"
      >
        <span aria-hidden="true" className="text-xl leading-none w-7 text-center flex-shrink-0">
          {toRestaurant ? '🏪' : '👤'}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold text-ink-primary truncate">
            {toRestaurant
              ? bi('Passer en mode restaurant', 'Switch to restaurant mode')
              : bi('Passer en mode client', 'Switch to client mode')}
          </span>
          <span className="block text-xs text-ink-tertiary truncate">
            {toRestaurant
              ? bi('Gérer commandes, menu et paramètres', 'Manage orders, menu and settings')
              : bi('Commander et parcourir les restaurants', 'Order food and browse restaurants')}
          </span>
        </span>
        <span aria-hidden="true" className="text-ink-tertiary text-lg flex-shrink-0">›</span>
      </button>
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
