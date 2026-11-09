'use client'

// « 🏪 Infos du restaurant »: everything customers see about the restaurant —
// photos (cover + logo), name, description, cuisine, city, area, address,
// map pin, phone, WhatsApp. Live at once.
//   Owner (Dashboard → Réglages): /api/restaurants/[id]/details + /image;
//     Tchop & Ndjoka is told about name / address / phone changes.
//   Admin (`admin`, Admin → Restaurants, any restaurant — managed ones too):
//     /api/admin/restaurants/[id]/info + /photo, plus the photo credit and a
//     typed map pin ("4.0525, 9.7001", e.g. copied from Google Maps).

import { useState } from 'react'
import Image from 'next/image'
import { useBi } from '@/lib/languageContext'
import { useRefData } from '@/lib/useRefData'
import { refList } from '@/lib/refData'
import { visibleCities } from '@/lib/cities'
import RefPicker, { OTHER } from '@/components/RefPicker'
import PhoneInput from '@/components/PhoneInput'
import type { Restaurant } from '@/types'
import { parsePin } from '@/lib/restaurantDetailFields'
import { FOCUS_OF, focusStyle } from '@/lib/photoFocus'
import FocusPicker from '@/components/FocusPicker'
import { uploadPhoto } from '@/lib/uploadPhoto'

const INPUT = 'w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand bg-white'
const BTN = 'text-xs font-semibold px-3 py-1.5 rounded-full border'

type R = Restaurant & { address?: string | null; phone?: string | null; lat?: number | null; lng?: number | null; logo_url?: string | null; photo_credit?: string | null; image_focus?: string | null; logo_focus?: string | null }

function formOf(r: R, cuisineCode: string) {
  return {
    name: r.name ?? '', description: r.description ?? '', cuisine_type: cuisineCode, cuisine_other: '',
    city: r.city ?? '', neighborhood: r.neighborhood ?? '', address: r.address ?? '',
    phone: r.phone ?? '', whatsapp: r.whatsapp ?? '',
  }
}

// Outside the panel: a component defined inside it would remount (and lose
// focus) on every keystroke.
function L({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="block text-xs font-semibold text-ink-secondary mb-1">{label}</span>
      {children}
    </label>
  )
}

