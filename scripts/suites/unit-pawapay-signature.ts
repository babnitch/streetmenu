// PawaPay callback verification (lib/pawapay.ts) — stage 2, log-only mode.
//
// No network: a P-256 key pair is generated here, callbacks are signed with
// the same library's signMessage, and the public-key fetch is a stub that
// counts its calls. Covers the verdicts the webhook logs, the key cache's
// refetch/throttle behaviour, the skip flag, and that nothing is rejected
// while PAWAPAY_REJECT_INVALID_CALLBACKS is false.

import { generateKeyPairSync, createHash } from 'crypto'
import { httpbis, createSigner } from 'http-message-signatures'
import {
  verifyPawaPayCallback, callbackVerifySkipped, shouldRejectCallback,
  PAWAPAY_REJECT_INVALID_CALLBACKS, __resetPawaPayKeyCache,
  type CallbackMessage, type PawaPayPublicKey,
} from '@/lib/pawapay'
import { assert, assertEq, step, finish } from '../testkit/assert'

const SUITE = 'unit-pawapay-signature'

const URL_ = 'https://streetmenu.vercel.app/api/payments/webhook'
const KEYID = 'pp-test-key'

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })

function digestHeader(body: Buffer): string {
  return `sha-256=:${createHash('sha256').update(body).digest('base64')}:`
}

async function signedCallback(opts: {
  body?:   string
  fields?: string[]
  keyid?:  string
  signWith?: typeof privateKey
} = {}): Promise<CallbackMessage> {
  const rawBody = Buffer.from(opts.body ?? JSON.stringify({ depositId: 'd-1', status: 'COMPLETED' }))
  const req = {
    method: 'POST',
    url:    URL_,
    headers: {
      'content-type':   'application/json',
      'content-digest': digestHeader(rawBody),
    } as Record<string, string>,
  }
  const signed = await httpbis.signMessage({
    key:    createSigner(opts.signWith ?? privateKey, 'ecdsa-p256-sha256', opts.keyid ?? KEYID),
    fields: opts.fields ?? ['@method', '@authority', '@path', 'content-digest', 'content-type'],
  }, req)
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(signed.headers)) headers[k.toLowerCase()] = String(v)
  return { method: req.method, url: req.url, headers, rawBody }
}

let fetchCalls = 0
const fetchKeys = async (): Promise<PawaPayPublicKey[]> => {
  fetchCalls++
  return [{ id: KEYID, key: PUBLIC_PEM }]
}

function fresh() { __resetPawaPayKeyCache(); fetchCalls = 0 }

