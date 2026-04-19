'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'
import { supabase } from '@/lib/supabase'
import { Event } from '@/types'
import { useLanguage } from '@/lib/languageContext'

export default function AdminEventsPage() {
  const { t } = useLanguage()
  const [events, setEvents] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'pending' | 'approved'>('pending')
  const [saving, setSaving] = useState<string | null>(null)

  const fetchEvents = useCallback(async () => {
    const { data } = await supabase
      .from('events')
      .select('*')
      .order('created_at', { ascending: false })
    if (data) setEvents(data)
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchEvents()
  }, [fetchEvents])

  async function approve(id: string) {
    setSaving(id)
    await supabase.from('events').update({ is_active: true }).eq('id', id)
    setEvents(prev => prev.map(e => e.id === id ? { ...e, is_active: true } : e))
    setSaving(null)
  }

  async function reject(id: string) {
    if (!confirm(t('admin.evtRejectConfirm'))) return
    setSaving(id)
    await supabase.from('events').delete().eq('id', id)
    setEvents(prev => prev.filter(e => e.id !== id))
    setSaving(null)
  }

  const pending  = events.filter(e => !e.is_active)
  const approved = events.filter(e => e.is_active)
  const shown = tab === 'pending' ? pending : approved

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-ink-primary">{t('admin.evtTitle')}</h1>
        <p className="text-sm text-ink-secondary mt-0.5">{t('admin.evtSub')}</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <div className="bg-white rounded-2xl p-4 shadow-sm">
          <p className="text-xs text-ink-secondary font-medium">{t('admin.evtPendingTab')}</p>
          <p className={`text-2xl font-bold mt-1 ${pending.length > 0 ? 'text-brand' : 'text-ink-primary'}`}>
            {pending.length}
          </p>
        </div>
        <div className="bg-white rounded-2xl p-4 shadow-sm">
          <p className="text-xs text-ink-secondary font-medium">{t('admin.evtApprovedTab')}</p>
          <p className="text-2xl font-bold text-ink-primary mt-1">{approved.length}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-surface-muted p-1 rounded-xl w-fit mb-5">
        <button
          onClick={() => setTab('pending')}
          className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
            tab === 'pending' ? 'bg-white text-ink-primary shadow-sm' : 'text-ink-secondary hover:text-ink-primary'
          }`}
        >
          {t('admin.evtPendingTab')}
          {pending.length > 0 && (
            <span className="ml-1.5 bg-brand text-white text-xs px-1.5 py-0.5 rounded-full">
              {pending.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setTab('approved')}
          className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
            tab === 'approved' ? 'bg-white text-ink-primary shadow-sm' : 'text-ink-secondary hover:text-ink-primary'
          }`}
        >
          {t('admin.evtApprovedTab')}
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="text-center py-16 text-ink-tertiary">
          <div className="text-4xl mb-3 animate-bounce">🎉</div>
          <p>{t('admin.evtLoading')}</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="text-center py-16 text-ink-tertiary">
          <div className="text-4xl mb-3">📭</div>
          <p>{tab === 'pending' ? t('admin.evtNoPending') : t('admin.evtNoApproved')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {shown.map(evt => (
            <EventRow
              key={evt.id}
              event={evt}
              saving={saving === evt.id}
              onApprove={() => approve(evt.id)}
              onReject={() => reject(evt.id)}
              tab={tab}
              approveLabel={t('admin.evtApproveBtn')}
              rejectLabel={t('admin.evtRejectBtn')}
              organizerLabel={t('admin.evtOrganizer')}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function EventRow({
  event, saving, onApprove, onReject, tab,
  approveLabel, rejectLabel, organizerLabel,
}: {
  event: Event
  saving: boolean
  onApprove: () => void
  onReject: () => void
  tab: 'pending' | 'approved'
  approveLabel: string
  rejectLabel: string
  organizerLabel: string
}) {
  const dateStr = new Date(event.date).toLocaleDateString('fr-FR', {
    day: '2-digit', month: 'short', year: 'numeric',
  })

  return (
    <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
      <div className="flex gap-4 p-4">
        {/* Thumbnail */}
        <div className="w-20 h-20 flex-shrink-0 rounded-xl bg-brand-light overflow-hidden relative">
          {event.cover_photo ? (
            <Image src={event.cover_photo} alt={event.title} fill className="object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-2xl">🎉</div>
          )}
        </div>

        {/* Details */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-bold text-ink-primary text-sm leading-tight">{event.title}</p>
              <p className="text-xs text-brand font-medium mt-0.5">
                📅 {dateStr}{event.time ? ` · ${event.time}` : ''}
              </p>
            </div>
            <span className="flex-shrink-0 text-xs bg-surface-muted text-ink-secondary px-2 py-0.5 rounded-full">
              {event.category}
            </span>
          </div>

          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5">
            {event.venue && (
              <p className="text-xs text-ink-tertiary truncate">📍 {event.venue}, {event.city}</p>
            )}
            {event.organizer_name && (
              <p className="text-xs text-ink-tertiary">{organizerLabel}: {event.organizer_name}</p>
            )}
            {event.whatsapp && (
              <p className="text-xs text-ink-tertiary font-mono">{event.whatsapp}</p>
            )}
          </div>

          {event.description && (
            <p className="text-xs text-ink-secondary mt-1.5 line-clamp-2">{event.description}</p>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="border-t border-divider px-4 py-3 flex items-center justify-end gap-2">
        <button
          onClick={onReject}
          disabled={saving}
          className="px-4 py-1.5 text-xs font-semibold text-danger bg-brand-light hover:bg-brand-light rounded-xl transition-colors disabled:opacity-50"
        >
          {rejectLabel}
        </button>
        {tab === 'pending' && (
          <button
            onClick={onApprove}
            disabled={saving}
            className="px-4 py-1.5 text-xs font-semibold text-white bg-brand hover:bg-brand-dark rounded-xl transition-colors disabled:opacity-50"
          >
            {approveLabel}
          </button>
        )}
      </div>
    </div>
  )
}
