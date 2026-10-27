'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useBi } from '@/lib/languageContext'
import { useMode, type Mode } from '@/lib/modeContext'

// ModeToggle — THE switcher for Client ⇄ Pro, for every logged-in customer
// (admins and logged-out visitors don't see it: `canEnterPro` is false).
// It lives on the Account page only (mobile row, desktop banner).
//
// Switching NAVIGATES to the mode's home:
//   - Pro → Orders (/dashboard) with a restaurant, else My events when the
//     user organises events, else the Pro home (/pro);
//   - Client → /.
// Flipping in place was the old bug: from /account the mode changed and the
// user stayed on a page that hadn't moved.
//
// Variants:
//   - "banner"  — a full-width card with help text; the desktop profile tab.
//   - "row"     — a MenuRow-shaped list item; the mobile account menu.
//   - "compact" — a two-option switch, full width.
export default function ModeToggle({ variant = 'compact' }: { variant?: 'banner' | 'row' | 'compact' }) {
  const { effectiveMode, setMode, canEnterPro, hasRestaurantRole, loading, setDashboardTab } = useMode()
  const router   = useRouter()
  const pathname = usePathname() ?? ''
  const bi       = useBi()

  if (loading || !canEnterPro) return null
  const mode = effectiveMode

  async function switchTo(next: Mode) {
    if (next === mode) return
    setMode(next)

    if (next === 'client') {
      if (pathname !== '/') router.push('/')
      return
    }
    if (hasRestaurantRole) {
      // Set the tab either way: on /dashboard this IS the visible effect of
      // the switch, and Next skips a re-render for a same-route push.
      setDashboardTab('orders')
      if (!pathname.startsWith('/dashboard')) router.push('/dashboard')
      return
    }
    // No restaurant: My events when there are some, else the Pro home.
    let hasEvents = false
    try {
      const r = await fetch('/api/events/my', { cache: 'no-store' })
      const d = await r.json()
      hasEvents = Array.isArray(d?.events) && d.events.length > 0
    } catch { /* fall through to the Pro home */ }
    router.push(hasEvents ? '/pro/events' : '/pro')
  }

  if (variant === 'banner') {
    return (
      <div className="bg-white rounded-2xl shadow-sm p-4 mb-4 border border-divider">
        <p className="text-xs text-ink-tertiary font-semibold mb-1">
          {bi('Mode actuel', 'Current mode')}
        </p>
        <p className="text-sm text-ink-secondary mb-3">
          {mode === 'pro'
            ? bi(
                'Vous êtes en mode Pro : vos restaurants et vos événements. Passez en mode Client pour commander.',
                'You\'re in Pro mode: your restaurants and events. Switch to Client to order food.',
              )
            : bi(
                'Vous parcourez en tant que client. Passez en mode Pro pour gérer vos restaurants et événements.',
                'You\'re browsing as a customer. Switch to Pro to manage your restaurants and events.',
              )}
        </p>
        <SegmentedToggle mode={mode} onChange={switchTo} size="lg" />
      </div>
    )
  }

  // Row variant — matches the MenuRow shape used by the mobile account menu
  // (icon well, label, description, chevron). One tap flips to the other mode.
  if (variant === 'row') {
    const toPro = mode !== 'pro'
    return (
      <button
        type="button"
        onClick={() => switchTo(toPro ? 'pro' : 'client')}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-brand-light"
      >
        <span aria-hidden="true" className="text-xl leading-none w-7 text-center flex-shrink-0">
          {toPro ? '🧰' : '👤'}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold text-ink-primary truncate">
            {toPro
              ? bi('Passer en mode Pro', 'Switch to Pro mode')
              : bi('Passer en mode client', 'Switch to client mode')}
          </span>
          <span className="block text-xs text-ink-tertiary truncate">
            {toPro
              ? bi('Restaurants, événements, commandes', 'Restaurants, events, orders')
              : bi('Commander et parcourir les restaurants', 'Order food and browse restaurants')}
          </span>
        </span>
        <span aria-hidden="true" className="text-ink-tertiary text-lg flex-shrink-0">›</span>
      </button>
    )
  }

  return <SegmentedToggle mode={mode} onChange={switchTo} size="sm" />
}

function SegmentedToggle({
  mode, onChange, size,
}: {
  mode: Mode
  onChange: (m: Mode) => void
  size: 'sm' | 'lg'
}) {
  const pad = size === 'lg' ? 'px-4 py-2.5 text-sm' : 'px-3 py-1.5 text-xs'
  return (
    <div
      role="group"
      aria-label="Client / Pro"
      className="inline-flex bg-surface-muted rounded-full p-0.5 w-full"
    >
      <ToggleOption active={mode === 'client'} onClick={() => onChange('client')} pad={pad} label="Client" />
      <ToggleOption active={mode === 'pro'} onClick={() => onChange('pro')} pad={pad} label="Pro" />
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
