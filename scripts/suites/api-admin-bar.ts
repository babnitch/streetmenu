// Admin top bar (components/AdminBar.tsx) in a real browser:
//   - order by use: Commandes, Restaurants, Événements, À visiter, Comptes…
//   - as many items as fit on one line, the rest under ⋯; never overflows
//   - FR/EN and Déconnexion always visible, phone and desktop
//   - a regular admin never sees super-admin-only items (Équipe plateforme)
// A throwaway admin account (+999), removed at the end.

import bcrypt from 'bcryptjs'
import { chromium, type Browser, type Page } from 'playwright'
import { sb, BASE, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { adminCookie, staffCookie } from '../testkit/session'
import { CLIENT_VERSION } from '../../lib/clientVersion'

const SUITE = 'api-admin-bar'
let browser: Browser

async function open(cookie: string, width: number): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: 'fr-FR' })
  const [name, ...rest] = cookie.split(';')[0].split('=')
  await ctx.addCookies([{ name, value: rest.join('='), url: BASE }])
  await ctx.addInitScript(v => { try { localStorage.setItem('tn_version', v); localStorage.setItem('sm_locale', 'fr') } catch { /* blocked */ } }, CLIENT_VERSION)
  const page = await ctx.newPage()
  await page.goto(BASE + '/account', { waitUntil: 'domcontentloaded', timeout: 240_000 })
  await page.waitForSelector('nav[aria-label="Navigation administration"] button', { timeout: 120_000 })
  await page.waitForTimeout(800)
  return page
}
const navState = (p: Page) => p.evaluate(() => {
  const nav = document.querySelector('nav[aria-label="Navigation administration"]') as HTMLElement
  const items = Array.from(nav.children).filter(c => c.tagName === 'BUTTON').map(b => (b as HTMLElement).innerText.trim())
  const right = nav.getBoundingClientRect().right
  const sticksOut = Array.from(nav.querySelectorAll('button')).some(b => b.getBoundingClientRect().right > right + 1)
  return { items, overflow: sticksOut || nav.scrollWidth > nav.clientWidth + 1 || document.documentElement.scrollWidth > window.innerWidth, hasMore: !!nav.querySelector('button[aria-label="Plus"]') }
})

async function main(): Promise<void> {
  browser = await chromium.launch()
  const email = testName('bar').toLowerCase().replace(/[^a-z0-9_]/g, '') + '@test.invalid'
  let adminId = ''
  try {
    const sup = await adminCookie()

    await step('desktop: order by use, fits on one line, ⋯ for the rest, FR/EN + logout', async () => {
      const p = await open(sup, 1280)
      const s = await navState(p)
      assert(!s.overflow, 'no overflow')
      assertEq(s.items.slice(0, 5).map(x => x.replace(/^\S+\s/, '')), ['Commandes', 'Restaurants', 'Événements', 'À visiter', 'Comptes'], 'first five, by use')
      assert(s.hasMore, '⋯ holds the rest')
      await p.click('button[aria-label="Plus"]')
      const menu = await p.locator('[role="menu"]').innerText()
      assert(menu.includes('Données de référence') && menu.includes('Équipe plateforme'), 'the rest is under ⋯ (super admin sees everything)')
      assert(await p.locator('button[aria-label="Déconnexion"]').isVisible(), 'logout visible')
      assert(await p.getByRole('button', { name: /^(FR|EN)/ }).first().isVisible().catch(() => false) || (await p.locator('header').innerText()).includes('EN'), 'language toggle visible')
      await p.context().close()
    })

    await step('phone: most items under ⋯, still no overflow, logout visible', async () => {
      const p = await open(sup, 390)
      const s = await navState(p)
      assert(!s.overflow, 'no overflow on a phone')
      assert(s.hasMore && s.items.length <= 2, `⋯ with few items shown (${s.items.length})`)
      assert(await p.locator('button[aria-label="Déconnexion"]').isVisible(), 'logout visible on a phone')
      await p.context().close()
    })

    await step('a regular admin: no super-admin-only items', async () => {
      const { data, error } = await sb.from('admin_users').insert({ email, name: 'Bar Admin', role: 'admin', status: 'active', phone: '+999550001', password_hash: bcrypt.hashSync('x-Password-1', 8) } as never).select('id').single()
      if (error || !data) throw new Error(`admin insert: ${error?.message}`)
      adminId = (data as { id: string }).id
      const p = await open(staffCookie({ id: adminId, email, name: 'Bar Admin', role: 'admin' }), 1280)
      await p.click('button[aria-label="Plus"]')
      const all = (await navState(p)).items.join(' ') + ' ' + await p.locator('[role="menu"]').innerText()
      assert(!all.includes('Équipe plateforme'), 'no Équipe plateforme')
      assert(all.includes('Données de référence'), 'Données de référence is there for admins')
      await p.context().close()
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    if (adminId) { await sb.from('audit_log').delete().eq('target_id', adminId); await sb.from('admin_users').delete().eq('id', adminId) }
    await browser.close()
  }
  finish(SUITE)
}

void main()
