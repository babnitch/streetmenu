// QR codes that are links (Q1). Server-only.
//
// Each event booking, order and claimed voucher has a token:
//   token = base64url(HMAC-SHA256(SCAN_TOKEN_SECRET, "<kind>:<id>:<version>"))[0..22]
// (22 characters = 132 bits). The QR holds https://<site>/scan/<token>. Only
// SHA-256(token) is stored (scan_tokens), so the database alone can't rebuild
// a QR; the server recomputes the token whenever it shows the QR again.
// A higher version for the same item revokes the old QR.
//
// NEVER rotate SCAN_TOKEN_SECRET casually: every QR already shown or sent
// would stop working (docs/decisions/scan-qr.md).

import { createHash, createHmac } from 'crypto'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { SITE_URL } from '@/lib/siteLinks'

export type ScanKind = 'reservation' | 'order' | 'voucher'
export const SCAN_KINDS: readonly ScanKind[] = ['reservation', 'order', 'voucher']
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/

function secret(): string {
  const s = process.env.SCAN_TOKEN_SECRET
  if (!s || s.length < 16) throw new Error('SCAN_TOKEN_SECRET is not set')
  return s
}

export function computeScanToken(kind: ScanKind, id: string, version = 1): string {
  return createHmac('sha256', secret()).update(`${kind}:${id}:${version}`).digest('base64url').slice(0, 22)
}

export function hashScanToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function scanUrlFor(token: string): string {
  return `${SITE_URL}/scan/${token}`
}

// The item's current token, recorded on first use (existing rows get theirs
// the first time they are shown or sent).
export async function ensureScanToken(kind: ScanKind, id: string): Promise<string> {
  const { data } = await supabaseAdmin.from('scan_tokens')
    .select('version').eq('kind', kind).eq('target_id', id)
    .order('version', { ascending: false }).limit(1).maybeSingle()
  const version = (data?.version as number | undefined) ?? 1
  const token = computeScanToken(kind, id, version)
  if (!data) {
    const { error } = await supabaseAdmin.from('scan_tokens')
      .upsert({ token_hash: hashScanToken(token), kind, target_id: id, version }, { onConflict: 'token_hash', ignoreDuplicates: true })
    if (error) throw new Error(`scan_tokens: ${error.message}`)
  }
  return token
}

export async function scanUrl(kind: ScanKind, id: string): Promise<string> {
  return scanUrlFor(await ensureScanToken(kind, id))
}

// token → the item it opens, or null (unknown, malformed or revoked).
export async function resolveScanToken(token: string): Promise<{ kind: ScanKind; id: string } | null> {
  if (!TOKEN_RE.test(token)) return null
  const { data } = await supabaseAdmin.from('scan_tokens')
    .select('kind, target_id, version').eq('token_hash', hashScanToken(token)).maybeSingle()
  if (!data) return null
  const { data: latest } = await supabaseAdmin.from('scan_tokens')
    .select('version').eq('kind', data.kind).eq('target_id', data.target_id)
    .order('version', { ascending: false }).limit(1).maybeSingle()
  if ((latest?.version as number | undefined) !== data.version) return null
  return { kind: data.kind as ScanKind, id: data.target_id as string }
}

// Revoke an item's QR (the next one shown is new).
export async function revokeScanToken(kind: ScanKind, id: string): Promise<void> {
  const { data } = await supabaseAdmin.from('scan_tokens')
    .select('version').eq('kind', kind).eq('target_id', id)
    .order('version', { ascending: false }).limit(1).maybeSingle()
  const version = ((data?.version as number | undefined) ?? 1) + 1
  const token = computeScanToken(kind, id, version)
  await supabaseAdmin.from('scan_tokens').insert({ token_hash: hashScanToken(token), kind, target_id: id, version })
}

// The customer's secret 4-digit delivery code (Q5): given only to the
// customer (the "en route" WhatsApp, their order), never to the restaurant
// or the rider — it proves the rider met the customer. Not the order number.
export function deliveryCode(orderId: string): string {
  const h = createHmac('sha256', secret()).update(`delivery:${orderId}`).digest()
  return String(h.readUInt32BE(0) % 10000).padStart(4, '0')
}

