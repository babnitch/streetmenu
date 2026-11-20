// Admin contact links, no database (lib/contactLinks.ts):
//   - only http(s) links; javascript:, data:, mailto:… → no link
//   - a stored handle ("@x" or "x") becomes the full Instagram / TikTok /
//     Facebook link; a link to another site in the Instagram field → none
//   - WhatsApp → wa.me/<digits>, phone → tel:, address / pin → Google Maps

import { safeHttpUrl, socialUrl, whatsappUrl, telUrl, mapsUrl, contactHref } from '@/lib/contactLinks'
import { assertEq, step, finish } from '../testkit/assert'

const SUITE = 'unit-contact-links'

async function main(): Promise<void> {
  await step('only http(s) links', async () => {
    assertEq(safeHttpUrl('https://ayatickets.fr/e/1'), 'https://ayatickets.fr/e/1', 'https kept')
    assertEq(safeHttpUrl('http://example.cm'), 'http://example.cm/', 'http kept')
    assertEq(safeHttpUrl('bamboulounge.cm/menu'), 'https://bamboulounge.cm/menu', 'bare domain → https')
    assertEq(safeHttpUrl('//example.com/x'), 'https://example.com/x', 'protocol-relative → https')
    assertEq(
      ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<b>x</b>', 'mailto:a@b.c', 'ftp://x.com', 'vbscript:x',
        'https://user:pw@evil.com', 'hello world', 'bamboulounge', '', null, undefined].map(v => safeHttpUrl(v as string)),
      Array(13).fill(null), 'every other scheme or non-link → null')
  })

  await step('social handles → full link', async () => {
    assertEq(socialUrl('instagram', '@bamboulounge'), 'https://www.instagram.com/bamboulounge/', 'instagram @handle')
    assertEq(socialUrl('instagram', 'bamboo.lounge_237'), 'https://www.instagram.com/bamboo.lounge_237/', 'instagram handle with dot')
    assertEq(socialUrl('tiktok', 'bamboulounge'), 'https://www.tiktok.com/@bamboulounge', 'tiktok handle')
    assertEq(socialUrl('tiktok', '@bamboulounge'), 'https://www.tiktok.com/@bamboulounge', 'tiktok @handle')
    assertEq(socialUrl('facebook', 'BambouLounge'), 'https://www.facebook.com/BambouLounge', 'facebook handle')
    assertEq(socialUrl('instagram', 'https://instagram.com/x'), 'https://instagram.com/x', 'full link kept')
    assertEq(socialUrl('instagram', 'instagram.com/x'), 'https://instagram.com/x', 'link without https')
    assertEq(socialUrl('facebook', 'https://fb.me/x'), 'https://fb.me/x', 'fb.me')
    assertEq(socialUrl('instagram', 'https://evil.com/x'), null, 'another site in the Instagram field → none')
    assertEq(socialUrl('instagram', 'https://instagram.com.evil.com/x'), null, 'look-alike host → none')
    assertEq(socialUrl('instagram', 'javascript:alert(1)'), null, 'javascript: → none')
    assertEq(socialUrl('tiktok', '@bad handle'), null, 'spaces → none')
  })

  await step('WhatsApp, phone, map', async () => {
    assertEq(whatsappUrl('+237 6 99 12 34 56'), 'https://wa.me/237699123456', 'wa.me digits')
    assertEq(telUrl('+237 699-12-34-56'), 'tel:+237699123456', 'tel: with +')
    assertEq([whatsappUrl('123'), telUrl('javascript:1234567890'), whatsappUrl(''), telUrl(null)], [null, null, null, null], 'too short / not a number → none')
    assertEq(mapsUrl({ address: 'Rue 1.234, Bonapriso', city: 'Douala' }),
      'https://www.google.com/maps/search/?api=1&query=Rue%201.234%2C%20Bonapriso%2C%20Douala', 'address + city')
    assertEq(mapsUrl({ address: 'x', lat: 4.05, lng: 9.7 }), 'https://www.google.com/maps/search/?api=1&query=4.05,9.7', 'pin wins')
    assertEq(mapsUrl({ address: 'Akwa', lat: 0, lng: 0 }), 'https://www.google.com/maps/search/?api=1&query=Akwa', '0,0 pin ignored')
    assertEq([mapsUrl({ city: 'Douala' }), mapsUrl({ address: '  ' })], [null, null], 'no address → none')
  })

  await step('contactHref by kind', async () => {
    assertEq(contactHref('ticket', 'javascript:alert(1)'), null, 'ticket javascript: → none')
    assertEq(contactHref('source', 'https://ayatickets.fr/e'), 'https://ayatickets.fr/e', 'source link')
    assertEq(contactHref('whatsapp', '+237699123456'), 'https://wa.me/237699123456', 'whatsapp')
    assertEq(contactHref('instagram', '@x'), 'https://www.instagram.com/x/', 'instagram handle')
  })

  finish(SUITE)
}

void main()
