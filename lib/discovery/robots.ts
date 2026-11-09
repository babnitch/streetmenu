// robots.txt (RFC 9309), just what the nightly job needs: may our bot read
// this path, and how long to wait between two requests.
//   - the group naming our bot wins; otherwise the "*" group;
//   - the longest matching rule wins, Allow wins a tie; "*" and "$" work;
//   - no robots.txt (4xx) = everything allowed; unreachable (5xx, network)
//     = nothing allowed that night.

export const BOT_TOKEN = 'TchopNdjokaBot'

export interface Robots {
  allows(pathAndQuery: string): boolean
  crawlDelaySec: number | null
}

interface Rule { allow: boolean; pattern: string }

export const ALLOW_ALL: Robots = { allows: () => true, crawlDelaySec: null }
export const DENY_ALL: Robots = { allows: () => false, crawlDelaySec: null }

export function parseRobots(text: string, botToken: string = BOT_TOKEN): Robots {
  const token = botToken.toLowerCase()
  type Group = { agents: string[]; rules: Rule[]; delay: number | null }
  const groups: Group[] = []
  let cur: Group | null = null
  let lastWasAgent = false

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], delay: null }; groups.push(cur) }
      cur.agents.push(value.toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (!cur) continue
    if (key === 'allow' || key === 'disallow') {
      if (value === '') continue          // "Disallow:" (empty) = no rule
      cur.rules.push({ allow: key === 'allow', pattern: value })
    } else if (key === 'crawl-delay') {
      const n = Number(value)
      if (Number.isFinite(n) && n >= 0) cur.delay = n
    }
  }

  const ours = groups.filter(g => g.agents.some(a => a !== '*' && token.includes(a)))
  const chosen = ours.length ? ours : groups.filter(g => g.agents.includes('*'))
  const rules = chosen.flatMap(g => g.rules)
  const delays = chosen.map(g => g.delay).filter((d): d is number => d != null)

  return {
    crawlDelaySec: delays.length ? Math.max(...delays) : null,
    allows(pathAndQuery: string): boolean {
      let best: Rule | null = null
      let bestLen = -1
      for (const r of rules) {
        if (!ruleMatches(r.pattern, pathAndQuery)) continue
        const len = r.pattern.length
        if (len > bestLen || (len === bestLen && r.allow)) { best = r; bestLen = len }
      }
      return best ? best.allow : true
    },
  }
}

function ruleMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$')
  const body = anchored ? pattern.slice(0, -1) : pattern
  const re = body.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${re}${anchored ? '$' : ''}`).test(path)
}

/** robots.txt from an HTTP answer (null = network failure). */
export function robotsFromResponse(res: { status: number; text: string } | null): Robots {
  if (!res || res.status >= 500) return DENY_ALL
  if (res.status >= 400) return ALLOW_ALL
  return parseRobots(res.text)
}
