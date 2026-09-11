// Browser smoke — the one layer the 18 API suites cannot see.
//
//     npm run test:ui
//
// A FRESH MACHINE OR CI MUST RUN THIS FIRST (npm does not fetch browsers):
//
//     npx playwright install chromium      # ~570 MB, cached outside the repo
//
// DELIBERATELY A SEPARATE RUNNER, NOT A test-all.ts SUITE. The other 18 suites
// need no browser binary and must keep passing without one — a missing chromium
// must never fail the API gate. So this has its own entry point and its own npm
// script, and test-all.ts does not discover it (it lives in scripts/ui/, not
// scripts/suites/).
//
// SCOPE IS FOUR PATHS AND STAYS FOUR PATHS. TEST-PLAN §3 excludes browser UI
// testing because selector maintenance makes it the flakiest thing in a suite.
// What a browser buys that the API layer cannot is narrow but real: whether the
// page actually RENDERS rather than flashing an empty state and freezing, and
// whether a SERVER REDIRECT fires — neither is visible to a route-handler test.
// Everything else is better tested against the database. Resist adding paths.
//
// ASSERTION STYLE. Content-presence, absence-of-page-error, and
// not-stuck-on-a-loader — never exact copy, pixel positions or styling
// selectors. Where a path needs to know what "real content" looks like, the
// expected values are READ FROM THE DATABASE AT RUNTIME rather than hardcoded,
// so an owner renaming their restaurant or editing their menu cannot break the
// test. Locators are route-based (`a[href^="/restaurant/"]`) rather than
// class-based wherever possible.
//
// ONE CLASS-COUPLED CHECK, FLAGGED: the "not stuck on a loader" assertions look
// for `.skeleton` (components/RestaurantCard.tsx RestaurantCardSkeleton),
// `.animate-bounce` (the restaurant detail loader) and `.animate-pulse` (the
// dashboard loader). Those are class names and will break if the loaders are
// restyled. They are kept because the bug class they guard — a page stuck
// forever on shimmer — has actually happened here, and there is no
// role-or-text-based way to assert the ABSENCE of a placeholder. If a loader is
// renamed, update the selector rather than deleting the check. The hard
// assertion in every path is the positive one (real content is present), which
// is fully resilient; the skeleton check is the belt to its braces.

import { chromium, type Browser, type Page } from '@playwright/test'
import { mkdirSync } from 'fs'
import { resolve } from 'path'
import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import jwt from 'jsonwebtoken'
import { customerCookie, adminCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeMenuItem } from '../testkit/fixtures'
import { teardown } from '../testkit/ledger'

const PROD  = process.env.UI_PROD_URL  ?? 'https://streetmenu.vercel.app'
const LOCAL = process.env.UI_LOCAL_URL ?? 'http://localhost:3001'
const MERESTO_ID = '854381d6-e295-4cf0-8522-089b049f626e'

// The real user is on a phone. The home feed is also the flash/freeze-prone
// page, and it behaves differently at this width.
const VIEWPORT = { width: 390, height: 844 }

const SHOT_DIR = resolve(process.cwd(), 'scripts', '.testrun', 'ui')

interface PageProbe { page: Page; errors: string[] }

async function openPage(browser: Browser, cookies?: Array<{ name: string; value: string; url: string }>): Promise<PageProbe> {
  const ctx = await browser.newContext({ viewport: VIEWPORT })
  if (cookies?.length) await ctx.addCookies(cookies)
  const page = await ctx.newPage()
  const errors: string[] = []
  // Uncaught exceptions in page scripts. This is what a freeze looks like
  // from outside when it is caused by a throw rather than a hang.
  page.on('pageerror', e => errors.push(String(e).slice(0, 200)))
  return { page, errors }
}

async function shoot(page: Page, name: string): Promise<string> {
  const path = resolve(SHOT_DIR, `${name}.png`)
  await page.screenshot({ path, fullPage: false })
  return path
}

/** Count of visible loading placeholders still on the page. */
async function loaderCount(page: Page): Promise<number> {
  const [skeleton, bounce, pulse] = await Promise.all([
    page.locator('.skeleton').count(),
    page.locator('.animate-bounce').count(),
    page.locator('.animate-pulse').count(),
  ])
  return skeleton + bounce + pulse
}

