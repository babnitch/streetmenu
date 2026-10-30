'use client'

// /pro/aide — every Pro section: what it is for + tips (lib/proHelp.ts).
// Linked from the Pro ☰ menu and from each ⓘ.

import TopNav from '@/components/TopNav'
import { useBi } from '@/lib/languageContext'
import { PRO_HELP, PRO_HELP_IDS } from '@/lib/proHelp'

export default function ProHelpPage() {
  const bi = useBi()
  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <main className="max-w-2xl mx-auto px-4 pt-5 pb-28 md:pb-12">
        <h1 className="text-2xl font-black text-ink-primary">❓ {bi('Aide Pro', 'Pro help')}</h1>
        <p className="text-sm text-ink-secondary mt-1">{bi('À quoi sert chaque section, et quelques conseils.', 'What each section is for, and a few tips.')}</p>
        <nav className="mt-4 flex flex-wrap gap-2" aria-label={bi('Sections', 'Sections')}>
          {PRO_HELP_IDS.map(id => (
            <a key={id} href={`#${id}`} className="text-xs font-semibold px-3 py-1.5 rounded-full border border-divider bg-white">{PRO_HELP[id].icon} {bi(PRO_HELP[id].title.fr, PRO_HELP[id].title.en)}</a>
          ))}
        </nav>
        <div className="mt-6 space-y-4">
          {PRO_HELP_IDS.map(id => {
            const h = PRO_HELP[id]
            return (
              <section key={id} id={id} className="bg-white rounded-2xl border border-divider p-4 scroll-mt-20">
                <h2 className="font-bold text-ink-primary">{h.icon} {bi(h.title.fr, h.title.en)}</h2>
                <p className="mt-1 text-sm text-ink-primary">{bi(h.what.fr, h.what.en)}</p>
                <ul className="mt-2 space-y-1 text-sm text-ink-secondary">
                  {h.tips.map((t, i) => <li key={i} className="flex gap-2"><span aria-hidden="true">💡</span><span>{bi(t.fr, t.en)}</span></li>)}
                </ul>
              </section>
            )
          })}
        </div>
      </main>
    </div>
  )
}
