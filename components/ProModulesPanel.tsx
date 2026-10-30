'use client'
import HelpTip from '@/components/HelpTip'

// "Mes modules" on /pro (M5): for each restaurant the user owns, and for
// their organiser account when they run events, every module with its
// status — Activé / Non activé (Demander l'activation) / Demande envoyée /
// Bientôt. The basic page (Vitrine / event page) is always included.

import { useCallback, useEffect, useState } from 'react'
import { useBi, useLanguage } from '@/lib/languageContext'
import { modulesFor, moduleInfo, type ModuleSubject } from '@/lib/modules'
import RequestModuleButton from '@/components/RequestModuleButton'

interface ProModules {
  organizer: string[]
  restaurants: Array<{ id: string; name: string; status?: string; modules: string[] }>
  pending: Array<{ subject_type: ModuleSubject; restaurant_id: string | null; module: string }>
}

export default function ProModulesPanel({ showOrganizer }: { showOrganizer: boolean }) {
  const bi = useBi()
  const [data, setData] = useState<ProModules | null>(null)

  const load = useCallback(() => {
    fetch('/api/pro/modules', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setData(d) })
      .catch(() => null)
  }, [])
  useEffect(() => { load() }, [load])

  if (!data) return null
  const owned = data.restaurants.filter(r => r.status !== 'deleted')
  if (owned.length === 0 && !showOrganizer) return null

  const isPending = (subject: ModuleSubject, m: string, rid?: string) =>
    data.pending.some(p => p.subject_type === subject && p.module === m && (subject === 'organizer' || p.restaurant_id === rid))

  return (
    <section className="mt-6" aria-labelledby="pro-modules">
      <h2 id="pro-modules" className="text-base font-bold text-ink-primary">🧩 {bi('Mes modules', 'My modules')} <HelpTip id="modules" /></h2>
      <p className="text-xs text-ink-tertiary mb-3">
        {bi('La vitrine (page, menu, horaires, contact) est toujours incluse.', 'The basic page (page, menu, hours, contact) is always included.')}
      </p>
      <div className="space-y-3">
        {owned.map(r => (
          <ModuleCard key={r.id} title={`🏪 ${r.name}`} subject="restaurant" active={r.modules}
            isPending={m => isPending('restaurant', m, r.id)} restaurantId={r.id} onSent={load} />
        ))}
        {showOrganizer && (
          <ModuleCard title={`🎉 ${bi('Organisateur', 'Organiser')}`} subject="organizer" active={data.organizer}
            isPending={m => isPending('organizer', m)} onSent={load} />
        )}
      </div>
    </section>
  )
}

function ModuleCard({ title, subject, active, isPending, restaurantId, onSent }: {
  title: string
  subject: ModuleSubject
  active: string[]
  isPending: (m: string) => boolean
  restaurantId?: string
  onSent: () => void
}) {
  const bi = useBi()
  const { locale } = useLanguage()
  return (
    <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
      <p className="px-4 pt-3 pb-2 text-sm font-bold text-ink-primary">{title}</p>
      <ul className="divide-y divide-divider">
        {modulesFor(subject).map(m => {
          const info = moduleInfo(subject, m)!
          const on = active.includes(m)
          return (
            <li key={m} className="px-4 py-2.5 flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink-primary">{locale === 'fr' ? info.fr : info.en}</span>
                <span className="block text-xs text-ink-tertiary">{locale === 'fr' ? info.descFr : info.descEn}</span>
              </span>
              <span className="flex-shrink-0">
                {on ? (
                  <span className="inline-block text-xs font-semibold text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-full">✓ {bi('Activé', 'On')}</span>
                ) : info.soon ? (
                  <span className="inline-block text-xs font-semibold text-ink-tertiary bg-surface-muted px-3 py-1.5 rounded-full">{bi('Bientôt', 'Soon')}</span>
                ) : (
                  <RequestModuleButton subject={subject} module={m} restaurantId={restaurantId} pending={isPending(m)} onSent={onSent} />
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
