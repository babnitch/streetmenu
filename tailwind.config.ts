import type { Config } from 'tailwindcss'

// Ndjoka & Tchop design tokens — Uber Eats-inspired palette.
// Use `bg-brand`, `text-brand-dark`, `border-divider`, `text-ink-secondary`
// etc. throughout the app so every CTA and text hierarchy stays in sync.
const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        // Primary brand — Ndjoka & Tchop orange, Uber Eats-style tokens.
        // DEFAULT and dark are the CTA colors; light fills soft surfaces
        // (banners, subtle highlights); badge is the medium pill shade;
        // darker is the ink for "orange text on brand-light" contrast.
        brand: {
          DEFAULT: '#F97316',  // primary
          dark:    '#EA580C',  // hover / pressed
          darker:  '#9A3412',  // text on brand-light surfaces
          light:   '#FFF7ED',  // soft background
          badge:   '#FDBA74',  // medium pill
        },
        // Neutral scale — echoes Uber Eats' black / dark-gray / light-gray trio.
        ink: {
          primary:   '#000000',
          secondary: '#545454',
          tertiary:  '#AFAFAF',
        },
        surface: {
          DEFAULT: '#FFFFFF',
          muted:   '#F6F6F6',
        },
        divider: '#E8E8E8',
        danger:  '#E74C3C',
        warning: '#F5A623',
      },
      boxShadow: {
        card: '0 2px 8px rgba(0, 0, 0, 0.08)',
      },
      keyframes: {
        shimmer: {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.6s linear infinite',
      },
    },
  },
  plugins: [],
}
export default config
