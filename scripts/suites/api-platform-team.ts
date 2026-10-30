// Platform team (Admin → Équipe plateforme) + team login code screen.
//   - a new member needs a phone (it gets the 6-digit login code);
//   - the super admin edits phone, role, status, temporary password —
//     one audit row per change; not their own account, not a super admin;
//   - a temporary password: the right password + code give no session,
//     only a pass to choose a new password (≠ the temporary one) → session;
//   - "Pas reçu ?" resend: only for a live challenge.
// Every phone is +999; the dev server's Twilio is a dummy (sends → 502, the
// code row still exists, read here from the table).

import { sb, testName, testPhone } from '../testkit/env'
import { BASE } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, adminCookie, staffCookie } from '../testkit/session'

const SUITE = 'api-platform-team'

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown>; setCookie: string }> {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => ({})), setCookie: r.headers.get('set-cookie') ?? '' }
}

async function main(): Promise<void> {
  const email = testName('ptm').toLowerCase().replace(/[^a-z0-9_]/g, '') + '@test.invalid'
  const phone = testPhone(97, 9701)
  let id = ''
  try {
    const admin = await adminCookie()

    await step('create: phone required, temporary password', async () => {
      const base = { name: 'PT Member', email, password: 'Temp-Pass-1', role: 'moderator' }
      const noPhone = await api<{ field?: string }>('/api/admin/team', { cookie: admin, body: base })
      assertEq([noPhone.status, noPhone.body.field], [400, 'phone'], 'no phone → 400')
      const bad = await api<{ field?: string }>('/api/admin/team', { cookie: admin, body: { ...base, phone: '12' } })
      assertEq([bad.status, bad.body.field], [400, 'phone'], 'bad phone → 400')
      const short = await api<{ field?: string }>('/api/admin/team', { cookie: admin, body: { ...base, password: 'short', phone } })
      assertEq(short.status, 400, 'short password → 400')
      const r = await api<{ member: { id: string; phone: string; must_change_password: boolean } }>('/api/admin/team', { cookie: admin, body: { ...base, phone } })
      assertEq(r.status, 200, `created (${r.raw.slice(0, 80)})`)
      id = r.body.member.id
      assertEq([r.body.member.phone, r.body.member.must_change_password], [phone, true], 'phone stored, temporary password')
      const moderator = staffCookie({ id, email, name: 'PT Member', role: 'moderator' })
      assertEq((await api('/api/admin/team', { cookie: moderator, body: { ...base, email: 'x' + email, phone } })).status, 403, 'only the super admin adds members')
    })

    let challenge = ''
    await step('first login: code, then choose a password, then the session', async () => {
      const login = await post('/api/auth/admin-login', { email, password: 'Temp-Pass-1' })
      assert(login.status === 200 || login.status === 502, `password ok → code step (HTTP ${login.status})`)
      const { data: ch } = await sb.from('admin_login_challenges').select('id, code, expires_at').eq('admin_id', id).eq('used', false).single()
      const c = ch as { id: string; code: string; expires_at: string }
      const ttl = (new Date(c.expires_at).getTime() - Date.now()) / 60000
      assert(ttl > 9 && ttl <= 10.1, `code valid 10 min (${ttl.toFixed(1)})`)
      challenge = c.id

      const resendBad = await post('/api/auth/admin-resend', { challenge: '00000000-0000-0000-0000-000000000000', channel: 'sms' })
      assertEq([resendBad.status, resendBad.body.restart], [400, true], 'resend needs a live challenge')
      const resend = await post('/api/auth/admin-resend', { challenge, channel: 'sms' })
      assert([200, 429, 502].includes(resend.status), `resend by SMS accepted for a live challenge (HTTP ${resend.status})`)
      const { data: live } = await sb.from('admin_login_challenges').select('id, code').eq('admin_id', id).eq('used', false).single()
      const l = live as { id: string; code: string }

      const v = await post('/api/auth/admin-verify', { challenge: l.id, code: l.code })
      assertEq([v.status, v.body.step], [200, 'set_password'], 'right code → choose a password')
      assert(!/sm_session|tn_session|session=/i.test(v.setCookie), 'no session yet')
      const pass = String(v.body.pass)
      assertEq((await post('/api/auth/admin-set-password', { pass: 'x', newPassword: 'New-Pass-123' })).status, 401, 'bad pass → 401')
      assertEq((await post('/api/auth/admin-set-password', { pass, newPassword: 'Temp-Pass-1' })).status, 400, 'same as the temporary → 400')
      const set = await post('/api/auth/admin-set-password', { pass, newPassword: 'New-Pass-123' })
      assertEq(set.status, 200, 'new password saved')
      assert(/Max-Age=43200/i.test(set.setCookie), 'then the 12-hour session')
      const { data: row } = await sb.from('admin_users').select('must_change_password').eq('id', id).single()
      assertEq((row as { must_change_password: boolean }).must_change_password, false, 'no longer temporary')
      assertEq((await post('/api/auth/admin-set-password', { pass, newPassword: 'Other-Pass-123' })).status, 409, 'the pass works once')
    })

    await step('super admin edits: phone, role, status, temporary password — audited', async () => {
      const newPhone = testPhone(97, 9702)
      const r = await api<{ changed: string[] }>(`/api/admin/team/${id}`, { method: 'PATCH', cookie: admin, body: { phone: newPhone, role: 'admin' } })
      assertEq(r.status, 200, 'saved')
      assertEq(r.body.changed.sort(), ['admin_user_phone_changed', 'admin_user_role_changed'], 'two changes')
      assertEq((await api(`/api/admin/team/${id}`, { method: 'PATCH', cookie: admin, body: { phone: 'abc' } })).status, 400, 'bad phone → 400')
      assertEq((await api(`/api/admin/team/${id}`, { method: 'PATCH', cookie: admin, body: { role: 'super_admin' } })).status, 400, 'cannot make a super admin')
      assertEq((await api(`/api/admin/team/${id}`, { method: 'PATCH', cookie: admin, body: { status: 'suspended' } })).status, 200, 'disabled')
      const off = await post('/api/auth/admin-login', { email, password: 'New-Pass-123' })
      assertEq(off.status, 403, 'disabled → cannot log in')
      await api(`/api/admin/team/${id}`, { method: 'PATCH', cookie: admin, body: { status: 'active', password: 'Reset-Pass-1' } })
      const { data: row } = await sb.from('admin_users').select('phone, role, status, must_change_password').eq('id', id).single()
      assertEq(row, { phone: newPhone, role: 'admin', status: 'active', must_change_password: true }, 'stored; reset → temporary again')
      const { data: audit } = await sb.from('audit_log').select('action').eq('target_id', id)
      const actions = (audit ?? []).map(a => (a as { action: string }).action)
      for (const a of ['admin_user_added', 'admin_user_phone_changed', 'admin_user_role_changed', 'admin_user_suspended', 'admin_user_reactivated', 'admin_user_password_reset', 'admin_user_password_set']) {
        assert(actions.includes(a), `audit: ${a}`)
      }
      const { data: sa } = await sb.from('admin_users').select('id').eq('role', 'super_admin').limit(1).single()
      const other = staffCookie({ id, email, name: 'PT', role: 'super_admin' })
      assertEq((await api(`/api/admin/team/${(sa as { id: string }).id}`, { method: 'PATCH', cookie: other, body: { role: 'moderator' } })).status, 403, 'a super admin is not editable here')
    })

    await step('remove: kept as "Retiré", cannot log in, audited', async () => {
      const r = await api(`/api/admin/team/${id}`, { method: 'DELETE', cookie: admin })
      assertEq(r.status, 200, `removed (${r.raw.slice(0, 80)})`)
      const { data: row } = await sb.from('admin_users').select('status, deleted_at, deleted_by').eq('id', id).maybeSingle()
      const m = row as { status: string; deleted_at: string | null; deleted_by: string | null } | null
      assertEq(m?.status, 'removed', 'row kept, status removed')
      assert(!!m?.deleted_at && !!m?.deleted_by, 'deleted_at + deleted_by set')
      const login = await post('/api/auth/admin-login', { email, password: 'Reset-Pass-1' })
      assertEq(login.status, 403, 'removed → cannot log in')
      const list = await api<{ team: Array<{ id: string; status: string }> }>('/api/admin/team', { cookie: admin })
      assertEq((list.body.team ?? []).find(t => t.id === id)?.status, 'removed', 'still in the list')
      assertEq((await api(`/api/admin/team/${id}`, { method: 'PATCH', cookie: admin, body: { status: 'active' } })).status, 409, 'cannot be edited back')
      const { data: audit } = await sb.from('audit_log').select('action').eq('target_id', id).eq('action', 'admin_user_removed')
      assertEq((audit ?? []).length, 1, 'audit: admin_user_removed')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    if (id) {
      await sb.from('admin_login_challenges').delete().eq('admin_id', id)
      await sb.from('audit_log').delete().eq('target_id', id)
      await sb.from('admin_login_attempts').delete().eq('email', email)
      await sb.from('admin_users').delete().eq('id', id)
    }
    await sb.from('auth_code_sends').delete().like('phone', '+99997%')
    await sb.from('message_log').delete().like('to_number', '%99997%')
  }
  finish(SUITE)
}

void main()
