// WhatsApp bot ↔ reference data: the numbered city and cuisine menus are
// built from the VISIBLE values (Admin → Données de référence), and a typed
// name that is not in the list becomes a proposal ("Autre…"). Server only.

import { refList } from '@/lib/refData'
import { chooseCity, chooseCuisine } from '@/lib/refChoice'
import { normalizeCuisine } from '@/lib/cuisineCategories'

const NUM = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟']
const num = (n: number) => NUM[n] ?? `${n}.`

export const botCities = (): string[] => refList('city').map(c => c.code)
export const botCuisines = () => refList('cuisine').filter(c => c.code !== 'autre')

export function cityMenu(lang: 'fr' | 'en'): string {
  const lines = botCities().map((c, i) => `${num(i + 1)} ${c}`)
  return lines.join('\n') + '\n\n' + (lang === 'en'
    ? '_Type the number, or the name of your city if it is not listed._'
    : '_Tapez le chiffre, ou le nom de votre ville si elle n\'est pas dans la liste._')
}

export type BotCity = { city: string; proposed: string | null } | null
/** A number from the menu, a listed name, or a new name (a proposal). */
export function parseCityReply(input: string): BotCity {
  const t = input.trim()
  if (/^\d+$/.test(t)) {
    const c = botCities()[Number(t) - 1]
    return c ? { city: c, proposed: null } : null
  }
  if (normalizeCuisine(t).replace(/[^a-z]/g, '').length < 2) return null
  const pick = chooseCity(null, t)
  return pick.ok ? { city: pick.city, proposed: pick.proposed } : null
}

export function cuisineMenu(lang: 'fr' | 'en'): string {
  const list = botCuisines()
  const lines = list.map((c, i) => `${num(i + 1)} ${lang === 'en' ? c.label_en : c.label_fr}`)
  return (lang === 'en' ? 'Type of *cuisine* (optional)?\n\n' : 'Type de *cuisine* (facultatif) ?\n\n')
    + lines.join('\n') + '\n\n'
    + (lang === 'en'
      ? '_Type the number, or your cuisine if it is not listed. 0 = skip._'
      : '_Tapez le chiffre, ou votre cuisine si elle n\'est pas dans la liste. 0 = passer._')
}

export type BotCuisine = { cuisine: string | null; proposed: string | null } | null
/** 0 / "passer" = none; a number; a listed name; or a new one (proposal). */
export function parseCuisineReply(input: string): BotCuisine {
  const t = input.trim()
  const n = normalizeCuisine(t)
  if (t === '0' || ['passer', 'skip', 'aucun', 'aucune', 'none'].includes(n)) return { cuisine: null, proposed: null }
  if (/^\d+$/.test(t)) {
    const c = botCuisines()[Number(t) - 1]
    return c ? { cuisine: c.label_fr, proposed: null } : null
  }
  if (normalizeCuisine(t).replace(/[^a-z]/g, '').length < 2) return null
  const pick = chooseCuisine(null, t)
  return pick.ok ? { cuisine: pick.cuisine, proposed: pick.proposed } : null
}
