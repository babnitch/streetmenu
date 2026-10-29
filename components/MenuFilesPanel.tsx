'use client'

// "Carte en photo / PDF" (N4a) — dashboard → Menu, and the admin restaurant
// card. Up to 5 files (photos or one PDF, 5 MB each): add, reorder, delete.
// Photos are shrunk on the phone, then every file goes straight to Storage
// with a one-time upload link; the server checks it and records it.
// Also shows the WhatsApp / call taps of the last 30 days.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useBi } from '@/lib/languageContext'
import { supabase } from '@/lib/supabase'
import { shrinkImage } from '@/lib/shrinkImage'
import { MENU_FILES_BUCKET, MAX_MENU_FILES, menuFileRefusal, type MenuFile } from '@/lib/menuFiles'

export default function MenuFilesPanel({ restaurantId, compact = false }: { restaurantId: string; compact?: boolean }) {
  const bi = useBi()
  const base = `/api/restaurants/${restaurantId}/menu-files`
  const [files, setFiles] = useState<MenuFile[] | null>(null)
  const [clicks, setClicks] = useState<{ whatsapp: number; call: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const r = await fetch(base, { cache: 'no-store' }).then(x => x.json()).catch(() => null)
    setFiles(Array.isArray(r?.files) ? r.files : [])
    const c = await fetch(`/api/restaurants/${restaurantId}/contact-click`, { cache: 'no-store' }).then(x => x.ok ? x.json() : null).catch(() => null)
    if (c) setClicks({ whatsapp: c.whatsapp ?? 0, call: c.call ?? 0 })
  }, [base, restaurantId])
  useEffect(() => { void load() }, [load])

  async function add(list: FileList | null) {
    if (!list || !files) return
    setError(''); setBusy(true)
    let current = files
    for (const raw of Array.from(list)) {
      const file = await shrinkImage(raw)
      const refusal = menuFileRefusal(current, file.type, file.size)
      if (refusal) { setError(`${raw.name} : ${bi(refusal.split(' / ')[0], refusal.split(' / ')[1] ?? refusal)}`); break }
      const u = await fetch(`${base}/upload-url`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: file.type, bytes: file.size }),
      }).then(async x => ({ ok: x.ok, d: await x.json().catch(() => ({})) }))
      if (!u.ok) { setError(u.d.error ?? bi('Envoi impossible', 'Upload failed')); break }
      const up = await supabase.storage.from(MENU_FILES_BUCKET).uploadToSignedUrl(u.d.path, u.d.token, file, { contentType: file.type })
      if (up.error) { setError(bi('Envoi impossible, réessayez.', 'Upload failed, please try again.')); break }
      const done = await fetch(base, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: u.d.path }),
      }).then(async x => ({ ok: x.ok, d: await x.json().catch(() => ({})) }))
      if (!done.ok) { setError(done.d.error ?? bi('Envoi impossible', 'Upload failed')); break }
      current = done.d.files
      setFiles(current)
    }
    setBusy(false)
    if (input.current) input.current.value = ''
  }

  async function remove(f: MenuFile) {
    if (!confirm(bi('Supprimer ce fichier de la carte ?', 'Delete this file from the menu?'))) return
    setBusy(true)
    const r = await fetch(`${base}/${f.id}`, { method: 'DELETE' }).then(x => x.json()).catch(() => null)
    setBusy(false)
    if (Array.isArray(r?.files)) setFiles(r.files)
  }

  async function move(i: number, dir: -1 | 1) {
    if (!files) return
    const next = [...files]
    const j = i + dir
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    setFiles(next)
    await fetch(base, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: next.map(f => f.id) }) })
  }

  const full = (files?.length ?? 0) >= MAX_MENU_FILES
  return (
    <section className={compact ? 'text-sm' : 'bg-white border border-divider rounded-2xl p-4 mb-4'}>
      {!compact && <h3 className="font-bold text-ink-primary">📄 {bi('Carte en photo / PDF', 'Menu as photo / PDF')}</h3>}
      <p className="text-xs text-ink-tertiary mt-0.5">
        {bi('Votre carte papier, sans tout retaper : jusqu\'à 5 photos ou un PDF (5 Mo max).', 'Your paper menu without retyping it: up to 5 photos or one PDF (5 MB max).')}
      </p>
      {files === null ? (
        <p className="text-xs text-ink-tertiary mt-2">{bi('Chargement…', 'Loading…')}</p>
      ) : (
        <ul className="mt-3 grid grid-cols-3 sm:grid-cols-5 gap-2">
          {files.map((f, i) => (
            <li key={f.id} className="relative rounded-xl overflow-hidden border border-divider bg-surface-muted aspect-[3/4]">
              {f.kind === 'pdf' ? (
                <a href={f.url} target="_blank" rel="noopener noreferrer" className="absolute inset-0 flex flex-col items-center justify-center text-ink-secondary">
                  <span className="text-3xl" aria-hidden="true">📄</span><span className="text-[11px] font-semibold">PDF</span>
                </a>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.url} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy" />
              )}
              <div className="absolute inset-x-0 bottom-0 flex justify-between bg-black/50 text-white text-xs">
                <button type="button" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={bi('Avant', 'Earlier')} className="px-2 py-1 disabled:opacity-30">◀</button>
                <button type="button" disabled={busy} onClick={() => remove(f)} aria-label={bi('Supprimer', 'Delete')} className="px-2 py-1">🗑</button>
                <button type="button" disabled={busy || i === files.length - 1} onClick={() => move(i, 1)} aria-label={bi('Après', 'Later')} className="px-2 py-1 disabled:opacity-30">▶</button>
              </div>
            </li>
          ))}
          {!full && (
            <li>
              <label className={`aspect-[3/4] rounded-xl border-2 border-dashed border-divider flex flex-col items-center justify-center text-ink-tertiary cursor-pointer hover:border-brand ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
                <span className="text-2xl" aria-hidden="true">{busy ? '…' : '+'}</span>
                <span className="text-[11px] font-semibold">{bi('Ajouter', 'Add')}</span>
                <input ref={input} type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" className="sr-only"
                  onChange={e => add(e.target.files)} />
              </label>
            </li>
          )}
        </ul>
      )}
      {error && <p className="text-xs text-danger mt-2">{error}</p>}
      {clicks && (
        <p className="text-xs text-ink-secondary mt-3">
          📈 {bi(`30 derniers jours : ${clicks.whatsapp} clic(s) WhatsApp · ${clicks.call} appel(s) depuis Tchop & Ndjoka`,
            `Last 30 days: ${clicks.whatsapp} WhatsApp tap(s) · ${clicks.call} call(s) from Tchop & Ndjoka`)}
        </p>
      )}
    </section>
  )
}
