'use client'

// Admin → Événements → card → « Infos de l'événement » (admin + super admin),
// any published event, managed or an organiser's: title, description,
// category, dates/times, venue, city, area, map pin, price / « À partir de »,
// « Billets / Infos » link, booking mode, WhatsApp, booking number, poster
// (+ cadrage + credit). Checks and audit: lib/eventEdit.ts. Only the fields
// changed are sent. A new date / time / venue / price on an event with
// bookings asks whether to tell the people who booked (WhatsApp).

import { useEffect, useState } from 'react'
import { useBi, useLanguage, pickBi } from '@/lib/languageContext'
import { visibleCities } from '@/lib/cities'
import { useRefData } from '@/lib/useRefData'
import { eventCategories, categoryLabel } from '@/lib/categoryLabels'
import { validateEventRange, EVENT_RANGE_ERRORS } from '@/lib/eventDate'
import { parsePin } from '@/lib/restaurantDetailFields'
import PhoneInput from '@/components/PhoneInput'
import ContactLink from '@/components/ContactLink'
import AdminPhotoPanel from '@/components/AdminPhotoPanel'

const INPUT = 'w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand bg-white'
const BTN = 'text-xs font-semibold px-3 py-1.5 rounded-full border'

type Form = {
  title: string; description: string; category: string; date: string; time: string; end_date: string; end_time: string
  venue: string; city: string; neighborhood: string; pin: string; ticket_price: string; price_is_from: boolean
  info_link: string; booking_mode: 'info' | 'platform'; whatsapp: string; notify_phone: string
}
type Loaded = Record<string, unknown> & { id: string }

const str = (v: unknown) => (v == null ? '' : String(v))
const hm = (v: unknown) => str(v).slice(0, 5)

function toForm(e: Loaded): Form {
  return {
    title: str(e.title), description: str(e.description), category: str(e.category),
    date: str(e.date), time: hm(e.time), end_date: str(e.end_date), end_time: hm(e.end_time),
    venue: str(e.venue), city: str(e.city), neighborhood: str(e.neighborhood),
    pin: e.lat != null && e.lng != null ? `${e.lat}, ${e.lng}` : '',
    ticket_price: e.ticket_price != null ? String(e.ticket_price) : '', price_is_from: e.price_is_from === true,
    info_link: str(e.info_link), booking_mode: e.booking_mode === 'info' ? 'info' : 'platform',
    whatsapp: str(e.whatsapp), notify_phone: str(e.notify_phone),
  }
}

/** The body for the fields that changed (the date range goes as a whole). */
export function changedBody(start: Form, f: Form): Record<string, unknown> {
  const b: Record<string, unknown> = {}
  const simple = ['title', 'description', 'category', 'venue', 'city', 'neighborhood', 'info_link', 'booking_mode', 'whatsapp', 'notify_phone'] as const
  for (const k of simple) if (f[k].trim() !== start[k].trim()) b[k] = f[k].trim()
  if (f.price_is_from !== start.price_is_from) b.price_is_from = f.price_is_from
  if (f.ticket_price.trim() !== start.ticket_price.trim()) b.ticket_price = f.ticket_price.trim() === '' ? null : Number(f.ticket_price)
  if ((['date', 'time', 'end_date', 'end_time'] as const).some(k => f[k] !== start[k])) {
    b.date = f.date; b.time = f.time || null; b.end_date = f.end_date || null; b.end_time = f.end_time || null
  }
  if (f.pin.trim() !== start.pin.trim()) {
    const p = parsePin(f.pin)
    if (p) { b.lat = p.lat; b.lng = p.lng } else if (!f.pin.trim()) { b.lat = null; b.lng = null }
  }
  return b
}

/** Changes the people who booked are told about. */
export const touchesBookings = (b: Record<string, unknown>) =>
  ['date', 'time', 'end_date', 'end_time', 'venue', 'city', 'ticket_price'].some(k => k in b)