export default function RestaurantInfoPanel({ restaurant, onChange, admin = false }: { restaurant: R; onChange: (r: R) => void; admin?: boolean }) {
  const bi = useBi()
  useRefData()
  const cuisineCode = refList('cuisine').find(v => v.label_fr === restaurant.cuisine_type || v.code === restaurant.cuisine_type)?.code ?? ''
  const [f, setF] = useState(() => formOf(restaurant, cuisineCode))
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [pinText, setPinText] = useState('')
  const [framing, setFraming] = useState<'image_url' | 'logo_url' | null>(null)
  const [credit, setCredit] = useState(restaurant.photo_credit ?? '')
  const detailsUrl = admin ? `/api/admin/restaurants/${restaurant.id}/info` : `/api/restaurants/${restaurant.id}/details`
  const photoUrl = admin ? `/api/admin/restaurants/${restaurant.id}/photo` : `/api/restaurants/${restaurant.id}/image`
  const set = (k: keyof typeof f, v: string) => setF(p => ({ ...p, [k]: v }))
  const start = formOf(restaurant, cuisineCode)

  async function post(url: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) { setMsg({ ok: false, text: String(d?.error ?? bi('Erreur', 'Error')) }); return null }
    return d as Record<string, unknown>
  }

  async function save() {
    setMsg(null)
    const body: Record<string, unknown> = {}
    for (const k of ['name', 'description', 'neighborhood', 'address', 'phone', 'whatsapp', 'city'] as const) {
      if (f[k].trim() !== start[k].trim()) body[k] = f[k]
    }
    if (f.cuisine_type !== start.cuisine_type || f.cuisine_other.trim()) Object.assign(body, f.cuisine_type === OTHER ? { cuisine_type: '', cuisine_other: f.cuisine_other.trim() } : { cuisine_type: f.cuisine_type, cuisine_other: '' })
    if (pin) { body.lat = pin.lat; body.lng = pin.lng }
    if (!Object.keys(body).length) { setMsg({ ok: true, text: bi('Rien à changer', 'Nothing to change') }); return }
    setBusy('save')
    try {
      const d = await post(detailsUrl, body)
      if (d?.restaurant) {
        const r = d.restaurant as R
        onChange(r); setPin(null); setPinText('')
        setF(formOf(r, refList('cuisine').find(v => v.label_fr === r.cuisine_type)?.code ?? ''))
        setMsg({ ok: true, text: bi('✅ Enregistré, visible tout de suite', '✅ Saved, visible right away') })
      }
    } catch { setMsg({ ok: false, text: bi('Réseau', 'Network') }) }
    finally { setBusy(null) }
  }

  function locate() {
    setMsg(null)
    if (!('geolocation' in navigator)) { setMsg({ ok: false, text: bi('Position indisponible sur cet appareil', 'Location unavailable on this device') }); return }
    setBusy('pin')
    navigator.geolocation.getCurrentPosition(
      p => { setPin({ lat: p.coords.latitude, lng: p.coords.longitude }); setBusy(null); setMsg({ ok: true, text: bi('Position prise : enregistrez pour la garder.', 'Position taken: save to keep it.') }) },
      () => { setBusy(null); setMsg({ ok: false, text: bi('Position refusée ou introuvable', 'Location refused or not found') }) },
      { enableHighAccuracy: true, timeout: 15000 },
    )
  }

  async function photo(field: 'image_url' | 'logo_url', file: File | null) {
    setMsg(null); setBusy(field)
    try {
      let body: Record<string, unknown> = { [field]: null }
      if (file) {
        const up = await uploadPhoto(file, { kind: field === 'logo_url' ? 'restaurant_logo' : 'restaurant_hero', pathPrefix: 'restaurants' })
        if (!up.ok) { setMsg({ ok: false, text: bi(up.error.fr, up.error.en) }); return }
        body = { [field]: up.url, blur_hash: up.blur_hash }
      }
      const d = await post(photoUrl, body)
      if (d) {
        const row = (d.restaurant ?? d) as Record<string, unknown>
        onChange({
          ...restaurant, image_url: (row.image_url as string | null) ?? null, logo_url: (row.logo_url as string | null) ?? null,
          ...('photo_credit' in row ? { photo_credit: row.photo_credit as string | null } : admin ? {} : { photo_credit: null }),
          // A new photo starts centred.
          [FOCUS_OF[field]]: 'image_focus' in row || 'logo_focus' in row ? (row[FOCUS_OF[field]] as string | null) ?? null : null,
        } as R)
        setFraming(null)
        setMsg({ ok: true, text: file ? bi('✅ Photo mise à jour', '✅ Photo updated') : bi('Photo retirée', 'Photo removed') })
      }
    } catch { setMsg({ ok: false, text: bi('Réseau', 'Network') }) }
    finally { setBusy(null) }
  }

  async function saveFocus(field: 'image_url' | 'logo_url', v: string | null) {
    setMsg(null); setBusy(`focus-${field}`)
    try {
      const d = await post(photoUrl, { [FOCUS_OF[field]]: v })
      if (d) {
        onChange({ ...restaurant, [FOCUS_OF[field]]: v } as R)
        setMsg({ ok: true, text: bi('✅ Cadrage enregistré', '✅ Framing saved') })
      }
    } catch { setMsg({ ok: false, text: bi('Réseau', 'Network') }) }
    finally { setBusy(null) }
  }

  async function saveCredit() {
    setMsg(null); setBusy('credit')
    try {
      const d = await post(photoUrl, { photo_credit: credit.trim() || null })
      if (d) {
        const row = (d.restaurant ?? {}) as Record<string, unknown>
        onChange({ ...restaurant, photo_credit: (row.photo_credit as string | null) ?? (credit.trim() || null) } as R)
        setMsg({ ok: true, text: bi('✅ Crédit enregistré', '✅ Credit saved') })
      }
    } catch { setMsg({ ok: false, text: bi('Réseau', 'Network') }) }
    finally { setBusy(null) }
  }

  const slot = (field: 'image_url' | 'logo_url', label: string, url: string | null | undefined, box: string) => (
    <div className="rounded-xl border border-divider p-3">
      <p className="text-xs font-semibold text-ink-secondary mb-2">{label}</p>
      <div className={`relative ${box} rounded-lg overflow-hidden bg-brand-light`}>
        {url ? <Image src={url} alt={label} fill className="object-cover" style={focusStyle(restaurant[FOCUS_OF[field]])} sizes="240px" />
          : <span className="absolute inset-0 flex items-center justify-center text-xs text-ink-tertiary">{bi('Aucune', 'None')}</span>}
      </div>
      <div className="flex flex-wrap gap-2 mt-2">
        <label className={`${BTN} border-brand text-brand-darker bg-white cursor-pointer ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
          {busy === field ? '…' : url ? bi('🔄 Remplacer', '🔄 Replace') : bi('⬆️ Ajouter', '⬆️ Add')}
          <input type="file" accept="image/*" className="hidden" disabled={!!busy}
            onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void photo(field, file) }} />
        </label>
        {url && (
          <button type="button" disabled={!!busy} className={`${BTN} border-divider text-ink-secondary bg-white disabled:opacity-50`}
            onClick={() => { if (confirm(bi('Retirer cette photo ?', 'Remove this photo?'))) void photo(field, null) }}>
            🗑️ {bi('Retirer', 'Remove')}
          </button>
        )}
        {url && (
          <button type="button" disabled={!!busy} aria-expanded={framing === field} onClick={() => setFraming(framing === field ? null : field)}
            className={`${BTN} border-divider text-ink-secondary bg-white disabled:opacity-50`}>
            🎯 {bi('Cadrage', 'Framing')}
          </button>
        )}
      </div>
      {url && framing === field && (
        <div className="mt-3">
          <p className="text-xs text-ink-tertiary mb-2">{bi('Touchez la partie à montrer sur les cartes (aperçu à la taille réelle).', 'Tap the part to show on the cards (real-size preview).')}</p>
          <FocusPicker key={url} src={url} shape="cover" value={restaurant[FOCUS_OF[field]] ?? null}
            busy={busy === `focus-${field}`} onSave={v => void saveFocus(field, v)} />
        </div>
      )}
    </div>
  )

  return (
    <section className="bg-white rounded-2xl shadow-sm p-4 mb-4">
      <h3 className="font-bold text-ink-primary mb-1">🏪 {bi('Infos du restaurant', 'Restaurant details')}</h3>
      <p className="text-xs text-ink-tertiary mb-3">
        {admin
          ? bi('Ce que les clients voient. Visible tout de suite ; chaque changement est enregistré dans le journal.', 'What customers see. Visible right away; every change is logged.')
          : bi('Ce que vos clients voient. Visible tout de suite ; l\'équipe Tchop & Ndjoka est prévenue si vous changez le nom, l\'adresse ou les numéros.',
            'What your customers see. Visible right away; the Tchop & Ndjoka team is told if you change the name, address or numbers.')}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        {slot('image_url', bi('Photo de couverture', 'Cover photo'), restaurant.image_url, 'w-full aspect-[2/1]')}
        {slot('logo_url', bi('Logo', 'Logo'), restaurant.logo_url, 'w-20 h-20')}
      </div>
      {admin && (
        <div className="flex gap-2 items-end mb-3">
          <label className="block flex-1">
            <span className="block text-xs font-semibold text-ink-secondary mb-1">{bi('Crédit photo (facultatif, affiché en petit sur la photo)', 'Photo credit (optional, shown small on the photo)')}</span>
            <input value={credit} onChange={e => setCredit(e.target.value)} maxLength={120} className={INPUT}
              placeholder={bi('Ex. : page Facebook du restaurant, avec accord', 'E.g. the restaurant\'s Facebook page, with permission')} />
          </label>
          <button type="button" onClick={saveCredit} disabled={!!busy || credit.trim() === (restaurant.photo_credit ?? '')}
            className={`${BTN} border-brand text-brand-darker bg-white disabled:opacity-40 mb-1`}>
            {busy === 'credit' ? '…' : bi('Enregistrer', 'Save')}
          </button>
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
        <L label={bi('Nom', 'Name')} wide><input value={f.name} onChange={e => set('name', e.target.value)} maxLength={120} className={INPUT} /></L>
        <L label={bi('Description', 'Description')} wide><textarea value={f.description} onChange={e => set('description', e.target.value)} maxLength={1000} rows={3} className={INPUT} /></L>
        <L label={bi('Cuisine', 'Cuisine')}>
          <RefPicker kind="cuisine" className={INPUT} value={f.cuisine_type} other={f.cuisine_other}
            onChange={(v, o) => setF(p => ({ ...p, cuisine_type: v, cuisine_other: o }))} optional />
        </L>
        <L label={bi('Ville', 'City')}>
          <select value={f.city} onChange={e => set('city', e.target.value)} className={INPUT}>
            {Array.from(new Set([f.city, ...visibleCities()].filter(Boolean))).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </L>
        <L label={bi('Quartier', 'Area')}><input value={f.neighborhood} onChange={e => set('neighborhood', e.target.value)} maxLength={80} className={INPUT} /></L>
        <L label={bi('Adresse', 'Address')}><input value={f.address} onChange={e => set('address', e.target.value)} maxLength={200} className={INPUT} placeholder={bi('Ex. : rue 1.234, face pharmacie…', 'E.g. street 1.234, opposite the pharmacy…')} /></L>
        <div className="sm:col-span-2 rounded-xl border border-divider p-3">
          <p className="text-xs font-semibold text-ink-secondary mb-1">📍 {bi('Position sur la carte', 'Map pin')}</p>
          <p className="text-xs text-ink-tertiary mb-2">
            {pin ? bi('Nouvelle position prise (pas encore enregistrée).', 'New position taken (not saved yet).')
              : admin ? bi('Collez les coordonnées (Google Maps : clic droit sur le lieu) ou utilisez votre position.', 'Paste the coordinates (Google Maps: right-click the place) or use your position.')
              : bi('Au restaurant, appuyez pour placer le point à l\'endroit exact.', 'At the restaurant, tap to put the pin at the exact spot.')}
            {(pin ?? (restaurant.lat && restaurant.lng ? { lat: restaurant.lat, lng: restaurant.lng } : null)) && (
              <> · <a className="underline" target="_blank" rel="noopener noreferrer"
                href={`https://www.google.com/maps?q=${(pin ?? restaurant).lat},${(pin ?? restaurant).lng}`}>{bi('Voir', 'View')} ↗</a></>
            )}
          </p>
          {admin && (
            <input value={pinText} inputMode="decimal" placeholder="4.0525, 9.7001" className={`${INPUT} mb-2`}
              aria-label={bi('Coordonnées', 'Coordinates')}
              onChange={e => { setPinText(e.target.value); setPin(parsePin(e.target.value)) }} />
          )}
          {admin && pinText && !pin && <p className="text-xs text-danger mb-2">{bi('Format : 4.0525, 9.7001', 'Format: 4.0525, 9.7001')}</p>}
          <button type="button" onClick={locate} disabled={!!busy} className={`${BTN} border-divider bg-white disabled:opacity-50`}>
            {busy === 'pin' ? '…' : bi('📍 Utiliser ma position actuelle', '📍 Use my current position')}
          </button>
        </div>
        <L label={bi('Téléphone (public, facultatif)', 'Phone (public, optional)')}><PhoneInput value={f.phone} onChange={full => set('phone', full)} /></L>
        <L label={bi('WhatsApp (commandes et bot)', 'WhatsApp (orders and bot)')}><PhoneInput value={f.whatsapp} onChange={full => set('whatsapp', full)} /></L>
      </div>
      {f.whatsapp.trim() !== start.whatsapp.trim() && (
        <p className="text-xs text-amber-800 mt-2">⚠️ {bi('Ce numéro reçoit les commandes et parle au bot Tchop & Ndjoka : vérifiez-le bien.', 'This number gets the orders and talks to the Tchop & Ndjoka bot: double-check it.')}</p>
      )}
      {msg && <p className={`text-xs mt-3 ${msg.ok ? 'text-brand-darker' : 'text-danger'}`}>{msg.text}</p>}
      <button type="button" onClick={save} disabled={!!busy}
        className="mt-3 w-full bg-brand hover:bg-brand-dark text-white py-2.5 rounded-xl font-semibold text-sm disabled:opacity-50">
        {busy === 'save' ? '…' : bi('Enregistrer', 'Save')}
      </button>
    </section>
  )
}
