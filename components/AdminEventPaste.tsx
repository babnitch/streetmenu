'use client'

// Admin → Événements → « Coller une annonce » (lib/discovery/paste.ts):
// paste the text of an event post (and/or its link) → the facts fill the
// "Créer un événement" form (info only, no poster) → the admin checks and
// publishes. The pasted text is never saved.

import { useState } from 'react'
import { useBi } from '@/lib/languageContext'
import { waLink } from '@/lib/legalInfo'
import { organiserMessage } from '@/lib/discovery/candidates'
import { AdminEventCreate } from '@/components/AdminEventManaged'
import type { PasteForm, PasteNote } from '@/lib/discovery/paste'
import type { Event } from '@/types'

const INPUT = 'w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand bg-white'
const MAX = 8000

const NOTE_TEXT: Record<PasteNote, { fr: string; en: string }> = {
  social_link_not_opened: { fr: 'Lien de réseau social jamais ouvert : seul le texte collé a été lu.', en: 'Social-media link never opened: only the pasted text was read.' },
  link_not_opened:        { fr: 'Lien non ouvert (site non approuvé) : seul le texte collé a été lu.', en: 'Link not opened (site not approved): only the pasted text was read.' },
  read_from_source:       { fr: 'Lu depuis la billetterie (source approuvée).', en: 'Read from the ticketing site (approved source).' },
  city_unknown:           { fr: 'Ville non reconnue : choisissez-la.', en: 'City not recognised: pick it.' },
  date_missing:           { fr: 'Date introuvable : indiquez-la.', en: 'No date found: enter it.' },
  not_an_event:           { fr: 'Ce texte ne ressemble pas à un événement : vérifiez.', en: 'This text doesn\'t look like an event: check it.' },
  end_dropped:            { fr: 'Fin incohérente retirée : vérifiez les heures.', en: 'Inconsistent end removed: check the times.' },
}

interface Extracted { form: PasteForm; organiser_phone: string | null; notes: PasteNote[]; used_ai: boolean; more_dates?: number }

export default function AdminEventPaste({ onClose, onCreated }: { onClose: () => void; onCreated: (e: Event) => void }) {
  const bi = useBi()
  const [text, setText] = useState('')
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<Extracted | null>(null)

  async function read() {
    setError('')
    if (!text.trim() && !link.trim()) { setError(bi('Collez le texte de l\'annonce', 'Paste the post text')); return }
    setBusy(true)
    try {
      const res = await fetch('/api/admin/events/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, link }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(String(d?.error ?? bi('Erreur', 'Error'))); return }
      setResult(d as Extracted)
    } catch {
      setError(bi('Réseau', 'Network'))
    } finally {
      setBusy(false)
    }
  }

  if (result) {
    const f = result.form
    const ask = result.organiser_phone && f.title && f.date
      ? waLink(result.organiser_phone, organiserMessage({ title: f.title, organiser_name: f.organizer_name || null, start_date: f.date, start_time: f.time || null, end_date: f.end_date || null, end_time: f.end_time || null, venue: f.venue || null, city: f.city || '' }, 'fr'))
      : null
    return (
      <AdminEventCreate
        heading={bi('Annonce collée : vérifiez puis publiez', 'Pasted post: check, then publish')}
        initial={f as never}
        extraBody={{ origin: 'paste' }}
        noPoster
        notice={
          <div className="text-xs text-ink-secondary mb-4 rounded-xl bg-surface px-3 py-2 space-y-1">
            <p>✨ {result.used_ai
              ? bi('Rempli automatiquement (IA) à partir du texte : vérifiez chaque champ. Écrivez votre propre description.', 'Filled in automatically (AI) from the text: check every field. Write your own description.')
              : bi('Rempli à partir de la billetterie : vérifiez chaque champ.', 'Filled in from the ticketing site: check every field.')}</p>
            {result.notes.map(n => <p key={n}>⚠️ {bi(NOTE_TEXT[n].fr, NOTE_TEXT[n].en)}</p>)}
            {!!result.more_dates && <p>📅 {bi(`${result.more_dates} autre(s) date(s) sur la page : une seule est reprise ici.`, `${result.more_dates} more date(s) on the page: only one is used here.`)}</p>}
            {result.organiser_phone && (
              <p>
                📞 {bi('Contact trouvé (non publié)', 'Contact found (not published)')} : <span className="font-mono">{result.organiser_phone}</span>
                {ask && <> · <a href={ask} target="_blank" rel="noopener noreferrer" className="underline font-semibold">{bi('Demander l\'accord sur WhatsApp', 'Ask for permission on WhatsApp')}</a></>}
              </p>
            )}
          </div>
        }
        onClose={onClose}
        onCreated={onCreated}
      />
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end md:items-center justify-center p-0 md:p-4" role="dialog" aria-modal="true">
      <div className="bg-white w-full md:max-w-2xl max-h-[92vh] overflow-y-auto rounded-t-3xl md:rounded-2xl p-5 shadow-xl">
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-bold text-ink-primary text-lg">{bi('Coller une annonce', 'Paste a post')}</h2>
          <button type="button" onClick={onClose} aria-label={bi('Fermer', 'Close')} className="w-9 h-9 rounded-full hover:bg-surface-muted text-xl">✕</button>
        </div>
        <p className="text-xs text-ink-tertiary mb-4">
          {bi('Copiez le texte d\'une annonce (Instagram, Facebook, WhatsApp, affiche…) et collez-le ici. Les champs du formulaire sont remplis pour vous ; le texte collé n\'est pas enregistré. Les liens Instagram, Facebook, TikTok et X ne sont jamais ouverts.',
            'Copy the text of a post (Instagram, Facebook, WhatsApp, flyer…) and paste it here. The form fields are filled in for you; the pasted text is not saved. Instagram, Facebook, TikTok and X links are never opened.')}
        </p>
        <label className="block text-sm">
          <span className="block text-xs font-semibold text-ink-secondary mb-1">{bi('Texte de l\'annonce', 'Post text')}</span>
          <textarea value={text} onChange={e => setText(e.target.value.slice(0, MAX))} rows={8} className={INPUT}
            placeholder={bi('Ex. : 🎶 Concert live ce samedi 20h au Bôj, Douala. Entrée 5 000 F…', 'E.g. 🎶 Live concert this Saturday 8pm at Bôj, Douala. Entry 5,000 F…')} />
          <span className="block text-right text-[11px] text-ink-tertiary">{text.length} / {MAX}</span>
        </label>
        <label className="block text-sm mt-2">
          <span className="block text-xs font-semibold text-ink-secondary mb-1">{bi('Lien (facultatif)', 'Link (optional)')}</span>
          <input type="url" inputMode="url" value={link} onChange={e => setLink(e.target.value)} placeholder="https://" className={INPUT} />
        </label>
        {error && <p className="text-xs text-danger mt-3">{error}</p>}
        <div className="flex gap-3 mt-4">
          <button type="button" onClick={read} disabled={busy}
            className="flex-1 bg-brand hover:bg-brand-dark text-white py-2.5 rounded-xl font-semibold text-sm disabled:opacity-50">
            {busy ? bi('Lecture…', 'Reading…') : bi('✨ Remplir le formulaire', '✨ Fill in the form')}
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