export default function AdminEventInfoPanel({ eventId, poster, onSaved }: {
  eventId: string
  poster: { url: string | null; focus: string | null; credit: string | null }
  onSaved: () => void
}) {
  const bi = useBi()
  const { locale } = useLanguage()
  useRefData()
  const [start, setStart] = useState<Form | null>(null)
  const [f, setF] = useState<Form | null>(null)
  const [bookings, setBookings] = useState(0)
  const [pinReady, setPinReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [ask, setAsk] = useState<Record<string, unknown> | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string; field?: string } | null>(null)

  const load = () => fetch(`/api/admin/events/${eventId}/info`, { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      if (!d?.event) { setMsg({ ok: false, text: bi('Chargement impossible', 'Could not load') }); return }
      const form = toForm(d.event); setStart(form); setF(form); setBookings(d.bookings ?? 0); setPinReady(d.pin_ready === true)
    }).catch(() => setMsg({ ok: false, text: bi('Réseau', 'Network') }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load() }, [eventId])

  if (!f || !start) return msg ? <p className="text-xs text-danger">{msg.text}</p> : <p className="text-xs text-ink-tertiary">…</p>
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF(x => x && ({ ...x, [k]: v }))
  const pin = parsePin(f.pin)

  async function send(body: Record<string, unknown>, notify: boolean) {
    setBusy(true); setMsg(null); setAsk(null)
    const r = await fetch(`/api/admin/events/${eventId}/info`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, notify }) }).catch(() => null)
    const d = r ? await r.json().catch(() => ({})) : {}
    setBusy(false)
    if (!r?.ok) { setMsg({ ok: false, text: pickBi(String(d?.error ?? 'Erreur / Error'), locale), field: d?.field }); return }
    setMsg({ ok: true, text: d.notified_count > 0
      ? bi(`✅ Enregistré · ${d.notified_count} personne(s) prévenue(s) sur WhatsApp`, `✅ Saved · ${d.notified_count} people told on WhatsApp`)
      : bi('✅ Enregistré', '✅ Saved') })
    await load()
    onSaved()
  }

  function save() {
    if (!f || !start) return
    setMsg(null)
    if (f.pin.trim() && !pin) { setMsg({ ok: false, text: bi('Position : format 4.0525, 9.7001', 'Pin: format 4.0525, 9.7001'), field: 'lat' }); return }
    const rangeError = validateEventRange({ date: f.date, time: f.time || null, end_date: f.end_date || null, end_time: f.end_time || null })
    if (rangeError) { setMsg({ ok: false, text: bi(EVENT_RANGE_ERRORS[rangeError].fr, EVENT_RANGE_ERRORS[rangeError].en) }); return }
    const body = changedBody(start, f)
    if (Object.keys(body).length === 0) { setMsg({ ok: true, text: bi('Rien n\'a changé', 'Nothing changed') }); return }
    if (bookings > 0 && touchesBookings(body)) { setAsk(body); return }
    void send(body, false)
  }

  const err = (k: string) => msg && !msg.ok && msg.field === k ? 'border-danger' : ''
  const L = ({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) => (
    <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="block text-xs font-semibold text-ink-secondary mb-1">{label}</span>
      {children}
    </label>
  )

  return (
    <div className="space-y-4 text-sm">
      {bookings > 0 && (
        <p className="text-xs rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2">
          🎟️ {bi(`${bookings} réservation(s) active(s) : un changement de date, d'heure, de lieu ou de prix les concerne.`, `${bookings} active booking(s): a new date, time, venue or price affects them.`)}
        </p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {L({ label: bi('Titre', 'Title'), wide: true, children: <input value={f.title} onChange={e => set('title', e.target.value)} maxLength={150} className={`${INPUT} ${err('title')}`} /> })}
        {L({ label: 'Description', wide: true, children: <textarea value={f.description} onChange={e => set('description', e.target.value)} rows={4} maxLength={2000} className={INPUT} /> })}
        {L({ label: bi('Catégorie', 'Category'), children: (
          <select value={f.category} onChange={e => set('category', e.target.value)} className={INPUT}>
            {Array.from(new Set([f.category, ...eventCategories()].filter(Boolean))).map(c => <option key={c} value={c}>{categoryLabel(c, locale)}</option>)}
          </select>) })}
        {L({ label: bi('Ville', 'City'), children: (
          <select value={f.city} onChange={e => set('city', e.target.value)} className={`${INPUT} ${err('city')}`}>
            {Array.from(new Set([f.city, ...visibleCities()].filter(Boolean))).map(c => <option key={c} value={c}>{c}</option>)}
          </select>) })}
        {L({ label: bi('Date de début', 'Start date'), children: <input type="date" value={f.date} onChange={e => set('date', e.target.value)} className={INPUT} /> })}
        {L({ label: bi('Heure de début', 'Start time'), children: <input type="time" value={f.time} onChange={e => set('time', e.target.value)} className={INPUT} /> })}
        {L({ label: bi('Date de fin (plusieurs jours)', 'End date (several days)'), children: <input type="date" value={f.end_date} min={f.date || undefined} onChange={e => set('end_date', e.target.value)} className={INPUT} /> })}
        {L({ label: bi('Heure de fin', 'End time'), children: <input type="time" value={f.end_time} onChange={e => set('end_time', e.target.value)} className={INPUT} /> })}
        {L({ label: bi('Lieu', 'Venue'), children: <>
          <input value={f.venue} onChange={e => set('venue', e.target.value)} maxLength={120} className={INPUT} />
          <ContactLink kind="map" map={{ address: [f.venue, f.neighborhood].filter(Boolean).join(', '), city: f.city }} label={bi('Voir sur Google Maps', 'View on Google Maps')} className="mt-1" />
        </> })}
        {L({ label: bi('Quartier', 'Area'), children: <input value={f.neighborhood} onChange={e => set('neighborhood', e.target.value)} maxLength={80} className={INPUT} /> })}
        {pinReady ? L({ label: bi('📍 Position sur la carte (coordonnées)', '📍 Map pin (coordinates)'), wide: true, children: <>
          <input value={f.pin} inputMode="decimal" placeholder="4.0525, 9.7001" onChange={e => set('pin', e.target.value)} className={`${INPUT} ${err('lat')}`} />
          <span className="block text-xs text-ink-tertiary mt-1">{bi('Google Maps : clic droit sur le lieu → copier les coordonnées. Vide = pas de position.', 'Google Maps: right-click the place → copy the coordinates. Empty = no pin.')}</span>
          {f.pin.trim() && !pin && <span className="block text-xs text-danger mt-1">{bi('Format : 4.0525, 9.7001', 'Format: 4.0525, 9.7001')}</span>}
          {pin && <ContactLink kind="map" map={{ lat: pin.lat, lng: pin.lng }} label={bi('Voir la position', 'View the pin')} className="mt-1" />}
        </> }) : (
          <p className="sm:col-span-2 text-xs text-ink-tertiary">📍 {bi('Position sur la carte : bientôt (base de données à mettre à jour).', 'Map pin: soon (database update pending).')}</p>
        )}
        {L({ label: bi('Prix (FCFA, vide = gratuit)', 'Price (FCFA, empty = free)'), children: <input type="number" min="0" inputMode="numeric" value={f.ticket_price} onChange={e => set('ticket_price', e.target.value)} className={INPUT} /> })}
        <label className="flex items-center gap-2 text-ink-primary self-end pb-2">
          <input type="checkbox" checked={f.price_is_from} onChange={e => set('price_is_from', e.target.checked)} className="w-4 h-4 accent-brand" />
          {bi('Prix « À partir de »', 'Price "From"')}
        </label>
        <div className="sm:col-span-2">
          <span className="block text-xs font-semibold text-ink-secondary mb-1">{bi('Réservation', 'Booking')}</span>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={bi('Réservation', 'Booking')}>
            {([['info', bi('ℹ️ Infos seulement (lien « Billets / Infos »)', 'ℹ️ Info only ("Tickets / Info" link)')], ['platform', bi('🎟️ Réservations sur Tchop & Ndjoka', '🎟️ Bookings on Tchop & Ndjoka')]] as const).map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={f.booking_mode === v} onClick={() => set('booking_mode', v)}
                className={`${BTN} ${f.booking_mode === v ? 'border-brand bg-brand-light text-brand-darker' : 'border-divider bg-white text-ink-secondary'} ${err('booking_mode')}`}>{label}</button>
            ))}
          </div>
        </div>
        {L({ label: bi('Lien « Billets / Infos »', '"Tickets / Info" link'), wide: true, children: <>
          <input type="url" inputMode="url" value={f.info_link} onChange={e => set('info_link', e.target.value)} placeholder="https://" className={`${INPUT} ${err('info_link')}`} />
          <ContactLink kind="ticket" value={f.info_link} className="mt-1" />
        </> })}
        {L({ label: bi('WhatsApp de contact (public)', 'Contact WhatsApp (public)'), children: <>
          <PhoneInput value={f.whatsapp} onChange={full => set('whatsapp', full)} />
          <ContactLink kind="whatsapp" value={f.whatsapp} className="mt-1" />
        </> })}
        {L({ label: bi('Numéro qui reçoit les réservations', 'Number that gets the bookings'), children: <>
          <PhoneInput value={f.notify_phone} onChange={full => set('notify_phone', full)} />
          <ContactLink kind="phone" value={f.notify_phone} className="mt-1" />
        </> })}
      </div>

      {ask ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 space-y-2">
          <p className="text-sm text-amber-900 font-semibold">
            ⚠️ {bi(`${bookings} personne(s) ont réservé. La date, l'heure, le lieu ou le prix change.`, `${bookings} people have booked. The date, time, venue or price changes.`)}
          </p>
          <p className="text-xs text-amber-900">{bi('Les prévenir sur WhatsApp (nouvelle date / lieu / prix) ?', 'Tell them on WhatsApp (new date / venue / price)?')}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => send(ask, true)} className="bg-brand hover:bg-brand-dark disabled:opacity-50 text-white px-4 py-2 rounded-xl text-sm font-semibold">
              💬 {bi('Enregistrer et prévenir', 'Save and tell them')}
            </button>
            <button type="button" disabled={busy} onClick={() => send(ask, false)} className="border border-divider bg-white px-4 py-2 rounded-xl text-sm font-semibold text-ink-secondary disabled:opacity-50">
              {bi('Enregistrer sans prévenir', 'Save without telling')}
            </button>
            <button type="button" disabled={busy} onClick={() => setAsk(null)} className="px-3 py-2 text-sm text-ink-tertiary">{bi('Annuler', 'Cancel')}</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={save} disabled={busy} className="bg-brand hover:bg-brand-dark disabled:opacity-50 text-white px-4 py-2 rounded-xl text-sm font-semibold">
          {busy ? '…' : bi('Enregistrer', 'Save')}
        </button>
      )}
      {msg && <p className={`text-xs ${msg.ok ? 'text-emerald-700' : 'text-danger'}`}>{msg.text}</p>}

      <div className="border-t border-divider pt-3">
        <p className="text-xs font-semibold text-ink-secondary mb-2">📷 {bi('Affiche, cadrage et crédit', 'Poster, framing and credit')}</p>
        <AdminPhotoPanel target="events" id={eventId} credit={poster.credit} onSaved={() => onSaved()}
          slots={[{ field: 'cover_photo', label: bi('Affiche', 'Poster'), url: poster.url, kind: 'event_poster', focus: poster.focus }]} />
      </div>
    </div>
  )
}
