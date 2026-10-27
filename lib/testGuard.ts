// Test send guard. The local test server runs with TEST_ONLY_PHONE_PREFIX=+999
// (and dummy Twilio credentials): any WhatsApp or SMS to a number outside the
// test range is refused before it reaches Twilio or the message log, so a
// test can never message — or leave a log row about — a real person.
// Unset in production: no effect.

export function testGuardPrefix(): string | null {
  const p = process.env.TEST_ONLY_PHONE_PREFIX
  return p && p.trim() ? p.trim() : null
}

export function blockedByTestGuard(to: string): boolean {
  const prefix = testGuardPrefix()
  if (!prefix) return false
  const bare = to.replace(/^whatsapp:/i, '').replace(/[^\d+]/g, '')
  const ok = bare.startsWith(prefix)
  if (!ok) console.error(`[test-guard] BLOCKED a send to a non-test number (${bare.slice(0, 4)}…)`)
  return !ok
}
