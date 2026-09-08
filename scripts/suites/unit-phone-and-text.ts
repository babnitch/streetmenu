// TEST-PLAN.md §1a #4 (phone), #10 (nickname), #12 (sanitisers).
//
// #4 asserts directly what test-check-phone.ts currently proves over HTTP:
// the set of shapes that must all be treated as the same number. Doing it
// here is instant and needs neither a server nor a customer row.

import { normalizePhone, samePhone } from '@/lib/phone'
import {
  validateLocalPhone,
  composeFullPhone,
  detectCountry,
  splitIntoCountryAndLocal,
  getCountryFromCity,
  isPlatformCountry,
} from '@/lib/phoneValidation'
import { validateNickname, nicknameCooldownDaysRemaining, displayNickname } from '@/lib/nickname'
import { sanitizeText, sanitizePhone, sanitizeCode, sanitizeNickname } from '@/lib/sanitize'
import { assert, assertEq, assertIncludes, step, finish } from '../testkit/assert'

const SUITE = 'unit-phone-and-text'

const DAY_MS = 24 * 60 * 60 * 1000
function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString()
}

async function main(): Promise<void> {
  // ── #4 phone ──────────────────────────────────────────────────────────────
  await step('normalizePhone', () => {
    assertEq(normalizePhone('+237670000000'), '+237670000000', 'already-normal number is unchanged')
    assertEq(normalizePhone('whatsapp:+237670000000'), '+237670000000', "strips the 'whatsapp:' prefix")
    assertEq(normalizePhone('WhatsApp:+237670000000'), '+237670000000', 'prefix strip is case-insensitive')
    assertEq(normalizePhone('237 670 000 000'), '+237670000000', 'spaces removed, + prepended')
    assertEq(normalizePhone('237-670-000-000'), '+237670000000', 'dashes removed')
    assertEq(normalizePhone('(237) 670 000 000'), '+237670000000', 'parentheses removed')
    assertEq(normalizePhone('00237670000000'), '+237670000000', "leading '00' becomes '+'")
    assertEq(normalizePhone('+00237670000000'), '+00237670000000', "'00' after an explicit '+' is left alone")
    assertEq(normalizePhone('670000000'), '+670000000', 'bare national number gets a +')
    assertEq(normalizePhone(''), '', 'empty string returns empty')
    assertEq(normalizePhone(null), '', 'null returns empty')
    assertEq(normalizePhone(undefined), '', 'undefined returns empty')
    assertEq(normalizePhone('abc'), '', 'letters-only produces no digits, returns empty')
  })

  await step('samePhone — the format-equivalence set', () => {
    const canonical = '+237670000000'
    for (const variant of ['237670000000', '670000000', '670 000 000', 'whatsapp:+237670000000', '00237670000000']) {
      assert(samePhone(canonical, variant), `matches variant "${variant}"`)
    }
    assert(samePhone('+237670000000', '+237670000000'), 'identical numbers match')
    assert(!samePhone('+237670000000', '+237670000001'), 'a different last digit does not match')
    assert(!samePhone('+237670000000', null), 'null never matches')
    assert(!samePhone(null, null), 'two nulls never match')
    assert(!samePhone('', ''), 'two empties never match')
    assert(!samePhone('12345', '12345'), 'fewer than 6 significant digits never matches')
    assert(samePhone('123456', '123456'), 'exactly 6 digits is the shortest match')
  })

  await step('validateLocalPhone — strict platform countries', () => {
    assert(validateLocalPhone('670000000', 'CM').ok, 'CM 9 digits with a valid 67 prefix')
    assert(validateLocalPhone('690000000', 'CM').ok, 'CM 69 prefix')
    const short = validateLocalPhone('67000000', 'CM')
    assert(!short.ok, 'CM 8 digits rejected')
    assertIncludes(short.error, '9', 'the CM error names the required length')
    assert(!validateLocalPhone('6700000000', 'CM').ok, 'CM 10 digits rejected')
    const badPrefix = validateLocalPhone('120000000', 'CM')
    assert(!badPrefix.ok, 'CM bad prefix rejected')
    assertIncludes(badPrefix.error, 'préfixe', 'the prefix error says so')

    assert(validateLocalPhone('0700000000', 'CI').ok, 'CI 10 digits, 07 prefix')
    assert(validateLocalPhone('770000000', 'SN').ok, 'SN 9 digits, 77 prefix')
    assert(validateLocalPhone('90000000', 'TG').ok, 'TG 8 digits, 9 prefix')
    assert(validateLocalPhone('96000000', 'BJ').ok, 'BJ 8 digits, 96 prefix')

    assert(!validateLocalPhone('', 'CM').ok, 'empty local number rejected')
    const unknown = validateLocalPhone('670000000', 'ZZ')
    assert(!unknown.ok, 'unknown ISO rejected')
    assertIncludes(unknown.error, 'inconnu', 'unknown-country error says so')
  })

  await step('validateLocalPhone — loose envelope for the rest of the world', () => {
    assert(validateLocalPhone('612345678', 'FR').ok, 'FR accepts a 9-digit local number')
    assert(validateLocalPhone('123456', 'FR').ok, '6 digits is the loose minimum')
    assert(!validateLocalPhone('12345', 'FR').ok, '5 digits is below the loose minimum')
    assert(validateLocalPhone('123456789012345', 'FR').ok, '15 digits is the loose maximum')
    assert(!validateLocalPhone('1234567890123456', 'FR').ok, '16 digits is above the loose maximum')
    // Formatting characters are stripped before the length check.
    assert(validateLocalPhone('6 12 34 56 78', 'FR').ok, 'separators are ignored when counting digits')
  })

  await step('composeFullPhone', () => {
    assertEq(composeFullPhone('670000000', 'CM'), '+237670000000', 'CM local → +237 E.164')
    assertEq(composeFullPhone('670 000 000', 'CM'), '+237670000000', 'separators stripped first')
    assertEq(composeFullPhone('0700000000', 'CI'), '+2250700000000', 'CI keeps its leading zero')
    assertEq(composeFullPhone('', 'CM'), '', 'empty local yields empty')
    assertEq(composeFullPhone('670000000', 'ZZ'), '', 'unknown ISO yields empty')
  })

  await step('detectCountry', () => {
    assertEq(detectCountry('+237670000000')?.iso, 'CM', '+237 → CM')
    assertEq(detectCountry('237670000000')?.iso, 'CM', 'works without the +')
    assertEq(detectCountry('+2250700000000')?.iso, 'CI', '+225 → CI')
    assertEq(detectCountry('+221770000000')?.iso, 'SN', '+221 → SN')
    assertEq(detectCountry('+22890000000')?.iso, 'TG', '+228 → TG')
    assertEq(detectCountry('+22996000000')?.iso, 'BJ', '+229 → BJ')
    // Longest dial code wins: +1242 is Bahamas, not +1 US/Canada.
    assertEq(detectCountry('+12425551234')?.iso, 'BS', 'a longer dial code beats the shorter prefix')
    assertEq(detectCountry(''), null, 'empty input → null')
    assertEq(detectCountry(null), null, 'null → null')
    assertEq(detectCountry('abc'), null, 'no digits → null')
    // The reserved test namespace must not resolve to a real country.
    assertEq(detectCountry('+999000910001'), null, '+999 test phones map to no country')
  })

  await step('splitIntoCountryAndLocal', () => {
    const cm = splitIntoCountryAndLocal('+237670000000')
    assertEq(cm.country?.iso, 'CM', 'country half')
    assertEq(cm.local, '670000000', 'local half')

    const ci = splitIntoCountryAndLocal('+2250700000000')
    assertEq(ci.country?.iso, 'CI', 'CI country half')
    assertEq(ci.local, '0700000000', 'CI local half keeps its leading zero')

    assertEq(splitIntoCountryAndLocal(null).local, '', 'null → empty local')
    assertEq(splitIntoCountryAndLocal(null).country, null, 'null → null country')

    const unknown = splitIntoCountryAndLocal('+999000910001')
    assertEq(unknown.country, null, 'unmatched number → null country')
    assertEq(unknown.local, '999000910001', 'unmatched number keeps all digits as local')

    // Round trip: split then recompose must be the identity.
    const round = splitIntoCountryAndLocal('+237690123456')
    assertEq(composeFullPhone(round.local, round.country!.iso), '+237690123456', 'split → compose round-trips')
  })

  await step('getCountryFromCity / isPlatformCountry', () => {
    assertEq(getCountryFromCity('Yaoundé').iso, 'CM', 'Yaoundé → CM')
    assertEq(getCountryFromCity('yaounde').iso, 'CM', 'unaccented lowercase works')
    assertEq(getCountryFromCity('Abidjan').iso, 'CI', 'Abidjan → CI')
    assertEq(getCountryFromCity('Dakar').iso, 'SN', 'Dakar → SN')
    assertEq(getCountryFromCity('Lomé').iso, 'TG', 'Lomé → TG')
    assertEq(getCountryFromCity('Cotonou').iso, 'BJ', 'Cotonou → BJ')
    assertEq(getCountryFromCity('Zurich').iso, 'CM', 'a non-platform city falls back to CM')
    assertEq(getCountryFromCity(null).iso, 'CM', 'null falls back to CM')

    for (const iso of ['CM', 'CI', 'SN', 'TG', 'BJ']) {
      assert(isPlatformCountry(iso), `${iso} is a platform country`)
    }
    assert(!isPlatformCountry('FR'), 'FR is not a platform country')
  })

  // ── #10 nickname ──────────────────────────────────────────────────────────
  await step('validateNickname', () => {
    const ok = validateNickname('Manu')
    assert(ok.ok, 'a plain nickname is accepted')
    assertEq(ok.ok ? ok.value : '', 'Manu', 'the accepted value is returned')
    assert(validateNickname('  Manu  ').ok, 'surrounding whitespace is trimmed before validating')
    assertEq(validateNickname('  Manu  ').ok ? (validateNickname('  Manu  ') as { value: string }).value : '', 'Manu',
      'and the trimmed value is what comes back')
    assert(validateNickname('a.b-c_1').ok, 'dot, dash, underscore and a single digit are allowed')
    assertEq(validateNickname('ab').ok ? '' : (validateNickname('ab') as { reason: string }).reason, 'too_short',
      '2 chars → too_short')
    assertEq(validateNickname('abc').ok, true, '3 chars is the minimum accepted')
    assertEq(validateNickname('a'.repeat(20)).ok, true, '20 chars is the maximum accepted')
    assertEq(validateNickname('a'.repeat(21)).ok ? '' : (validateNickname('a'.repeat(21)) as { reason: string }).reason,
      'too_long', '21 chars → too_long')
    assertEq(validateNickname('has space').ok ? '' : (validateNickname('has space') as { reason: string }).reason,
      'invalid_chars', 'spaces → invalid_chars')
    assertEq(validateNickname('emoji🎉').ok ? '' : (validateNickname('emoji🎉') as { reason: string }).reason,
      'invalid_chars', 'emoji → invalid_chars')
    assertEq(validateNickname('user6700').ok ? '' : (validateNickname('user6700') as { reason: string }).reason,
      'phone_like', '4+ consecutive digits → phone_like')
    assertEq(validateNickname('u12b34').ok, true, 'digits broken up by letters are fine')
    assertEq(validateNickname('').ok ? '' : (validateNickname('') as { reason: string }).reason, 'too_short',
      'empty → too_short')
  })

  await step('nicknameCooldownDaysRemaining — 30-day window', () => {
    assertEq(nicknameCooldownDaysRemaining(null), 0, 'never changed → 0 days remaining')
    assertEq(nicknameCooldownDaysRemaining(undefined), 0, 'undefined → 0')
    assertEq(nicknameCooldownDaysRemaining(daysAgo(31)), 0, 'changed 31 days ago → cooldown over')
    assertEq(nicknameCooldownDaysRemaining(daysAgo(40)), 0, 'well past the window → 0, never negative')
    assertEq(nicknameCooldownDaysRemaining(daysAgo(10)), 20, 'changed 10 days ago → 20 remaining')
    assertEq(nicknameCooldownDaysRemaining(daysAgo(29)), 1, 'changed 29 days ago → 1 remaining')
    assert(nicknameCooldownDaysRemaining(new Date().toISOString()) > 0, 'changed just now → still in cooldown')
  })

  await step('displayNickname', () => {
    assertEq(displayNickname({ nickname: 'Manu', name: 'Emmanuel Ndoh' }), 'Manu', 'nickname wins when set')
    assertEq(displayNickname({ nickname: null, name: 'Emmanuel Ndoh' }), 'Emmanuel', 'falls back to the first name')
    assertEq(displayNickname({ nickname: '   ', name: 'Emmanuel Ndoh' }), 'Emmanuel', 'blank nickname falls back too')
    assertEq(displayNickname({ nickname: null, name: null }), 'Anonyme', 'no nickname and no name → Anonyme')
    assertEq(displayNickname({ nickname: null, name: '   ' }), 'Anonyme', 'blank name → Anonyme')
  })

  // ── #12 sanitisers ────────────────────────────────────────────────────────
  await step('sanitizeText', () => {
    assertEq(sanitizeText('hello', 50), 'hello', 'plain text passes through')
    assertEq(sanitizeText('  hello  ', 50), 'hello', 'trimmed')
    assertEq(sanitizeText('<b>bold</b>', 50), 'bold', 'HTML tags stripped')
    assertEq(sanitizeText('<script>alert(1)</script>ok', 50), 'alert(1)ok', 'script tags stripped, text kept')
    assertEq(sanitizeText('<img src=x onerror=y>', 50), '', 'a lone self-closing-ish tag leaves nothing')
    assertEq(sanitizeText('a\x01b\x1Fc', 50), 'abc', 'control characters removed')
    assertEq(sanitizeText('a    b', 50), 'a b', 'runs of spaces collapse to one')
    assertEq(sanitizeText('a\t\tb', 50), 'a b', 'tabs collapse too')
    assertEq(sanitizeText('line1\r\nline2', 50), 'line1\nline2', 'CRLF normalised to LF')
    assertEq(sanitizeText('line1\nline2', 50), 'line1\nline2', 'single newlines are preserved')
    assertEq(sanitizeText('abcdefghij', 5), 'abcde', 'truncated to maxLength')
    assertEq(sanitizeText(123, 50), '', 'a number is not a string → empty')
    assertEq(sanitizeText(null, 50), '', 'null → empty')
    assertEq(sanitizeText(undefined, 50), '', 'undefined → empty')
    assertEq(sanitizeText({}, 50), '', 'an object → empty')
  })

  await step('sanitizePhone', () => {
    assertEq(sanitizePhone('+237670000000'), '+237670000000', 'a clean E.164 number survives')
    assertEq(sanitizePhone('+237 670 000 000'), '+237670000000', 'spaces stripped, + kept')
    assertEq(sanitizePhone('237670000000'), '237670000000', 'no + means no + is added')
    assertEq(sanitizePhone('+237-670-abc-000'), '+237670000', 'letters and dashes stripped')
    assertEq(sanitizePhone('  +237670000000  '), '+237670000000', 'trimmed first')
    assertEq(sanitizePhone('abc'), '', 'no digits → empty')
    assertEq(sanitizePhone(''), '', 'empty → empty')
    assertEq(sanitizePhone(null), '', 'null → empty')
    assertEq(sanitizePhone(42), '', 'a number is not a string → empty')
  })

  await step('sanitizeCode', () => {
    assertEq(sanitizeCode('tchop-1234'), 'TCHOP-1234', 'uppercased, dash kept')
    assertEq(sanitizeCode('bien venue!'), 'BIENVENUE', 'spaces and punctuation stripped')
    assertEq(sanitizeCode('a_b-c1'), 'A_B-C1', 'underscore, dash and digits are allowed')
    assertEq(sanitizeCode('é!@#$%'), '', 'nothing allowed survives → empty')
    assertEq(sanitizeCode('A'.repeat(40)), 'A'.repeat(32), 'capped at the 32-char default')
    assertEq(sanitizeCode('A'.repeat(40), 8), 'A'.repeat(8), 'explicit maxLength is honoured')
    assertEq(sanitizeCode(null), '', 'null → empty')
    assertEq(sanitizeCode(99), '', 'a number is not a string → empty')
  })

  await step('sanitizeNickname — the spam filter above validateNickname', () => {
    assertEq(sanitizeNickname('Manu'), 'Manu', 'a clean nickname passes')
    assertEq(sanitizeNickname('user6700'), null, '4+ consecutive digits rejected')
    assertEq(sanitizeNickname('@handle'), null, 'an @ handle is rejected')
    assertEq(sanitizeNickname(''), null, 'empty → null')
    assertEq(sanitizeNickname('<b>Manu</b>'), 'Manu', 'tags are stripped before the checks')
    assertEq(sanitizeNickname('a'.repeat(30)), 'a'.repeat(24), 'capped at 24 chars')
  })

  finish(SUITE)
}

void main()
