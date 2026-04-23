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

const API_TOKEN   = process.env.PAWAPAY_API_TOKEN   ?? ''
const BASE_URL    = process.env.PAWAPAY_BASE_URL    ?? 'https://api.sandbox.pawapay.io'
const ENVIRONMENT = process.env.PAWAPAY_ENVIRONMENT ?? 'sandbox'

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

// PawaPay requires the local subscriber number WITHOUT the leading '+' or
// country code in the `payer.address.value` field. Stripping helpers below.
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
  localNumber:   string
} | null {
  const digits = phoneNumber.replace(/[^\d+]/g, '')
  if (!digits) return null

  // Auto-detect country from the dial prefix if not passed explicitly.
  const detected: CountryCode | null =
    digits.startsWith('+237') ? 'CMR' :
    digits.startsWith('+225') ? 'CIV' :
    digits.startsWith('+221') ? 'SEN' :
    digits.startsWith('+229') ? 'BEN' :
    country ?? null
  if (!detected) return null

  if (detected === 'CMR') {
    const local = stripCountryCode(digits, '237')
    // Local Cameroonian numbers are 9 digits starting with 6.
    const prefix2 = local.slice(0, 2)
    if (['65', '67', '68'].includes(prefix2)) return { correspondent: 'MTN_MOMO_CMR', currency: 'XAF', localNumber: local }
    if (prefix2 === '69')                     return { correspondent: 'ORANGE_CMR',   currency: 'XAF', localNumber: local }
    return null
  }
  if (detected === 'CIV') {
    const local = stripCountryCode(digits, '225')
    const prefix2 = local.slice(0, 2)
    if (['07', '08', '09'].includes(prefix2)) return { correspondent: 'MTN_MOMO_CIV', currency: 'XOF', localNumber: local }
    if (['05', '06'].includes(prefix2))       return { correspondent: 'ORANGE_CIV',   currency: 'XOF', localNumber: local }
    if (prefix2 === '01')                     return { correspondent: 'MOOV_CIV',     currency: 'XOF', localNumber: local }
    return null
  }
  if (detected === 'SEN') {
    const local = stripCountryCode(digits, '221')
    const prefix2 = local.slice(0, 2)
    if (['77', '78'].includes(prefix2)) return { correspondent: 'ORANGE_SEN', currency: 'XOF', localNumber: local }
    if (prefix2 === '76')               return { correspondent: 'FREE_SEN',   currency: 'XOF', localNumber: local }
    return null
  }
  if (detected === 'BEN') {
    const local = stripCountryCode(digits, '229')
    const prefix2 = local.slice(0, 2)
    if (['96', '97'].includes(prefix2)) return { correspondent: 'MTN_MOMO_BEN', currency: 'XOF', localNumber: local }
    if (['94', '95'].includes(prefix2)) return { correspondent: 'MOOV_BEN',     currency: 'XOF', localNumber: local }
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
  if (!res.ok) {
    console.error(`[pawapay] ${init.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 400)}`)
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
      address: { value: mno.localNumber },
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
      address: { value: mno.localNumber },
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

// ── Webhook signature verification ───────────────────────────────────────────
// PawaPay signs callbacks with HMAC-SHA256 using the webhook secret. The
// signature lives in the `signature` header. Format: hex digest of the
// raw request body. We accept any of the common header names PawaPay uses
// so a sandbox/production header rename doesn't silently bypass the check.
import { createHmac, timingSafeEqual } from 'crypto'

export function verifyWebhookSignature(rawBody: string, headerValue: string | null | undefined): boolean {
  const secret = process.env.PAWAPAY_WEBHOOK_SECRET ?? ''
  if (!secret) {
    // No secret configured — accept in sandbox so dev unblocks, but log loudly.
    if (ENVIRONMENT !== 'production') {
      console.warn('[pawapay] PAWAPAY_WEBHOOK_SECRET not set — accepting webhook unverified (sandbox only)')
      return true
    }
    return false
  }
  if (!headerValue) return false
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  try {
    const a = Buffer.from(expected, 'hex')
    const b = Buffer.from(headerValue.replace(/^sha256=/, ''), 'hex')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export const PAWAPAY_ENVIRONMENT = ENVIRONMENT
