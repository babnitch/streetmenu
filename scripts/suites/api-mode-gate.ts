// Client / Pro separated — in a real browser (Playwright, headless) against
// the local server, for every entry point in both modes:
//   - a Pro page opened in Client mode shows "Cette page fait partie du mode
//     Pro" + "Passer en mode Pro", and the mode does NOT change by itself;
//     the button switches and stays on the page
//   - a client-only /account?tab= in Pro mode shows the mirror screen
//   - logged out on a Pro page → login with the return path
//   - the account page and the ☰ menu list only their mode's rows
//   - pro alerts (the ☰ dot for pending orders) only in Pro mode
//   - admins are not gated
// Every phone is +999.

import { chromium, type Browser, type Page } from 'playwright'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { customerCookie, adminCookie } from '../testkit/session'
import { BASE } from '../testkit/env'
import { CLIENT_VERSION } from '../../lib/clientVersion'
import { makeCustomer, makeRestaurant, makeOrder } from '../testkit/fixtures'
import { teardown } from '../testkit/ledger'

const SUITE = 'api-mode-gate'
const PRO_PAGES = ['/pro', '/pro/events', '/pro/profile', '/pro/restaurants', '/pro/restaurants/new', '/dashboard', '/scanner', '/livraisons', '/events/submit']
const PRO_GATE = 'Cette page fait partie du mode Pro.'
const CLIENT_GATE = 'Cette page fait partie du mode Client.'

let browser: Browser

async function open(cookie: string | null, mode: 'client' | 'pro', path: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'fr-FR' })
  if (cookie) {
    const [name, ...rest] = cookie.split(';')[0].split('=')
    await ctx.addCookies([{ name, value: rest.join('='), url: BASE }])
  }
  // Seed the browser's mode once (the app's version guard would otherwise
  // clear tn_* keys on a first visit).
  await ctx.addInitScript(([m, v]) => {
    try {
      if (!sessionStorage.getItem('__mode_seeded')) {
        localStorage.setItem('tn_version', v); localStorage.setItem('tn_mode', m); localStorage.setItem('sm_locale', 'fr')
        sessionStorage.setItem('__mode_seeded', '1')
      }
    } catch { /* storage blocked */ }
  }, [mode, CLIENT_VERSION] as const)
  const page = await ctx.newPage()
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  return page
}

// Visible text only (hidden panels don't count).
const text = (p: Page) => p.evaluate(() => document.body.innerText)
const storedMode = (p: Page) => p.evaluate(() => localStorage.getItem('tn_mode'))
async function waitFor(p: Page, needle: string, ms = 60_000): Promise<boolean> {
  try { await p.waitForFunction(n => document.body.innerText.includes(n), needle, { timeout: ms }); return true } catch { return false }
}

