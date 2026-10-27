// "Remember my number": the last customer phone that logged in (full
// +E.164) and its country, kept in localStorage so the login screen comes
// back pre-filled. Never a cookie; logout leaves it.

const LAST_PHONE_KEY   = 'tn_last_phone'
const LAST_COUNTRY_KEY = 'tn_last_country'

export function readSavedPhone(): { phone: string; country: string } {
  if (typeof window === 'undefined') return { phone: '', country: '' }
  try {
    return {
      phone:   localStorage.getItem(LAST_PHONE_KEY)   ?? '',
      country: localStorage.getItem(LAST_COUNTRY_KEY) ?? '',
    }
  } catch {
    return { phone: '', country: '' }
  }
}

export function saveLastPhone(phone: string, country: string): void {
  if (typeof window === 'undefined') return
  try {
    const trimmed = phone.trim()
    if (trimmed) localStorage.setItem(LAST_PHONE_KEY, trimmed)
    if (country) localStorage.setItem(LAST_COUNTRY_KEY, country)
  } catch { /* storage unavailable — no pre-fill next time */ }
}

// A ?return= target is trusted only as a same-site path (never
// "//evil.com" or an external URL), and never the login screen itself.
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null
  if (raw === '/login' || raw.startsWith('/login?') || raw.startsWith('/admin/login')) return null
  return raw
}

// Where a login gate sends a logged-out visitor.
export function loginHref(returnTo: string): string {
  return `/login?return=${encodeURIComponent(returnTo)}`
}
