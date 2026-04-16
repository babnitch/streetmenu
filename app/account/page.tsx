'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/lib/authContext'
import { useLanguage } from '@/lib/languageContext'
import TopNav from '@/components/TopNav'
import VoucherCard from '@/components/VoucherCard'
import { CustomerVoucher, Order } from '@/types'

type AuthStep = 'phone' | 'otp' | 'setup' | 'dashboard'

async function assignWelcomeVoucher(customerId: string) {
  const { data: voucher } = await supabase
    .from('vouchers')
    .select('id')
    .eq('code', 'BIENVENUE10')
    .single()
  if (!voucher) return
  const { data: existing } = await supabase
    .from('customer_vouchers')
    .select('id')
    .eq('customer_id', customerId)
    .eq('voucher_id', voucher.id)
    .maybeSingle()
  if (!existing) {
    await supabase.from('customer_vouchers').insert({ customer_id: customerId, voucher_id: voucher.id })
  }
}

export default function AccountPage() {
  const { user, loading: authLoading, signOut } = useAuth()
  const { t } = useLanguage()

  const [step, setStep] = useState<AuthStep>('phone')
  const [phone, setPhone] = useState('')
  const [otp, setOtp] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [setupSaving, setSetupSaving] = useState(false)
  const [error, setError] = useState('')

  const [tab, setTab] = useState<'vouchers' | 'orders'>('vouchers')
  const [customerVouchers, setCustomerVouchers] = useState<CustomerVoucher[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [loadingData, setLoadingData] = useState(false)

  useEffect(() => {
    if (authLoading) return
    if (user) {
      const hasName = user.user_metadata?.full_name
      if (!hasName) {
        setStep('setup')
      } else {
        setStep('dashboard')
        loadDashboardData(user.id)
      }
    }
  }, [user, authLoading])

  async function loadDashboardData(userId: string) {
    setLoadingData(true)
    const [{ data: cvData }, { data: ordersData }] = await Promise.all([
      supabase
        .from('customer_vouchers')
        .select('*, vouchers(*)')
        .eq('customer_id', userId)
        .order('claimed_at', { ascending: false }),
      supabase
        .from('orders')
        .select('*, restaurants(name, city)')
        .eq('customer_id', userId)
        .order('created_at', { ascending: false })
        .limit(20),
    ])
    if (cvData) setCustomerVouchers(cvData)
    if (ordersData) setOrders(ordersData)
    setLoadingData(false)
  }

  async function sendOtp() {
    setError('')
    const cleaned = phone.trim()
    if (!cleaned) return
    setSending(true)
    const { error: err } = await supabase.auth.signInWithOtp({ phone: cleaned })
    setSending(false)
    if (err) {
      setError(err.message)
    } else {
      setStep('otp')
    }
  }

  async function verifyOtp() {
    setError('')
    setVerifying(true)
    const { data, error: err } = await supabase.auth.verifyOtp({
      phone: phone.trim(),
      token: otp.trim(),
      type: 'sms',
    })
    setVerifying(false)
    if (err) {
      setError(err.message)
      return
    }
    const u = data.user
    if (!u) return
    if (!u.user_metadata?.full_name) {
      setStep('setup')
    } else {
      setStep('dashboard')
      loadDashboardData(u.id)
    }
  }

  async function saveSetup() {
    if (!user || !displayName.trim()) return
    setSetupSaving(true)
    await supabase.auth.updateUser({ data: { full_name: displayName.trim() } })
    await assignWelcomeVoucher(user.id)
    setSetupSaving(false)
    setStep('dashboard')
    loadDashboardData(user.id)
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#fffaf5' }}>
        <div className="text-4xl animate-bounce">👤</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen" style={{ background: '#fffaf5' }}>
      <TopNav />

      <div className="max-w-md mx-auto px-4 py-8">

        {/* ── Phone step ── */}
        {step === 'phone' && (
          <div className="bg-white rounded-3xl shadow-sm p-6">
            <div className="text-center mb-6">
              <div className="text-5xl mb-3">👤</div>
              <h1 className="text-xl font-bold text-gray-900">{t('account.title')}</h1>
              <p className="text-sm text-gray-400 mt-1">{t('account.phoneHint')}</p>
            </div>
            <label className="block text-xs text-gray-500 mb-1">{t('account.phoneLbl')}</label>
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder={t('account.phonePh')}
              className="w-full border border-gray-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-orange-400 mb-3"
            />
            {error && <p className="text-xs text-red-500 mb-3">{error}</p>}
            <button
              onClick={sendOtp}
              disabled={sending || !phone.trim()}
              className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white py-3.5 rounded-2xl font-bold text-sm transition-colors"
            >
              {sending ? t('account.sending') : t('account.sendOtp')}
            </button>
          </div>
        )}

        {/* ── OTP step ── */}
        {step === 'otp' && (
          <div className="bg-white rounded-3xl shadow-sm p-6">
            <div className="text-center mb-6">
              <div className="text-5xl mb-3">📱</div>
              <h1 className="text-xl font-bold text-gray-900">{t('account.otpLbl')}</h1>
              <p className="text-sm text-gray-400 mt-1">{phone}</p>
            </div>
            <input
              type="text"
              inputMode="numeric"
              value={otp}
              onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder={t('account.otpPh')}
              className="w-full border border-gray-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-orange-400 text-center tracking-widest font-mono text-lg mb-3"
            />
            {error && <p className="text-xs text-red-500 mb-3">{error}</p>}
            <button
              onClick={verifyOtp}
              disabled={verifying || otp.length < 6}
              className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white py-3.5 rounded-2xl font-bold text-sm transition-colors mb-3"
            >
              {verifying ? t('account.verifying') : t('account.verify')}
            </button>
            <button
              onClick={() => { setStep('phone'); setOtp(''); setError('') }}
              className="w-full text-gray-400 text-sm py-2 hover:text-gray-600 transition-colors"
            >
              {t('account.changePhone')}
            </button>
          </div>
        )}

        {/* ── Setup step ── */}
        {step === 'setup' && (
          <div className="bg-white rounded-3xl shadow-sm p-6">
            <div className="text-center mb-6">
              <div className="text-5xl mb-3">🎉</div>
              <h1 className="text-xl font-bold text-gray-900">{t('account.setupBtn')}</h1>
              <p className="text-sm text-green-600 font-medium mt-1">{t('account.setupSub')}</p>
            </div>
            <label className="block text-xs text-gray-500 mb-1">{t('account.nameLbl')}</label>
            <input
              type="text"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder={t('account.namePh')}
              className="w-full border border-gray-200 rounded-2xl px-4 py-3 text-sm outline-none focus:border-orange-400 mb-4"
            />
            <button
              onClick={saveSetup}
              disabled={setupSaving || !displayName.trim()}
              className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white py-3.5 rounded-2xl font-bold text-sm transition-colors"
            >
              {setupSaving ? '…' : t('account.setupBtn')}
            </button>
          </div>
        )}

        {/* ── Dashboard ── */}
        {step === 'dashboard' && user && (
          <div>
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
              <div>
                <p className="text-xs text-gray-400">{t('account.hello')}</p>
                <p className="font-bold text-gray-900 text-lg">
                  {user.user_metadata?.full_name ?? user.phone}
                </p>
              </div>
              <button
                onClick={() => signOut()}
                className="text-xs text-gray-400 hover:text-red-500 transition-colors px-3 py-1.5 rounded-xl hover:bg-red-50"
              >
                {t('account.signOut')}
              </button>
            </div>

            {/* Tabs */}
            <div className="flex bg-white rounded-2xl p-1 shadow-sm mb-5">
              <button
                onClick={() => setTab('vouchers')}
                className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${
                  tab === 'vouchers' ? 'bg-orange-500 text-white' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                🏷️ {t('account.vouchersTab')}
              </button>
              <button
                onClick={() => setTab('orders')}
                className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${
                  tab === 'orders' ? 'bg-orange-500 text-white' : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                📋 {t('account.ordersTab')}
              </button>
            </div>

            {loadingData && (
              <div className="text-center py-12 text-gray-400">
                <div className="text-3xl animate-pulse">…</div>
              </div>
            )}

            {/* Vouchers tab */}
            {!loadingData && tab === 'vouchers' && (
              <div className="space-y-3">
                {customerVouchers.length === 0 ? (
                  <div className="text-center py-12">
                    <div className="text-4xl mb-3">🏷️</div>
                    <p className="text-gray-400 text-sm">{t('account.noVouchers')}</p>
                  </div>
                ) : (
                  customerVouchers.map(cv => (
                    cv.vouchers && (
                      <VoucherCard
                        key={cv.id}
                        voucher={cv.vouchers}
                        customerVoucherId={cv.id}
                        usedAt={cv.used_at}
                      />
                    )
                  ))
                )}
              </div>
            )}

            {/* Orders tab */}
            {!loadingData && tab === 'orders' && (
              <div className="space-y-3">
                {orders.length === 0 ? (
                  <div className="text-center py-12">
                    <div className="text-4xl mb-3">📋</div>
                    <p className="text-gray-400 text-sm">{t('account.noOrders')}</p>
                    <Link href="/" className="mt-4 inline-block text-orange-500 text-sm font-semibold underline">
                      Explorer les restaurants
                    </Link>
                  </div>
                ) : (
                  orders.map(order => (
                    <div key={order.id} className="bg-white rounded-2xl shadow-sm p-4">
                      <div className="flex items-center justify-between mb-1">
                        <p className="font-semibold text-gray-900 text-sm">
                          {t('account.orderAt')} {order.restaurants?.name ?? '—'}
                        </p>
                        <span className="text-xs text-gray-400">
                          {new Date(order.created_at).toLocaleDateString('fr-FR')}
                        </span>
                      </div>
                      <p className="text-xs text-gray-400 mb-2">
                        {Array.isArray(order.items)
                          ? order.items.map((it: { name: string; quantity: number }) => `${it.quantity}× ${it.name}`).join(', ')
                          : ''}
                      </p>
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-orange-500 text-sm">{Number(order.total_price).toLocaleString()} FCFA</span>
                        <span className="text-xs bg-orange-50 text-orange-600 px-2 py-0.5 rounded-full font-medium capitalize">
                          {order.status}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  )
}
