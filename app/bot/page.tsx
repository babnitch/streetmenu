'use client'

import { PageShell } from '@/components/LegalPage'
import { useBi } from '@/lib/languageContext'

// /bot — what TchopNdjokaBot is (the link in its User-Agent).
export default function Page() {
  const bi = useBi()
  const items = [
    bi('Il lit, une fois par nuit, les pages d\'événements publiques de billetteries qui l\'autorisent (robots.txt et conditions d\'utilisation).',
      'Once a night, it reads the public event pages of ticketing sites that allow it (robots.txt and terms of use).'),
    bi('Il garde seulement les faits : titre, dates, lieu, ville, prix, organisateur et le lien vers la billetterie. Jamais d\'image ni de texte de description.',
      'It keeps only facts: title, dates, venue, city, price, organiser and the link to the ticketing page. Never an image or description text.'),
    bi('Il respecte robots.txt, fait au plus une requête par seconde par site et s\'arrête dès qu\'un site le demande.',
      'It follows robots.txt, makes at most one request per second per site and stops as soon as a site asks.'),
    bi('Rien n\'est publié automatiquement : notre équipe contacte l\'organisateur avant toute annonce.',
      'Nothing is published automatically: our team contacts the organiser before any listing.'),
  ]
  return (
    <PageShell title="TchopNdjokaBot">
      <p className="mt-3 text-ink-secondary">
        {bi('Le robot de Tchop & Ndjoka qui repère les événements à Yaoundé et Douala.', 'The Tchop & Ndjoka robot that spots events in Yaoundé and Douala.')}
      </p>
      <ul className="mt-4 list-disc pl-5 space-y-2 text-sm text-ink-secondary">
        {items.map(t => <li key={t}>{t}</li>)}
      </ul>
      <p className="mt-6 text-sm text-ink-secondary">
        {bi('Vous gérez un site et voulez qu\'il arrête ? Bloquez « TchopNdjokaBot » dans votre robots.txt ou écrivez-nous via la page ',
          'You run a site and want it to stop? Block "TchopNdjokaBot" in your robots.txt or write to us via the ')}
        <a href="/contact" className="underline font-semibold">{bi('Contact', 'Contact page')}</a>.
      </p>
    </PageShell>
  )
}
