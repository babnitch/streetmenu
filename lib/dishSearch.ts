'use client'

// Dish-name search (shared by the home search overlay and the restaurant
// list, N1). A debounced `menu_items` query; `menu_items` is publicly
// readable (supabase-rls-policies.sql) but only for active restaurants, so
// the result set is already scoped. Returns restaurant_id → the first
// matching dish name, so a hit can explain itself.

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

export function useDishHits(query: string, enabled = true): { hits: Record<string, string>; searching: boolean } {
  const [hits, setHits] = useState<Record<string, string>>({})
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    const q = query.trim()
    if (!enabled || q.length < 2) { setHits({}); setSearching(false); return }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const { data } = await supabase
          .from('menu_items')
          .select('restaurant_id, name')
          .ilike('name', `%${q.replace(/[%_,()]/g, ' ')}%`)
          .eq('is_available', true)
          .limit(60)
        if (cancelled) return
        const next: Record<string, string> = {}
        for (const row of (data ?? []) as Array<{ restaurant_id: string; name: string }>) {
          if (!next[row.restaurant_id]) next[row.restaurant_id] = row.name
        }
        setHits(next)
      } catch { if (!cancelled) setHits({}) }
      finally { if (!cancelled) setSearching(false) }
    }, 300)
    return () => { cancelled = true; clearTimeout(t) }
  }, [query, enabled])

  return { hits, searching }
}