async function main(): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true })
  console.log(`  (production: ${PROD})`)
  console.log(`  (local:      ${LOCAL})`)

  let browser: Browser | null = null
  try {
    try {
      browser = await chromium.launch({ headless: true })
    } catch (e) {
      // A missing binary is an environment problem, not a product failure —
      // but it must still be loud, because a silently skipped browser smoke
      // is worse than none.
      assert(false, 'chromium launches',
        `${(e as Error).message.slice(0, 160)} — run: npx playwright install chromium`)
      finish('smoke-browser')
      return
    }
    assert(true, `chromium launched (${browser.version()})`)

    // ══ PATH 1 — home feed, read-only against PRODUCTION ════════════════════
    await step('1. production home feed renders real restaurants', async () => {
      // What "real" means is read from the database at runtime, so an owner
      // renaming their restaurant cannot break this.
      const { data: visible } = await sb.from('restaurants')
        .select('name')
        .eq('is_active', true).in('status', ['active', 'approved']).is('deleted_at', null)
        .limit(5)
      const names = ((visible ?? []) as Array<{ name: string }>).map(r => r.name)
      assert(names.length > 0, 'the database has at least one publicly-visible restaurant to expect')

      const { page, errors } = await openPage(browser!)
      const res = await page.goto(PROD, { waitUntil: 'networkidle', timeout: 60_000 })
      assertEq(res?.status(), 200, 'home page → HTTP 200')

      // Route-based locator: structural, not styling.
      const cards = await page.locator('a[href^="/restaurant/"]').count()
      assert(cards > 0, `real restaurant cards are present (${cards})`)

      // The actual guard against the "Aucun restaurant" flash and the
      // storage-freeze class: content rendered, not placeholder shimmer.
      const body = await page.locator('body').innerText()
      const shown = names.filter(n => body.includes(n))
      assert(shown.length > 0,
        `card CONTENT rendered — at least one known restaurant name is on the page (${shown.length}/${names.length})`)

      const loaders = await loaderCount(page)
      assertEq(loaders, 0, 'no loading placeholders remain — not stuck on skeletons')

      assertEq(errors, [], `no uncaught page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)

      console.log(`     screenshot: ${await shoot(page, '1-prod-home')}`)
      await page.context().close()
    })

    // ══ PATH 2 — restaurant detail, read-only against PRODUCTION ════════════
    await step('2. production restaurant page renders its menu', async () => {
      const { data: r } = await sb.from('restaurants').select('name').eq('id', MERESTO_ID).maybeSingle()
      const restName = (r as { name?: string } | null)?.name ?? ''
      assert(!!restName, 'the restaurant resolves in the database')

      const { data: items } = await sb.from('menu_items')
        .select('name').eq('restaurant_id', MERESTO_ID).eq('is_available', true).limit(10)
      const itemNames = ((items ?? []) as Array<{ name: string }>).map(m => m.name)
      assert(itemNames.length > 0, `it has available menu items to expect (${itemNames.length})`)

      const { page, errors } = await openPage(browser!)
      const res = await page.goto(`${PROD}/restaurant/${MERESTO_ID}`, { waitUntil: 'networkidle', timeout: 60_000 })
      assertEq(res?.status(), 200, 'restaurant page → HTTP 200')

      const body = await page.locator('body').innerText()
      assert(body.includes(restName), 'the restaurant name is rendered')

      const shownItems = itemNames.filter(n => body.includes(n))
      assert(shownItems.length > 0,
        `the MENU rendered — at least one real item is visible (${shownItems.length}/${itemNames.length})`)

      assertEq(await loaderCount(page), 0, 'not stuck on the loading state')
      assert(body.length > 200, `the page is not blank (${body.length} chars of text)`)
      assertEq(errors, [], `no uncaught page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)

      console.log(`     screenshot: ${await shoot(page, '2-prod-restaurant')}`)
      await page.context().close()
    })

    // ══ PATH 3 — vendor dashboard, interactive against LOCALHOST ════════════
    await step('3. local vendor dashboard loads real content, not the empty-state flash', async () => {
      // Regression guard for the bug fixed this session: the dashboard used to
      // fall through to "Aucun restaurant" while the restaurant fetch was
      // still in flight, and stale localStorage could freeze it there.
      //
      // The session is FORGED with the same helper the API suites use — no
      // login UI, so no OTP and no Twilio.
      const owner = await makeCustomer({ suiteNo: 99, name: 'UI Smoke Owner' })
      const rest  = await makeRestaurant({ ownerId: owner.id, label: 'ui_smoke', whatsapp: owner.phone })
      await makeMenuItem(rest.id, { name: 'UI Smoke Dish', price: 2500 })

      const cookieValue = customerCookie(owner).replace(/^sm_session=/, '')
      const { page, errors } = await openPage(browser!, [
        { name: 'sm_session', value: cookieValue, url: LOCAL },
      ])

      const res = await page.goto(`${LOCAL}/dashboard`, { waitUntil: 'networkidle', timeout: 60_000 })
      assertEq(res?.status(), 200, 'dashboard → HTTP 200')

      // Give the two round trips (auth/me, then vendor/restaurants) time to
      // settle — the flash bug lived exactly in the gap between them.
      await page.waitForTimeout(1500)
      const body = await page.locator('body').innerText()

      // POSITIVE assertion first: the vendor's own restaurant is on screen.
      // Its name comes from the fixture, so this is data we control, not copy.
      assert(body.includes(rest.name),
        'the vendor’s restaurant is rendered on the dashboard')

      // NEGATIVE: not the empty state, and not still loading.
      assert(!body.includes('Aucun restaurant'),
        'the "Aucun restaurant" empty state is NOT showing for a vendor who has one')
      assertEq(await loaderCount(page), 0, 'not stuck on the loading placeholder')
      assert(!body.includes('Impossible de charger'),
        'and not showing the fetch-failed state')

      assertEq(errors, [], `no uncaught page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)

      console.log(`     screenshot: ${await shoot(page, '3-local-dashboard')}`)
      await page.context().close()
    })
    // ══ PATH 4 — admin landing redirect, against LOCALHOST ══════════════════
    // Guards middleware.ts. A server-side 307 is invisible to every other
    // suite: it happens before any route handler runs, so the API layer
    // cannot see it, and only a browser following the document chain can
    // tell the difference between "redirected" and "rendered something that
    // looks like /account".
    //
    // Runs against LOCAL because the middleware is local code — pointing this
    // at production would fail until it is deployed.
    await step('4. an admin hitting / is redirected to the console; a forged cookie is not', async () => {
      // Real admin session, forged the same way every API suite forges one.
      const adminValue = (await adminCookie()).replace(/^sm_session=/, '')
      const { page, errors } = await openPage(browser!, [
        { name: 'sm_session', value: adminValue, url: LOCAL },
      ])
      await page.goto(`${LOCAL}/`, { waitUntil: 'networkidle', timeout: 60_000 })

      assertEq(new URL(page.url()).pathname, '/account',
        'an admin asking for / ends up on /account')
      // The no-flash proof, structural rather than copy-based: if the customer
      // feed had painted at any point these links would exist.
      assertEq(await page.locator('a[href^="/restaurant/"]').count(), 0,
        'and the customer feed never rendered — zero restaurant card links')
      assertEq(errors, [], `no uncaught page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
      console.log(`     screenshot: ${await shoot(page, '4-local-admin-landing')}`)
      await page.context().close()

      // A cookie claiming super_admin but signed with the WRONG secret. This
      // is the highest-value assertion in the file: it proves the middleware
      // VERIFIES rather than merely decodes. If verification were ever
      // weakened to a base64 parse, this forged token would redirect and this
      // assertion would fail.
      const forged = jwt.sign(
        { id: 'forged', name: 'Not Really Admin', role: 'super_admin' },
        'definitely-not-the-real-jwt-secret',
        { expiresIn: '1h' },
      )
      const { page: p2, errors: e2 } = await openPage(browser!, [
        { name: 'sm_session', value: forged, url: LOCAL },
      ])
      await p2.goto(`${LOCAL}/`, { waitUntil: 'networkidle', timeout: 60_000 })

      assertEq(new URL(p2.url()).pathname, '/',
        'a FORGED admin cookie is NOT redirected — it stays on the public home')
      assert(await p2.locator('a[href^="/restaurant/"]').count() > 0,
        'and gets the ordinary customer feed, exactly like a stranger')
      assertEq(e2, [], `no uncaught page errors${e2.length ? `: ${e2.join(' | ')}` : ''}`)
      console.log(`     screenshot: ${await shoot(p2, '4-local-forged-cookie')}`)
      await p2.context().close()
    })

  } finally {
    if (browser) await browser.close()
    // Path 3 is the only one that writes; paths 1 and 2 are pure reads.
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }

  finish('smoke-browser')
}

void main()
