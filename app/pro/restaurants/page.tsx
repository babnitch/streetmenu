'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import TopNav from '@/components/TopNav'
import { proLoginHref } from '@/lib/lastPhone'
import { useBi, useLanguage } from '@/lib/languageContext'
import { useMode, type DashboardTab, type TeamRole } from '@/lib/modeContext'
import { restaurantToolsFor, toolLabel, type RestaurantTool } from '@/lib/navConfig'

interface Row { id: string; name: string; status?: string | null; city?: string | null }

// /pro/restaurants — "Mes restaurants": every restaurant the user is on the
// team of, its status, and its tools (lib/navConfig RESTAURANT_TOOLS, gated
// by the user's role in that restaurant).
export default function ProRestaurantsPage() {
  const bi = useBi()
  const { locale } = useLanguage()
  const router = useRouter()
  const { loading, canEnterPro, sessionRole, setDashboardTab } = useMode()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [roles, setRoles] = useState<Record<string, TeamRole>>({})


  useEffect(() => {
    if (!canEnterPro) return
    let cancelled = false
    fetch('/api/vendor/restaurants', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        setRows(Array.isArray(d?.restaurants) ? d.restaurants : [])
        setRoles((d?.rolesByRestaurantId ?? {}) as Record<string, TeamRole>)
      })
      .catch(() => { if (!cancelled) setRows([]) })
    return () => { cancelled = true }
  }, [canEnterPro])

  function openTool(restaurantId: string, tool: RestaurantTool) {
    if (tool.href) { router.push(tool.href); return }
    setDashboardTab(tool.key as DashboardTab)
    router.push(`/dashboard?restaurant=${restaurantId}`)
  }

  const statusBadge = (status?: string | null) =>
    status === 'pending'
      ? <span className="text-[11px] font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">{bi('En attente de validation', 'Awaiting approval')}</span>
      : status === 'suspended'
        ? <span className="text-[11px] font-semibold text-rose-700 bg-rose-50 px-2 py-0.5 rounded-full">{bi('Suspendu', 'Suspended')}</span>
        : <span className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full">{bi('Actif', 'Active')}</span>

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <main className="max-w-2xl mx-auto px-4 py-6 pb-28 md:pb-10">
        {loading || (canEnterPro && rows === null) ? (
          <div className="py-20 text-center text-4xl animate-bounce" aria-hidden="true">🏪</div>
        ) : !canEnterPro ? (
          <div className="bg-white rounded-2xl shadow-sm p-6 text-center">
            <h1 className="text-lg font-bold text-ink-primary mb-2">{bi('Mes restaurants', 'My restaurants')}</h1>
            {sessionRole ? (
              <p className="text-sm text-ink-secondary">{bi('Réservé aux comptes clients.', 'For customer accounts only.')}</p>
            ) : (
              <Link href={proLoginHref('/pro/restaurants')}
                className="inline-block bg-brand hover:bg-brand-dark text-white px-6 py-2.5 rounded-xl font-semibold text-sm">
                🔐 {bi('Se connecter', 'Log in')}
              </Link>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 mb-4">
              <h1 className="text-xl font-bold text-ink-primary">🏪 {bi('Mes restaurants', 'My restaurants')}</h1>
              <Link href="/pro/restaurants/new"
                className="bg-brand hover:bg-brand-dark text-white text-xs font-semibold px-3.5 py-2 rounded-full transition-colors">
                ➕ {bi('Ajouter un restaurant', 'Add a restaurant')}
              </Link>
            </div>

            {rows!.length === 0 ? (
              <div className="bg-white rounded-2xl shadow-sm p-6 text-center">
                <p className="text-4xl mb-3" aria-hidden="true">🏪</p>
                <p className="text-sm text-ink-secondary mb-4">
                  {bi(
                    'Recevez commandes et réservations sur WhatsApp, payées par Mobile Money.',
                    'Get orders and bookings on WhatsApp, paid by Mobile Money.',
                  )}
                </p>
                <Link href="/pro/restaurants/new"
                  className="inline-block bg-brand hover:bg-brand-dark text-white px-6 py-2.5 rounded-xl font-semibold text-sm">
                  ➕ {bi('Ajouter un restaurant', 'Add a restaurant')}
                </Link>
              </div>
            ) : (
              <div className="space-y-3">
                {rows!.map(r => (
                  <div key={r.id} className="bg-white rounded-2xl shadow-sm p-4">
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="min-w-0">
                        <p className="font-bold text-ink-primary truncate">{r.name}</p>
                        {r.city && <p className="text-xs text-ink-tertiary">📍 {r.city}</p>}
                      </div>
                      {statusBadge(r.status)}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {restaurantToolsFor(roles[r.id] ?? null).map(tool => (
                        <button
                          key={tool.key}
                          type="button"
                          onClick={() => openTool(r.id, tool)}
                          className="text-xs font-semibold px-3 py-1.5 rounded-full border border-divider bg-white text-ink-secondary hover:bg-brand-light hover:text-brand-darker transition-colors"
                        >
                          {tool.icon} {toolLabel(tool, locale)}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
