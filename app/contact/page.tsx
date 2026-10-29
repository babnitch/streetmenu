'use client'

// /contact (U2) — e-mail, phone and support WhatsApp from Admin → Plateforme
// (only the ones that are set). Public, no login.

import { PageShell } from '@/components/LegalPage'
import { useBi } from '@/lib/languageContext'
import { usePlatformInfo } from '@/lib/usePlatformInfo'
import { waLink } from '@/lib/legalInfo'

export default function ContactPage() {
  const bi = useBi()
  const info = usePlatformInfo()
  const rows = info ? [
    info.support_whatsapp && { icon: '💬', label: bi('WhatsApp (support)', 'WhatsApp (support)'), value: info.support_whatsapp, href: waLink(info.support_whatsapp, bi('Bonjour Tchop & Ndjoka,', 'Hello Tchop & Ndjoka,')) },
    info.contact_email && { icon: '✉️', label: bi('E-mail', 'E-mail'), value: info.contact_email, href: `mailto:${info.contact_email}` },
    info.contact_phone && { icon: '📞', label: bi('Téléphone', 'Phone'), value: info.contact_phone, href: `tel:${info.contact_phone}` },
  ].filter(Boolean) as Array<{ icon: string; label: string; value: string; href: string }> : []
  return (
    <PageShell title={bi('Contact', 'Contact')}>
      <p className="mt-3 text-ink-secondary">
        {bi('Une question, un problème avec une commande ou un billet, un restaurant à ajouter ? Écrivez-nous — avec le code de la commande ou du billet (#AB12) si vous l\'avez.',
          'A question, a problem with an order or a ticket, a restaurant to add? Write to us — with the order or ticket code (#AB12) if you have it.')}
      </p>
      {info === null ? <p className="mt-6 text-ink-tertiary">…</p> : rows.length === 0 ? (
        <p className="mt-6 text-sm text-ink-tertiary">{bi('Coordonnées bientôt disponibles.', 'Contact details coming soon.')}</p>
      ) : (
        <ul className="mt-6 space-y-3">
          {rows.map(r => (
            <li key={r.label}>
              <a href={r.href} target={r.href.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer"
                className="flex items-center gap-3 bg-white rounded-2xl shadow-sm p-4 hover:shadow-md">
                <span className="text-2xl" aria-hidden="true">{r.icon}</span>
                <span><span className="block text-xs text-ink-tertiary">{r.label}</span><span className="block font-semibold text-ink-primary">{r.value}</span></span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {info?.company_name && (
        <p className="mt-8 text-xs text-ink-tertiary">
          {[info.company_name, info.company_number, info.company_address].filter(Boolean).join(' · ')}
        </p>
      )}
    </PageShell>
  )
}
