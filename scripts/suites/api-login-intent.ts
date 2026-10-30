// Client / Pro login entry points — in a real browser (Playwright, headless):
//   - logged out ☰ → "Espace Pro" opens the PRO login directly
//   - from there ☰ → "Se connecter" / "Créer un compte" give the CLIENT
//     login (the page is already open — it must follow the URL)
//   - the Pro login has "Je suis un client" back to the client login
// Nobody logs in; no data is written.

import { chromium, type Browser, type Page } from 'playwright'
import { assert, step, finish } from '../testkit/assert'
import { BASE } from '../testkit/env'
import { CLIENT_VERSION } from '../../lib/clientVersion'

const SUITE = 'api-login-intent'
const PRO_TITLE = 'Espace Pro — connexion ou inscription'
const CLIENT_TITLE = 'Connexion ou inscription'
let browser: Browser

async function open(path: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'fr-FR' })
  await ctx.addInitScript(v => {
    try { localStorage.setItem('tn_version', v); localStorage.setItem('sm_locale', 'fr') } catch { /* blocked */ }
  }, CLIENT_VERSION)
  const page = await ctx.newPage()
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 240_000 })
  return page
}
const h1 = async (p: Page, want: string) => {
  try { await p.waitForFunction(t => (document.querySelector('h1')?.textContent ?? '').trim() === t, want, { timeout: 60_000 }); return true } catch { return false }
}
async function openMenu(p: Page): Promise<void> {
  await p.waitForSelector('button[aria-label^="Menu"]', { timeout: 120_000 })
  await p.waitForTimeout(500)   // hydrated
  await p.click('button[aria-label^="Menu"] >> nth=0')
  await p.waitForSelector('[role="dialog"][aria-label="Menu"]', { timeout: 30_000 })
}

async function main(): Promise<void> {
  browser = await chromium.launch()
  try {
    await step('☰ Espace Pro (logged out) → Pro login directly', async () => {
      const p = await open('/')
      await openMenu(p)
      await p.getByRole('link', { name: 'Espace Pro' }).click()
      assert(await h1(p, PRO_TITLE), 'Pro login, no second tap')
      assert(p.url().includes('intent=pro'), 'URL says pro')

      await openMenu(p)
      await p.getByRole('link', { name: 'Se connecter' }).click()
      assert(await h1(p, CLIENT_TITLE), '☰ Se connecter from the Pro login → client login')

      await p.goto(BASE + '/login?intent=pro', { waitUntil: 'domcontentloaded' })
      assert(await h1(p, PRO_TITLE), 'back on the Pro login')
      await openMenu(p)
      await p.getByRole('link', { name: 'Créer un compte' }).click()
      assert(await h1(p, CLIENT_TITLE), '☰ Créer un compte → client login')
      await p.context().close()
    })

    await step('Pro login → "Je suis un client" → client login', async () => {
      const p = await open('/login?intent=pro&return=%2Fpro')
      assert(await h1(p, PRO_TITLE), 'Pro login')
      await p.getByRole('button', { name: /Je suis un client/ }).click()
      assert(await h1(p, CLIENT_TITLE), 'client login')
      const left = await p.waitForURL(u => !u.toString().includes('intent=pro'), { timeout: 15_000 }).then(() => true, () => false)
      assert(left, 'URL no longer says pro')
      await p.getByRole('button', { name: /Vous êtes un professionnel/ }).click()
      assert(await h1(p, PRO_TITLE), 'and back to Pro with one tap')
      await p.context().close()
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await browser.close()
  }
  finish(SUITE)
}

void main()
