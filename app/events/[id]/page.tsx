'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { supabase } from '@/lib/supabase'
import { Event } from '@/types'
import { useLanguage } from '@/lib/languageContext'
import TopNav from '@/components/TopNav'

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { t } = useLanguage()
  const [event, setEvent] = useState<Event | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchEvent() {
      const { data } = await supabase
        .from('events')
        .select('*')
        .eq('id', id)
        .single()
      setEvent(data)
      setLoading(false)
    }
    fetchEvent()
  }, [id])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface">
        <div className="text-4xl animate-bounce">🎉</div>
      </div>
    )
  }

  if (!event) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-surface">
        <div className="text-5xl">😕</div>
        <p className="text-ink-secondary">{t('evt.notFound')}</p>
        <Link href="/events" className="text-brand underline text-sm">{t('evt.back')}</Link>
      </div>
    )
  }

  const dateStr = new Date(event.date).toLocaleDateString('fr-FR', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  })

  const whatsappMsg = encodeURIComponent(
    `Bonjour ! Je suis intéressé(e) par votre événement "${event.title}" le ${dateStr}.`
  )
  const whatsappNumber = event.whatsapp?.replace(/[^0-9]/g, '')
  const whatsappUrl = `https://wa.me/${whatsappNumber}?text=${whatsappMsg}`

  const shareMsg = encodeURIComponent(
    `🎉 ${event.title} — ${dateStr}${event.venue ? ` @ ${event.venue}` : ''}\nvia Ndjoka & Tchop`
  )
  const shareUrl = `https://wa.me/?text=${shareMsg}`

  return (
    <div className="min-h-screen bg-surface">

      <TopNav />

      {/* Hero */}
      <div className="relative h-56 sm:h-72 bg-gradient-to-br from-brand-badge to-brand">
        {event.cover_photo && (
          <Image
            src={event.cover_photo}
            alt={event.title}
            fill
            className="object-cover"
            priority
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />

        {/* Back button */}
        <div className="absolute top-4 left-4 z-10">
          <Link
            href="/events"
            className="bg-white/90 backdrop-blur-sm text-ink-primary px-3 py-1.5 rounded-xl text-sm font-semibold flex items-center gap-1 hover:bg-white transition-colors"
          >
            {t('evt.back')}
          </Link>
        </div>

        {/* Category badge */}
        <div className="absolute bottom-4 left-4 right-4 z-10">
          <span className="inline-block bg-brand text-white text-xs font-bold px-2.5 py-1 rounded-full mb-2">
            {event.category}
          </span>
          <h1 className="text-white text-2xl font-bold leading-tight drop-shadow-lg">
            {event.title}
          </h1>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-xl mx-auto px-4 py-6 space-y-6">

        {/* Date / venue / price row */}
        <div className="bg-white rounded-2xl p-4 shadow-sm space-y-3">
          <DetailRow icon="📅" label={t('evt.date')} value={`${dateStr}${event.time ? ` · ${event.time}` : ''}`} />
          {event.venue && (
            <DetailRow
              icon="📍"
              label={t('evt.venue')}
              value={`${event.venue}${event.neighborhood ? `, ${event.neighborhood}` : ''}${event.city ? ` — ${event.city}` : ''}`}
            />
          )}
          <DetailRow
            icon="🎟"
            label={t('evt.price')}
            value={
              event.price === null || event.price === 0
                ? t('evt.free')
                : `${Number(event.price).toLocaleString()} FCFA`
            }
          />
          {event.organizer_name && (
            <DetailRow icon="👤" label={t('evt.organizer')} value={event.organizer_name} />
          )}
        </div>

        {/* Description */}
        {event.description && (
          <div className="bg-white rounded-2xl p-4 shadow-sm">
            <p className="text-ink-primary text-sm leading-relaxed whitespace-pre-wrap">{event.description}</p>
          </div>
        )}

        {/* CTAs */}
        {whatsappNumber && (
          <a
            href={whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full bg-brand hover:bg-brand-dark text-white text-center py-3.5 rounded-2xl text-sm font-bold transition-colors shadow-card"
          >
            💬 {t('evt.interested')}
          </a>
        )}

        <a
          href={shareUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block w-full bg-white border border-divider hover:bg-surface-muted text-ink-primary text-center py-3 rounded-2xl text-sm font-semibold transition-colors"
        >
          {t('evt.share')}
        </a>

      </div>
    </div>
  )
}

function DetailRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-lg mt-0.5 flex-shrink-0">{icon}</span>
      <div>
        <p className="text-xs text-ink-tertiary font-medium uppercase tracking-wide">{label}</p>
        <p className="text-sm text-ink-primary font-medium mt-0.5">{value}</p>
      </div>
    </div>
  )
}
