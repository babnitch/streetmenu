// /api/popular fills its rows: up to 6 restaurants / events, the popular
// ones first, then the rest — so the home rows never vanish while the city
// has something. Checked against the city's real data (Yaoundé): the row
// size equals min(6, what the city has), no duplicates, never a past
// event, the popular flags are there. Test rows live a few seconds.

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api } from '../testkit/session'
import { makeCustomer, makeEvent, pastDateISO, futureDateISO } from '../testkit/fixtures'
import { teardown } from '../testkit/ledger'
import { isPastEvent, EVENT_DATE_COLUMNS } from '../../lib/eventDate'

const SUITE = 'api-popular-fill'
const CITY = 'Yaoundé'

interface Pop { restaurants: Array<{ id: string }>; events: Array<{ id: string }>; restaurants_popular?: boolean; events_popular?: boolean }

async function main(): Promise<void> {
  try {
    const org = await makeCustomer({ suiteNo: 93, name: 'Popular Org' })
    const past = await makeEvent({ organizerId: org.id, label: 'pop_past', city: CITY, isActive: true, date: pastDateISO(3) })
    const soon = await makeEvent({ organizerId: org.id, label: 'pop_soon', city: CITY, isActive: true, date: futureDateISO(1) })
    const pending = await makeEvent({ organizerId: org.id, label: 'pop_pending', city: CITY, isActive: false, date: futureDateISO(1) })

    await step('rows filled to min(6, what the city has); flags present', async () => {
      const r = await api<Pop>(`/api/popular?city=${encodeURIComponent(CITY)}`)
      assertEq(r.status, 200, '200')
      const { count: restCount } = await sb.from('restaurants').select('id', { count: 'exact', head: true })
        .eq('city', CITY).eq('is_active', true).in('status', ['active', 'approved']).is('deleted_at', null)
      const { data: evs } = await sb.from('events').select(`id, ${EVENT_DATE_COLUMNS}`).eq('city', CITY).eq('is_active', true)
      const upcoming = (evs ?? []).filter(e => !isPastEvent(e as never)).length
      assertEq(r.body.restaurants.length, Math.min(6, restCount ?? 0), `restaurants: min(6, ${restCount})`)
      assertEq(r.body.events.length, Math.min(6, upcoming), `events: min(6, ${upcoming})`)
      assertEq(typeof r.body.restaurants_popular, 'boolean', 'restaurants_popular')
      assertEq(typeof r.body.events_popular, 'boolean', 'events_popular')
      assertEq(new Set(r.body.events.map(e => e.id)).size, r.body.events.length, 'no duplicate event')
      assertEq(new Set(r.body.restaurants.map(x => x.id)).size, r.body.restaurants.length, 'no duplicate restaurant')
    })

    await step('never a past or unapproved event; an upcoming one appears when there is room', async () => {
      const r = await api<Pop>(`/api/popular?city=${encodeURIComponent(CITY)}`)
      const evIds = r.body.events.map(e => e.id)
      assert(!evIds.includes(past.id), 'past event never shown')
      assert(!evIds.includes(pending.id), 'pending (not approved) event never shown')
      if (r.body.events.length < 6) assert(evIds.includes(soon.id), 'tomorrow\'s event fills the row')
    })

    await step('test cities stay refused', async () => {
      assertEq((await api('/api/popular?city=Nowhere')).status, 400, 'unknown city → 400')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
