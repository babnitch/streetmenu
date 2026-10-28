// TEST-PLAN.md §1c #28 (login / sign-up) and #37 partial (customer history:
// orders linked to the session's customer_id).
//
// Login is one step for everyone (L1): send-code to any valid number, then
// verify-code; a NEW number gets a sign-up pass and complete-signup asks only
// for a first name. Limits and code attempts live in the database
// (supabase-auth-login-limits.sql).
//
// Delivery: the local server runs with dummy Twilio credentials, so a send
// fails at Twilio and the route answers 502 after logging the attempts. What
// does not depend on delivery — the code row, the send log, the limits — is
// asserted hard. Codes for verify are written straight into
// verification_codes, so no message is ever needed.
//
// The suite's code sends go to +999 numbers and count against the live
// platform's daily cap only until teardown deletes them.

import { sb, BASE, testName } from '../testkit/env'
import { assert, assertEq, warn, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeOrder, testPictureUrl } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import bcrypt from 'bcryptjs'
import { staffCookie } from '../testkit/session'

const SUITE = 'api-auth-and-profile'

interface SendCodeBody { sent?: boolean; channel?: string; error?: string; reason?: string; retry_after?: number }
interface VerifyBody {
  error?: string; result?: string; needsName?: boolean; signupPass?: string
  customer?: { id: string; phone: string; name: string }; isNewAccount?: boolean; linkedOrders?: number
}

// Puts a known code in place for `phone`, the way send-code would.
async function plantCode(phone: string, code: string): Promise<void> {
  await sb.from('verification_codes').delete().eq('phone', phone)
  const { error } = await sb.from('verification_codes').insert({
    phone, code, expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), used: false,
  } as never)
  if (error) throw new Error(`plant code: ${error.message}`)
}

// POST returning the Set-Cookie header too (api() does not expose headers).
async function postWithCookie(path: string, body: unknown): Promise<{ status: number; body: VerifyBody; setCookie: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => ({})), setCookie: res.headers.get('set-cookie') ?? '' }
}

async function countCustomers(phone: string): Promise<number> {
  const { count } = await sb.from('customers').select('*', { count: 'exact', head: true }).eq('phone', phone)
  return count ?? 0
}

