'use client'
import RefPicker, { pickerBody } from '@/components/RefPicker'
import { useRefData } from '@/lib/useRefData'

// Admin → Événements (N3): events listed by Tchop & Ndjoka, with no organiser.
//   AdminEventCreate     "+ Créer un événement" — a short form; nobody is
//                        messaged; free reservations only until an
//                        organiser is linked.
//   AdminEventOrganizer  on an event with no organiser: a number for the
//                        bookings, or link an organiser account.

import { useState } from 'react'
import { useBi } from '@/lib/languageContext'
import PhoneInput from '@/components/PhoneInput'
import DoorStaffPanel from '@/components/DoorStaffPanel'
import type { Event } from '@/types'

const INPUT = 'w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand bg-white'

async function postJSON(url: string, body: unknown): Promise<{ ok: boolean; error: string; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, error: String(data?.error ?? ''), data }
  } catch {
    return { ok: false, error: 'Réseau / Network', data: {} }
  }
}

const EMPTY = {
  title: '', category: 'Concert', category_other: '', city: 'Yaoundé', city_other: '', venue: '', neighborhood: '',
  date: '', time: '', end_date: '', end_time: '', price: '', max_tickets: '',
  description: '', organizer_name: '', whatsapp: '', notify_phone: '', publish: true,
  // I6: "Infos seulement" by default — no booking here, a link instead.
  booking_mode: 'info' as 'info' | 'platform', info_link: '', price_is_from: false,
}

