'use client'

// Stands in for a feature whose module is off (M2+): what the module does and
// that it is not switched on. M5 adds the "Demander l'activation" button.

import { useBi, useLanguage } from '@/lib/languageContext'
import { moduleInfo, type ModuleSubject } from '@/lib/modules'

export default function ModuleLocked({
  subject, module, children,
}: {
  subject: ModuleSubject
  module: string
  children?: React.ReactNode   // e.g. the request button
}) {
  const bi = useBi()
  const { locale } = useLanguage()
  const info = moduleInfo(subject, module)
  if (!info) return null
  return (
    <div className="bg-white rounded-2xl shadow-sm p-5 border border-dashed border-divider">
      <p className="text-sm font-bold text-ink-primary">
        🔒 {bi('Module', 'Module')} « {locale === 'fr' ? info.fr : info.en} » {bi('non activé', 'not enabled')}
      </p>
      <p className="text-xs text-ink-secondary mt-1">{locale === 'fr' ? info.descFr : info.descEn}</p>
      {children && <div className="mt-3">{children}</div>}
    </div>
  )
}
