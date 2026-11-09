// Sites we never fetch, whatever the source of the link (the nightly job, a
// pasted link): their terms forbid automated access and a Meta / X ban would
// hit the business accounts. A pasted post from them is used as TEXT only.

const BLOCKED_DOMAINS = [
  'instagram.com', 'instagr.am', 'ig.me',
  'facebook.com', 'fb.com', 'fb.me', 'fb.watch', 'messenger.com', 'm.me',
  'tiktok.com',
  'x.com', 'twitter.com', 't.co',
  'threads.net', 'threads.com',
  'whatsapp.com', 'wa.me',
]

/** True when the URL is on a blocked site — or isn't a valid http(s) URL. */
export function isBlockedUrl(url: string): boolean {
  let host: string
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return true
    host = u.hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return true
  }
  return BLOCKED_DOMAINS.some(d => host === d || host.endsWith(`.${d}`))
}
