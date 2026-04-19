'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useLanguage } from '@/lib/languageContext'
import LanguageToggle from '@/components/LanguageToggle'

export default function AdminLoginPage() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const { t } = useLanguage()

  useEffect(() => {
    const token = localStorage.getItem('adminToken')
    if (token) router.replace('/admin/restaurants')
  }, [router])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const res = await fetch('/api/admin/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })

    const data = await res.json()
    setLoading(false)

    if (res.ok && data.token) {
      localStorage.setItem('adminToken', data.token)
      router.replace('/admin/restaurants')
    } else {
      setError(data.error ?? 'Login failed')
      setPassword('')
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-light to-brand-light flex items-center justify-center px-4">
      {/* Language toggle top-right */}
      <div className="absolute top-4 right-4">
        <LanguageToggle />
      </div>

      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2 mb-3">
            <span className="bg-brand text-white font-black text-xl px-2.5 py-1.5 rounded-xl tracking-tight leading-none">NT</span>
          </div>
          <h1 className="text-2xl font-bold text-ink-primary">Ndjoka &amp; Tchop</h1>
          <p className="text-sm text-ink-secondary mt-1">{t('admin.panel')}</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-3xl shadow-xl shadow-brand-light p-8"
        >
          <label className="block text-sm font-medium text-ink-primary mb-2">
            {t('admin.passwordLbl')}
          </label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder={t('admin.passwordPh')}
            required
            autoFocus
            className="w-full border border-divider rounded-xl px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-light transition mb-4"
          />

          {error && (
            <p className="text-danger text-sm mb-4 text-center">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !password}
            className="w-full bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white py-3 rounded-xl font-semibold transition-colors"
          >
            {loading ? t('admin.checking') : t('admin.enterBtn')}
          </button>
        </form>
      </div>
    </div>
  )
}
