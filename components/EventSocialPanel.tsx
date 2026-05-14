'use client'

// Likes + comments under each event. Self-contained: owns the like/unlike
// roundtrips, the paginated comment list, the comment composer, and the
// inline nickname prompt that fires the first time the customer tries
// to comment without one set.
//
// Optimistic UX for likes (count + heart flip immediately, server reconciles).
// Comments use a posted-row insert at the top of the list so the user sees
// their text without a refetch.

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useLanguage, useBi } from '@/lib/languageContext'

interface CommentRow {
  id:         string
  comment:    string
  created_at: string
  author:     string
}

interface SessionUser { id: string; name: string; phone: string; role: string }

const PAGE_SIZE = 10

export default function EventSocialPanel({ eventId }: { eventId: string }) {
  const bi = useBi()
  const { locale } = useLanguage()

  // Auth read. We hit /api/auth/me once per mount so the like + comment
  // CTAs know whether to show "Login to interact" vs the active controls.
  const [me, setMe] = useState<SessionUser | null>(null)
  const [meLoading, setMeLoading] = useState(true)

  // Likes
  const [likes, setLikes]   = useState(0)
  const [liked, setLiked]   = useState(false)
  const [likeBusy, setLikeBusy] = useState(false)

  // Comments
  const [comments, setComments] = useState<CommentRow[]>([])
  const [offset,   setOffset]   = useState(0)
  const [hasMore,  setHasMore]  = useState(false)
  const [loadingComments, setLoadingComments] = useState(true)
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState('')

  // Nickname prompt (inline modal). Triggered when the comment POST fails
  // with reason='nickname_required'.
  const [showNicknameModal, setShowNicknameModal] = useState(false)
  const [nicknameDraft, setNicknameDraft] = useState('')
  const [savingNickname, setSavingNickname] = useState(false)
  const [nicknameError, setNicknameError] = useState('')

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => { if (d?.user?.role === 'customer') setMe(d.user) })
      .catch(() => null)
      .finally(() => setMeLoading(false))
  }, [])

  // Initial likes + comments load.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [likesRes, commentsRes] = await Promise.all([
          fetch(`/api/events/${eventId}/likes`,    { cache: 'no-store' }).then(r => r.json()),
          fetch(`/api/events/${eventId}/comments?limit=${PAGE_SIZE}`, { cache: 'no-store' }).then(r => r.json()),
        ])
        if (cancelled) return
        setLikes(Number(likesRes?.count ?? 0))
        setLiked(!!likesRes?.userLiked)
        setComments(Array.isArray(commentsRes?.comments) ? commentsRes.comments : [])
        setHasMore(!!commentsRes?.has_more)
        setOffset(Array.isArray(commentsRes?.comments) ? commentsRes.comments.length : 0)
      } finally {
        if (!cancelled) setLoadingComments(false)
      }
    })()
    return () => { cancelled = true }
  }, [eventId])

  async function toggleLike() {
    if (likeBusy || !me) return
    setLikeBusy(true)
    // Optimistic update — flip locally, reconcile from server payload.
    const prevLiked = liked
    const prevLikes = likes
    setLiked(!liked)
    setLikes(prev => prev + (liked ? -1 : 1))
    try {
      const res = await fetch(`/api/events/${eventId}/like`, { method: 'POST' })
      if (!res.ok) {
        setLiked(prevLiked); setLikes(prevLikes)
        return
      }
      const d = await res.json()
      setLiked(!!d?.liked)
      setLikes(Number(d?.count ?? 0))
    } catch {
      setLiked(prevLiked); setLikes(prevLikes)
    } finally {
      setLikeBusy(false)
    }
  }

  const loadMore = useCallback(async () => {
    setLoadingComments(true)
    try {
      const res = await fetch(`/api/events/${eventId}/comments?offset=${offset}&limit=${PAGE_SIZE}`, { cache: 'no-store' })
      const d = await res.json()
      if (Array.isArray(d?.comments)) {
        setComments(prev => [...prev, ...d.comments])
        setOffset(prev => prev + d.comments.length)
        setHasMore(!!d.has_more)
      }
    } finally {
      setLoadingComments(false)
    }
  }, [eventId, offset])

  async function postComment() {
    const text = draft.trim()
    if (!text || posting || !me) return
    setPosting(true); setPostError('')
    try {
      const res = await fetch(`/api/events/${eventId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: text }),
      })
      const d = await res.json()
      if (res.status === 412 && d?.reason === 'nickname_required') {
        // First-comment nickname prompt. Spec: ask inline rather than
        // bouncing to /account.
        setNicknameError('')
        setShowNicknameModal(true)
        return
      }
      if (!res.ok) {
        setPostError(d?.error ?? bi('Erreur', 'Error'))
        return
      }
      setComments(prev => [d.comment as CommentRow, ...prev])
      setOffset(prev => prev + 1)
      setDraft('')
    } finally {
      setPosting(false)
    }
  }

  async function saveNicknameAndComment() {
    if (savingNickname) return
    setSavingNickname(true); setNicknameError('')
    try {
      const res = await fetch('/api/auth/nickname', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: nicknameDraft }),
      })
      const d = await res.json()
      if (!res.ok) {
        setNicknameError(d?.error ?? bi('Erreur', 'Error'))
        return
      }
      setShowNicknameModal(false)
      setNicknameDraft('')
      // Retry the comment now that the nickname is set.
      postComment()
    } finally {
      setSavingNickname(false)
    }
  }

  return (
    <>
      {/* Likes bar — sits above the comments header. The heart pop is a
          short scale animation triggered on state flip. */}
      <div className="bg-white rounded-2xl shadow-sm p-4 mb-3 flex items-center justify-between">
        <p className="text-sm text-ink-secondary">
          ❤️ <strong className="text-ink-primary">{likes}</strong> {bi('j\'aime', 'likes')}
        </p>
        {meLoading ? (
          <div className="text-xs text-ink-tertiary">…</div>
        ) : me ? (
          <button
            onClick={toggleLike}
            disabled={likeBusy}
            className={`text-sm px-4 py-1.5 rounded-full font-semibold transition-all active:scale-95 disabled:opacity-50 ${
              liked
                ? 'bg-rose-50 text-rose-700 border border-rose-200'
                : 'bg-brand text-white hover:bg-brand-dark'
            }`}
          >
            {liked ? <>💖 {bi('Aimé', 'Liked')}</> : <>❤️ {bi('J\'aime', 'Like')}</>}
          </button>
        ) : (
          <Link href="/account?return=" className="text-xs text-brand hover:text-brand-dark font-semibold underline">
            {bi('Connectez-vous', 'Log in')}
          </Link>
        )}
      </div>

      <div className="bg-white rounded-2xl shadow-sm p-4">
        <h2 className="text-base font-bold text-ink-primary mb-3">
          💬 {bi('Commentaires', 'Comments')} ({comments.length})
        </h2>

        {/* Composer. Login-gated; if no nickname set, the POST surfaces
            the nickname prompt modal. */}
        {me ? (
          <div className="mb-4">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              maxLength={500}
              placeholder={bi('Écrivez un commentaire…', 'Write a comment…')}
              rows={2}
              className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand bg-surface resize-none"
            />
            <div className="flex items-center justify-between mt-2">
              <p className="text-[11px] text-ink-tertiary">
                {draft.length}/500
              </p>
              <button
                onClick={postComment}
                disabled={posting || !draft.trim()}
                className="bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white px-4 py-1.5 rounded-full text-sm font-semibold transition-colors"
              >
                {posting ? '…' : bi('Envoyer', 'Send')}
              </button>
            </div>
            {postError && <p className="text-xs text-danger mt-1">{postError}</p>}
          </div>
        ) : (
          <div className="mb-4 text-center bg-surface-muted rounded-xl py-3 px-4 text-xs text-ink-tertiary">
            <Link href="/account?return=" className="text-brand hover:text-brand-dark font-semibold underline">
              {bi('Connectez-vous pour commenter', 'Log in to comment')}
            </Link>
          </div>
        )}

        {loadingComments && comments.length === 0 ? (
          <div className="text-center py-6 text-ink-tertiary text-sm">…</div>
        ) : comments.length === 0 ? (
          <p className="text-sm text-ink-tertiary text-center py-4">
            {bi('Aucun commentaire pour le moment.', 'No comments yet.')}
          </p>
        ) : (
          <div className="space-y-3">
            {comments.map(c => (
              <div key={c.id} className="border-b border-divider pb-3 last:border-b-0 last:pb-0">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm font-semibold text-ink-primary">{c.author}</p>
                  <p className="text-[11px] text-ink-tertiary">{relativeTime(c.created_at, locale)}</p>
                </div>
                <p className="text-sm text-ink-secondary whitespace-pre-wrap">{c.comment}</p>
              </div>
            ))}
            {hasMore && (
              <button
                onClick={loadMore}
                disabled={loadingComments}
                className="w-full bg-surface-muted hover:bg-divider text-ink-secondary py-2 rounded-full text-xs font-semibold transition-colors disabled:opacity-50"
              >
                {loadingComments ? '…' : bi('Voir plus', 'Load more')}
              </button>
            )}
          </div>
        )}
      </div>

      {showNicknameModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={() => !savingNickname && setShowNicknameModal(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="font-bold text-ink-primary mb-1">
              {bi('Choisissez un pseudo', 'Choose a nickname')}
            </h3>
            <p className="text-xs text-ink-tertiary mb-3">
              {bi(
                '3-20 caractères. Affiché sur vos commentaires. Modifiable une fois par 30 jours.',
                '3-20 characters. Shown on your comments. Editable once per 30 days.',
              )}
            </p>
            <input
              type="text"
              value={nicknameDraft}
              onChange={e => setNicknameDraft(e.target.value)}
              maxLength={20}
              placeholder={bi('ex: BabNT', 'e.g. BabNT')}
              className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand bg-surface mb-2"
              autoFocus
            />
            {nicknameError && <p className="text-xs text-danger mb-2">{nicknameError}</p>}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowNicknameModal(false)}
                disabled={savingNickname}
                className="flex-1 px-3 py-2 rounded-full text-sm font-semibold bg-surface-muted text-ink-secondary hover:bg-divider transition-colors disabled:opacity-50"
              >
                {bi('Annuler', 'Cancel')}
              </button>
              <button
                onClick={saveNicknameAndComment}
                disabled={savingNickname || nicknameDraft.trim().length < 3}
                className="flex-1 px-3 py-2 rounded-full text-sm font-semibold bg-brand text-white hover:bg-brand-dark transition-colors disabled:opacity-50"
              >
                {savingNickname ? '…' : bi('Continuer', 'Continue')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// Compact relative time. Uses minutes / hours / days for anything within
// 30 days, falls back to the full date after.
function relativeTime(iso: string, locale: 'fr' | 'en'): string {
  const date = new Date(iso)
  const diffMs = Date.now() - date.getTime()
  const m = Math.floor(diffMs / (60 * 1000))
  if (m < 1)  return locale === 'fr' ? "à l'instant" : 'just now'
  if (m < 60) return locale === 'fr' ? `il y a ${m} min`    : `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return locale === 'fr' ? `il y a ${h}h`       : `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return locale === 'fr' ? `il y a ${d}j`       : `${d}d ago`
  return date.toLocaleDateString(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}
