// Mode économique = compact list — in a real browser (Playwright, headless).
//   - first visit (no choice stored): the hint line with a switch; ✕ hides
//     it for good
//   - ON: home, Restaurants, Loisirs, À visiter show text rows, no <img> at all
//     in the page body, home rows ≤ 5 items
//   - OFF: the image cards are back (home has card links with images)
// Reads only (Yaoundé's public lists); no data written.

import { chromium, type Browser, type Page } from 'playwright'
import { assert, step, finish } from '../testkit/assert'
import { BASE } from '../testkit/env'
import { CLIENT_VERSION } from '../../lib/clientVersion'

const SUITE = 'api-low-data'
let browser: Browser

async function open(path: string, lowData: '1' | '0' | null): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'fr-FR' })
  await ctx.addInitScript(([v, ld]) => {
    try {
      if (sessionStorage.getItem('__seeded')) return
      localStorage.setItem('tn_version', v); localStorage.setItem('sm_locale', 'fr'); localStorage.setItem('tn_selected_city', 'Yaoundé')
      if (ld === null) localStorage.removeItem('tn_low_data'); else localStorage.setItem('tn_low_data', ld)
      sessionStorage.setItem('__seeded', '1')
    } catch { /* blocked */ }
  }, [CLIENT_VERSION, lowData] as const)
  const page = await ctx.newPage()
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 240_000 })
  return page
}
const HINT = 'Données limitées ? Activez le Mode économique'
async function settle(p: Page, needle: string): Promise<boolean> {
  try { await p.waitForFunction(n => document.body.innerText.includes(n), needle, { timeout: 90_000 }); await p.waitForTimeout(2500); return true } catch { return false }
}
const imgs = (p: Page) => p.evaluate(() => document.querySelectorAll('main img, section img').length)

async function main(): Promise<void> {
  browser = await chromium.launch()
  try {
    await step('first visit: the hint, ✕ hides it for good', async () => {
      const p = await open('/', null)
      assert(await settle(p, HINT), 'hint shown')
      await p.getByRole('button', { name: 'Fermer' }).first().click()
      await p.waitForTimeout(500)
      assert(!(await p.evaluate(n => document.body.innerText.includes(n), HINT)), 'gone after ✕')
      await p.reload({ waitUntil: 'domcontentloaded' })
      await p.waitForTimeout(3000)
      assert(!(await p.evaluate(n => document.body.innerText.includes(n), HINT)), 'still gone after reload')
      assert((await p.evaluate(() => localStorage.getItem('tn_low_data'))) === '0', 'choice stored as off')
      await p.context().close()
    })

    await step('ON: compact rows, no images', async () => {
      for (const [path, needle] of [['/', 'Restaurants'], ['/restaurants', 'Restaurants'], ['/events', 'Tous les événements'], ['/lieux', 'À visiter']] as const) {
        const p = await open(path, '1')
        assert(await settle(p, needle), `${path}: loaded`)
        assert(!(await p.evaluate(n => document.body.innerText.includes(n), HINT)), `${path}: no hint once chosen`)
        assertNoImg(path, await imgs(p))
        if (path === '/') {
          const rows = await p.evaluate(() => Array.from(document.querySelectorAll('main section')).map(s => s.querySelectorAll('a[href^="/restaurant/"], a[href^="/events/"], a[href^="/lieux/"]').length))
          assert(rows.length > 0 && rows.every(n => n <= 5), `home rows ≤ 5 items (${rows.join(',')})`)
        }
        await p.context().close()
      }
    })

    await step('Loisirs switch says « À visiter »', async () => {
      for (const path of ['/events', '/lieux']) {
        const p = await open(path, '0')
        const tab = p.locator('[role="tablist"] [role="tab"]').nth(1)
        await tab.waitFor({ timeout: 90_000 })
        assert((await tab.innerText()).trim() === 'À visiter', `${path}: second tab is « À visiter »`)
        await p.context().close()
      }
    })

    await step('OFF: the cards are back', async () => {
      const p = await open('/', '0')
      assert(await settle(p, 'Restaurants'), 'home loaded')
      assert(await imgs(p) > 0, 'images on the home page again')
      await p.context().close()
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await browser.close()
  }
  finish(SUITE)
}
function assertNoImg(path: string, n: number) { assert(n === 0, `${path}: no images (${n})`) }

void main()
