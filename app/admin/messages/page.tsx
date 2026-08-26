'use client'

// Admin → 📨 Messages. Rendered standalone at /admin/messages and as a
// sub-tab inside the account dashboard (app/account/page.tsx).

import MessageLogPanel from '@/components/MessageLogPanel'
import { useBi } from '@/lib/languageContext'

export default function AdminMessagesPage() {
  const bi = useBi()

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-ink-primary">
          📨 {bi('Journal des messages', 'Message log')}
        </h1>
        <p className="text-sm text-ink-secondary mt-0.5">
          {bi(
            'Chaque WhatsApp et SMS envoyé, avec le statut de livraison réel de Twilio.',
            'Every WhatsApp and SMS sent, with real delivery status from Twilio.',
          )}
        </p>
      </div>

      <MessageLogPanel showStats showFilters />
    </div>
  )
}
