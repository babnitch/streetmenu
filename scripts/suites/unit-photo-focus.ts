// Photo focus point (lib/photoFocus.ts, lib/adminPhotos.ts), no database:
//   - "x y" percent, 0–100, the centre stored as null
//   - CSS object-position, centre by default
//   - a restaurant shows its cover, else its logo → that photo's focus
//   - the photo routes' checks: a valid focus, a bad one refused, a new photo
//     resets the focus (unless one comes with it), focus dropped before the SQL

import { parseFocus, formatFocus, focusPosition, heroFocus, FOCUS_PRESETS } from '@/lib/photoFocus'
import { checkPhotoBody, focusResets, withoutFocus } from '@/lib/adminPhotos'
import { assert, assertEq, step, finish } from '../testkit/assert'

const SUITE = 'unit-photo-focus'
const P1 = 'https://example.com/a.jpg', P2 = 'https://example.com/b.jpg'

async function main(): Promise<void> {
  await step('values', () => {
    assertEq(parseFocus('30 70'), { x: 30, y: 70 }, 'parsed')
    assertEq(parseFocus('0 100'), { x: 0, y: 100 }, 'edges')
    for (const bad of ['101 5', '30,70', '30', '-1 5', 'abc', null, 42]) assertEq(parseFocus(bad), null, `refused: ${String(bad)}`)
    assertEq(formatFocus({ x: 30.4, y: 70.6 }), '30 71', 'rounded')
    assertEq(formatFocus({ x: 50, y: 50 }), null, 'centre → null')
    assertEq(formatFocus({ x: -20, y: 140 }), '0 100', 'clamped')
    assertEq(focusPosition('30 70'), '30% 70%', 'object-position')
    assertEq(focusPosition(null), '50% 50%', 'default centre')
    assertEq(focusPosition('bad'), '50% 50%', 'bad value → centre')
    assertEq(FOCUS_PRESETS.map(p => `${p.fr}:${p.f.x} ${p.f.y}`), ['Haut:50 0', 'Bas:50 100', 'Gauche:0 50', 'Droite:100 50', 'Centre:50 50'], 'the five buttons')
  })

  await step('which photo a restaurant shows', () => {
    assertEq(heroFocus({ image_url: P1, image_focus: '10 20', logo_focus: '90 90' }), '10 20', 'cover → its focus')
    assertEq(heroFocus({ image_url: null, image_focus: '10 20', logo_focus: '90 90' }), '90 90', 'no cover → the logo\'s')
    assertEq(heroFocus({ image_url: P1 }), null, 'none → centre')
  })

  await step('route checks', () => {
    const ok = checkPhotoBody({ image_focus: '20 80', logo_focus: '50 50' }, ['image_url', 'logo_url'])
    assertEq(ok, { ok: true, patch: { image_focus: '20 80', logo_focus: null } }, 'focus saved, centre as null')
    const bad = checkPhotoBody({ image_focus: '200 1' }, ['image_url'])
    assert(!bad.ok && bad.field === 'image_focus', 'bad focus refused')
    assertEq(checkPhotoBody({ cover_focus: '10 10' }, ['image_url']).ok, false, 'a focus of a photo this row lacks is ignored')
    assertEq(focusResets({ image_url: P2 }, { image_url: P1, image_focus: '10 10' }), { image_focus: null }, 'new photo → focus reset')
    assertEq(focusResets({ image_url: P2, image_focus: '30 30' }, { image_url: P1, image_focus: '10 10' }), {}, 'new photo + its focus → kept')
    assertEq(focusResets({ image_url: P1 }, { image_url: P1, image_focus: '10 10' }), {}, 'same photo → focus kept')
    assertEq(focusResets({ image_url: P2 }, { image_url: P1, image_focus: null }), {}, 'already centred → nothing to write')
    assertEq(focusResets({ cover_photo: null }, { cover_photo: P1, cover_focus: '5 5' }), { cover_focus: null }, 'removed → reset')
    assertEq(withoutFocus({ image_url: P1, image_focus: '1 1', logo_focus: null, photo_credit: 'x' }), { image_url: P1, photo_credit: 'x' }, 'focus dropped before the SQL')
  })

  finish(SUITE)
}

void main()