async function main() {
  delete process.env.PAWAPAY_SKIP_WEBHOOK_VERIFY
  delete process.env.PAWAPAY_ENVIRONMENT
  delete process.env.PAWAPAY_BASE_URL

  await step('switch is log-only', async () => {
    assertEq(PAWAPAY_REJECT_INVALID_CALLBACKS, false, 'PAWAPAY_REJECT_INVALID_CALLBACKS is false in stage 2')
  })

  await step('valid callback', async () => {
    fresh()
    const v = await verifyPawaPayCallback(await signedCallback(), { fetchKeys })
    assertEq(v.status, 'valid', 'self-signed P-256 callback verifies')
    if (v.status === 'valid') {
      assertEq(v.keyid, KEYID, 'reports keyid')
      assertEq(v.alg, 'ecdsa-p256-sha256', 'alg derived from key')
    }
    assertEq(fetchCalls, 1, 'keys fetched once')
    await verifyPawaPayCallback(await signedCallback(), { fetchKeys })
    assertEq(fetchCalls, 1, 'second callback uses the cache')
  })

  await step('tampered body', async () => {
    fresh()
    const msg = await signedCallback()
    msg.rawBody = Buffer.from(JSON.stringify({ depositId: 'd-1', status: 'COMPLETED', amount: 999999 }))
    const v = await verifyPawaPayCallback(msg, { fetchKeys })
    assertEq(v.status === 'invalid' && v.reason, 'digest-mismatch', 'body change breaks the digest')
  })

  await step('body + recomputed digest (attacker re-hashes)', async () => {
    fresh()
    const msg = await signedCallback()
    msg.rawBody = Buffer.from('{"depositId":"d-1","status":"COMPLETED","x":1}')
    msg.headers['content-digest'] = digestHeader(msg.rawBody)
    const v = await verifyPawaPayCallback(msg, { fetchKeys })
    assertEq(v.status === 'invalid' && v.reason, 'signature-mismatch', 'a self-consistent digest no longer passes (the old fake check would)')
  })

  await step('tampered signature', async () => {
    fresh()
    const msg = await signedCallback()
    const other_ = await signedCallback({ signWith: other.privateKey })
    msg.headers['signature'] = other_.headers['signature']
    const v = await verifyPawaPayCallback(msg, { fetchKeys })
    assertEq(v.status === 'invalid' && v.reason, 'signature-mismatch', 'signature from another key fails')
  })

  await step('content-digest not covered', async () => {
    fresh()
    const msg = await signedCallback({ fields: ['@method', '@authority', '@path', 'content-type'] })
    const v = await verifyPawaPayCallback(msg, { fetchKeys })
    assertEq(v.status === 'invalid' && v.reason, 'required-component-not-covered', 'unbound body is INVALID')
  })

  await step('missing signature headers', async () => {
    fresh()
    const msg = await signedCallback()
    delete msg.headers['signature']
    delete msg.headers['signature-input']
    const v = await verifyPawaPayCallback(msg, { fetchKeys })
    assertEq(v.status === 'invalid' && v.reason, 'missing-signature', 'unsigned callback (dashboard signing off) → missing-signature')
    assertEq(fetchCalls, 0, 'no key fetch for an unsigned callback')
  })

  await step('wrong URL (e.g. bad @authority reconstruction)', async () => {
    fresh()
    const msg = await signedCallback()
    msg.url = 'https://internal-host.local/api/payments/webhook'
    const v = await verifyPawaPayCallback(msg, { fetchKeys })
    assertEq(v.status === 'invalid' && v.reason, 'signature-mismatch', 'different @authority fails')
  })

  await step('unknown keyid → refetch once, then throttled', async () => {
    fresh()
    await verifyPawaPayCallback(await signedCallback(), { fetchKeys })          // warms cache
    assertEq(fetchCalls, 1, 'warm-up fetch')
    const v = await verifyPawaPayCallback(await signedCallback({ keyid: 'rotated-key' }), { fetchKeys })
    assertEq(v.status === 'invalid' && v.reason, 'unknown-keyid', 'unknown keyid is INVALID')
    // warm-up was < 60s ago → the refetch is throttled
    assertEq(fetchCalls, 1, 'refetch throttled within 60s of the last fetch')

    fresh()
    const v2 = await verifyPawaPayCallback(await signedCallback({ keyid: 'rotated-key' }), { fetchKeys })
    assertEq(v2.status === 'invalid' && v2.reason, 'unknown-keyid', 'cold cache: still unknown after one fetch')
    assertEq(fetchCalls, 1, 'cold cache: exactly one fetch')
  })

  await step('rotated key picked up by the refetch', async () => {
    fresh()
    const rotated = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    let calls = 0
    const rotatingFetch = async (): Promise<PawaPayPublicKey[]> => {
      calls++
      return [{ id: 'k2', key: rotated.publicKey.export({ type: 'spki', format: 'pem' }).toString() }]
    }
    const v = await verifyPawaPayCallback(await signedCallback({ keyid: 'k2', signWith: rotated.privateKey }), { fetchKeys: rotatingFetch })
    assertEq(v.status, 'valid', 'new keyid verifies after fetch')
    assertEq(calls, 1, 'one fetch')
  })

  await step('alg mismatch', async () => {
    fresh()
    const msg = await signedCallback()
    msg.headers['signature-input'] = msg.headers['signature-input'].replace('alg="ecdsa-p256-sha256"', 'alg="hmac-sha256"')
    const v = await verifyPawaPayCallback(msg, { fetchKeys })
    assertEq(v.status === 'invalid' && v.reason, 'alg-mismatch', 'request cannot choose an algorithm the key does not allow')
  })

  await step('verifier never throws', async () => {
    fresh()
    const boom = async (): Promise<PawaPayPublicKey[]> => { throw new Error('PawaPay down') }
    let threw = false
    let v
    try { v = await verifyPawaPayCallback(await signedCallback(), { fetchKeys: boom }) } catch { threw = true }
    assert(!threw, 'key endpoint failure does not throw')
    assertEq(v?.status === 'invalid' && v.reason, 'unknown-keyid', 'key endpoint down → INVALID unknown-keyid')

    const msg = await signedCallback()
    msg.headers['signature-input'] = '((( not a dictionary'
    const v2 = await verifyPawaPayCallback(msg, { fetchKeys })
    assertEq(v2.status === 'invalid' && v2.reason, 'malformed', 'garbage Signature-Input → malformed')
  })

  await step('log-only: nothing is rejected', async () => {
    fresh()
    const msg = await signedCallback()
    delete msg.headers['signature']
    delete msg.headers['signature-input']
    const v = await verifyPawaPayCallback(msg, { fetchKeys })
    assertEq(shouldRejectCallback(v), false, 'INVALID is not rejected while the switch is false')
    assertEq(shouldRejectCallback({ status: 'skipped' }), false, 'SKIPPED is never rejected')
  })

  await step('skip flag', async () => {
    const cases: Array<[string | undefined, boolean]> = [
      [undefined, false], ['', false], ['TRUE', false], [' true', false], ['1', false], ['yes', false], ['true', true],
    ]
    for (const [val, want] of cases) {
      if (val === undefined) delete process.env.PAWAPAY_SKIP_WEBHOOK_VERIFY
      else process.env.PAWAPAY_SKIP_WEBHOOK_VERIFY = val
      assertEq(callbackVerifySkipped(), want, `PAWAPAY_SKIP_WEBHOOK_VERIFY=${JSON.stringify(val)} → skip=${want}`)
    }

    process.env.PAWAPAY_SKIP_WEBHOOK_VERIFY = 'true'
    const v = await verifyPawaPayCallback(await signedCallback(), { fetchKeys })
    assertEq(v.status, 'skipped', 'flag set in sandbox → skipped')

    process.env.PAWAPAY_ENVIRONMENT = 'production'
    assertEq(callbackVerifySkipped(), false, 'ignored when PAWAPAY_ENVIRONMENT=production')
    delete process.env.PAWAPAY_ENVIRONMENT

    process.env.PAWAPAY_BASE_URL = 'https://api.pawapay.io'
    assertEq(callbackVerifySkipped(), false, 'ignored when BASE_URL is the live API even if ENVIRONMENT is blank')
    process.env.PAWAPAY_BASE_URL = 'https://api.sandbox.pawapay.io'
    assertEq(callbackVerifySkipped(), true, 'honoured against the sandbox API')

    delete process.env.PAWAPAY_BASE_URL
    delete process.env.PAWAPAY_SKIP_WEBHOOK_VERIFY
  })

  finish(SUITE)
}

main()
