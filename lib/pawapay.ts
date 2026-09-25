// PawaPay mobile-money integration — server-only.
//
// Wraps the PawaPay v1 REST API for the three primitives the app needs:
//   - createDeposit: customer pays the platform (collection from MoMo wallet)
//   - checkDepositStatus: polled by /api/payments/status during checkout
//   - createPayout: platform pays a vendor (settlement to MoMo wallet)
//
// MNO routing is local — `detectMNO` maps a +E.164 phone to PawaPay's
// "correspondent" code based on the country prefix and operator ranges.
// PawaPay rejects deposits with an unknown correspondent, so callers must
// surface a clear error when detectMNO returns null.

import { randomUUID } from 'crypto'

// Trim defensively — copy/paste from dashboards sometimes lands with a
// trailing newline or surrounding quotes which silently break Bearer auth.
const API_TOKEN   = (process.env.PAWAPAY_API_TOKEN   ?? '').trim().replace(/^["']|["']$/g, '')
const BASE_URL    = (process.env.PAWAPAY_BASE_URL    ?? 'https://api.sandbox.pawapay.io').trim().replace(/\/+$/, '')
const ENVIRONMENT = (process.env.PAWAPAY_ENVIRONMENT ?? 'sandbox').trim()

// ── Types ────────────────────────────────────────────────────────────────────

export type PawaPayCorrespondent =
  // Cameroon
  | 'MTN_MOMO_CMR' | 'ORANGE_CMR'
  // Ivory Coast
  | 'MTN_MOMO_CIV' | 'ORANGE_CIV' | 'MOOV_CIV'
  // Senegal
  | 'ORANGE_SEN' | 'FREE_SEN'
  // Benin
  | 'MTN_MOMO_BEN' | 'MOOV_BEN'

export type PawaPayCurrency = 'XAF' | 'XOF'

// PawaPay status vocabulary. ACCEPTED/SUBMITTED/ENQUEUED are intermediate,
// COMPLETED is success, FAILED/REJECTED are terminal failures.
export type PawaPayStatus =
  | 'ACCEPTED' | 'SUBMITTED' | 'ENQUEUED' | 'COMPLETED' | 'FAILED' | 'REJECTED' | 'DUPLICATE_IGNORED'

export interface DepositParams {
  amount:        number             // FCFA (no decimals — XAF/XOF have no minor unit)
  currency:      PawaPayCurrency
  phoneNumber:   string             // +E.164
  orderId:       string             // for traceability + statementDescription
  description?:  string             // 4–22 chars; PawaPay shows it on the wallet statement
}

export interface DepositResult {
  depositId:     string
  status:        PawaPayStatus
  correspondent: PawaPayCorrespondent
}

export interface DepositStatus {
  status:        PawaPayStatus
  amount?:       number
  currency?:     PawaPayCurrency
  correspondent?: PawaPayCorrespondent
  failureReason?: string            // when status is FAILED/REJECTED
}

export interface PayoutParams {
  amount:        number
  currency:      PawaPayCurrency
  phoneNumber:   string
  payoutId?:     string             // generated if not provided
  description?:  string
}

export interface PayoutResult {
  payoutId:      string
  status:        PawaPayStatus
  correspondent: PawaPayCorrespondent
}

// ── MNO detection ────────────────────────────────────────────────────────────

export type CountryCode = 'CMR' | 'CIV' | 'SEN' | 'BEN'

// PawaPay's `payer.address.value` (and `recipient.address.value` on payouts)
// expects the full MSISDN as digits only — country code included, no '+',
// no spaces, no dashes. e.g. "237670000000" for +237 67 00 00 00.
//
// `stripCountryCode` is still useful internally for MNO detection, which
// matches on the operator prefix of the local subscriber number.
function stripCountryCode(phone: string, dialCode: string): string {
  const digits = phone.replace(/[^\d+]/g, '')
  if (digits.startsWith('+' + dialCode)) return digits.slice(dialCode.length + 1)
  if (digits.startsWith(dialCode))       return digits.slice(dialCode.length)
  return digits.replace(/^\+/, '')
}

// Map +E.164 phone → PawaPay correspondent code based on operator prefix
// ranges per country. Returns null when the country/prefix is unsupported,
// which the caller should surface as a clear error to the customer.
//
// Sources:
//   CMR: MTN holds 67/68 ranges in 6XX; Orange holds 69; numbers also start
//        with 65 (MTN). Cameroon phones are +237 6 X X XXX XXX.
//   CIV: After 2021 MSISDN expansion, 07/08/09 → MTN, 05/06 → Orange,
//        01 → Moov. Numbers are +225 0X XX XXX XXX.
//   SEN: 77/78 → Orange, 76 → Free. +221 7X XXX XX XX.
//   BEN: 96/97 → MTN, 94/95 → Moov. +229 9X XX XX XX.
export function detectMNO(phoneNumber: string, country?: CountryCode): {
  correspondent: PawaPayCorrespondent
  currency:      PawaPayCurrency
  msisdn:        string  // full E.164 digits without '+', for PawaPay's address.value
} | null {
  const digits = phoneNumber.replace(/[^\d+]/g, '')
  if (!digits) return null

  // Accept the country code with OR without a leading '+'. We strip the
  // '+' before prefix-matching so "237670000000" and "+237670000000"
  // route to the same correspondent.
  const bare = digits.replace(/^\+/, '')
  const detected: CountryCode | null =
    bare.startsWith('237') ? 'CMR' :
    bare.startsWith('225') ? 'CIV' :
    bare.startsWith('221') ? 'SEN' :
    bare.startsWith('229') ? 'BEN' :
    country ?? null
  if (!detected) return null

  if (detected === 'CMR') {
    const local = stripCountryCode(digits, '237')
    // Local Cameroonian numbers are 9 digits starting with 6.
    const prefix2 = local.slice(0, 2)
    const msisdn = '237' + local
    if (['65', '67', '68'].includes(prefix2)) return { correspondent: 'MTN_MOMO_CMR', currency: 'XAF', msisdn }
    if (prefix2 === '69')                     return { correspondent: 'ORANGE_CMR',   currency: 'XAF', msisdn }
    return null
  }
  if (detected === 'CIV') {
    const local = stripCountryCode(digits, '225')
    const prefix2 = local.slice(0, 2)
    const msisdn = '225' + local
    if (['07', '08', '09'].includes(prefix2)) return { correspondent: 'MTN_MOMO_CIV', currency: 'XOF', msisdn }
    if (['05', '06'].includes(prefix2))       return { correspondent: 'ORANGE_CIV',   currency: 'XOF', msisdn }
    if (prefix2 === '01')                     return { correspondent: 'MOOV_CIV',     currency: 'XOF', msisdn }
    return null
  }
  if (detected === 'SEN') {
    const local = stripCountryCode(digits, '221')
    const prefix2 = local.slice(0, 2)
    const msisdn = '221' + local
    if (['77', '78'].includes(prefix2)) return { correspondent: 'ORANGE_SEN', currency: 'XOF', msisdn }
    if (prefix2 === '76')               return { correspondent: 'FREE_SEN',   currency: 'XOF', msisdn }
    return null
  }
  if (detected === 'BEN') {
    const local = stripCountryCode(digits, '229')
    const prefix2 = local.slice(0, 2)
    const msisdn = '229' + local
    if (['96', '97'].includes(prefix2)) return { correspondent: 'MTN_MOMO_BEN', currency: 'XOF', msisdn }
    if (['94', '95'].includes(prefix2)) return { correspondent: 'MOOV_BEN',     currency: 'XOF', msisdn }
    return null
  }
  return null
}

// Map MNO correspondent → human-readable label (used by UI and WhatsApp copy).
export function mnoLabel(correspondent: PawaPayCorrespondent): string {
  if (correspondent.startsWith('MTN_MOMO')) return 'MTN MoMo'
  if (correspondent.startsWith('ORANGE'))   return 'Orange Money'
  if (correspondent.startsWith('MOOV'))     return 'Moov Money'
  if (correspondent.startsWith('FREE'))     return 'Free Money'
  return correspondent
}

// ── Country inference from restaurant city ───────────────────────────────────
// Used by the checkout flow to default the deposit currency / detection
// country without asking the customer. City list mirrors lib/whatsapp/incoming.
export function countryFromCity(city: string): CountryCode | null {
  const c = (city ?? '').toLowerCase().trim()
  if (['yaoundé', 'yaounde', 'douala', 'bafoussam'].includes(c)) return 'CMR'
  if (['abidjan', 'bouaké', 'bouake', 'yamoussoukro'].includes(c)) return 'CIV'
  if (['dakar', 'thiès', 'thies', 'saint-louis'].includes(c)) return 'SEN'
  if (['lomé', 'lome', 'cotonou', 'porto-novo'].includes(c)) return 'BEN'
  return null
}

// ── HTTP layer ───────────────────────────────────────────────────────────────

async function pawapayFetch(path: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  const url = `${BASE_URL}${path}`

  // Debug — strip when 401s are resolved. Logs token shape (NOT the token)
  // so we can catch UUID-vs-JWT confusion, trailing whitespace, accidental
  // quoting, and base-URL drift without leaking the credential.
  const tokenSample = API_TOKEN
    ? `${API_TOKEN.slice(0, 6)}…${API_TOKEN.slice(-4)} (len=${API_TOKEN.length}, looksJWT=${API_TOKEN.startsWith('eyJ')})`
    : '<empty>'
  console.info('[pawapay] →', init.method ?? 'GET', url)
  console.info('[pawapay]   auth: Bearer', tokenSample)
  if (typeof init.body === 'string') {
    console.info('[pawapay]   body:', init.body.slice(0, 600))
  }

  const res = await fetch(url, {
    ...init,
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type':  'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }

  console.info(`[pawapay] ← ${init.method ?? 'GET'} ${path} → ${res.status}`)
  if (!res.ok) {
    console.error(`[pawapay]   response: ${text.slice(0, 600)}`)
  }
  return { status: res.status, body }
}

// PawaPay's statementDescription field has a 4–22 char window with a
// restricted alphabet. Sanitise + truncate so a long restaurant name or
// order id never breaks the request.
function sanitiseStatementDescription(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9 ]+/g, '').trim()
  const padded  = cleaned.length < 4 ? (cleaned + ' Order').trim() : cleaned
  return padded.slice(0, 22)
}

// ── Public API ───────────────────────────────────────────────────────────────

// Initiates a deposit (collection) from the customer's MoMo wallet. The
// customer receives a USSD prompt on their phone; the actual transfer happens
// asynchronously and is reported via the webhook + status polling.
export async function createDeposit(params: DepositParams): Promise<DepositResult> {
  const mno = detectMNO(params.phoneNumber)
  if (!mno) throw new Error(`Numéro non supporté pour le paiement / Unsupported payment number: ${params.phoneNumber}`)
  if (mno.currency !== params.currency) {
    // Caller derived currency from the restaurant city; mismatch with detected
    // country means the customer is paying with a wallet outside the
    // restaurant's currency zone. PawaPay would reject this anyway.
    throw new Error(`Devise incompatible / Currency mismatch: detected ${mno.currency}, requested ${params.currency}`)
  }

  const depositId = randomUUID()
  const description = sanitiseStatementDescription(params.description ?? `Order ${params.orderId.slice(0, 8)}`)

  const payload = {
    depositId,
    amount:        String(params.amount), // PawaPay expects decimal as string
    currency:      params.currency,
    correspondent: mno.correspondent,
    payer: {
      type:    'MSISDN',
      address: { value: mno.msisdn },
    },
    customerTimestamp:      new Date().toISOString(),
    statementDescription:   description,
  }

  const { status, body } = await pawapayFetch('/deposits', {
    method: 'POST',
    body:   JSON.stringify(payload),
  })

  const parsed = (body ?? {}) as { status?: PawaPayStatus; depositId?: string; rejectionReason?: { rejectionMessage?: string } }
  const apiStatus = parsed.status ?? (status >= 400 ? 'FAILED' : 'ACCEPTED')

  if (apiStatus === 'REJECTED' || apiStatus === 'FAILED') {
    const reason = parsed.rejectionReason?.rejectionMessage ?? `HTTP ${status}`
    throw new Error(`Paiement refusé par PawaPay / Payment rejected: ${reason}`)
  }

  return {
    depositId:     parsed.depositId ?? depositId,
    status:        apiStatus,
    correspondent: mno.correspondent,
  }
}

// Polled by /api/payments/status. PawaPay returns a 1-element array on the
// happy path; an empty array means the deposit doesn't exist (yet).
export async function checkDepositStatus(depositId: string): Promise<DepositStatus> {
  const { body } = await pawapayFetch(`/deposits/${depositId}`, { method: 'GET' })
  const arr = Array.isArray(body) ? body : []
  if (arr.length === 0) return { status: 'ACCEPTED' } // optimistic — deposit not yet visible

  const row = arr[0] as {
    status?:        PawaPayStatus
    requestedAmount?: string
    depositedAmount?: string
    currency?:      PawaPayCurrency
    correspondent?: PawaPayCorrespondent
    failureReason?: { failureMessage?: string }
  }
  return {
    status:        row.status ?? 'ACCEPTED',
    amount:        Number(row.depositedAmount ?? row.requestedAmount ?? 0) || undefined,
    currency:      row.currency,
    correspondent: row.correspondent,
    failureReason: row.failureReason?.failureMessage,
  }
}

// Sends money from the platform to a vendor's MoMo wallet. Used for
// settlements — admin-triggered for now via /api/payments/payout.
export async function createPayout(params: PayoutParams): Promise<PayoutResult> {
  const mno = detectMNO(params.phoneNumber)
  if (!mno) throw new Error(`Numéro non supporté / Unsupported payout number: ${params.phoneNumber}`)
  if (mno.currency !== params.currency) {
    throw new Error(`Devise incompatible / Currency mismatch: detected ${mno.currency}, requested ${params.currency}`)
  }

  const payoutId = params.payoutId ?? randomUUID()
  const description = sanitiseStatementDescription(params.description ?? 'Vendor payout')

  const payload = {
    payoutId,
    amount:               String(params.amount),
    currency:             params.currency,
    correspondent:        mno.correspondent,
    recipient: {
      type:    'MSISDN',
      address: { value: mno.msisdn },
    },
    customerTimestamp:    new Date().toISOString(),
    statementDescription: description,
  }

  const { status, body } = await pawapayFetch('/payouts', {
    method: 'POST',
    body:   JSON.stringify(payload),
  })

  const parsed = (body ?? {}) as { status?: PawaPayStatus; payoutId?: string; rejectionReason?: { rejectionMessage?: string } }
  const apiStatus = parsed.status ?? (status >= 400 ? 'FAILED' : 'ACCEPTED')
  if (apiStatus === 'REJECTED' || apiStatus === 'FAILED') {
    const reason = parsed.rejectionReason?.rejectionMessage ?? `HTTP ${status}`
    throw new Error(`Payout refusé / Payout rejected: ${reason}`)
  }
  return {
    payoutId:      parsed.payoutId ?? payoutId,
    status:        apiStatus,
    correspondent: mno.correspondent,
  }
}

// ── Callback signature verification (RFC 9421) ──────────────────────────────
// PawaPay signs callbacks with RFC 9421 HTTP Message Signatures (Signature +
// Signature-Input) using THEIR private key, and binds the body with an
// RFC 9530 Content-Digest that the signature covers. Their public keys come
// from GET /v2/public-key/http as [{ id, key }], id being the keyid.
//
// The signature crypto is http-message-signatures (not hand-rolled). The
// Content-Digest compare is ours — it is a plain hash check, and the library
// does not do it. The digest alone proves nothing (anyone can hash a body
// they wrote); it only means something because the signature covers it, so a
// signature that does not cover content-digest is INVALID.
//
// ┌─ ROLLOUT — READ BEFORE TOUCHING PAWAPAY_REJECT_INVALID_CALLBACKS ─────────┐
// │ Stage 2 (now): LOG ONLY. Every callback is verified and logged as        │
// │   VALID / INVALID reason=… / SKIPPED, and processed regardless.          │
// │ Then: enable "Signed callbacks" in the PawaPay dashboard. While it is    │
// │   off, PawaPay sends no signature and EVERY real callback logs           │
// │   INVALID reason=missing-signature.                                      │
// │ Then: watch real callbacks log VALID. This is also where an encoding     │
// │   mismatch would surface (PawaPay DOES send DER — handled by            │
// │   verifierFor below), as would a wrong @authority/@path reconstruction   │
// │   behind Vercel's proxy.                                                 │
// │ Also decide before stage 5: PawaPay sets expires = created + 60 and the  │
// │   library checks it with ZERO clock tolerance, so a callback delivered   │
// │   (or retried) >60s after signing logs INVALID reason=expired. Watch for │
// │   that in the logs; a small tolerance may be needed before rejecting.    │
// │ Only then, stage 5: flip the switch below to true. Flipping it before    │
// │   real callbacks log VALID blocks EVERY real payment.                    │
// └──────────────────────────────────────────────────────────────────────────┘
import { createHash, createPublicKey, createVerify, timingSafeEqual, type KeyObject } from 'crypto'
import {
  httpbis, createVerifier, type Algorithm, type Verifier, type VerifyingKey,
  ExpiredError, UnsupportedAlgorithmError, MalformedSignatureError, UnacceptableSignatureError,
} from 'http-message-signatures'
import { parseDictionary, isInnerList } from 'structured-headers'

// THE switch. Code constant on purpose, not an env var — a missing or
// mistyped env var must never be what decides whether money callbacks are
// authenticated. Stage 5 flips this to true (see ROLLOUT above).
export const PAWAPAY_REJECT_INVALID_CALLBACKS = false

// The single place the webhook asks "reject this?". SKIPPED is never
// rejected: in stage 5 PAWAPAY_SKIP_WEBHOOK_VERIFY=true therefore also means
// "accept unverified" — which is why callbackVerifySkipped() refuses it in
// production.
export function shouldRejectCallback(v: CallbackVerification): boolean {
  return PAWAPAY_REJECT_INVALID_CALLBACKS && v.status === 'invalid'
}

// Production if EITHER signal says so, so a blank PAWAPAY_ENVIRONMENT on a
// deploy pointed at the live API still counts as production.
function isProductionPawaPay(): boolean {
  const env  = (process.env.PAWAPAY_ENVIRONMENT ?? '').trim()
  const base = (process.env.PAWAPAY_BASE_URL ?? '').trim()
  return env === 'production' || (base !== '' && !base.includes('sandbox'))
}

// Explicit opt-out for local/sandbox work: exactly 'true', nothing looser.
// Unset, empty, 'TRUE', ' true', '1' all mean VERIFY. Ignored in production
// — a sandbox flag copied into prod must never disable verification.
export function callbackVerifySkipped(): boolean {
  if (process.env.PAWAPAY_SKIP_WEBHOOK_VERIFY !== 'true') return false
  if (isProductionPawaPay()) {
    console.error(
      '[pawapay] PAWAPAY_SKIP_WEBHOOK_VERIFY=true is set in PRODUCTION — IGNORED, ' +
      'callbacks are still verified. Remove it from the production environment.',
    )
    return false
  }
  return true
}

// ── Public-key fetch + cache ──
// In-memory, keyed by keyid. Lost on a cold start, which only costs one
// refetch. Unknown keyid → refetch once; refetches are throttled and shared
// so a stream of junk keyids cannot turn into a stream of PawaPay calls.

export interface PawaPayPublicKey { id: string; key: string }
export type PawaPayKeyFetcher = () => Promise<PawaPayPublicKey[]>

interface CachedKey { key: KeyObject; algs: Algorithm[] }

const KEY_TTL_MS              = 24 * 60 * 60 * 1000
const REFETCH_MIN_INTERVAL_MS = 60 * 1000

let keyCache       = new Map<string, CachedKey>()
let keysFetchedAt  = 0
let lastFetchStart = 0
let inflightFetch: Promise<void> | null = null

async function fetchPawaPayPublicKeys(): Promise<PawaPayPublicKey[]> {
  const { status, body } = await pawapayFetch('/v2/public-key/http', { method: 'GET' })
  if (status !== 200 || !Array.isArray(body)) {
    throw new Error(`public-key fetch failed: HTTP ${status}`)
  }
  return body as PawaPayPublicKey[]
}

// Algorithms a key may verify, derived from the KEY — never taken from the
// request, so a caller cannot pick a weaker algorithm for us.
function algsForKey(key: KeyObject): Algorithm[] {
  const type = key.asymmetricKeyType
  if (type === 'ec') {
    const curve = key.asymmetricKeyDetails?.namedCurve
    if (curve === 'prime256v1') return ['ecdsa-p256-sha256']
    if (curve === 'secp384r1')  return ['ecdsa-p384-sha384']
    return []
  }
  if (type === 'ed25519') return ['ed25519']
  if (type === 'rsa-pss') return ['rsa-pss-sha512']
  if (type === 'rsa')     return ['rsa-pss-sha512', 'rsa-v1_5-sha256']
  return []
}

async function refreshKeys(fetchKeys: PawaPayKeyFetcher): Promise<void> {
  if (inflightFetch) return inflightFetch
  if (Date.now() - lastFetchStart < REFETCH_MIN_INTERVAL_MS) return
  lastFetchStart = Date.now()
  inflightFetch = (async () => {
    try {
      const rows = await fetchKeys()
      const next = new Map<string, CachedKey>()
      for (const row of rows) {
        if (!row?.id || !row?.key) continue
        try {
          const key = createPublicKey(row.key)
          next.set(row.id, { key, algs: algsForKey(key) })
        } catch (e) {
          console.error(`[pawapay] public key id=${row.id} unparseable: ${(e as Error).message}`)
        }
      }
      keyCache = next
      keysFetchedAt = Date.now()
      console.info(`[pawapay] public keys refreshed: ${Array.from(next.keys()).join(', ') || '<none>'}`)
    } finally {
      inflightFetch = null
    }
  })()
  return inflightFetch
}

async function lookupKey(keyid: string, fetchKeys: PawaPayKeyFetcher): Promise<CachedKey | null> {
  const fresh = Date.now() - keysFetchedAt < KEY_TTL_MS
  if (!fresh || !keyCache.has(keyid)) {
    try { await refreshKeys(fetchKeys) }
    catch (e) { console.error(`[pawapay] ${(e as Error).message}`) } // fall back to whatever is cached
  }
  return keyCache.get(keyid) ?? null
}

// Tests only.
export function __resetPawaPayKeyCache(): void {
  keyCache = new Map(); keysFetchedAt = 0; lastFetchStart = 0; inflightFetch = null
}

// ── Verification ──

export type CallbackInvalidReason =
  | 'missing-signature'        // no Signature / Signature-Input at all (dashboard signing off?)
  | 'malformed'                // headers present but unparseable, or not exactly one signature
  | 'required-component-not-covered'
  | 'missing-content-digest'
  | 'digest-mismatch'
  | 'unknown-keyid'
  | 'alg-mismatch'
  | 'expired'
  | 'signature-mismatch'
  | 'signature-encoding'       // crypto refused the signature bytes (e.g. wrong length for the encoding)
  | 'verifier-error'

export type CallbackVerification =
  | { status: 'valid';   keyid: string; alg: string; covered: string[]; ageSeconds: number | null }
  | { status: 'invalid'; reason: CallbackInvalidReason; detail?: string; keyid?: string; covered?: string[] }
  | { status: 'skipped' }

export interface CallbackMessage {
  method:  string
  url:     string                  // absolute URL as PawaPay addressed it
  headers: Record<string, string>  // lowercase names
  rawBody: Buffer                  // exact bytes received
}

const DIGEST_ALGS: Record<string, string> = { 'sha-256': 'sha256', 'sha-512': 'sha512' }

// Every supported digest present must match; at least one must be present.
function checkContentDigest(header: string | undefined, body: Buffer): 'ok' | 'missing' | 'mismatch' {
  if (!header) return 'missing'
  let dict
  try { dict = parseDictionary(header) } catch { return 'mismatch' }
  let checked = 0
  for (const [name, [value]] of Array.from(dict.entries())) {
    const alg = DIGEST_ALGS[name]
    if (!alg) continue
    if (!(value instanceof ArrayBuffer)) return 'mismatch'
    const given = Buffer.from(value)
    const want  = createHash(alg).update(body).digest()
    if (given.length !== want.length || !timingSafeEqual(given, want)) return 'mismatch'
    checked++
  }
  return checked > 0 ? 'ok' : 'missing'
}

export async function verifyPawaPayCallback(
  msg: CallbackMessage,
  opts: { fetchKeys?: PawaPayKeyFetcher } = {},
): Promise<CallbackVerification> {
  if (callbackVerifySkipped()) return { status: 'skipped' }
  // Never throws: in log-only mode a verifier bug must not block a payment.
  try {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(msg.headers)) headers[name.toLowerCase()] = value
    return await verifyInner({ ...msg, headers }, opts.fetchKeys ?? fetchPawaPayPublicKeys)
  } catch (e) {
    return { status: 'invalid', reason: 'verifier-error', detail: (e as Error).message }
  }
}

