'use client'

// Stands in for a feature whose module is off (M2+): what the module does and
// that it is not switched on, with "Demander l'activation" (M5) unless the
// caller turns it off (e.g. a manager, who can't ask).

import { useBi, useLanguage } from '@/lib/languageContext'
import { moduleInfo, type ModuleSubject } from '@/lib/modules'
import RequestModuleButton from '@/components/RequestModuleButton'

export default function ModuleLocked({
  subject, module, restaurantId, canRequest = true, children,
}: {
  subject: ModuleSubject
  module: string
  restaurantId?: string        // restaurant modules: which restaurant asks
  canRequest?: boolean
  children?: React.ReactNode
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
      {canRequest && !info.soon && (subject === 'organizer' || restaurantId) && (
        <div className="mt-3"><RequestModuleButton subject={subject} module={module} restaurantId={restaurantId} /></div>
      )}
    </div>
  )
}
