'use client'

// The admin top bar, phone and desktop: logo · as many menu items as fit on
// one line (in lib/adminNav ADMIN_TABS order, the role's items only) · ⋯ with
// the rest · FR/EN · Déconnexion. Measured live (ResizeObserver), so nothing
// ever overflows; on a phone most items are under ⋯. Super-admin-only items
// stay hidden for other admins (visibleAdminTabs).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useBi, pickBi, useLanguage } from '@/lib/languageContext'
import { visibleAdminTabs, ADMIN_TAB_ICONS, ADMIN_TAB_LABELS, type AdminSubTab } from '@/lib/adminNav'
import LanguageToggle from '@/components/LanguageToggle'

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect
const MORE_W = 44, GAP = 4

export default function AdminBar({ role, current, onSelect, extra }: {
  role: string | null | undefined
  /** The open panel (null off /account). */
  current: AdminSubTab | null
  onSelect: (t: AdminSubTab) => void
  /** Small indicators before FR/EN (e.g. Mode économique). */
  extra?: React.ReactNode
}) {
  const bi = useBi()
  const { locale } = useLanguage()
  const tabs = visibleAdminTabs(role)
  const navRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState(tabs.length)

  const measure = useCallback(() => {
    const nav = navRef.current, m = measureRef.current
    if (!nav || !m) return
    const widths = Array.from(m.children).map(c => (c as HTMLElement).offsetWidth)
    const avail = nav.clientWidth
    let used = 0, n = 0
    for (let i = 0; i < widths.length; i++) {
      const rest = i < widths.length - 1 ? MORE_W + GAP : 0
      if (used + widths[i] + rest > avail) break
      used += widths[i] + GAP; n++
    }
    setFit(n)
  }, [])
  useIsoLayoutEffect(() => {
    measure()
    if (typeof ResizeObserver === 'undefined' || !navRef.current) return
    const ro = new ResizeObserver(measure)
    ro.observe(navRef.current)
    return () => ro.disconnect()
  }, [measure, tabs.length, locale])

  const shown = tabs.slice(0, fit)
  const more = tabs.slice(fit)
  async function signOut() {
    try { await fetch('/api/auth/logout', { method: 'POST' }) } catch { /* leave anyway */ }
    window.location.href = '/admin/login'
  }
  const item = (tab: AdminSubTab, active: boolean) =>
    `px-2.5 md:px-3 py-1.5 rounded-full text-[13px] md:text-sm font-semibold whitespace-nowrap transition-colors ${active ? 'bg-brand-light text-brand-darker' : 'text-ink-secondary hover:text-ink-primary hover:bg-surface-muted'}`

  return (
    <div className="max-w-5xl mx-auto px-2 sm:px-4 h-12 md:h-14 flex items-center gap-1.5 sm:gap-3">
      <Link href="/account" className="flex items-center gap-1 flex-shrink-0" aria-label="Tchop &amp; Ndjoka — admin console">
        <span className="text-brand font-black tracking-tight text-lg sm:text-xl">T&amp;N</span>
      </Link>

      <nav ref={navRef} className="relative flex-1 min-w-0 flex items-center gap-1" aria-label={bi('Navigation administration', 'Admin navigation')}>
        {/* Off-screen copy, to measure each item's width. */}
        <div aria-hidden="true" className="absolute inset-0 overflow-hidden invisible pointer-events-none">
          <div ref={measureRef} className="flex gap-1 w-max">
            {tabs.map(t => <span key={t} className={item(t, false)}>{ADMIN_TAB_ICONS[t]} {pickBi(ADMIN_TAB_LABELS[t], locale)}</span>)}
          </div>
        </div>
        {shown.map(t => (
          <button key={t} type="button" onClick={() => onSelect(t)} className={item(t, current === t)} aria-current={current === t ? 'page' : undefined}>
            {ADMIN_TAB_ICONS[t]} {pickBi(ADMIN_TAB_LABELS[t], locale)}
          </button>
        ))}
        {more.length > 0 && <MoreMenu tabs={more} current={current} onSelect={onSelect} label={bi('Plus', 'More')} />}
      </nav>

      <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
        {extra}
        <LanguageToggle />
        <button type="button" onClick={signOut} title={bi('Déconnexion', 'Log out')} aria-label={bi('Déconnexion', 'Log out')}
          className="h-9 px-2.5 rounded-full text-sm font-semibold text-ink-secondary hover:text-danger hover:bg-surface-muted flex items-center gap-1">
          <span aria-hidden="true">⎋</span><span className="hidden lg:inline">{bi('Déconnexion', 'Log out')}</span>
        </button>
      </div>
    </div>
  )
}

function MoreMenu({ tabs, current, onSelect, label }: { tabs: AdminSubTab[]; current: AdminSubTab | null; onSelect: (t: AdminSubTab) => void; label: string }) {
  const { locale } = useLanguage()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])
  const inside = current != null && tabs.includes(current)
  return (
    <div ref={rootRef} className="relative flex-shrink-0">
      <button type="button" onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label}
        className={`w-10 h-9 rounded-full text-base font-bold ${inside || open ? 'bg-brand-light text-brand-darker' : 'text-ink-secondary hover:bg-surface-muted'}`}>⋯</button>
      {open && (
        <div role="menu" className="absolute top-full mt-2 right-0 md:left-0 md:right-auto min-w-[14rem] max-h-[70vh] overflow-y-auto bg-surface border border-divider rounded-2xl shadow-card py-1 z-50">
          {tabs.map(t => (
            <button key={t} role="menuitem" type="button" onClick={() => { onSelect(t); setOpen(false) }}
              className={`w-full text-left px-4 py-2 text-sm flex items-center gap-2 ${t === current ? 'bg-brand-light text-brand-darker font-semibold' : 'text-ink-primary hover:bg-surface-muted'}`}>
              <span aria-hidden="true">{ADMIN_TAB_ICONS[t]}</span>
              <span className="flex-1">{pickBi(ADMIN_TAB_LABELS[t], locale)}</span>
              {t === current && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