// PawaPay signs ECDSA callbacks DER-encoded (an ASN.1 SEQUENCE of r and s,
// 70–72 bytes for P-256), not RFC 9421's raw r‖s — the library's own ECDSA
// verifier only does raw, and Node throws "Malformed signature" on anything
// that isn't exactly 64 bytes. So for EC keys we hand the library a verify
// function that uses Node's built-in DER support; the library still parses the
// headers, rebuilds the signature base and enforces alg/created/expires.
// Raw r‖s is accepted too: it is exactly 2× the coordinate size, which a DER
// signature never is in practice, so the length alone picks the encoding.
const ECDSA_HASH: Record<string, { hash: string; rawLength: number }> = {
  'ecdsa-p256-sha256': { hash: 'sha256', rawLength: 64 },
  'ecdsa-p384-sha384': { hash: 'sha384', rawLength: 96 },
}

function verifierFor(key: KeyObject, alg: Algorithm): Verifier {
  const ec = ECDSA_HASH[alg]
  if (!ec) return createVerifier(key, alg)   // RSA / ed25519: the library's own verifier, unchanged
  return async (data, signature) => createVerify(ec.hash).update(data).verify({
    key,
    dsaEncoding: signature.length === ec.rawLength ? 'ieee-p1363' : 'der',
  }, signature)
}

