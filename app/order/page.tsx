'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { useCart } from '@/lib/cartContext'
import { supabase } from '@/lib/supabase'

export default function OrderPage() {
  const { items, totalPrice, totalItems, restaurantId, updateQuantity, clearCart } = useCart()
  const router = useRouter()

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)
  const [orderId, setOrderId] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!restaurantId || items.length === 0) return

    setSubmitting(true)
    const { data, error } = await supabase.from('orders').insert({
      restaurant_id: restaurantId,
      customer_name: name.trim(),
      customer_phone: phone.trim(),
      items: items,
      total_price: totalPrice,
      status: 'pending',
    }).select().single()

    setSubmitting(false)

    if (!error && data) {
      setOrderId(data.id)
      setSuccess(true)
      clearCart()
    } else {
      alert('Failed to place order. Please try again.')
    }
  }

  if (items.length === 0 && !success) {
    return (
      <div className="min-h-screen bg-orange-50 flex items-center justify-center px-4">
        <div className="text-center">
          <div className="text-5xl mb-4">🛒</div>
          <h2 className="text-xl font-bold text-gray-800 mb-2">Your cart is empty</h2>
          <p className="text-gray-500 mb-6">Browse restaurants and add items to your cart</p>
          <button
            onClick={() => router.push('/')}
            className="bg-orange-500 text-white px-6 py-3 rounded-xl font-semibold hover:bg-orange-600 transition-colors"
          >
            Explore Restaurants
          </button>
        </div>
      </div>
    )
  }

  if (success) {
    return (
      <div className="min-h-screen bg-orange-50 flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <div className="text-6xl mb-4">🎉</div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Order Placed!</h2>
          <p className="text-gray-500 mb-2">Your order has been sent to the restaurant.</p>
          {orderId && (
            <p className="text-xs text-gray-400 mb-6 font-mono">Order #{orderId.slice(0, 8).toUpperCase()}</p>
          )}
          <div className="bg-white rounded-2xl p-4 mb-6 shadow-sm text-left">
            <p className="text-sm text-gray-600">The restaurant will contact you at <strong className="text-gray-900">{phone}</strong> to confirm your order.</p>
          </div>
          <button
            onClick={() => router.push('/')}
            className="bg-orange-500 text-white px-6 py-3 rounded-xl font-semibold hover:bg-orange-600 transition-colors w-full"
          >
            Back to Map
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-orange-50">
      {/* Header */}
      <div className="bg-white shadow-sm px-4 py-4 flex items-center gap-3">
        <button
          onClick={() => router.back()}
          className="w-9 h-9 rounded-full bg-orange-50 flex items-center justify-center text-gray-600 hover:bg-orange-100 transition-colors"
        >
          ←
        </button>
        <h1 className="text-lg font-bold text-gray-900">Your Order</h1>
        <span className="ml-auto text-sm text-gray-500">{totalItems} items</span>
      </div>

      <div className="px-4 py-4 max-w-lg mx-auto pb-32">
        {/* Cart Items */}
        <div className="bg-white rounded-2xl overflow-hidden shadow-sm mb-4">
          {items.map((item, idx) => (
            <div key={item.id} className={`flex items-center gap-3 px-4 py-3 ${idx < items.length - 1 ? 'border-b border-gray-50' : ''}`}>
              {item.photo_url ? (
                <div className="relative w-12 h-12 rounded-xl overflow-hidden flex-shrink-0">
                  <Image src={item.photo_url} alt={item.name} fill className="object-cover" />
                </div>
              ) : (
                <div className="w-12 h-12 rounded-xl bg-orange-50 flex items-center justify-center text-xl flex-shrink-0">🍽️</div>
              )}
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-900 text-sm truncate">{item.name}</p>
                <p className="text-orange-500 text-sm font-semibold">CHF {item.price.toFixed(2)}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => updateQuantity(item.id, item.quantity - 1)}
                  className="w-7 h-7 rounded-full bg-orange-100 text-orange-600 font-bold flex items-center justify-center hover:bg-orange-200 transition-colors"
                >
                  −
                </button>
                <span className="w-5 text-center text-sm font-semibold">{item.quantity}</span>
                <button
                  onClick={() => updateQuantity(item.id, item.quantity + 1)}
                  className="w-7 h-7 rounded-full bg-orange-100 text-orange-600 font-bold flex items-center justify-center hover:bg-orange-200 transition-colors"
                >
                  +
                </button>
              </div>
            </div>
          ))}
          <div className="px-4 py-3 bg-orange-50 flex items-center justify-between">
            <span className="font-semibold text-gray-700">Total</span>
            <span className="font-bold text-orange-500 text-lg">CHF {totalPrice.toFixed(2)}</span>
          </div>
        </div>

        {/* Customer Form */}
        <form onSubmit={handleSubmit}>
          <h2 className="text-base font-bold text-gray-900 mb-3">Your Details</h2>
          <div className="bg-white rounded-2xl shadow-sm overflow-hidden mb-4">
            <div className="px-4 py-3 border-b border-gray-50">
              <label className="block text-xs text-gray-500 mb-1">Your Name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Anna Müller"
                required
                className="w-full text-sm text-gray-900 placeholder-gray-400 outline-none"
              />
            </div>
            <div className="px-4 py-3">
              <label className="block text-xs text-gray-500 mb-1">Phone Number</label>
              <input
                type="tel"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="e.g. +41 78 123 45 67"
                required
                className="w-full text-sm text-gray-900 placeholder-gray-400 outline-none"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting || !name || !phone}
            className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white py-4 rounded-2xl font-bold text-base shadow-lg shadow-orange-200 transition-colors"
          >
            {submitting ? 'Placing Order...' : `Place Order · CHF ${totalPrice.toFixed(2)}`}
          </button>
        </form>
      </div>
    </div>
  )
}