async function main(): Promise<void> {
  browser = await chromium.launch()
  try {
    const user = await makeCustomer({ suiteNo: 91, name: 'Mode Owner' })
    const buyer = await makeCustomer({ suiteNo: 91, name: 'Mode Buyer' })
    const rest = await makeRestaurant({ ownerId: user.id, label: 'mode_r' })
    await makeOrder(rest.id, buyer, { status: 'pending' })
    const uc = customerCookie(user)

    await step('Client mode: every Pro page shows the switch screen, never switches by itself', async () => {
      for (const path of PRO_PAGES) {
        const p = await open(uc, 'client', path)
        assert(await waitFor(p, PRO_GATE), `${path}: switch screen`)
        await p.waitForTimeout(1500)
        assertEq(await storedMode(p), 'client', `${path}: still Client mode`)
        await p.context().close()
      }
    })

    await step('"Passer en mode Pro" switches and stays on the page', async () => {
      const p = await open(uc, 'client', '/scanner')
      await waitFor(p, PRO_GATE)
      await p.click('text=Passer en mode Pro')
      assert(await waitFor(p, 'Contrôler des billets'), 'the scanner page shows')
      assertEq(new URL(p.url()).pathname, '/scanner', 'same page')
      assertEq(await storedMode(p), 'pro', 'now Pro mode')
      await p.context().close()
    })

    await step('Pro mode: Pro pages open; client account tabs show the mirror screen', async () => {
      const p = await open(uc, 'pro', '/pro/events')
      assert(!(await waitFor(p, PRO_GATE, 8000)), '/pro/events opens')
      await p.context().close()
      for (const tab of ['orders', 'bookings', 'vouchers', 'favorites']) {
        const q = await open(uc, 'pro', `/account?tab=${tab}`)
        assert(await waitFor(q, CLIENT_GATE), `?tab=${tab}: "mode Client" screen`)
        await q.context().close()
      }
    })

    await step('logged out on a Pro page → login with the return path', async () => {
      const p = await open(null, 'client', '/scanner?event=x')
      await p.waitForURL(u => u.pathname === '/login', { timeout: 60_000 })
      assertEq(new URL(p.url()).searchParams.get('return'), '/scanner?event=x', 'return path kept')
      assertEq(new URL(p.url()).searchParams.get('intent'), null, 'plain login (no silent Pro)')
      await p.context().close()
    })

    await step('account page lists only its mode', async () => {
      const c = await open(uc, 'client', '/account')
      assert(await waitFor(c, 'Mes favoris'), 'client: Mes favoris')
      const ct = await text(c)
      for (const pro of ['Profil Pro', 'Mes modules', 'Promouvoir', 'Contrôle à l\'entrée', 'Mon restaurant']) assert(!ct.includes(pro), `client: no "${pro}"`)
      await c.context().close()
      const p = await open(uc, 'pro', '/account')
      assert(await waitFor(p, 'Profil Pro'), 'pro: Profil Pro')
      await waitFor(p, 'Mon restaurant', 20_000)
      const pt = await text(p)
      assert(pt.includes('Mes modules') && pt.includes('Mon restaurant'), 'pro: modules, my restaurant')
      for (const cl of ['Mes favoris', 'Bons de réduction', 'Gérer vos alertes']) assert(!pt.includes(cl), `pro: no "${cl}"`)
      await p.context().close()
    })

    await step('☰ lists only its mode; the pending-orders dot only in Pro mode', async () => {
      const c = await open(uc, 'client', '/restaurants')
      await c.waitForSelector('button[aria-label^="Menu"]', { timeout: 60_000 })
      await c.waitForTimeout(3000)
      const labelC = await c.getAttribute('button[aria-label^="Menu"] >> nth=0', 'aria-label')
      assertEq(labelC, 'Menu', 'client: no pending dot')
      await c.click('button[aria-label^="Menu"] >> nth=0')
      await waitFor(c, 'Espace Pro')
      const mc = await text(c)
      assert(mc.includes('Mes commandes') && mc.includes('Espace Pro'), 'client ☰: my orders + Espace Pro')
      assert(!mc.includes('Commandes du restaurant') && !mc.includes('Mes événements'), 'client ☰: no pro rows')
      assert(!mc.includes('Vous avez 1 commande'), 'client: no pending-orders banner')
      await c.context().close()

      const p = await open(uc, 'pro', '/pro/events')
      await p.waitForSelector('button[aria-label^="Menu"]', { timeout: 60_000 })
      await p.waitForFunction(() => document.querySelector('button[aria-label^="Menu ("]') !== null, null, { timeout: 60_000 }).catch(() => null)
      const labelP = await p.getAttribute('button[aria-label^="Menu"] >> nth=0', 'aria-label')
      assert(/Menu \(\d+\)/.test(labelP ?? ''), `pro: pending dot (${labelP})`)
      await p.click('button[aria-label^="Menu"] >> nth=0')
      await waitFor(p, 'Commandes du restaurant')
      const mp = await text(p)
      assert(mp.includes('Commandes du restaurant') && mp.includes('Mes événements'), 'pro ☰: pro rows')
      assert(!mp.includes('Mes commandes') && !mp.includes('Mes favoris'), 'pro ☰: no customer rows')
      await p.context().close()
    })

    await step('admins are not gated', async () => {
      const p = await open(await adminCookie(), 'client', '/dashboard')
      assert(!(await waitFor(p, PRO_GATE, 10_000)), 'admin: no switch screen on /dashboard')
      await p.context().close()
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await browser?.close()
    await teardown()
  }
  finish(SUITE)
}

void main()
