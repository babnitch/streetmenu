import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { getRefData } from '@/lib/refDataServer'
import { visibleCities } from '@/lib/cities'
import { eventCategories } from '@/lib/categoryLabels'
import { todayInDouala } from '@/lib/weekend'
import { readApprovedEventPage } from '@/lib/discovery/run'
import { isBlockedUrl } from '@/lib/discovery/blocklist'
import {
  PASTE_MAX_CHARS, cleanExtraction, extractWithAi, foundToResult, linkNotes, PasteAiUnavailable,
} from '@/lib/discovery/paste'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST /api/admin/events/extract  { text?: string, link?: string }
// « Coller une annonce » (lib/discovery/paste.ts): the facts of a pasted
// event post, for the "Créer un événement" form. Saves nothing but the token
// use. A blocked-site link (Instagram, Facebook…) is never opened.
// super_admin | admin.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  const linkRaw = typeof body.link === 'string' ? body.link.trim() : ''
  if (text.length > PASTE_MAX_CHARS) {
    return NextResponse.json({ error: `Texte trop long (max ${PASTE_MAX_CHARS} caractères) / Text too long (max ${PASTE_MAX_CHARS} characters)` }, { status: 400 })
  }
  let link: string | null = null
  if (linkRaw) {
    try { const u = new URL(linkRaw); if (u.protocol === 'https:' || u.protocol === 'http:') link = u.toString() } catch { /* below */ }
    if (!link) return NextResponse.json({ error: 'Lien invalide (https://…) / Invalid link (https://…)', field: 'link' }, { status: 400 })
  }
  if (!text && !link) return NextResponse.json({ error: 'Collez le texte de l\'annonce / Paste the post text' }, { status: 400 })

  await getRefData()
  const cities = visibleCities()
  const categories = eventCategories()

  // A page on an approved source: read like the nightly job (no AI).
  if (link && !isBlockedUrl(link)) {
    const found = await readApprovedEventPage(link).catch(() => null)
    if (found?.length) return NextResponse.json({ ok: true, ...foundToResult(found[0]), more_dates: found.length - 1 })
  }
  if (!text) {
    return NextResponse.json({
      error: isBlockedUrl(link!)
        ? 'Ce lien n\'est jamais ouvert : collez le texte de l\'annonce / This link is never opened: paste the post text'
        : 'Lien non lu (site non approuvé) : collez le texte de l\'annonce / Link not read (site not approved): paste the post text',
    }, { status: 400 })
  }

  try {
    const raw = await extractWithAi({ text, link, today: todayInDouala(), cities, categories, adminId: session.id })
    const result = cleanExtraction(raw, { cities, categories, pastedLink: link })
    return NextResponse.json({ ok: true, ...result, notes: [...linkNotes(link, false), ...result.notes] })
  } catch (e) {
    if (e instanceof PasteAiUnavailable) {
      console.error('[events/extract] ANTHROPIC_API_KEY is not set on this deployment')
      return NextResponse.json({ error: 'Lecture automatique indisponible (clé manquante) / Automatic reading unavailable (missing key)' }, { status: 503 })
    }
    console.error('[events/extract] failed:', (e as Error).message)
    return NextResponse.json({ error: 'Lecture impossible, réessayez ou remplissez à la main / Could not read it, retry or fill in by hand' }, { status: 502 })
  }
}
