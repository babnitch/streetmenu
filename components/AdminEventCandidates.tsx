'use client'

// Admin → Événements → « Trouvés cette nuit »: events the nightly discovery
// found (lib/discovery/run.ts), waiting for a decision. Nothing is ever
// published by itself. Per event:
//   - Voir la source        the ticketing page
//   - Contacter             the permission message (FR/EN) to send from the
//                           admin's own WhatsApp / mail, then "contacté"
//   - Publier en info seule the "Créer un événement" form, pre-filled, info
//                           only, ticket link, no poster
//   - Ignorer               with a reason
// Moderators see the list; admins act. Every action is audited server-side.

import { useState } from 'react'
import { useBi, useLanguage } from '@/lib/languageContext'
import { formatEventWhen } from '@/lib/eventDate'
import { formatFCFA } from '@/lib/money'
import { categoryLabel } from '@/lib/categoryLabels'
import { waLink } from '@/lib/legalInfo'
import {
  organiserMessage, candidateToForm, IGNORE_REASONS, IGNORE_REASON_LABELS,
  type EventCandidate, type IgnoreReason,
} from '@/lib/discovery/candidates'
import { AdminEventCreate } from '@/components/AdminEventManaged'
import type { Event } from '@/types'

const BTN = 'text-xs font-semibold px-3 py-1.5 rounded-full border'

