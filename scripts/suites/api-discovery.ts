// Event discovery over HTTP.
//   D1: the nightly route (/api/internal/discover-events) only answers the
//       internal secret — no secret, a wrong one, an admin cookie: refused;
//       an unknown step: 400 (never runs anything).

import { assertEq, assert, step, finish } from '../testkit/assert'
import { api, adminCookie } from '../testkit/session'
import { teardown } from '../testkit/ledger'

const SUITE = 'api-discovery'
const ROUTE = '/api/internal/discover-events'

async function main(): Promise<void> {
  try {
    await step('D1: nightly route needs the internal secret', async () => {
      const post = (headers: Record<string, string>, cookie?: string) =>
        api(ROUTE, { method: 'POST', headers, cookie, body: { step: 'nope' } })
      const none = await post({})
      assert([401, 503].includes(none.status), `no secret → refused (${none.status})`)
      assert([401, 503].includes((await post({ Authorization: 'Bearer wrong' })).status), 'wrong secret → refused')
      assert([401, 503].includes((await post({}, await adminCookie())).status), 'admin cookie is not enough')
      const secret = process.env.INTERNAL_API_SECRET
      if (secret) assertEq((await post({ Authorization: `Bearer ${secret}` })).status, 400, 'right secret, unknown step → 400')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
