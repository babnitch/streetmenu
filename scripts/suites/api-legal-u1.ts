// U1 — footer legal & contact info: Admin → Plateforme saves it (validated,
// audited), anyone (no login) reads it; an empty value is simply absent.
// The local test server uses its own 'test_legal_contact' row — the live
// footer is never touched.

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, adminCookie, customerCookie } from '../testkit/session'
import { makeCustomer } from '../testkit/fixtures'
import { teardown } from '../testkit/ledger'
import { legalLine, validateLegalInfo } from '../../lib/legalInfo'

const SUITE = 'api-legal-u1'

async function main(): Promise<void> {
  try {
    await step('the legal line shows only what is set', () => {
      assertEq(legalLine({}, 'fr'), '', 'no company → nothing')
      assertEq(legalLine({ company_name: 'TN SARL', company_number: 'RC/YAO/2026/B/1', company_address: 'Yaoundé', contact_email: 'a@b.cm', contact_phone: '+237600000000' }, 'fr'),
        'Tchop & Ndjoka est un nom commercial de TN SARL, n° RC/YAO/2026/B/1, Yaoundé · a@b.cm · +237600000000', 'FR full')
      assertEq(legalLine({ company_name: 'TN SARL' }, 'en'), 'Tchop & Ndjoka is a trading name of TN SARL', 'EN, name only')
      assert(!validateLegalInfo({ instagram: 'http://insta' }).ok, 'http link refused')
      assertEq(validateLegalInfo({ contact_phone: '+237 6 00 00 00 00', tiktok: '' }), { ok: true, info: { contact_phone: '+237600000000' } }, 'spaces removed, empty dropped')
    })

    const admin = await adminCookie()
    const put = (body: unknown, cookie = admin) => api<{ error?: string; field?: string }>('/api/admin/platform/info', { method: 'PUT', cookie, body })

    await step('admin saves (validated); anyone reads, no login', async () => {
      const cust = await makeCustomer({ suiteNo: 89, name: 'U1 Customer' })
      assertEq((await put({ company_name: 'X' }, customerCookie(cust))).status, 401, 'customer → 401')
      const bad = await put({ contact_email: 'nope' })
      assertEq([bad.status, bad.body.field], [400, 'contact_email'], 'bad e-mail → 400 + field')
      assertEq((await put({ company_name: 'Test SARL', contact_email: 'test@example.cm', support_whatsapp: '+99989000001', instagram: 'https://instagram.com/tn' })).status, 200, 'saved')
      const pub = await api<Record<string, string>>('/api/platform/info')
      assertEq(pub.body, { company_name: 'Test SARL', contact_email: 'test@example.cm', support_whatsapp: '+99989000001', instagram: 'https://instagram.com/tn' }, 'public, only the set values')
      const { data } = await sb.from('audit_log').select('id').eq('action', 'legal_contact_updated').order('created_at', { ascending: false }).limit(1)
      assert((data ?? []).length === 1, 'audited')
      assertEq((await put({})).status, 200, 'cleared')
      assertEq((await api<Record<string, string>>('/api/platform/info')).body, {}, 'empty → nothing shown')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await sb.from('platform_settings').delete().eq('key', 'test_legal_contact')
    await teardown()
  }
  finish(SUITE)
}

void main()