async function act(id: string, body: Record<string, unknown>): Promise<{ ok: boolean; error: string }> {
  try {
    const res = await fetch(`/api/admin/event-candidates/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const d = await res.json().catch(() => ({}))
    return { ok: res.ok, error: String(d?.error ?? '') }
  } catch {
    return { ok: false, error: 'Réseau / Network' }
  }
}

export default function AdminEventCandidates({ candidates, canAct, onChanged, onPublished, toast }: {
  candidates: EventCandidate[]
  canAct: boolean
  onChanged: () => void
  onPublished: (e: Event) => void
  toast: (msg: string, ok?: boolean) => void
}) {
  const bi = useBi()
  const [publishing, setPublishing] = useState<EventCandidate | null>(null)

  if (candidates.length === 0) {
    return (
      <div className="text-center py-16 text-ink-tertiary">
        <div className="text-4xl mb-3">🔭</div>
        <p>{bi('Rien de nouveau. La recherche tourne chaque nuit (ayatickets.fr).', 'Nothing new. The search runs every night (ayatickets.fr).')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-tertiary">
        {bi('Trouvés automatiquement : faits et lien seulement, rien n\'est publié sans vous.', 'Found automatically: facts and link only, nothing is published without you.')}
      </p>
      {candidates.map(c => (
        <CandidateCard key={c.id} c={c} canAct={canAct} onChanged={onChanged} toast={toast} onPublish={() => setPublishing(c)} />
      ))}
      {publishing && (
        <AdminEventCreate
          heading={bi('Publier en info seule', 'Publish as info only')}
          initial={candidateToForm(publishing) as never}
          extraBody={{ candidate_id: publishing.id }}
          noPoster
          notice={
            <p className="text-xs text-ink-secondary mb-4 rounded-xl bg-surface px-3 py-2">
              🔎 {bi('Trouvé sur', 'Found on')} <a href={publishing.source_url} target="_blank" rel="noopener noreferrer" className="underline font-semibold">{publishing.source_domain}</a>
              {' · '}{bi('vérifiez les infos et écrivez votre propre description (rien n\'est copié).', 'check the details and write your own description (nothing is copied).')}
            </p>
          }
          onClose={() => setPublishing(null)}
          onCreated={evt => { setPublishing(null); onPublished(evt); onChanged() }}
        />
      )}
    </div>
  )
}

function CandidateCard({ c, canAct, onChanged, onPublish, toast }: {
  c: EventCandidate; canAct: boolean; onChanged: () => void; onPublish: () => void; toast: (msg: string, ok?: boolean) => void
}) {
  const bi = useBi()
  const { locale } = useLanguage()
  const lang = locale === 'en' ? 'en' : 'fr'
  const [panel, setPanel] = useState<'contact' | 'ignore' | null>(null)
  const [msgLang, setMsgLang] = useState<'fr' | 'en'>('fr')
  const [text, setText] = useState(() => organiserMessage(c, 'fr'))
  const [reason, setReason] = useState<IgnoreReason>('not_relevant')
  const [busy, setBusy] = useState(false)

  const when = formatEventWhen({ date: c.start_date, end_date: c.end_date, time: c.start_time, end_time: c.end_time }, lang, 'card')
  const price = c.price_fcfa == null ? bi('prix ?', 'price ?') : c.price_fcfa === 0 ? bi('gratuit', 'free') : `${c.price_is_from ? bi('dès ', 'from ') : ''}${formatFCFA(c.price_fcfa)}`

  function switchLang(l: 'fr' | 'en') { setMsgLang(l); setText(organiserMessage(c, l)) }

  async function run(body: Record<string, unknown>, okMsg: string) {
    setBusy(true)
    const r = await act(c.id, body)
    setBusy(false)
    if (!r.ok) { toast(r.error || bi('Erreur', 'Error'), false); return }
    toast(okMsg)
    setPanel(null)
    onChanged()
  }

  async function copy() {
    try { await navigator.clipboard.writeText(text); toast(bi('Message copié', 'Message copied')) }
    catch { toast(bi('Copie impossible : sélectionnez le texte', 'Could not copy: select the text'), false) }
  }

  return (
    <div className="bg-white rounded-2xl p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-bold text-ink-primary leading-tight">{c.title}</p>
          <p className="text-sm text-ink-secondary mt-0.5">📅 {when}</p>
          <p className="text-sm text-ink-secondary">📍 {[c.venue, c.city].filter(Boolean).join(' · ')}</p>
          <p className="text-sm text-ink-secondary">
            🎟️ {price}{c.category ? ` · ${categoryLabel(c.category, locale)}` : ''}{c.organiser_name ? ` · 👤 ${c.organiser_name}` : ''}
          </p>
        </div>
        {c.status === 'contacted' && (
          <span className="shrink-0 text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 rounded-full">
            📨 {bi('Contacté', 'Contacted')}
          </span>
        )}
      </div>

      <p className="text-xs text-ink-tertiary mt-2">
        <a href={c.source_url} target="_blank" rel="noopener noreferrer" className="underline font-semibold text-ink-secondary">
          🔗 {bi('Voir la source', 'View source')} ({c.source_domain}) ↗
        </a>
        {c.other_urls.length > 0 && <> · {bi(`aussi sur ${c.other_urls.length} autre(s) page(s)`, `also on ${c.other_urls.length} other page(s)`)}</>}
      </p>
      {c.possible_duplicate_event_id && (
        <p className="text-xs mt-1 text-amber-800">
          ⚠️ {bi('Doublon possible de', 'Possible duplicate of')}{' '}
          <a href={`/events/${c.possible_duplicate_event_id}`} target="_blank" rel="noopener noreferrer" className="underline font-semibold">
            {c.possible_duplicate_title ?? bi('un événement', 'an event')}
          </a>
        </p>
      )}

      {canAct && (
        <div className="flex flex-wrap gap-2 mt-3">
          <button type="button" onClick={() => setPanel(panel === 'contact' ? null : 'contact')} className={`${BTN} border-divider bg-white hover:bg-surface-muted`}>
            💬 {bi('Contacter l\'organisateur', 'Contact the organiser')}
          </button>
          <button type="button" onClick={onPublish} className={`${BTN} border-brand text-brand-darker bg-white hover:bg-brand-light`}>
            ℹ️ {bi('Publier en info seule', 'Publish as info only')}
          </button>
          <button type="button" onClick={() => setPanel(panel === 'ignore' ? null : 'ignore')} className={`${BTN} border-divider text-ink-secondary bg-white hover:bg-surface-muted`}>
            🚫 {bi('Ignorer', 'Ignore')}
          </button>
        </div>
      )}

      {panel === 'contact' && (
        <div className="mt-3 rounded-xl border border-divider bg-surface p-3 space-y-2">
          <div className="flex gap-1" role="radiogroup" aria-label={bi('Langue du message', 'Message language')}>
            {(['fr', 'en'] as const).map(l => (
              <button key={l} type="button" role="radio" aria-checked={msgLang === l} onClick={() => switchLang(l)}
                className={`px-3 py-1 rounded-lg text-xs font-semibold ${msgLang === l ? 'bg-white shadow-sm text-ink-primary' : 'text-ink-secondary'}`}>
                {l === 'fr' ? 'Français' : 'English'}
              </button>
            ))}
          </div>
          <textarea value={text} onChange={e => setText(e.target.value)} rows={5}
            className="w-full border border-divider rounded-xl px-3 py-2 text-sm bg-white outline-none focus:border-brand" />
          <div className="flex flex-wrap gap-2">
            {c.organiser_phone && (
              <a href={waLink(c.organiser_phone, text)} target="_blank" rel="noopener noreferrer" className={`${BTN} border-brand text-brand-darker bg-white`}>
                🟢 WhatsApp
              </a>
            )}
            {c.organiser_email && (
              <a href={`mailto:${c.organiser_email}?subject=${encodeURIComponent(c.title)}&body=${encodeURIComponent(text)}`} className={`${BTN} border-divider bg-white`}>
                ✉️ Email
              </a>
            )}
            <button type="button" onClick={copy} className={`${BTN} border-divider bg-white`}>📋 {bi('Copier le message', 'Copy the message')}</button>
            {c.organiser_url && (
              <a href={c.organiser_url} target="_blank" rel="noopener noreferrer" className={`${BTN} border-divider bg-white`}>
                👤 {bi('Page de l\'organisateur', 'Organiser page')} ↗
              </a>
            )}
          </div>
          {!c.organiser_phone && !c.organiser_email && (
            <p className="text-xs text-ink-tertiary">
              {bi('Pas de contact public : copiez le message et trouvez l\'organisateur via sa page ou la source.', 'No public contact: copy the message and reach the organiser via their page or the source.')}
            </p>
          )}
          <button type="button" disabled={busy}
            onClick={() => run({ action: 'contacted', lang: msgLang, channel: c.organiser_phone ? 'whatsapp' : c.organiser_email ? 'email' : 'page' }, bi('✅ Marqué comme contacté', '✅ Marked as contacted'))}
            className="w-full bg-brand hover:bg-brand-dark text-white py-2 rounded-xl font-semibold text-sm disabled:opacity-50">
            {busy ? '…' : bi('✅ C\'est envoyé : marquer comme contacté', '✅ Sent: mark as contacted')}
          </button>
        </div>
      )}

      {panel === 'ignore' && (
        <div className="mt-3 rounded-xl border border-divider bg-surface p-3 flex flex-wrap items-center gap-2">
          <select value={reason} onChange={e => setReason(e.target.value as IgnoreReason)} aria-label={bi('Motif', 'Reason')}
            className="border border-divider rounded-xl px-3 py-1.5 text-sm bg-white">
            {IGNORE_REASONS.map(r => <option key={r} value={r}>{IGNORE_REASON_LABELS[r][lang]}</option>)}
          </select>
          <button type="button" disabled={busy} onClick={() => run({ action: 'ignore', reason }, bi('Ignoré', 'Ignored'))}
            className={`${BTN} border-danger text-danger bg-white disabled:opacity-50`}>
            {busy ? '…' : bi('Confirmer', 'Confirm')}
          </button>
        </div>
      )}
    </div>
  )
}
