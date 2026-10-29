'use client'

// Shell of the public info pages (U2): title, an admin-only "Brouillon – à
// relire" banner (the texts are drafts until reviewed), the content, and
// the last-updated date.

import TopNav from '@/components/TopNav'
import { useBi, useLanguage } from '@/lib/languageContext'
import { useMode } from '@/lib/modeContext'
import { usePlatformInfo } from '@/lib/usePlatformInfo'
import { LEGAL_TEXTS, LEGAL_UPDATED, type LegalPageKey } from '@/lib/legalTexts'
import { formatEventDay } from '@/lib/eventDate'

const ADMIN = ['super_admin', 'admin', 'moderator']

export function DraftBanner() {
  const bi = useBi()
  const { sessionRole } = useMode()
  if (!sessionRole || !ADMIN.includes(sessionRole)) return null
  return (
    <p className="mb-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm font-semibold px-4 py-2">
      ✏️ {bi('Brouillon – à relire (visible par les admins seulement)', 'Draft – to be reviewed (visible to admins only)')}
    </p>
  )
}

export function PageShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <main className="max-w-2xl mx-auto px-4 pt-6 pb-12">
        <DraftBanner />
        <h1 className="text-2xl md:text-3xl font-black text-ink-primary leading-tight">{title}</h1>
        {children}
      </main>
    </div>
  )
}

export default function LegalPage({ page }: { page: LegalPageKey }) {
  const bi = useBi()
  const { locale } = useLanguage()
  const info = usePlatformInfo()
  const lang = locale === 'en' ? 'en' : 'fr'
  const t = LEGAL_TEXTS[page][lang]
  const company = info?.company_name || bi('l\'éditeur de Tchop & Ndjoka', 'the publisher of Tchop & Ndjoka')
  const fill = (s: string) => s.replaceAll('{company}', company)
  return (
    <PageShell title={t.title}>
      {t.intro && <p className="mt-3 text-ink-secondary">{fill(t.intro)}</p>}
      {t.sections.map(sec => (
        <section key={sec.h} className="mt-6">
          <h2 className="text-lg font-bold text-ink-primary">{sec.h}</h2>
          {sec.p.map((p, i) => <p key={i} className="mt-2 text-sm text-ink-secondary leading-relaxed">{fill(p)}</p>)}
        </section>
      ))}
      <p className="mt-10 text-xs text-ink-tertiary">{bi('Mise à jour', 'Updated')} : {formatEventDay(LEGAL_UPDATED, lang, 'list')}</p>
    </PageShell>
  )
}
