// D1 — nightly event discovery, the pure parts:
//   - blocked sites (Instagram, Facebook, TikTok, X…) are never fetched
//   - robots.txt: our group or "*", longest rule wins, Allow wins a tie,
//     no file = allowed, unreachable = nothing allowed
//   - RSS feed → event page links on the source's own site
//   - schema.org Event → facts only (dates in Douala time, city, price, organiser);
//     a tour (EventSeries) gives one event per date in our cities
//   - duplicate titles (accents, case, extra words)
// Synthetic pages, shaped like ayatickets.fr's.

import { isBlockedUrl } from '@/lib/discovery/blocklist'
import { parseRobots, robotsFromResponse } from '@/lib/discovery/robots'
import { parseRssItems, extractJsonLdEvents, toFoundEvent, localParts, cityOf, mapCategory } from '@/lib/discovery/parse'
import { titleKey, titleSimilarity, classifyAgainst } from '@/lib/discovery/dedupe'
import { assert, assertEq, step, finish } from '../testkit/assert'

const SUITE = 'unit-discovery-d1'
const CITIES = ['Yaoundé', 'Douala']

const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`
const place = (name: string, locality: string) => ({ '@type': 'Place', name, address: { '@type': 'PostalAddress', addressLocality: locality, addressCountry: 'CM' } })

async function main(): Promise<void> {
  await step('blocked sites', () => {
    for (const u of ['https://www.instagram.com/p/abc', 'https://instagram.com/x', 'https://m.facebook.com/events/1', 'https://fb.me/x',
      'https://www.tiktok.com/@a', 'https://x.com/a/status/1', 'https://twitter.com/a', 'https://t.co/x', 'https://www.threads.net/@a',
      'https://wa.me/237600000000', 'not a url', 'ftp://ayatickets.fr/x', 'javascript:alert(1)']) {
      assert(isBlockedUrl(u), `blocked: ${u}`)
    }
    for (const u of ['https://ayatickets.fr/fr/event/x', 'https://notinstagram.com/x', 'https://myx.com/a']) assert(!isBlockedUrl(u), `allowed: ${u}`)
  })

  await step('robots.txt', () => {
    const r = parseRobots([
      'User-agent: *', 'Disallow: /search/', 'Disallow: /*/cart', 'Disallow: /*?_target_path=', 'Allow: /fr/events', '',
      'User-agent: GPTBot', 'Disallow: /',
    ].join('\n'))
    assert(r.allows('/fr/event/the-divine-tour'), 'event page allowed')
    assert(r.allows('/rss'), 'feed allowed')
    assert(!r.allows('/search/concert'), '/search/ refused')
    assert(!r.allows('/fr/cart'), 'wildcard rule')
    assert(!r.allows('/fr/signin?_target_path=/x'), 'query rule')
    const ours = parseRobots('User-agent: *\nAllow: /\n\nUser-agent: TchopNdjokaBot\nDisallow: /private\nCrawl-delay: 10')
    assert(!ours.allows('/private/x') && ours.allows('/fr/event/x'), 'our own group wins over *')
    assertEq(ours.crawlDelaySec, 10, 'crawl delay read')
    const tie = parseRobots('User-agent: *\nDisallow: /fr/\nAllow: /fr/\nDisallow: /fr/e\nAllow: /fr/event$')
    assert(tie.allows('/fr/x'), 'Allow wins a tie')
    assert(tie.allows('/fr/event') && !tie.allows('/fr/events'), 'longest rule wins, $ anchors')
    const all = parseRobots('User-agent: *\nDisallow: /')
    assert(!all.allows('/rss'), 'Disallow: / blocks everything')
    assert(parseRobots('User-agent: *\nDisallow:').allows('/x'), 'empty Disallow blocks nothing')
    assert(robotsFromResponse({ status: 404, text: '' }).allows('/x'), 'no robots.txt → allowed')
    assert(!robotsFromResponse({ status: 503, text: '' }).allows('/x'), 'server error → nothing allowed')
    assert(!robotsFromResponse(null).allows('/x'), 'unreachable → nothing allowed')
  })

  await step('RSS feed → event pages on the same site', () => {
    const xml = `<rss><channel>
      <item><title>A &amp; B</title><link>https://ayatickets.fr/fr/event/a-b-1?utm=x#top</link><category>Concert / Musique</category></item>
      <item><link>https://ayatickets.fr/fr/event/a-b-1</link></item>
      <item><link>https://evil.example/fr/event/x</link></item>
      <item><link>http://ayatickets.fr/fr/event/plain-http</link></item>
      <item><link><![CDATA[https://www.ayatickets.fr/fr/event/c]]></link><category>Festival / Spectacle</category></item>
    </channel></rss>`
    const items = parseRssItems(xml, 'ayatickets.fr')
    assertEq(items.map(i => i.url), ['https://ayatickets.fr/fr/event/a-b-1', 'https://www.ayatickets.fr/fr/event/c'], 'own site, https, no query, no repeat')
    assertEq(items[0].category, 'Concert / Musique', 'category kept')
  })

  await step('dates in Douala time, city, category', () => {
    assertEq(localParts('2026-11-13T18:00:00+01:00'), { date: '2026-11-13', time: '18:00' }, 'Douala offset')
    assertEq(localParts('2026-11-13T23:30:00Z'), { date: '2026-11-14', time: '00:30' }, 'UTC → next day in Douala')
    assertEq(localParts('2026-11-13'), { date: '2026-11-13', time: null }, 'date only')
    assertEq(localParts('nope'), null, 'bad date')
    assertEq(cityOf(place('Majestic Cinema', 'Yaoundé'), CITIES), 'Yaoundé', 'locality')
    assertEq(cityOf(place('Bessengue', 'DOUALA'), CITIES), 'Douala', 'case-insensitive')
    assertEq(cityOf({ name: 'Salle X', address: { streetAddress: 'Odza, Yaounde' } }, CITIES), 'Yaoundé', 'accents optional, street address')
    assertEq(cityOf(place('Hall', 'Bamenda'), CITIES), null, 'another city → not ours')
    assertEq(cityOf(place('Hall', 'Doualaville'), CITIES), null, 'whole word only')
    assertEq(mapCategory('Concert / Musique'), 'Concert', 'concert')
    assertEq(mapCategory('Cinéma / Théâtre / Films'), 'Culture', 'cinema')
    assertEq(mapCategory('Sports / Fitness / Santé et Bien-être'), 'Sport', 'sport')
    assertEq(mapCategory(null), 'Autre', 'unknown')
  })

  await step('page → facts only', () => {
    const url = 'https://ayatickets.fr/fr/event/mauvaise-compagnie'
    const html = '<html>' + ld({
      '@context': 'https://schema.org', '@type': 'Event', name: 'Mauvaise &amp; Compagnie', url,
      startDate: '2026-12-13T18:00:00+01:00', endDate: '2026-12-13T20:00:00+01:00',
      location: place('Bessengue', 'Douala'), organizer: { '@type': 'Organization', name: 'Emilie Z', url: 'https://ayatickets.fr/fr/organizer/ez' },
      description: 'LONG TEXT WE NEVER KEEP', image: ['https://ayatickets.fr/uploads/x.jpg'],
      offers: [{ price: 5000, priceCurrency: 'XAF' }, { price: '10000', priceCurrency: 'XAF' }, { price: 12, priceCurrency: 'EUR' }],
    }) + ld({ '@type': 'BreadcrumbList' }) + '<script type="application/ld+json">{broken</script></html>'
    const evs = extractJsonLdEvents(html)
    assertEq(evs.length, 1, 'one Event (breadcrumb and broken block ignored)')
    const f = toFoundEvent(evs[0], url, 'Cinéma / Théâtre / Films', CITIES)
    assertEq(f, {
      title: 'Mauvaise & Compagnie', start_date: '2026-12-13', start_time: '18:00', end_date: null, end_time: '20:00',
      venue: 'Bessengue', city: 'Douala', category: 'Culture', price_fcfa: 5000, price_is_from: true,
      organiser_name: 'Emilie Z', organiser_url: 'https://ayatickets.fr/fr/organizer/ez', ticket_url: url,
    }, 'facts, lowest FCFA price "from", no description or image')
    assert(!JSON.stringify(f).includes('LONG TEXT') && !JSON.stringify(f).includes('.jpg'), 'nothing copied beyond facts')
  })

  await step('tours, cancelled, odd dates, free', () => {
    const url = 'https://ayatickets.fr/fr/event/tour'
    const series = ld({ '@context': 'https://schema.org', '@graph': [{
      '@type': 'EventSeries', name: 'The Tour', organizer: { '@type': 'Organization', name: 'Phido' },
      subEvent: [
        { '@type': 'Event', name: 'The Tour', startDate: '2026-11-13T18:00:00+01:00', location: place('Majestic', 'Yaoundé'), offers: { price: 0, priceCurrency: 'XAF' } },
        { '@type': 'Event', name: 'The Tour', startDate: '2026-11-15T18:00:00+01:00', location: place('Hall', 'Bamenda') },
        { '@type': 'Event', name: 'The Tour', startDate: '2026-11-20T18:00:00+01:00', location: place('Salle', 'Douala') },
      ],
    }] })
    const found = extractJsonLdEvents(series).map(e => toFoundEvent(e, url, null, CITIES)).filter(Boolean)
    assertEq(found.map(f => `${f!.city} ${f!.start_date}`), ['Yaoundé 2026-11-13', 'Douala 2026-11-20'], 'one per date in our cities')
    assertEq(found[0]!.organiser_name, 'Phido', 'organiser inherited from the series')
    assertEq([found[0]!.price_fcfa, found[0]!.price_is_from], [0, false], 'free')
    const one = (o: Record<string, unknown>) => toFoundEvent({ '@type': 'Event', name: 'X', location: place('V', 'Yaoundé'), ...o }, url, null, CITIES)
    assertEq(one({ startDate: '2026-12-01T20:00:00+01:00', eventStatus: 'https://schema.org/EventCancelled' }), null, 'cancelled → nothing')
    assertEq(one({}), null, 'no start date → nothing')
    const back = one({ startDate: '2026-12-01T20:00:00+01:00', endDate: '2026-11-30T20:00:00+01:00' })
    assertEq([back?.end_date, back?.end_time], [null, null], 'end before start → dropped')
    const overnight = one({ startDate: '2026-12-01T22:00:00+01:00', endDate: '2026-12-02T04:00:00+01:00' })
    assertEq([overnight?.end_date, overnight?.end_time], ['2026-12-02', '04:00'], 'overnight → next day kept')
    const sameDayEarlier = one({ startDate: '2026-12-01T22:00:00+01:00', endDate: '2026-12-01T04:00:00+01:00' })
    assertEq([sameDayEarlier?.end_date, sameDayEarlier?.end_time], [null, null], 'same-day end before start → dropped')
    assertEq(one({ startDate: '2026-12-01', offers: [] })?.price_fcfa, null, 'no offers → price unknown')
  })

  await step('duplicate titles', () => {
    assertEq(titleKey('  Écrans Noirs – 30e édition! '), 'ecrans noirs 30e edition', 'folded key')
    assertEq(titleSimilarity('The Divine Tour by Phido', 'THE DIVINE TOUR BY PHIDO'), 1, 'case')
    assert(titleSimilarity('Christmas Night', 'CHRISTMAS NIGHT – Odza 2026') >= 0.8, 'extra words on one side')
    assert(titleSimilarity('Concert', 'Concert de Noël') < 0.5, 'one word proves nothing')
    assert(titleSimilarity('Douala Fiesta 2026', 'Yaoundé Jazz Festival') < 0.5, 'different events')
    const others = [{ id: 'a', title: 'Yaoundé Jazz Festival 2026' }, { id: 'b', title: 'Christmas Night' }]
    assertEq(classifyAgainst('CHRISTMAS NIGHT', others), { kind: 'duplicate', id: 'b' }, 'duplicate')
    assertEq(classifyAgainst('Jazz Festival Live', others).kind, 'possible', 'possible duplicate')
    assertEq(classifyAgainst('Mauvaise Compagnie', others), { kind: 'new' }, 'new')
    assertEq(classifyAgainst('Anything', []), { kind: 'new' }, 'nothing to compare')
  })

  finish(SUITE)
}

void main()
