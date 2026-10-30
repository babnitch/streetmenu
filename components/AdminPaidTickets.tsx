'use client'

// Admin → Commandes → "Billets payés" (R2): tickets paid by Mobile Money,
// with their refund state and (super admin) the Rembourser button.

import { useCallback, useEffect, useState } from 'react'
import { useBi, useLanguage } from '@/lib/languageContext'
import { formatFCFA } from '@/lib/money'
import { matchesSearch } from '@/lib/textSearch'
import RefundButton, { RefundStatusPill } from '@/components/RefundButton'

interface Ticket {
  id: string; customer_name: string | null; customer_phone: string | null; quantity: number; total_price: number
  reservation_status: string; reservation_code: string | null; refund_status: string; refunded_amount: number
  event_date: string | null; created_at: string; events: { title: string; city: string } | null
}

export default function AdminPaidTickets() {
  const bi = useBi()
  const { locale } = useLanguage()
  const [tickets, setTickets] = useState<Ticket[] | null>(null)
  const [q, setQ] = useState('')
  const load = useCallback(() => {
    fetch('/api/admin/paid-tickets', { cache: 'no-store' }).then(r => r.json()).then(d => setTickets(d.tickets ?? [])).catch(() => setTickets([]))
  }, [])
  useEffect(load, [load])
  const shown = (tickets ?? []).filter(t => matchesSearch(q, [t.customer_name, t.customer_phone, t.reservation_code, t.events?.title]))
  return (
    <div className="space-y-3">
      <input value={q} onChange={e => setQ(e.target.value)} placeholder={bi('Rechercher : nom, numéro, code, événement', 'Search: name, number, code, event')}
        className="w-full border border-divider rounded-xl px-3 py-2 text-sm bg-white" />
      {tickets === null ? <p className="text-sm text-ink-tertiary">…</p> : shown.length === 0 ? (
        <p className="text-sm text-ink-tertiary">{bi('Aucun billet payé par Mobile Money.', 'No tickets paid by Mobile Money.')}</p>
      ) : (
        <ul className="bg-white rounded-2xl shadow-sm divide-y divide-divider">
          {shown.map(t => (
            <li key={t.id} className="px-4 py-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink-primary truncate">{t.events?.title ?? '—'}{t.reservation_code ? ` · #${t.reservation_code}` : ''}</p>
                <p className="text-xs text-ink-secondary">{t.customer_name ?? '—'} · {t.customer_phone ?? ''} · {t.quantity} {bi('place(s)', 'ticket(s)')}</p>
                <p className="text-xs text-ink-tertiary">
                  {t.event_date ?? ''} · {new Date(t.created_at).toLocaleDateString(locale === 'en' ? 'en-GB' : 'fr-FR')}
                  {t.reservation_status === 'cancelled' ? ` · ${bi('annulée', 'cancelled')}` : ''}
                </p>
                <div className="mt-1"><RefundStatusPill status={t.refund_status} refunded={t.refunded_amount} /></div>
              </div>
              <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                <span className="text-sm font-bold text-brand">{formatFCFA(t.total_price)}</span>
                <RefundButton kind="reservation" id={t.id} onChanged={load} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
