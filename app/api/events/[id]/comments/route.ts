import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { displayNickname } from '@/lib/nickname'
import { rateLimit, rateLimitedResponse } from '@/lib/rateLimit'
import { sanitizeText } from '@/lib/sanitize'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 10
const MAX_LEN   = 500

// GET /api/events/[id]/comments?offset=0&limit=10
// Public listing — excludes is_deleted=true rows. Returns comments with
// nickname only (never phone). Pagination is offset-based; the response
// includes `has_more` so the client knows when to hide "Voir plus".
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const offset = Math.max(0, parseInt(req.nextUrl.searchParams.get('offset') ?? '0', 10) || 0)
  const limitRaw = parseInt(req.nextUrl.searchParams.get('limit') ?? `${PAGE_SIZE}`, 10) || PAGE_SIZE
  const limit  = Math.min(50, Math.max(1, limitRaw))

  // Fetch limit+1 to detect has_more without a second count() call.
  const { data, error } = await supabaseAdmin
    .from('event_comments')
    .select('id, comment, created_at, customers(nickname, name)')
    .eq('event_id', params.id)
    .eq('is_deleted', false)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = data ?? []
  const hasMore = rows.length > limit
  const visible = rows.slice(0, limit)
  const comments = visible.map(r => {
    const c = r.customers as unknown as { nickname: string | null; name: string | null } | null
    return {
      id:         r.id,
      comment:    r.comment,
      created_at: r.created_at,
      author:     displayNickname(c ?? { nickname: null, name: null }),
    }
  })
  return NextResponse.json({ comments, has_more: hasMore })
}

// POST /api/events/[id]/comments { comment }
// Login + nickname required. Returns 412 with reason='nickname_required'
// when the caller hasn't set one yet — UI uses that to prompt inline.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  }

  // 20 comments per customer per hour — caps a spam loop without
  // bothering a chatty user.
  const limited = rateLimit({ key: `comment:${session.id}`, max: 20, windowMs: 3600_000 })
  if (limited) return rateLimitedResponse(limited)

  const body = await req.json().catch(() => ({}))
  const comment = sanitizeText(body?.comment, MAX_LEN)
  if (!comment) {
    return NextResponse.json({ error: 'Commentaire vide / Empty comment' }, { status: 400 })
  }

  const { data: c } = await supabaseAdmin
    .from('customers').select('nickname').eq('id', session.id).maybeSingle()
  if (!c?.nickname) {
    return NextResponse.json({
      error: 'Choisissez un pseudo pour commenter / Choose a nickname to comment',
      reason: 'nickname_required',
    }, { status: 412 })
  }

  // Verify the event exists.
  const { data: ev } = await supabaseAdmin
    .from('events').select('id, is_active').eq('id', params.id).maybeSingle()
  if (!ev || !ev.is_active) {
    return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })
  }

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('event_comments')
    .insert({ event_id: params.id, customer_id: session.id, comment })
    .select('id, created_at').single()
  if (insErr || !inserted) {
    return NextResponse.json({ error: insErr?.message ?? 'Erreur / Error' }, { status: 500 })
  }

  await writeAudit({
    action:          'comment_created',
    targetType:      'event',
    targetId:        params.id,
    performedBy:     session.id,
    performedByType: 'customer',
    metadata:        { comment_id: inserted.id, length: comment.length },
  })

  return NextResponse.json({
    ok: true,
    comment: {
      id:         inserted.id,
      comment,
      created_at: inserted.created_at,
      author:     c.nickname,
    },
  })
}
