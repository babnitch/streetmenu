'use client'

import { useLanguage } from '@/lib/languageContext'

export default function LanguageToggle() {
  const { locale, setLocale } = useLanguage()

  return (
    <div className="flex items-center rounded-xl overflow-hidden border border-gray-200 bg-white/95 backdrop-blur-sm shadow-sm text-xs font-bold select-none">
      <button
        onClick={() => setLocale('fr')}
        className={`px-2.5 py-1.5 transition-colors ${
          locale === 'fr'
            ? 'bg-orange-500 text-white'
            : 'text-gray-400 hover:text-gray-700 hover:bg-gray-50'
        }`}
        aria-label="Français"
      >
        FR
      </button>
      <button
        onClick={() => setLocale('en')}
        className={`px-2.5 py-1.5 transition-colors ${
          locale === 'en'
            ? 'bg-orange-500 text-white'
            : 'text-gray-400 hover:text-gray-700 hover:bg-gray-50'
        }`}
        aria-label="English"
      >
        EN
      </button>
    </div>
  )
}