async function main(): Promise<void> {
  try {
    // ── #28 check-phone / send-code ────────────────────────────────────────
    const known = await makeCustomer({ suiteNo: 28, name: 'Test WA Customer' })
    // Never inserted — the "unknown phone" side of every assertion below.
    const unknownPhone = '+999280099'

    await step('Pro profile: name + extra number typed any way, normalised', async () => {
      const cookie = customerCookie(known)
      assertEq((await api('/api/pro/profile')).status, 401, 'no session → 401')
      const r = await api<{ profile?: { pro_name: string | null; pro_notify_phone: string | null } }>('/api/pro/profile', {
        method: 'PATCH', cookie, body: { pro_name: '  Asso <b>Mboa</b>  ', pro_notify_phone: '0699 00 00 01' },
      })
      assertEq(r.status, 200, `PATCH → 200 (body ${r.raw.slice(0, 160)})`)
      assertEq(r.body.profile?.pro_name, 'Asso Mboa', 'name sanitised')
      assertEq(r.body.profile?.pro_notify_phone, '+237699000001', '"0699 00 00 01" → +237699000001 (account country)')
      const bad = await api<{ error?: string }>('/api/pro/profile', { method: 'PATCH', cookie, body: { pro_notify_phone: '12' } })
      assertEq(bad.status, 400, 'unusable number → 400')
      assert(/Numéro invalide/.test(bad.body.error ?? '') && /Invalid number/.test(bad.body.error ?? ''), 'FR/EN error')
      const g = await api<{ profile?: { pro_notify_phone: string | null } }>('/api/pro/profile', { cookie })
      assertEq(g.body.profile?.pro_notify_phone, '+237699000001', 'a refused update left the saved number')
      const cleared = await api<{ profile?: { pro_name: string | null; pro_notify_phone: string | null } }>('/api/pro/profile', {
        method: 'PATCH', cookie, body: { pro_name: '', pro_notify_phone: '' },
      })
      assertEq(cleared.body.profile?.pro_notify_phone, null, "'' clears the number")
      assertEq(cleared.body.profile?.pro_name, null, "'' clears the name")
    })

    await step('image upload needs a login', async () => {
      const anon = await api('/api/upload/image', { method: 'POST', body: {} })
      assertEq(anon.status, 401, 'no session → 401')
      // Logged in, the gate lets the request through to form parsing (a JSON
      // body is not multipart → 400). No file is stored.
      const signed = await api('/api/upload/image', { method: 'POST', cookie: customerCookie(known), body: {} })
      assertEq(signed.status, 400, `logged in → past the gate (400 not multipart, got ${signed.status})`)
    })

    await step('the old /admin password login is gone', async () => {
      const r = await api('/api/admin/auth', { body: { password: 'x' } })
      assertEq(r.status, 404, 'POST /api/admin/auth → 404')
    })

    await step('check-phone is gone (no account lookup by strangers)', async () => {
      const r = await api(`/api/auth/check-phone?phone=${encodeURIComponent(known.phone)}`)
      assertEq(r.status, 404, 'HTTP 404')
    })

    await step('send-code: an unusable number → 400 with a FR/EN error', async () => {
      const r = await api<SendCodeBody>('/api/auth/send-code', { body: { phone: '12', country: 'CM' } })
      assertEq(r.status, 400, 'HTTP 400')
      assert(/Numéro invalide/.test(r.body.error ?? ''), 'error explains the format')
    })

    await step('send-code for an existing customer: one 6-digit code, logged, no duplicate', async () => {
      const messy = known.phone.replace(/^(\+\d{3})(\d{3})(\d+)$/, '$1 $2 $3')
      const r = await api<SendCodeBody>('/api/auth/send-code', { body: { phone: messy } })
      if (r.status !== 200) {
        warn(`send-code returned ${r.status}, not 200`, 'no channel can deliver with dummy Twilio credentials — expected locally')
      }
      const { data: codes } = await sb.from('verification_codes').select('code, used').eq('phone', known.phone)
      assertEq((codes ?? []).length, 1, 'exactly one fresh code')
      assert(/^\d{6}$/.test((codes as Array<{ code: string }>)[0]?.code ?? ''), 'the code has 6 digits')
      const { data: log } = await sb.from('auth_code_sends').select('status, channel').eq('phone', known.phone)
      assert((log ?? []).length >= 1, `the attempt is logged in auth_code_sends (${(log ?? []).length} row(s))`)
      assertEq(await countCustomers(known.phone), 1, 'still exactly 1 customer row (no dup)')
    })

    await step('send-code again at once → 429, wait 30 s (limit in the database)', async () => {
      const r = await api<SendCodeBody>('/api/auth/send-code', { body: { phone: known.phone } })
      assertEq(r.status, 429, 'HTTP 429')
      assertEq(r.body.reason, 'resend_cooldown', 'reason resend_cooldown')
      assert((r.body.retry_after ?? 0) > 0 && (r.body.retry_after ?? 0) <= 30, `retry_after in (0, 30] (${r.body.retry_after})`)
      const { data } = await sb.from('auth_code_sends').select('status, reason').eq('phone', known.phone).eq('status', 'blocked')
      assertEq((data ?? []).length, 1, 'the blocked attempt is logged too')
    })

    await step('send-code for an unknown number: no account is created yet', async () => {
      await api<SendCodeBody>('/api/auth/send-code', { body: { phone: unknownPhone } })
      assertEq(await countCustomers(unknownPhone), 0, 'no customer row created by sending a code')
    })

    await step('a suspended account gets no code', async () => {
      const sus = await makeCustomer({ suiteNo: 28, name: 'Suspended', status: 'suspended' })
      const r = await api<SendCodeBody>('/api/auth/send-code', { body: { phone: sus.phone, locale: 'en' } })
      assertEq(r.status, 403, 'HTTP 403')
      assert(/suspended/i.test(r.body.error ?? ''), 'English error for locale en')
      const { data } = await sb.from('verification_codes').select('id').eq('phone', sus.phone)
      assertEq((data ?? []).length, 0, 'no code written')
    })

    await step('verify-code: wrong codes count down, then the code dies', async () => {
      const p = await makeCustomer({ suiteNo: 28, name: 'Wrong Codes' })
      await plantCode(p.phone, '123456')
      const first = await api<VerifyBody>('/api/auth/verify-code', { body: { phone: p.phone, code: '000000' } })
      assertEq(first.status, 400, 'wrong → 400')
      assertEq(first.body.result, 'wrong', 'result wrong')
      assert(/4/.test(first.body.error ?? ''), `says 4 attempts left (${first.body.error})`)
      for (let i = 0; i < 4; i++) await api('/api/auth/verify-code', { body: { phone: p.phone, code: '000000' } })
      const right = await api<VerifyBody>('/api/auth/verify-code', { body: { phone: p.phone, code: '123456' } })
      assertEq(right.status, 400, 'the right code after 5 wrong ones → still refused')
      assertEq(right.body.result, 'locked', 'result locked')
    })

    await step('verify-code for a known number: 30-day session, guest orders attached', async () => {
      const p = await makeCustomer({ suiteNo: 28, name: 'Returning' })
      const rest = await makeRestaurant({ label: 'guest_link' })
      // A guest order placed with the same number, typed with spaces.
      const { data: g } = await sb.from('orders').insert({
        restaurant_id: rest.id, customer_id: null, customer_name: 'Guest', items: [], total_price: 1000, status: 'pending',
        customer_phone: p.phone.replace(/^(\+\d{3})(\d{3})(\d+)$/, '$1 $2 $3'),
      } as never).select('id').single()
      track('orders', (g as { id: string }).id)
      await plantCode(p.phone, '654321')
      const r = await postWithCookie('/api/auth/verify-code', { phone: p.phone, code: '654321' })
      assertEq(r.status, 200, `HTTP 200 (${JSON.stringify(r.body).slice(0, 120)})`)
      assertEq(r.body.customer?.id, p.id, 'logged in to the existing account')
      assertEq(r.body.isNewAccount, false, 'not a new account')
      assert(/Max-Age=2592000/i.test(r.setCookie), 'session cookie lasts 30 days')
      assertEq(r.body.linkedOrders, 1, 'one guest order attached')
      const { data: o } = await sb.from('orders').select('customer_id').eq('id', (g as { id: string }).id).single()
      assertEq((o as { customer_id: string | null }).customer_id, p.id, 'the guest order now belongs to the account')
    })

    await step('new number: code → first name only → account + BIENVENUE, site language kept', async () => {
      const phone = '+999280098'
      await plantCode(phone, '111222')
      const v = await api<VerifyBody>('/api/auth/verify-code', { body: { phone, code: '111222', locale: 'en' } })
      assertEq(v.status, 200, 'HTTP 200')
      assertEq(v.body.needsName, true, 'needsName')
      assert(!!v.body.signupPass, 'a sign-up pass is returned')
      assertEq(await countCustomers(phone), 0, 'no account before the first name')

      // The pass is not a session.
      const me = await api<{ user: unknown }>('/api/auth/me', { cookie: `sm_session=${v.body.signupPass}` })
      assertEq(me.body.user, null, 'a sign-up pass used as a cookie is not a login')

      const noName = await api<VerifyBody>('/api/auth/complete-signup', { body: { signupPass: v.body.signupPass, name: '  ' } })
      assertEq(noName.status, 400, 'no first name → 400')
      const done = await postWithCookie('/api/auth/complete-signup', { signupPass: v.body.signupPass, name: 'Amina', locale: 'en' })
      assertEq(done.status, 200, `HTTP 200 (${JSON.stringify(done.body).slice(0, 120)})`)
      track('customers', done.body.customer?.id)
      assertEq(done.body.isNewAccount, true, 'isNewAccount')
      assert(/Max-Age=2592000/i.test(done.setCookie), 'logged in for 30 days')
      const { data: c } = await sb.from('customers').select('name, preferred_language').eq('phone', phone).single()
      assertEq((c as { name: string }).name, 'Amina', 'first name saved')
      assertEq((c as { preferred_language: string }).preferred_language, 'en', 'site language saved')
      const { data: vouchers } = await sb.from('customer_vouchers').select('id').eq('customer_id', done.body.customer?.id ?? '')
      assert((vouchers ?? []).length >= 1, 'BIENVENUE welcome voucher given')
      const bad = await api('/api/auth/complete-signup', { body: { signupPass: 'forged', name: 'X' } })
      assertEq(bad.status, 401, 'a forged pass → 401')
    })

    await step('Pro sign-up path: business name required, account opens in Pro', async () => {
      const phone = '+999280097'
      await plantCode(phone, '333444')
      const v = await api<VerifyBody>('/api/auth/verify-code', { body: { phone, code: '333444' } })
      assertEq(v.body.needsName, true, 'new number → needsName')
      const noBiz = await api('/api/auth/complete-signup', { body: { signupPass: v.body.signupPass, name: 'Pro', pro: true } })
      assertEq(noBiz.status, 400, 'Pro path without a business name → 400')
      const done = await api<VerifyBody & { default_mode?: string }>('/api/auth/complete-signup', {
        body: { signupPass: v.body.signupPass, name: 'Paul', pro: true, pro_name: 'Maquis Paul' },
      })
      assertEq(done.status, 200, `HTTP 200 (${JSON.stringify(done.body).slice(0, 120)})`)
      track('customers', done.body.customer?.id)
      assertEq(done.body.default_mode, 'pro', 'answer says Pro')
      const { data: c } = await sb.from('customers').select('pro_name, default_mode').eq('phone', phone).single()
      assertEq((c as { pro_name: string }).pro_name, 'Maquis Paul', 'business name saved as pro_name')
      assertEq((c as { default_mode: string }).default_mode, 'pro', 'default_mode = pro on the account')
      // A later login reports it.
      await plantCode(phone, '555666')
      const again = await api<{ default_mode?: string }>('/api/auth/verify-code', { body: { phone, code: '555666' } })
      assertEq(again.body.default_mode, 'pro', 'next login opens in Pro')
    })

    await step('mode switch in Mon compte is saved on the account', async () => {
      const p = await makeCustomer({ suiteNo: 28, name: 'Mode Switch' })
      assertEq((await api('/api/customer/mode', { method: 'PATCH', body: { mode: 'pro' } })).status, 401, 'no session → 401')
      const cookie = customerCookie(p)
      assertEq((await api('/api/customer/mode', { method: 'PATCH', cookie, body: { mode: 'boss' } })).status, 400, 'bad mode → 400')
      assertEq((await api('/api/customer/mode', { method: 'PATCH', cookie, body: { mode: 'pro' } })).status, 200, 'pro → 200')
      const { data } = await sb.from('customers').select('default_mode').eq('id', p.id).single()
      assertEq((data as { default_mode: string }).default_mode, 'pro', 'saved')
    })

    await step('Ajouter un restaurant (web): owner = account, city-centre pin, one per number', async () => {
      const owner = await makeCustomer({ suiteNo: 28, name: 'Resto Owner' })
      const cookie = customerCookie(owner)
      const body = { name: testName('c3_resto'), city: 'Dakar', neighborhood: 'Plateau', cuisine_type: 'Grillades', image_url: testPictureUrl() }
      assertEq((await api('/api/restaurants/submit', { body })).status, 401, 'logged out → 401')
      assertEq((await api('/api/restaurants/submit', { cookie, body: { ...body, city: 'Paris' } })).status, 400, 'unknown city → 400')
      assertEq((await api('/api/restaurants/submit', { cookie, body: { ...body, cuisine_type: 'Pizza' } })).status, 400, 'unknown food type → 400')
      const r = await api<{ restaurant?: { id: string } }>('/api/restaurants/submit', { cookie, body: { ...body, lat: 48.85, lng: 2.35 } })
      assertEq(r.status, 200, `HTTP 200 (${r.raw.slice(0, 120)})`)
      track('restaurants', r.body.restaurant?.id)
      const { data: row } = await sb.from('restaurants')
        .select('customer_id, whatsapp, status, is_active, lat, lng, cuisine_type').eq('id', r.body.restaurant?.id ?? '').single()
      const x = row as { customer_id: string; whatsapp: string; status: string; is_active: boolean; lat: number; lng: number; cuisine_type: string }
      assertEq(x.customer_id, owner.id, 'owner = the account')
      assertEq(x.whatsapp, owner.phone, 'WhatsApp = the account phone')
      assertEq(x.status, 'pending', 'pending approval')
      assertEq(x.is_active, false, 'not live yet')
      assertEq([x.lat, x.lng], [14.6937, -17.4441], 'a position far from Dakar is ignored → city centre')
      const { data: team } = await sb.from('restaurant_team').select('role, status').eq('restaurant_id', r.body.restaurant?.id ?? '').eq('customer_id', owner.id)
      assertEq((team as Array<{ role: string }> | null)?.[0]?.role, 'owner', 'owner team row')
      const second = await api('/api/restaurants/submit', { cookie, body: { ...body, name: testName('c3_resto2') } })
      assertEq(second.status, 409, 'a second restaurant on the same number → 409')
      const old = await api('/api/restaurants/signup', { body: { ...body, name: testName('c3_old_signup'), whatsapp: '+999280096', owner_name: 'x' } })
      assert(old.status >= 400, `the old public, ownerless signup is gone (HTTP ${old.status})`)
      const { data: none } = await sb.from('restaurants').select('id').eq('name', testName('c3_old_signup'))
      assertEq((none ?? []).length, 0, 'nothing created by it')
    })

    await step('team login: 2 steps, lockout, logs, 12-hour session', async () => {
      // A throwaway team account. The local server runs with
      // ADMIN_LOGIN_ALERTS=off, so its lock alert never reaches real phones.
      const email = testName('team').toLowerCase().replace(/[^a-z0-9_]/g, '') + '@test.invalid'
      const { data: adm, error } = await sb.from('admin_users').insert({
        email, name: 'Test Team', role: 'moderator', status: 'active', phone: '+999280095',
        password_hash: bcrypt.hashSync('Right-Password-1', 10),
      } as never).select('id').single()
      if (error || !adm) throw new Error(`team insert: ${error?.message}`)
      const adminId = (adm as { id: string }).id
      try {
        const unknown = await api<{ error?: string }>('/api/auth/admin-login', { body: { email: 'nobody' + email, password: 'x' } })
        const wrong = await api<{ error?: string }>('/api/auth/admin-login', { body: { email, password: 'wrong' } })
        assertEq(unknown.status, 401, 'unknown email → 401')
        assertEq(wrong.status, 401, 'wrong password → 401')
        assertEq(unknown.body.error, wrong.body.error, 'same message: no telling whether the email exists')

        const ok = await api<{ step?: string; challenge?: string }>('/api/auth/admin-login', { body: { email, password: 'Right-Password-1' } })
        assert(ok.status === 200 || ok.status === 502, `right password → code step (HTTP ${ok.status}; 502 = dummy Twilio)`)
        const { data: ch } = await sb.from('admin_login_challenges').select('id, code').eq('admin_id', adminId).eq('used', false).single()
        const c = ch as { id: string; code: string }
        assert(/^\d{6}$/.test(c.code), 'a 6-digit code is pending')
        const { data: noSession } = await sb.from('admin_login_attempts').select('stage, success').eq('email', email).eq('success', true)
        assertEq((noSession ?? []).map(r => (r as { stage: string }).stage), ['password'], 'the password alone opens no session')

        const bad = await api<{ error?: string }>('/api/auth/admin-verify', { body: { challenge: c.id, code: c.code === '000000' ? '111111' : '000000' } })
        assertEq(bad.status, 400, 'wrong code → 400')
        const good = await postWithCookie('/api/auth/admin-verify', { challenge: c.id, code: c.code })
        assertEq(good.status, 200, `right code → 200 (${JSON.stringify(good.body).slice(0, 100)})`)
        assert(/Max-Age=43200/i.test(good.setCookie), 'team session lasts 12 hours')
        const reuse = await api('/api/auth/admin-verify', { body: { challenge: c.id, code: c.code } })
        assertEq(reuse.status, 400, 'a code works once')

        // Failures so far for this email: wrong password + wrong code = 2.
        for (let i = 0; i < 3; i++) await api('/api/auth/admin-login', { body: { email, password: 'wrong' } })
        const locked = await api<{ locked?: boolean }>('/api/auth/admin-login', { body: { email, password: 'Right-Password-1' } })
        assertEq(locked.status, 429, '5 failures → locked, even with the right password')
        assertEq(locked.body.locked, true, 'says locked')
        const { data: audit } = await sb.from('audit_log').select('action').eq('target_id', adminId)
        const actions = new Set((audit ?? []).map(r => (r as { action: string }).action))
        assert(actions.has('admin_login_success') && actions.has('admin_login_failed'), 'successes and failures are in the audit log')

        // A suspended team member's open session ends.
        const cookie = staffCookie({ id: adminId, email, name: 'Test Team', role: 'moderator' })
        assertEq(((await api<{ user: { id: string } | null }>('/api/auth/me', { cookie })).body.user)?.id, adminId, 'team session works')
        await sb.from('admin_users').update({ status: 'suspended' } as never).eq('id', adminId)
        assertEq((await api<{ user: unknown }>('/api/auth/me', { cookie })).body.user, null, 'suspended → session ended')

        const page = await fetch(`${BASE}/admin/login`)
        assert(/noindex/i.test(page.headers.get('x-robots-tag') ?? ''), '/admin/login is noindex')
      } finally {
        const { data: att } = await sb.from('admin_login_attempts').select('id').or(`email.eq.${email},email.eq.nobody${email}`)
        const ids = [adminId, ...(att ?? []).map(r => (r as { id: string }).id)]
        await sb.from('audit_log').delete().in('target_id', ids)
        await sb.from('admin_login_attempts').delete().in('id', ids)
        await sb.from('admin_users').delete().eq('id', adminId)
      }
    })

    await step('/api/auth/me ends the session of a suspended account', async () => {
      const p = await makeCustomer({ suiteNo: 28, name: 'Later Suspended' })
      const cookie = customerCookie(p)
      assertEq(((await api<{ user: { id: string } | null }>('/api/auth/me', { cookie })).body.user)?.id, p.id, 'logged in')
      await sb.from('customers').update({ status: 'suspended' } as never).eq('id', p.id)
      const after = await api<{ user: unknown }>('/api/auth/me', { cookie })
      assertEq(after.body.user, null, 'suspended → user null')
    })

    // ── #37 partial: session identity and customer history ─────────────────
    const buyer = await makeCustomer({ suiteNo: 37, name: 'Test Checkout' })
    const rest  = await makeRestaurant({ label: 'checkout_rest' })
    const cookie = customerCookie(buyer)

    await step('/api/auth/me with a session returns that customer', async () => {
      const r = await api<{ user?: { id: string; role: string; name: string; phone: string } }>(
        '/api/auth/me', { cookie },
      )
      assertEq(r.status, 200, 'HTTP 200')
      assertEq(r.body.user?.role, 'customer', 'role=customer')
      assertEq(r.body.user?.id, buyer.id, 'id matches the seeded customer')
      assertEq(r.body.user?.name, buyer.name, 'name matches')
      assertEq(r.body.user?.phone, buyer.phone, 'phone matches')
    })

    await step('/order renders without a 500', async () => {
      const r = await api('/order', { cookie })
      assertEq(r.status, 200, '/order HTTP 200')
    })

    let linkedOrderId = ''
    await step('a logged-in order is linked to customer_id', async () => {
      const o = await makeOrder(rest.id, buyer, { status: 'pending', total: 2500 })
      linkedOrderId = o.id
      const { data } = await sb.from('orders').select('customer_id').eq('id', o.id).maybeSingle()
      assertEq((data as { customer_id?: string } | null)?.customer_id, buyer.id, 'order linked to customer_id')
    })

    await step('a guest order has a null customer_id', async () => {
      const { data, error } = await sb.from('orders').insert({
        restaurant_id: rest.id,
        customer_name: 'Guest',
        customer_phone: '+999370099',
        items: [{ name: 'Eru', quantity: 1, price: 2000 }],
        total_price: 2000,
        status: 'pending',
        customer_id: null,
      } as never).select('id, customer_id').single()
      assert(!error, `guest order inserted${error ? ` — ${error.message}` : ''}`)
      const row = data as unknown as { id: string; customer_id: string | null }
      track('orders', row.id)
      assertEq(row.customer_id, null, 'guest order has null customer_id')
    })

    await step('"mes commandes" scoped to customer_id returns only the linked order', async () => {
      const { data } = await sb.from('orders').select('id, customer_id')
        .eq('customer_id', buyer.id).order('created_at', { ascending: false })
      assertEq((data ?? []).length, 1, 'exactly one order in "mes commandes"')
      assertEq((data as Array<{ id: string }>)[0]?.id, linkedOrderId, 'it is the logged-in order, not the guest one')
    })
  } finally {
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }

  finish(SUITE)
}

void main()
