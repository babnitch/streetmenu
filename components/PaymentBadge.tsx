'use client'

import type { Order } from '@/types'
import { pickBi } from '@/lib/languageContext'
import type { Locale } from '@/lib/translations'

// Compact payment badge — rendered next to the order status pill across
// the vendor dashboard, the customer order history, and the admin orders
// table. Shape mirrors STATUS_COLORS in /dashboard so the two pills sit
// flush. Pure presentational; takes the order shape directly.

interface PaymentBadgeProps {
  order: Pick<Order, 'order_type' | 'payment_status' | 'payment_method' | 'payment_id'>
  locale: Locale
  size?: 'sm' | 'xs'
  showRef?: boolean // surface payment_id last 6 (customer history uses this)
}

const PM_LABELS: Record<string, string> = {
  MTN_MOMO_CMR: 'MTN MoMo',
  MTN_MOMO_CIV: 'MTN MoMo',
  MTN_MOMO_BEN: 'MTN MoMo',
  ORANGE_CMR:   'Orange Money',
  ORANGE_CIV:   'Orange Money',
  ORANGE_SEN:   'Orange Money',
  MOOV_CIV:     'Moov Money',
  MOOV_BEN:     'Moov Money',
  FREE_SEN:     'Free Money',
}

export default function PaymentBadge({ order, locale, size = 'xs', showRef = false }: PaymentBadgeProps) {
  // Reservations get a single neutral badge; nothing to show beyond "no
  // online payment expected" so the vendor can spot them at a glance.
  if (order.order_type === 'reservation' || order.payment_status === 'not_required') {
    return (
      <Pill tone="neutral" size={size}>
        📋 {pickBi('Réservation / Reservation', locale)}
      </Pill>
    )
  }

  const method = order.payment_method ? PM_LABELS[order.payment_method] ?? order.payment_method : null

  if (order.payment_status === 'paid') {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <Pill tone="success" size={size}>
          💰 {pickBi('Payé / Paid', locale)}{method ? ` · ${method}` : ''}
        </Pill>
        {showRef && order.payment_id && (
          <span className="text-[10px] text-ink-tertiary font-mono">ref: {order.payment_id.slice(-6).toUpperCase()}</span>
        )}
      </div>
    )
  }
  if (order.payment_status === 'pending') {
    return <Pill tone="warning" size={size}>⏳ {pickBi('Paiement en attente / Payment pending', locale)}</Pill>
  }
  if (order.payment_status === 'failed') {
    return <Pill tone="danger" size={size}>❌ {pickBi('Paiement échoué / Payment failed', locale)}</Pill>
  }
  if (order.payment_status === 'refunded') {
    return <Pill tone="neutral" size={size}>↩️ {pickBi('Remboursé / Refunded', locale)}</Pill>
  }
  return null
}

function Pill({ tone, size, children }: { tone: 'success' | 'warning' | 'danger' | 'neutral'; size: 'xs' | 'sm'; children: React.ReactNode }) {
  const sizeCls = size === 'sm' ? 'text-xs px-2.5 py-1' : 'text-[10px] px-2 py-0.5'
  const toneCls = tone === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                : tone === 'warning' ? 'bg-amber-50 text-amber-700 border border-amber-200'
                : tone === 'danger'  ? 'bg-rose-50 text-rose-700 border border-rose-200'
                :                      'bg-surface-muted text-ink-secondary border border-divider'
  return (
    <span className={`rounded-full font-medium whitespace-nowrap ${sizeCls} ${toneCls}`}>
      {children}
    </span>
  )
}
