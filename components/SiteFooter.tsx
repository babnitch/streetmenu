'use client'

// Footer (U1) on customer pages — compact on mobile (above the bottom bar),
// four columns on desktop. Reachable without login: Meta checks the site
// for the privacy policy, the company name and a contact. Values come from
// Admin → Plateforme; any empty value hides its part.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useBi, useLanguage } from '@/lib/languageContext'
import { usePlatformInfo } from '@/lib/usePlatformInfo'
import { legalLine, waLink } from '@/lib/legalInfo'
import { openAddSheet } from '@/components/AddSheet'

// Not on the pro, admin and staff tools.
const HIDDEN = ['/admin', '/dashboard', '/pro', '/scanner', '/livraisons', '/login', '/account']

export default function SiteFooter() {
  const pathname = usePathname() ?? ''
  const bi = useBi()
  const { locale } = useLanguage()
  const info = usePlatformInfo()
  if (HIDDEN.some(p => pathname === p || pathname.startsWith(`${p}/`))) return null

  const social = [
    { key: 'instagram', href: info?.instagram, label: 'Instagram', icon: '📸' },
    { key: 'tiktok', href: info?.tiktok, label: 'TikTok', icon: '🎵' },
    { key: 'facebook', href: info?.facebook, label: 'Facebook', icon: '📘' },
    { key: 'whatsapp_channel', href: info?.whatsapp_channel, label: bi('Chaîne WhatsApp', 'WhatsApp Channel'), icon: '💬' },
  ].filter(s => !!s.href)
  const claim = info?.support_whatsapp
    ? waLink(info.support_whatsapp, bi('Bonjour, je suis le propriétaire d\'un restaurant listé sur Tchop & Ndjoka.', 'Hello, I own a restaurant listed on Tchop & Ndjoka.'))
    : null
  const line = info ? legalLine(info, locale === 'en' ? 'en' : 'fr') : ''
  const A = ({ href, children }: { href: string; children: React.ReactNode }) => (
    <Link href={href} className="hover:text-ink-primary hover:underline">{children}</Link>
  )

  return (
    <footer className="mt-10 border-t border-divider bg-surface-muted text-ink-secondary">
      <div className="max-w-5xl mx-auto px-4 py-6 md:py-10 text-sm">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-5">
          <div>
            <p className="font-bold text-ink-primary">Tchop &amp; Ndjoka</p>
            <ul className="mt-2 space-y-1.5">
              <li><A href="/a-propos">{bi('À propos', 'About')}</A></li>
              <li><A href="/contact">{bi('Contact', 'Contact')}</A></li>
            </ul>
          </div>
          <div>
            <p className="font-bold text-ink-primary">{bi('Professionnels', 'Professionals')}</p>
            <ul className="mt-2 space-y-1.5">
              <li><A href="/pro/restaurants/new">{bi('Ajouter mon restaurant ou bar', 'Add my restaurant or bar')}</A></li>
              <li><button type="button" onClick={openAddSheet} className="text-left hover:text-ink-primary hover:underline">{bi('Ajouter un événement ou un lieu', 'Add an event or a place')}</button></li>
              {claim && <li><a href={claim} target="_blank" rel="noopener noreferrer" className="hover:text-ink-primary hover:underline">{bi('C\'est votre restaurant ?', 'Is this your restaurant?')}</a></li>}
            </ul>
          </div>
          <div>
            <p className="font-bold text-ink-primary">{bi('Légal', 'Legal')}</p>
            <ul className="mt-2 space-y-1.5">
              <li><A href="/conditions">{bi('Conditions d\'utilisation', 'Terms of use')}</A></li>
              <li><A href="/confidentialite">{bi('Confidentialité', 'Privacy')}</A></li>
              <li><A href="/remboursements">{bi('Remboursements', 'Refunds')}</A></li>
              <li><A href="/suppression-donnees">{bi('Suppression des données', 'Data deletion')}</A></li>
            </ul>
          </div>
          {social.length > 0 && (
            <div>
              <p className="font-bold text-ink-primary">{bi('Suivez-nous', 'Follow us')}</p>
              <ul className="mt-2 flex md:flex-col gap-3 md:gap-1.5">
                {social.map(s => (
                  <li key={s.key}>
                    <a href={s.href} target="_blank" rel="noopener noreferrer" aria-label={s.label} className="hover:text-ink-primary">
                      <span aria-hidden="true">{s.icon}</span><span className="hidden md:inline"> {s.label}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {line && <p className="mt-6 pt-4 border-t border-divider text-xs text-ink-tertiary leading-relaxed">{line}</p>}
      </div>
    </footer>
  )
}