async function verifyInner(msg: CallbackMessage, fetchKeys: PawaPayKeyFetcher): Promise<CallbackVerification> {
  const sigHeader   = msg.headers['signature']
  const inputHeader = msg.headers['signature-input']
  if (!sigHeader && !inputHeader) return { status: 'invalid', reason: 'missing-signature' }
  if (!sigHeader || !inputHeader) {
    return { status: 'invalid', reason: 'malformed', detail: 'only one of Signature / Signature-Input present' }
  }

  // Parsed here only to enforce policy and to log what was signed; the
  // library re-parses and does the actual verification.
  let inputs
  try { inputs = parseDictionary(inputHeader) } catch (e) {
    return { status: 'invalid', reason: 'malformed', detail: (e as Error).message }
  }
  if (inputs.size !== 1) {
    return { status: 'invalid', reason: 'malformed', detail: `expected 1 signature, got ${inputs.size}` }
  }
  const [input] = Array.from(inputs.values())
  if (!isInnerList(input)) return { status: 'invalid', reason: 'malformed', detail: 'signature input is not an inner list' }
  const covered = input[0].map(([name]) => String(name))
  const keyidParam = input[1].get('keyid')
  const keyid = typeof keyidParam === 'string' ? keyidParam : undefined
  const createdParam = input[1].get('created')
  const ageSeconds = typeof createdParam === 'number' ? Math.floor(Date.now() / 1000) - createdParam : null

  const coversTarget = covered.includes('@path') || covered.includes('@target-uri')
  if (!covered.includes('content-digest') || !covered.includes('@method') || !coversTarget) {
    return {
      status: 'invalid', reason: 'required-component-not-covered', keyid, covered,
      detail: 'must cover content-digest, @method and @path/@target-uri',
    }
  }
  if (!keyid) return { status: 'invalid', reason: 'malformed', detail: 'no keyid', covered }

  const digest = checkContentDigest(msg.headers['content-digest'], msg.rawBody)
  if (digest === 'missing')  return { status: 'invalid', reason: 'missing-content-digest', keyid, covered }
  if (digest === 'mismatch') return { status: 'invalid', reason: 'digest-mismatch', keyid, covered }

  let keyFound = false
  let usedAlg = ''
  const keyLookup = async (params: { keyid?: string; alg?: string }): Promise<VerifyingKey | null> => {
    if (!params.keyid) return null
    const cached = await lookupKey(params.keyid, fetchKeys)
    if (!cached) return null
    keyFound = true
    // With no alg param the key must imply exactly one algorithm.
    const alg = params.alg ?? (cached.algs.length === 1 ? cached.algs[0] : undefined)
    if (!alg || !cached.algs.includes(alg)) {
      throw new UnsupportedAlgorithmError(`alg=${params.alg ?? '<none>'} not allowed for key (allows ${cached.algs.join(',') || 'nothing'})`)
    }
    usedAlg = alg
    return { id: params.keyid, algs: cached.algs, verify: verifierFor(cached.key, alg) }
  }

  let ok: boolean | null
  try {
    ok = await httpbis.verifyMessage({ keyLookup }, { method: msg.method, url: msg.url, headers: msg.headers })
  } catch (e) {
    const detail = (e as Error).message
    if (e instanceof ExpiredError)              return { status: 'invalid', reason: 'expired', detail, keyid, covered }
    if (e instanceof UnsupportedAlgorithmError) return { status: 'invalid', reason: 'alg-mismatch', detail, keyid, covered }
    if (e instanceof MalformedSignatureError || e instanceof UnacceptableSignatureError) {
      return { status: 'invalid', reason: 'malformed', detail, keyid, covered }
    }
    if ((e as { code?: string }).code === 'ERR_CRYPTO_OPERATION_FAILED') {
      return { status: 'invalid', reason: 'signature-encoding', detail, keyid, covered }
    }
    return { status: 'invalid', reason: 'verifier-error', detail, keyid, covered }
  }

  if (!keyFound) return { status: 'invalid', reason: 'unknown-keyid', keyid, covered }
  if (ok !== true) return { status: 'invalid', reason: 'signature-mismatch', keyid, covered }
  return { status: 'valid', keyid, alg: usedAlg, covered, ageSeconds }
}

export function logCallbackVerification(v: CallbackVerification, context: string): void {
  if (v.status === 'valid') {
    console.log(`[pawapay] callback signature: VALID keyid=${v.keyid} alg=${v.alg} age=${v.ageSeconds ?? '?'}s covered=(${v.covered.join(' ')}) ${context}`)
  } else if (v.status === 'skipped') {
    console.warn(`[pawapay] callback signature: SKIPPED (PAWAPAY_SKIP_WEBHOOK_VERIFY=true) ${context}`)
  } else {
    console.error(
      `[pawapay] callback signature: INVALID reason=${v.reason}` +
      `${v.keyid ? ` keyid=${v.keyid}` : ''}${v.covered ? ` covered=(${v.covered.join(' ')})` : ''}` +
      `${v.detail ? ` detail="${v.detail}"` : ''} ${context}` +
      (PAWAPAY_REJECT_INVALID_CALLBACKS ? ' → REJECTED' : ' → processed anyway (log-only mode)'),
    )
  }
}

export const PAWAPAY_ENVIRONMENT = ENVIRONMENT