export function AdminEventCreate({ onCreated, onClose }: { onCreated: (e: Event) => void; onClose: () => void }) {
  const bi = useBi()
  useRefData()
  const [f, setF] = useState(EMPTY)
  const [photo, setPhoto] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k: keyof typeof EMPTY, v: string | boolean) => setF(p => ({ ...p, [k]: v }))

  async function save() {
    setError('')
    if (!f.title.trim() || !f.date) { setError(bi('Titre et date requis', 'Title and date required')); return }
    setBusy(true)
    let cover = ''
    // I1: the poster is optional — without one, a cover is generated.
    if (photo) try {
      const fd = new FormData()
      fd.append('file', photo)
      fd.append('kind', 'event_poster')
      fd.append('pathPrefix', 'events')
      const r = await fetch('/api/upload/image', { method: 'POST', body: fd })
      const j = await r.json().catch(() => ({}))
      if (r.ok && typeof j?.url === 'string') cover = j.url
    } catch { /* handled below */ }
    if (photo && !cover) { setBusy(false); setError(bi('L\'envoi de l\'affiche a échoué, réessayez.', 'The poster upload failed, please try again.')); return }
    const r = await postJSON('/api/admin/events', { ...f, ...pickerBody('city', f.city, f.city_other), ...pickerBody('category', f.category, f.category_other), cover_photo: cover, ...(f.booking_mode === 'info' ? { max_tickets: '', notify_phone: '' } : { info_link: '', price_is_from: false }) })
    setBusy(false)
    if (!r.ok) { setError(r.error || bi('Erreur', 'Error')); return }
    onCreated(r.data.event as unknown as Event)
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end md:items-center justify-center p-0 md:p-4" role="dialog" aria-modal="true">
      <div className="bg-white w-full md:max-w-2xl max-h-[92vh] overflow-y-auto rounded-t-3xl md:rounded-2xl p-5 shadow-xl">
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-bold text-ink-primary text-lg">{bi('Créer un événement', 'Create an event')}</h2>
          <button type="button" onClick={onClose} aria-label={bi('Fermer', 'Close')} className="w-9 h-9 rounded-full hover:bg-surface-muted text-xl">✕</button>
        </div>
        <p className="text-xs text-ink-tertiary mb-4">
          {bi('Géré par Tchop & Ndjoka : aucun message envoyé. Infos seulement, ou réservations gratuites jusqu\'à l\'ajout d\'un organisateur.',
            'Managed by Tchop & Ndjoka: no message sent. Info only, or free reservations until an organiser is linked.')}
        </p>
        <div className="grid grid-cols-2 gap-2 mb-4" role="radiogroup" aria-label={bi('Réservation', 'Booking')}>
          {([
            ['info', bi('ℹ️ Infos seulement', 'ℹ️ Info only'), bi('Pas de réservation : lien « Billets / Infos »', 'No booking: a "Tickets / Info" link')],
            ['platform', bi('📋 Réservations gratuites', '📋 Free reservations'), bi('Sur Tchop & Ndjoka, avec QR', 'On Tchop & Ndjoka, with QR')],
          ] as const).map(([v, t, sub]) => (
            <button key={v} type="button" role="radio" aria-checked={f.booking_mode === v} onClick={() => set('booking_mode', v)}
              className={`text-left rounded-xl border p-3 ${f.booking_mode === v ? 'border-brand bg-brand-light/50' : 'border-divider bg-white'}`}>
              <span className="block text-sm font-bold text-ink-primary">{t}</span>
              <span className="block text-xs text-ink-secondary">{sub}</span>
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <L label={bi('Titre *', 'Title *')} wide><input value={f.title} onChange={e => set('title', e.target.value)} className={INPUT} /></L>
          <L label={bi('Catégorie *', 'Category *')}>
            <RefPicker kind="event_category" className={INPUT} value={f.category} other={f.category_other}
              onChange={(v, o) => setF(p => ({ ...p, category: v, category_other: o }))} />
          </L>
          <L label={bi('Ville *', 'City *')}>
            <RefPicker kind="city" className={INPUT} value={f.city} other={f.city_other}
              onChange={(v, o) => setF(p => ({ ...p, city: v, city_other: o }))} />
          </L>
          <L label={bi('Lieu', 'Venue')}><input value={f.venue} onChange={e => set('venue', e.target.value)} className={INPUT} /></L>
          <L label={bi('Quartier', 'Area')}><input value={f.neighborhood} onChange={e => set('neighborhood', e.target.value)} className={INPUT} /></L>
          <L label={bi('Date de début *', 'Start date *')}><input type="date" value={f.date} onChange={e => set('date', e.target.value)} className={INPUT} /></L>
          <L label={bi('Heure de début', 'Start time')}><input type="time" value={f.time} onChange={e => set('time', e.target.value)} className={INPUT} /></L>
          <L label={bi('Date de fin', 'End date')}><input type="date" value={f.end_date} onChange={e => set('end_date', e.target.value)} className={INPUT} /></L>
          <L label={bi('Heure de fin', 'End time')}><input type="time" value={f.end_time} onChange={e => set('end_time', e.target.value)} className={INPUT} /></L>
          <L label={bi('Prix à l\'entrée (FCFA, vide = gratuit)', 'Entry price (FCFA, empty = free)')}>
            <input type="number" min="0" inputMode="numeric" value={f.price} onChange={e => set('price', e.target.value)} className={INPUT} />
          </L>
          {f.booking_mode === 'info' ? (
            <label className="flex items-center gap-2 text-ink-primary self-end pb-2">
              <input type="checkbox" checked={f.price_is_from} onChange={e => set('price_is_from', e.target.checked)} className="w-4 h-4 accent-brand" />
              {bi('Prix « À partir de »', 'Price "From"')}
            </label>
          ) : (
            <L label={bi('Places par jour (vide = illimité)', 'Seats per day (empty = unlimited)')}>
              <input type="number" min="0" inputMode="numeric" value={f.max_tickets} onChange={e => set('max_tickets', e.target.value)} className={INPUT} />
            </L>
          )}
          {f.booking_mode === 'info' && (
            <L label={bi('Lien « Billets / Infos »', '"Tickets / Info" link')} wide>
              <input type="url" inputMode="url" value={f.info_link} onChange={e => set('info_link', e.target.value)} placeholder="https://" className={INPUT} />
            </L>
          )}
          <L label={bi('Organisateur affiché', 'Organiser shown')}><input value={f.organizer_name} onChange={e => set('organizer_name', e.target.value)} placeholder="Tchop & Ndjoka" className={INPUT} /></L>
          <L label={bi('WhatsApp de contact (public)', 'Contact WhatsApp (public)')}><PhoneInput value={f.whatsapp} onChange={full => set('whatsapp', full)} /></L>
          {f.booking_mode === 'platform' && (
            <L label={bi('Numéro qui reçoit les réservations', 'Number that gets the bookings')}><PhoneInput value={f.notify_phone} onChange={full => set('notify_phone', full)} /></L>
          )}
          <L label="Description" wide><textarea value={f.description} onChange={e => set('description', e.target.value)} rows={3} className={INPUT} /></L>
          <L label={bi('Affiche (facultative : une couverture est générée)', 'Poster (optional: a cover is generated)')} wide>
            <input type="file" accept="image/*" onChange={e => setPhoto(e.target.files?.[0] ?? null)} className="text-sm text-ink-secondary" />
          </L>
          <label className="sm:col-span-2 flex items-center gap-2 text-ink-primary">
            <input type="checkbox" checked={f.publish} onChange={e => set('publish', e.target.checked)} className="w-4 h-4 accent-brand" />
            {bi('Publier maintenant (visible par tous)', 'Publish now (visible to everyone)')}
          </label>
        </div>
        {error && <p className="text-xs text-danger mt-3">{error}</p>}
        <div className="flex gap-3 mt-4">
          <button type="button" onClick={save} disabled={busy}
            className="flex-1 bg-brand hover:bg-brand-dark text-white py-2.5 rounded-xl font-semibold text-sm disabled:opacity-50">
            {busy ? '…' : bi('Créer l\'événement', 'Create the event')}
          </button>
          <button type="button" onClick={onClose} disabled={busy}
            className="flex-1 border border-divider py-2.5 rounded-xl font-semibold text-sm text-ink-secondary hover:bg-surface-muted">
            {bi('Annuler', 'Cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}

function L({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="block text-xs font-semibold text-ink-secondary mb-1">{label}</span>
      {children}
    </label>
  )
}

export function AdminEventOrganizer({ event, onChanged }: { event: Event; onChanged: () => void }) {
  const bi = useBi()
  const [mode, setMode] = useState<'notify' | 'link' | null>(null)
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  async function save() {
    if (!mode) return
    setBusy(true); setMsg(null)
    const r = await postJSON(`/api/admin/events/${event.id}/organizer`, { mode, phone, name })
    setBusy(false)
    if (!r.ok) { setMsg({ ok: false, text: r.error || bi('Erreur', 'Error') }); return }
    setMsg({ ok: true, text: mode === 'link' ? bi('Organisateur lié. Aucun message envoyé.', 'Organiser linked. No message sent.') : bi('Numéro enregistré.', 'Number saved.') })
    setMode(null); setPhone(''); setName('')
    onChanged()
  }

  return (
    <div className="mt-2 rounded-xl border border-divider bg-surface px-3 py-2 text-xs">
      <p className="text-ink-secondary">
        🏢 {event.booking_mode === 'info'
          ? bi('Géré par Tchop & Ndjoka · ℹ️ infos seulement (pas de réservation)', 'Managed by Tchop & Ndjoka · ℹ️ info only (no booking)')
          : bi('Géré par Tchop & Ndjoka · réservations gratuites seulement', 'Managed by Tchop & Ndjoka · free reservations only')}
        {event.booking_mode === 'info' && event.info_link && <> · <a href={event.info_link} target="_blank" rel="noopener noreferrer" className="underline">🎟️ {bi('lien', 'link')}</a></>}
        {event.notify_phone && <> · 🔔 <span className="font-mono">{event.notify_phone}</span></>}
      </p>
      {!mode ? (
        <div className="flex flex-wrap gap-2 mt-1.5">
          <button type="button" onClick={() => setMode('notify')} className="font-semibold px-2.5 py-1 rounded-full border border-divider bg-white hover:bg-surface-muted">
            🔔 {bi('Numéro des réservations', 'Bookings number')}
          </button>
          <button type="button" onClick={() => setMode('link')} className="font-semibold px-2.5 py-1 rounded-full border border-brand text-brand-darker bg-white hover:bg-brand-light">
            👤 {bi('Lier l\'organisateur', 'Link the organiser')}
          </button>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <PhoneInput value={phone} onChange={full => setPhone(full)} />
          {mode === 'link' && (
            <input value={name} onChange={e => setName(e.target.value)} placeholder={bi('Nom (si nouveau numéro)', 'Name (if new number)')} className={INPUT} />
          )}
          <p className="text-ink-tertiary">
            {mode === 'link'
              ? bi('Son compte devient l\'organisateur (ses modules s\'appliquent). Aucun message envoyé.', 'Their account becomes the organiser (their modules apply). No message sent.')
              : bi('Ce numéro reçoit les réservations. Vide = retirer.', 'This number gets the bookings. Empty = remove.')}
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={save} disabled={busy || (mode === 'link' && !phone)}
              className="font-semibold px-3 py-1.5 rounded-full bg-brand text-white disabled:opacity-50">{busy ? '…' : bi('Enregistrer', 'Save')}</button>
            <button type="button" onClick={() => setMode(null)} className="font-semibold px-3 py-1.5 rounded-full border border-divider">{bi('Annuler', 'Cancel')}</button>
          </div>
        </div>
      )}
      {msg && <p className={`mt-1 ${msg.ok ? 'text-emerald-700' : 'text-danger'}`}>{msg.text}</p>}
      {/* Q4: door staff for a managed event (scan only). */}
      <details className="mt-2">
        <summary className="cursor-pointer font-semibold text-ink-secondary">🚪 {bi('Contrôle à l\'entrée', 'Door staff')}</summary>
        <div className="mt-2"><DoorStaffPanel eventId={event.id} /></div>
      </details>
    </div>
  )
}
