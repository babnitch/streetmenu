'use client'

// Admin → Restaurants / Événements → « 📷 Photo »: replace or remove the
// photos of an existing restaurant (cover + logo) or event (poster), and the
// optional photo credit shown small on the photo. Uploads go through
// /api/upload/image (same resize + blur placeholder as the owner flow), then
// /api/admin/{restaurants|events}/[id]/photo saves and audits.

import { useState } from 'react'
import Image from 'next/image'
import { useBi } from '@/lib/languageContext'
import { PHOTO_CREDIT_MAX } from '@/lib/adminPhotos'

export interface PhotoSlot {
  field: 'image_url' | 'logo_url' | 'cover_photo'
  label: string
  url: string | null
  kind: 'restaurant_hero' | 'restaurant_logo' | 'event_poster'
}

const BTN = 'text-xs font-semibold px-3 py-1.5 rounded-full border'

export default function AdminPhotoPanel({ target, id, slots, credit, onSaved }: {
  target: 'restaurants' | 'events'
  id: string
  slots: PhotoSlot[]
  credit: string | null
  onSaved: (row: Record<string, unknown>) => void
}) {
  const bi = useBi()
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [creditText, setCreditText] = useState(credit ?? '')

  async function save(body: Record<string, unknown>, key: string, okText: string) {
    setBusy(key); setMsg(null)
    try {
      const res = await fetch(`/api/admin/${target}/${id}/photo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setMsg({ ok: false, text: String(d?.error ?? bi('Erreur', 'Error')) }); return }
      const row = (d.restaurant ?? d.event ?? {}) as Record<string, unknown>
      onSaved(row)
      if ('photo_credit' in row) setCreditText((row.photo_credit as string | null) ?? '')
      setMsg({ ok: true, text: okText })
    } catch {
      setMsg({ ok: false, text: bi('Réseau', 'Network') })
    } finally {
      setBusy(null)
    }
  }

  async function upload(slot: PhotoSlot, file: File) {
    setBusy(slot.field); setMsg(null)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('kind', slot.kind)
    fd.append('pathPrefix', target)
    let url = '', blur = ''
    try {
      const r = await fetch('/api/upload/image', { method: 'POST', body: fd })
      const j = await r.json().catch(() => ({}))
      if (r.ok && typeof j?.url === 'string') { url = j.url; blur = typeof j.blur_hash === 'string' ? j.blur_hash : '' }
    } catch { /* below */ }
    if (!url) { setBusy(null); setMsg({ ok: false, text: bi('L\'envoi a échoué, réessayez.', 'Upload failed, please try again.') }); return }
    await save({ [slot.field]: url, blur_hash: blur }, slot.field, bi('✅ Photo enregistrée', '✅ Photo saved'))
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {slots.map(slot => (
          <div key={slot.field} className="rounded-xl border border-divider bg-white p-3">
            <p className="text-xs font-semibold text-ink-secondary mb-2">{slot.label}</p>
            <div className={`relative ${slot.kind === 'restaurant_logo' ? 'w-20 h-20' : slot.kind === 'event_poster' ? 'w-24 aspect-[4/5]' : 'w-full aspect-[2/1]'} rounded-lg overflow-hidden bg-brand-light`}>
              {slot.url
                ? <Image src={slot.url} alt={slot.label} fill className="object-cover" sizes="240px" />
                : <span className="absolute inset-0 flex items-center justify-center text-xs text-ink-tertiary text-center px-1">{bi('Aucune (couverture générée)', 'None (generated cover)')}</span>}
            </div>
            <div className="flex flex-wrap gap-2 mt-2">
              <label className={`${BTN} border-brand text-brand-darker bg-white cursor-pointer ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
                {busy === slot.field ? '…' : slot.url ? bi('🔄 Remplacer', '🔄 Replace') : bi('⬆️ Ajouter', '⬆️ Add')}
                <input type="file" accept="image/*" className="hidden" disabled={!!busy}
                  onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(slot, f) }} />
              </label>
              {slot.url && (
                <button type="button" disabled={!!busy} className={`${BTN} border-divider text-ink-secondary bg-white disabled:opacity-50`}
                  onClick={() => { if (confirm(bi('Retirer cette photo ?', 'Remove this photo?'))) void save({ [slot.field]: null }, slot.field, bi('Photo retirée', 'Photo removed')) }}>
                  🗑️ {bi('Retirer', 'Remove')}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-divider bg-white p-3">
        <label className="block">
          <span className="block text-xs font-semibold text-ink-secondary mb-1">{bi('Crédit photo (facultatif, affiché en petit sur la photo)', 'Photo credit (optional, shown small on the photo)')}</span>
          <input value={creditText} maxLength={PHOTO_CREDIT_MAX} onChange={e => setCreditText(e.target.value)}
            placeholder={bi('Ex. : page Facebook du restaurant, avec accord', 'E.g. the restaurant\'s Facebook page, with permission')}
            className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand bg-white" />
        </label>
        <button type="button" disabled={!!busy || creditText.trim() === (credit ?? '')}
          onClick={() => void save({ photo_credit: creditText.trim() || null }, 'credit', bi('✅ Crédit enregistré', '✅ Credit saved'))}
          className={`${BTN} mt-2 border-brand text-brand-darker bg-white disabled:opacity-40`}>
          {busy === 'credit' ? '…' : bi('Enregistrer le crédit', 'Save the credit')}
        </button>
      </div>
      {msg && <p className={`text-xs ${msg.ok ? 'text-brand-darker' : 'text-danger'}`}>{msg.text}</p>}
    </div>
  )
}
