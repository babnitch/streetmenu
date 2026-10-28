'use client'

import React, { createContext, useContext, useState, useCallback } from 'react'
import { CartItem } from '@/types'
import { useBi } from '@/lib/languageContext'

interface CartContextType {
  items: CartItem[]
  restaurantId: string | null
  restaurantName: string | null
  // Adding a dish from another restaurant asks first ("Le vider ?"): the
  // cart is never emptied without the customer saying so.
  addItem: (item: CartItem, restaurantId: string, restaurantName?: string) => void
  removeItem: (id: string) => void
  updateQuantity: (id: string, quantity: number) => void
  clearCart: () => void
  // The server's current prices after a refused checkout: updates each
  // line's price and drops dishes that are gone or sold out.
  syncPrices: (current: Array<{ id: string; price: number; available: boolean }>) => void
  totalPrice: number
  totalItems: number
}

const CartContext = createContext<CartContextType | null>(null)

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([])
  const [restaurantId, setRestaurantId] = useState<string | null>(null)
  const [restaurantName, setRestaurantName] = useState<string | null>(null)
  const bi = useBi()

  const addItem = useCallback((item: CartItem, rid: string, rName?: string) => {
    // Only a cart that still holds dishes from another restaurant needs asking.
    if (restaurantId && restaurantId !== rid && items.length > 0) {
      const other = restaurantName ?? bi('un autre restaurant', 'another restaurant')
      if (!confirm(bi(
        `Votre panier contient des plats de ${other}. Le vider ?`,
        `Your cart has dishes from ${other}. Empty it?`,
      ))) return
      setItems([])
    }
    setRestaurantId(rid)
    setRestaurantName(rName ?? null)
    setItems(prev => {
      const existing = prev.find(i => i.id === item.id)
      if (existing) {
        return prev.map(i => i.id === item.id ? { ...i, quantity: i.quantity + 1 } : i)
      }
      return [...prev, { ...item, quantity: 1 }]
    })
  }, [restaurantId, restaurantName, items.length, bi])

  const removeItem = useCallback((id: string) => {
    setItems(prev => prev.filter(i => i.id !== id))
  }, [])

  const updateQuantity = useCallback((id: string, quantity: number) => {
    if (quantity <= 0) {
      setItems(prev => prev.filter(i => i.id !== id))
    } else {
      setItems(prev => prev.map(i => i.id === id ? { ...i, quantity } : i))
    }
  }, [])

  const clearCart = useCallback(() => {
    setItems([])
    setRestaurantId(null)
    setRestaurantName(null)
  }, [])

  const syncPrices = useCallback((current: Array<{ id: string; price: number; available: boolean }>) => {
    const byId = new Map(current.map(c => [c.id, c]))
    setItems(prev => prev
      .filter(i => byId.get(i.id)?.available !== false)
      .map(i => {
        const c = byId.get(i.id)
        return c ? { ...i, price: c.price } : i
      }))
  }, [])

  const totalPrice = items.reduce((sum, item) => sum + item.price * item.quantity, 0)
  const totalItems = items.reduce((sum, item) => sum + item.quantity, 0)

  return (
    <CartContext.Provider value={{ items, restaurantId, restaurantName, addItem, removeItem, updateQuantity, clearCart, syncPrices, totalPrice, totalItems }}>
      {children}
    </CartContext.Provider>
  )
}

export function useCart() {
  const ctx = useContext(CartContext)
  if (!ctx) throw new Error('useCart must be used within CartProvider')
  return ctx
}
