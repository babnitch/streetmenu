'use client'

import { useLanguage } from '@/lib/languageContext'

export default function LanguageToggle() {
  const { locale, setLocale } = useLanguage()

  return (
    <div className="flex items-center rounded-xl overflow-hidden border border-divider bg-white/95 backdrop-blur-sm shadow-sm text-xs font-bold select-none">
      <button
        onClick={() => setLocale('fr')}
        className={`px-2.5 py-1.5 transition-colors ${
          locale === 'fr'
            ? 'bg-brand text-white'
            : 'text-ink-tertiary hover:text-ink-primary hover:bg-surface-muted'
        }`}
        aria-label="Français"
      >
        FR
      </button>
      <button
        onClick={() => setLocale('en')}
        className={`px-2.5 py-1.5 transition-colors ${
          locale === 'en'
            ? 'bg-brand text-white'
            : 'text-ink-tertiary hover:text-ink-primary hover:bg-surface-muted'
        }`}
        aria-label="English"
      >
        EN
      </button>
    </div>
  )
}
