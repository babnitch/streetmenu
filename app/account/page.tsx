'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import dynamicLoad from 'next/dynamic'
import { useLanguage, useBi, pickBi } from '@/lib/languageContext'
import TopNav from '@/components/TopNav'
import LanguageToggle from '@/components/LanguageToggle'
import ModeToggle from '@/components/ModeToggle'
import VoucherCard from '@/components/VoucherCard'
import AdminProfilePanel from '@/components/AdminProfilePanel'
import PaymentBadge from '@/components/PaymentBadge'
import NotificationsPanel from '@/components/NotificationsPanel'
import BroadcastPanel from '@/components/BroadcastPanel'
import PromotePanel from '@/components/PromotePanel'
import EventTiersPanel from '@/components/EventTiersPanel'
import EventVouchersPanel from '@/components/EventVouchersPanel'
import PhoneInput from '@/components/PhoneInput'
import { useDataMode } from '@/lib/dataMode'
import { categoryLabel } from '@/lib/categoryLabels'
import { canPayOnline, type PaymentMode } from '@/lib/paymentMode'
import { CustomerVoucher, EventReservation, Order } from '@/types'

// Event categories — kept in sync with app/events/submit/page.tsx.
const EVENT_EDIT_CATEGORIES = [
  'Concert', 'Festival', 'BT/Club', 'Sport', 'Culture', 'Gastronomie', 'Enfants', 'Business', 'Autre',
] as const

// ── Lazy-loaded admin panels (no SSR) ────────────────────────────────────────
const AdminRestaurants = dynamicLoad(() => import('@/app/admin/restaurants/page'), { ssr: false })
const AdminOrders      = dynamicLoad(() => import('@/app/admin/orders/page'),      { ssr: false })
const AdminEvents      = dynamicLoad(() => import('@/app/admin/events/page'),      { ssr: false })
const AdminBroadcasts  = dynamicLoad(() => import('@/app/admin/broadcasts/page'),  { ssr: false })
const AdminPromotions  = dynamicLoad(() => import('@/app/admin/promotions/page'),  { ssr: false })
const AdminVouchers    = dynamicLoad(() => import('@/app/admin/vouchers/page'),    { ssr: false })
const AdminReports     = dynamicLoad(() => import('@/app/admin/reports/page'),     { ssr: false })
const AdminAccounts    = dynamicLoad(() => import('@/app/admin/accounts/page'),    { ssr: false })
const AdminPlatformTeam = dynamicLoad(() => import('@/app/admin/platformteam/page'), { ssr: false })

// ── Types ────────────────────────────────────────────────────────────────────
type LoginTab    = 'customer' | 'team'
type AuthStep    = 'loading' | 'login' | 'register' | 'otp' | 'dashboard'

// Read a `?return=` target from the URL, but only trust same-site absolute
// paths (`/events/submit`) — never protocol-relative (`//evil.com`) or
// external URLs, so the login gate can't be turned into an open redirect.
function safeReturnUrl(): string | null {
  if (typeof window === 'undefined') return null
  const raw = new URLSearchParams(window.location.search).get('return')
  if (!raw) return null
  if (!raw.startsWith('/') || raw.startsWith('//')) return null
  return raw
}
type DashView    = 'customer' | 'vendor' | 'admin'
type CustomerTab = 'vouchers' | 'orders' | 'events' | 'profile' | 'restaurant' | 'team'
type AdminSubTab = 'restaurants' | 'orders' | 'events' | 'broadcasts' | 'promotions' | 'vouchers' | 'reports' | 'accounts' | 'platformteam' | 'profile'

// Explicit bilingual labels — avoids the earlier bug where the label was
// built from the tab value (e.g. `account.adminNav${capitalize(sub)}`),
// which produced a non-existent key `account.adminNavPlatformteam` and
// rendered raw in the UI.
const ADMIN_TAB_LABELS: Record<AdminSubTab, string> = {
  restaurants:  'Restaurants',
  orders: 'Commandes / Orders',
  events: 'Événements / Events',
  broadcasts: 'Diffusions / Broadcasts',
  promotions: 'Promotions / Promotions',
  vouchers: 'Bons / Vouchers',
  reports: 'Signalements / Reports',
  accounts: 'Comptes / Accounts',
  platformteam: 'Équipe plateforme / Platform Team',
  profile: 'Mon profil / My Profile',
}

interface SessionUser {
  id:     string
  name:   string
  role:   'customer' | 'super_admin' | 'admin' | 'moderator'
  phone?: string
  email?: string
}

interface VendorRestaurant {
  id:           string
  name:         string
  city:         string
  neighborhood: string
  cuisine_type: string
  image_url:    string | null
  is_active:    boolean
  status:       string
  deleted_at:   string | null
  suspended_at: string | null
  suspended_by: string | null
  whatsapp:     string
  teamRole:     'owner' | 'manager' | 'staff'
}

interface TeamMember {
  id:       string
  role:     string
  added_at: string
  customers: { id: string; name: string; phone: string }
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function AccountPage() {
  const bi = useBi()
  const { t, locale } = useLanguage()

  // Login form state
  const [loginTab,    setLoginTab]    = useState<LoginTab>('customer')
  const [step,        setStep]        = useState<AuthStep>('loading')
  const [phone,       setPhone]       = useState('')
  const [email,       setEmail]       = useState('')
  const [password,    setPassword]    = useState('')
  const [rememberMe,  setRememberMe]  = useState(false)
  const [name,        setName]        = useState('')
  const [city,        setCity]        = useState('')
  const [otp,         setOtp]         = useState('')
  const [sending,     setSending]     = useState(false)
  const [verifying,   setVerifying]   = useState(false)
  const [loggingIn,   setLoggingIn]   = useState(false)
  const [error,       setError]       = useState('')
  // OTP resend — 30s cooldown, capped at 3 resends per session so a leaked
  // verify-code endpoint can't be hammered via the UI.
  const [resendCooldown, setResendCooldown] = useState(0)
  const [resendCount,    setResendCount]    = useState(0)
  const [resending,      setResending]      = useState(false)

  // Session / dashboard
  const [user,             setUser]             = useState<SessionUser | null>(null)
  const [dashView,         setDashView]         = useState<DashView>('customer')
  // Default to Profile — Orders and Vouchers no longer render as tab
  // buttons on this page (they live in the bottom nav), but deep links
  // with ?tab=orders / ?tab=vouchers still work for backward compat.
  // Read ?tab= synchronously in the lazy initializer so /account?tab=orders
  // lands on Orders directly, with no flash through the default Profile tab.
  // The post-mount useEffect below keeps in-page URL changes (back/forward
  // nav, deep-linked toasts) in sync.
  const [customerTab,      setCustomerTab]      = useState<CustomerTab>(() => {
    if (typeof window === 'undefined') return 'orders'
    const q = new URLSearchParams(window.location.search).get('tab')
    const allowed: CustomerTab[] = ['vouchers', 'orders', 'events', 'profile', 'restaurant', 'team']
    const initial = q && (allowed as string[]).includes(q) ? (q as CustomerTab) : 'orders'
    console.log('[account] initial customerTab from URL:', { rawQuery: q, initial })
    return initial
  })
  const [adminSubTab,      setAdminSubTab]      = useState<AdminSubTab>('restaurants')
  const [customerVouchers, setCustomerVouchers] = useState<CustomerVoucher[]>([])
  const [eventReservations, setEventReservations] = useState<EventReservation[]>([])
  // Events the user organizes. Populated from /api/events/my; empty array
  // means the "Mes événements" tab stays hidden.
  interface MyEvent {
    id: string; title: string; date: string; time: string | null
    description?: string | null; neighborhood?: string | null; category?: string | null
    venue: string | null; city: string | null; cover_photo: string | null
    ticket_price: number | null; max_tickets: number | null; tickets_sold: number | null
    payment_enabled: boolean; payment_mode?: string | null; whatsapp_payment_enabled?: boolean
    organizer_name: string | null; event_status: string | null
    is_active: boolean
    requires_confirmation?: boolean
    reservations_open?:     boolean
    reservations_count: number; tickets_count: number
    revenue: number; commission: number; net_revenue: number; pending_count: number
    pending_approval_count?: number
  }
  interface OrganizerTrust {
    events_submitted_count: number
    events_approved_count:  number
    event_auto_approve:     boolean
  }
  const [myEvents, setMyEvents] = useState<MyEvent[]>([])
  const [organizerTrust, setOrganizerTrust] = useState<OrganizerTrust | null>(null)
  // One-time welcome banner shown after a brand-new customer signs in for
  // the first time. Set by verifyOtp when /api/auth/verify-code reports
  // isNewAccount; dismissed by the user via the close button.
  const [welcomeVoucherCode, setWelcomeVoucherCode] = useState<string | null>(null)
  const [orders,           setOrders]           = useState<Order[]>([])
  const [loadingData,      setLoadingData]      = useState(false)

  // Vendor state
  const [myRestaurants,    setMyRestaurants]    = useState<VendorRestaurant[]>([])
  const [activeRestId,     setActiveRestId]     = useState<string>('')
  const [teamMembers,      setTeamMembers]      = useState<TeamMember[]>([])
  // Pending team invitations — phone is not yet a customer; they'll be added
  // to restaurant_team once they WhatsApp-reply "accepter". Kept per-active-
  // restaurant; reloaded alongside team members when the Team tab opens.
  const [pendingInvitations, setPendingInvitations] = useState<Array<{
    id: string; phone: string; role: string; status: string;
    created_at: string; expires_at: string;
  }>>([])
  const [loadingInvitations, setLoadingInvitations] = useState(false)
  const [cancellingInvId,    setCancellingInvId]    = useState<string | null>(null)
  const [loadingTeam,      setLoadingTeam]      = useState(false)
  const [teamPhone,        setTeamPhone]        = useState('')
  const [teamRole,         setTeamRole]         = useState('staff')
  const [addingMember,     setAddingMember]     = useState(false)
  const [teamError,        setTeamError]        = useState('')
  const [restActionLoading, setRestActionLoading] = useState('')
  const [uploadingPhoto,   setUploadingPhoto]   = useState(false)

  // Profile tab
  interface ProfileRow {
    id: string; name: string; phone: string; city: string
    nickname: string | null; nickname_updated_at: string | null
    status: string
    suspended_at: string | null; suspended_by: string | null; suspension_reason: string | null
    deleted_at: string | null; created_at: string
  }
  const [profile,         setProfile]         = useState<ProfileRow | null>(null)
  const [profileEditing,  setProfileEditing]  = useState(false)
  const [profileName,     setProfileName]     = useState('')
  const [profileCity,     setProfileCity]     = useState('')
  const [profileNickname, setProfileNickname] = useState('')
  const [savingNickname,  setSavingNickname]  = useState(false)
  const [savingProfile,   setSavingProfile]   = useState(false)
  const PROFILE_CITIES = ['Yaoundé', 'Abidjan', 'Dakar', 'Lomé']

  // Modals
  type VendorModal = 'suspend-rest' | 'delete-rest' | 'delete-account' | null
  const [vendorModal,      setVendorModal]      = useState<VendorModal>(null)
  const [modalReason,      setModalReason]      = useState('')
  const [accountDeletedAt, setAccountDeletedAt] = useState<string | null>(null)

  // Toast
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)
  function showToast(msg: string, ok = true) {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3500)
  }

  // OTP resend cooldown tick — runs while there's time left on the clock.
  useEffect(() => {
    if (resendCooldown <= 0) return
    const t = setInterval(() => setResendCooldown(c => (c > 0 ? c - 1 : 0)), 1000)
    return () => clearInterval(t)
  }, [resendCooldown])

  async function handleResendCode() {
    if (resending || resendCooldown > 0 || resendCount >= 3) return
    setResending(true)
    try {
      const res = await fetch('/api/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: phone.trim(),
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(city        ? { city }               : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        showToast(data.error || bi('Erreur', 'Error'), false)
        return
      }
      setResendCount(c => c + 1)
      setResendCooldown(30)
      showToast(bi('Code renvoyé!', 'Code resent!'))
    } finally {
      setResending(false)
    }
  }

  // Honor the ?tab= query param — BottomNav links to /account?tab=orders,
  // and TopNav desktop nav does likewise. Only adopt known CustomerTab
  // values to avoid arbitrary strings leaking into state. (The lazy
  // initializer above handles the first paint; this effect catches
  // in-page URL changes that don't remount the component.)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const q = new URLSearchParams(window.location.search).get('tab')
    const allowed: CustomerTab[] = ['vouchers', 'orders', 'events', 'profile', 'restaurant', 'team']
    if (q && (allowed as string[]).includes(q)) {
      console.log('[account] post-mount effect setting tab:', q)
      setCustomerTab(q as CustomerTab)
    }
  }, [])

  // ── On mount: check JWT session ──
  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(data => {
        if (data.user) {
          const u: SessionUser = data.user
          // Already logged in as a customer and arrived here via a login
          // gate (?return=/events/submit) — bounce straight to the target
          // instead of showing the dashboard.
          const ret = safeReturnUrl()
          if (ret && u.role === 'customer') {
            window.location.href = ret
            return
          }
          setUser(u)
          setStep('dashboard')
          if (['super_admin', 'admin', 'moderator'].includes(u.role)) {
            setDashView('admin')
          } else {
            setDashView('customer')
            loadCustomerData(u.id)
            loadMyRestaurants()
          }
        } else {
          setStep('login')
        }
      })
      .catch(() => setStep('login'))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loadCustomerData = useCallback(async (customerId: string) => {
    setLoadingData(true)
    // All four reads now go through API routes that authenticate via
    // our JWT and run as supabaseAdmin (bypassing RLS). The previous
    // direct supabase.from('customer_vouchers' | 'orders') reads only
    // worked because RLS was open — supabase-rls-policies.sql locked
    // both tables to service-role-only.
    const [cvRes, ordersRes, resvRes, myEvRes] = await Promise.all([
      fetch('/api/customer/vouchers/my',  { cache: 'no-store' }).then(r => r.json()).catch(() => ({ vouchers: [] })),
      fetch('/api/customer/orders',       { cache: 'no-store' }).then(r => r.json()).catch(() => ({ orders: [] })),
      fetch('/api/customer/reservations', { cache: 'no-store' }).then(r => r.json()).catch(() => ({ reservations: [] })),
      fetch('/api/events/my',             { cache: 'no-store' }).then(r => r.json()).catch(() => ({ events: [] })),
    ])
    if (Array.isArray(cvRes?.vouchers))      setCustomerVouchers(cvRes.vouchers)
    if (Array.isArray(ordersRes?.orders))    setOrders(ordersRes.orders)
    if (Array.isArray(resvRes?.reservations)) setEventReservations(resvRes.reservations)
    if (Array.isArray(myEvRes?.events)) setMyEvents(myEvRes.events)
    if (myEvRes?.trust) setOrganizerTrust(myEvRes.trust as OrganizerTrust)
    // Diagnostic: shows in the browser console exactly what the organizer
    // tab keys off — the events count + submitted-count trust. If the tab is
    // missing, this reveals whether /api/events/my returned data for THIS
    // logged-in customer (vs. a stale deploy or a different account).
    console.log('[account] /api/events/my → for customer=%s: %d event(s), trust=%o',
      customerId, Array.isArray(myEvRes?.events) ? myEvRes.events.length : 'n/a', myEvRes?.trust)
    setLoadingData(false)
  }, [])

  async function loadMyRestaurants() {
    const res = await fetch('/api/vendor/restaurants')
    const data = await res.json()
    if (data.restaurants?.length) {
      setMyRestaurants(data.restaurants)
      setActiveRestId(data.restaurants[0].id)
    }
  }

  async function loadTeam(restaurantId: string) {
    setLoadingTeam(true)
    const res = await fetch(`/api/restaurants/${restaurantId}/team`)
    const data = await res.json()
    setTeamMembers(data.team ?? [])
    setLoadingTeam(false)
  }

  // Pending invitations live in team_invitations (see the SQL migration).
  // Loaded in parallel with the team list when the Team tab opens.
  async function loadInvitations(restaurantId: string) {
    setLoadingInvitations(true)
    try {
      const res = await fetch(`/api/restaurants/${restaurantId}/invite`)
      const data = await res.json()
      setPendingInvitations(data.invitations ?? [])
    } finally {
      setLoadingInvitations(false)
    }
  }

  async function handleCancelInvitation(invitationId: string) {
    if (!activeRestId) return
    setCancellingInvId(invitationId)
    try {
      const res = await fetch(`/api/restaurants/${activeRestId}/invite/${invitationId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const d = await res.json()
        showToast(d.error ?? bi('Erreur', 'Error'), false)
        return
      }
      showToast(bi('Invitation annulée', 'Invitation cancelled'))
      await loadInvitations(activeRestId)
    } finally {
      setCancellingInvId(null)
    }
  }

  // Load team when switching to team tab
  useEffect(() => {
    if (customerTab === 'team' && activeRestId) { loadTeam(activeRestId); loadInvitations(activeRestId) }
    if (customerTab === 'profile' && !profile) loadProfile()
  }, [customerTab, activeRestId, profile])

  // Name of the known customer when check-phone confirms existence.
  // Lets the OTP screen greet them by name without exposing their details.
  const [knownName, setKnownName] = useState<string | null>(null)

  // ── Customer login: check phone, then send OTP ──
  // Two-phase flow so a customer who registered via WhatsApp goes straight to
  // code entry instead of being asked for name/city again.
  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const cleaned = phone.trim()
    console.log('[login-flow] submit, cleaned phone =', JSON.stringify(cleaned))
    if (!cleaned) return
    setSending(true)
    try {
      console.log('[login-flow] calling check-phone…')
      const checkRes = await fetch(
        `/api/auth/check-phone?phone=${encodeURIComponent(cleaned)}`
      )
      const check = await checkRes.json()
      console.log('[login-flow] check-phone status =', checkRes.status, 'body =', check)
      if (!checkRes.ok) { setError(check.error || bi('Erreur', 'Error')); return }

      if (check.exists) {
        console.log('[login-flow] existing customer — skipping register form, sending code')
        setKnownName(check.name ?? null)
        const sendRes = await fetch('/api/auth/send-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: cleaned }),
        })
        const sendData = await sendRes.json()
        console.log('[login-flow] send-code status =', sendRes.status, 'body =', sendData)
        if (!sendRes.ok) { setError(sendData.error || bi('Erreur', 'Error')); return }
        setResendCount(0)
        setResendCooldown(30)
        setStep('otp')
        return
      }

      console.log('[login-flow] new customer — showing register form')
      setKnownName(null)
      setStep('register')
    } finally {
      setSending(false)
    }
  }

  // ── Register (new customer) ──
  async function handleRegisterSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!name.trim() || !city) return
    setSending(true)
    try {
      const res  = await fetch('/api/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim(), name: name.trim(), city }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || bi('Erreur', 'Error')); return }
      setResendCount(0)
      setResendCooldown(30)
      setStep('otp')
    } finally {
      setSending(false)
    }
  }

  // ── Verify OTP ──
  async function verifyOtp() {
    setError('')
    setVerifying(true)
    try {
      const res  = await fetch('/api/auth/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: phone.trim(),
          code:  otp.trim(),
          rememberMe,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(city        ? { city }               : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || bi('Erreur', 'Error')); return }
      const u: SessionUser = { id: data.customer.id, phone: data.customer.phone, name: data.customer.name, role: 'customer' }
      // Login gate return — send the user back to where they came from
      // (e.g. /events/submit) now that the session cookie is set.
      const ret = safeReturnUrl()
      if (ret) {
        window.location.href = ret
        return
      }
      setUser(u)
      setStep('dashboard')
      setDashView('customer')
      if (data.isNewAccount && data.welcomeVoucherCode) {
        setWelcomeVoucherCode(data.welcomeVoucherCode)
        // Land on the Vouchers tab so the new BIENVENUE claim is right there.
        setCustomerTab('vouchers')
      }
      loadCustomerData(u.id)
      loadMyRestaurants()
    } finally {
      setVerifying(false)
    }
  }

  // ── Admin / team login ──
  async function handleAdminLogin(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoggingIn(true)
    try {
      const res  = await fetch('/api/auth/admin-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password, rememberMe }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || 'Erreur'); return }
      const u: SessionUser = { id: data.user.id, email: data.user.email, name: data.user.name, role: data.user.role }
      setUser(u)
      setStep('dashboard')
      setDashView('admin')
    } finally {
      setLoggingIn(false)
    }
  }

  // ── Sign out ──
  async function handleSignOut() {
    await fetch('/api/auth/logout', { method: 'POST' })
    setUser(null)
    setPhone(''); setEmail(''); setPassword(''); setName(''); setCity(''); setOtp('')
    setMyRestaurants([]); setCustomerVouchers([]); setOrders([])
    setStep('login')
  }

  // ── Vendor: restaurant actions ──
  const activeRest = myRestaurants.find(r => r.id === activeRestId)

  async function handleRestaurantAction(action: 'suspend' | 'reactivate' | 'delete' | 'undo-delete') {
    if (!activeRestId) return
    setVendorModal(null)
    setRestActionLoading(action)
    try {
      const res = await fetch(`/api/restaurants/${activeRestId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: modalReason }),
      })
      const data = await res.json()
      if (res.ok) {
        const labels: Record<string, string> = {
          suspend: '⏸️ Restaurant suspendu / suspended',
          reactivate: '✅ Restaurant réactivé / reactivated',
          delete: '🗑️ Restaurant supprimé / deleted',
          'undo-delete': bi('↩️ Suppression annulée', 'Deletion undone'),
        }
        showToast(labels[action] ?? bi('✅ Fait', 'Done'))
        setModalReason('')
        await loadMyRestaurants()
      } else {
        showToast(data.error ?? bi('Erreur', 'Error'), false)
      }
    } finally {
      setRestActionLoading('')
    }
  }

  // ── Vendor: delete own account ──
  async function handleDeleteAccount() {
    if (!user) return
    setVendorModal(null)
    const res = await fetch(`/api/accounts/${user.id}/delete`, { method: 'POST' })
    const data = await res.json()
    if (res.ok) {
      showToast(bi('🗑️ Compte supprimé', 'Account deleted'))
      setAccountDeletedAt(new Date().toISOString())
    } else {
      showToast(data.error ?? bi('Erreur', 'Error'), false)
    }
  }

  async function handleUndoDeleteAccount() {
    if (!user) return
    const res = await fetch(`/api/accounts/${user.id}/undo-delete`, { method: 'POST' })
    const data = await res.json()
    if (res.ok) {
      showToast(bi('↩️ Suppression annulée', 'Deletion undone'))
      setAccountDeletedAt(null)
    } else {
      showToast(data.error ?? bi('Erreur', 'Error'), false)
    }
  }

  // ── Vendor: add or invite team member ──
  // Always go through /invite — known numbers get added directly, unknown
  // ones get a pending invitation that completes via WhatsApp accept/decline.
  async function handleAddTeamMember(e: React.FormEvent) {
    e.preventDefault()
    setTeamError('')
    setAddingMember(true)
    try {
      const res = await fetch(`/api/restaurants/${activeRestId}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: teamPhone.trim(), role: teamRole }),
      })
      const data = await res.json()
      if (!res.ok) { setTeamError(data.error ?? 'Erreur'); return }
      setTeamPhone('')
      if (data.mode === 'invited') {
        showToast(bi('📨 Invitation envoyée', 'Invitation sent'))
      } else {
        showToast(bi('✅ Membre ajouté', 'Member added'))
      }
      await Promise.all([loadTeam(activeRestId), loadInvitations(activeRestId)])
    } finally {
      setAddingMember(false)
    }
  }

  async function handleRemoveTeamMember(memberId: string) {
    await fetch(`/api/restaurants/${activeRestId}/team/${memberId}`, { method: 'DELETE' })
    await loadTeam(activeRestId)
  }

  async function handleChangeRole(memberId: string, role: string) {
    const res = await fetch(`/api/restaurants/${activeRestId}/team/${memberId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    })
    if (res.ok) {
      showToast(bi('✅ Rôle mis à jour', 'Role updated'))
      await loadTeam(activeRestId)
    } else {
      const d = await res.json()
      showToast(d.error ?? bi('Erreur', 'Error'), false)
    }
  }

  async function loadProfile() {
    const res = await fetch('/api/auth/profile', { cache: 'no-store' })
    if (!res.ok) return
    const data = await res.json()
    if (data.profile) {
      setProfile(data.profile)
      setProfileName(data.profile.name ?? '')
      setProfileCity(data.profile.city ?? '')
      setProfileNickname(data.profile.nickname ?? '')
      setAccountDeletedAt(data.profile.deleted_at ?? null)
    }
  }

  async function handleSaveProfile() {
    if (!profile) return
    setSavingProfile(true)
    try {
      const res = await fetch('/api/auth/update-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: profileName, city: profileCity }),
      })
      const data = await res.json()
      if (res.ok) {
        setProfile(p => (p ? { ...p, name: profileName, city: profileCity } : p))
        setProfileEditing(false)
        showToast(bi('✅ Profil mis à jour', 'Profile updated'))
      } else {
        showToast(data.error ?? bi('Erreur', 'Error'), false)
      }
    } finally {
      setSavingProfile(false)
    }
  }

  async function handleRestaurantPhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !activeRestId) return
    setUploadingPhoto(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('kind', 'restaurant_hero')
      fd.append('pathPrefix', 'restaurants')
      const upRes = await fetch('/api/upload/image', { method: 'POST', body: fd })
      if (!upRes.ok) { showToast(bi('Erreur upload', 'Upload error'), false); return }
      const upJson = await upRes.json()
      const res = await fetch(`/api/restaurants/${activeRestId}/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_url: upJson.url, blur_hash: upJson.blur_hash }),
      })
      if (res.ok) {
        showToast(bi('✅ Photo mise à jour', 'Photo updated'))
        await loadMyRestaurants()
      } else {
        const d = await res.json()
        showToast(d.error ?? bi('Erreur', 'Error'), false)
      }
    } finally {
      setUploadingPhoto(false)
      e.target.value = ''
    }
  }

  // ── Admin permission checks ──
  function adminCan(tab: AdminSubTab): boolean {
    if (!user) return false
    // Everyone in the admin dashboard can see their own profile
    if (tab === 'profile') return true
    if (user.role === 'super_admin') return true
    if (user.role === 'admin') return tab !== 'platformteam'
    if (user.role === 'moderator') return ['restaurants', 'orders', 'events', 'broadcasts', 'promotions', 'reports'].includes(tab)
    return false
  }

  // ── Loading splash ──
  if (step === 'loading') {
    return (
      <div className="min-h-[calc(100dvh-4rem)] md:min-h-screen flex items-center justify-center bg-surface">
        <div className="text-4xl animate-bounce">👤</div>
      </div>
    )
  }

  // Admin dashboard keeps the narrow-centered 2xl column to match the
  // rest of the chrome; form surfaces (sign-in, sign-up, profile edit)
  // stay at max-w-md because single-column forms become unusable past
  // ~600px and 2xl is already wider than ideal for that case.
  const containerClass =
    step === 'dashboard' && dashView === 'admin'
      ? 'max-w-2xl mx-auto px-4 py-8'
      : 'max-w-md mx-auto px-4 py-8'

  return (
    <div className="min-h-screen bg-surface">
      {toast && (
        <div className={`fixed top-5 right-5 z-[100] px-5 py-3 rounded-2xl shadow-lg text-sm font-semibold text-white transition-all max-w-sm ${toast.ok ? 'bg-brand' : 'bg-danger'}`}>
          {toast.msg}
        </div>
      )}

      <TopNav />

      <div className={containerClass}>

        {/* ── Login ── */}
        {step === 'login' && (
          <div className="max-w-md mx-auto bg-white rounded-3xl shadow-sm p-6">
            <div className="text-center mb-5">
              <div className="text-5xl mb-3">👤</div>
              <h1 className="text-xl font-bold text-ink-primary">{t('account.title')}</h1>
            </div>

            {/* Login tabs */}
            <div className="flex bg-surface-muted rounded-2xl p-1 mb-5 gap-1">
              <button
                onClick={() => { setLoginTab('customer'); setError('') }}
                className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${loginTab === 'customer' ? 'bg-white text-ink-primary shadow-sm' : 'text-ink-secondary hover:text-ink-primary'}`}
              >
                {t('account.tabCustomer')}
              </button>
              <button
                onClick={() => { setLoginTab('team'); setError('') }}
                className={`flex-1 py-2 rounded-xl text-sm font-semibold transition-colors ${loginTab === 'team' ? 'bg-white text-ink-primary shadow-sm' : 'text-ink-secondary hover:text-ink-primary'}`}
              >
                {t('account.tabTeam')}
              </button>
            </div>

            {loginTab === 'customer' && (
              <form onSubmit={handleSendCode} autoComplete="on" className="space-y-3">
                <div>
                  <label className="block text-xs text-ink-secondary mb-1">{t('account.phoneLbl')}</label>
                  <PhoneInput
                    value={phone}
                    onChange={(full) => setPhone(full)}
                    autoComplete="tel"
                    name="phone"
                    wrapperClassName="rounded-2xl"
                  />
                  <p className="text-xs text-ink-tertiary mt-1">{t('account.whatsappHint')}</p>
                </div>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} className="w-4 h-4 rounded accent-brand" />
                  <span className="text-sm text-ink-secondary">{t('account.rememberMe')}</span>
                </label>
                {error && <p className="text-xs text-danger">{error}</p>}
                <button
                  type="submit"
                  disabled={sending || !phone.trim()}
                  className="w-full bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white py-3.5 rounded-2xl font-bold text-sm transition-colors"
                >
                  {sending ? t('account.sending') : t('account.sendOtp')}
                </button>
              </form>
            )}

            {loginTab === 'team' && (
              <form onSubmit={handleAdminLogin} autoComplete="on" className="space-y-3">
                <div>
                  <label className="block text-xs text-ink-secondary mb-1">{t('account.emailLbl')}</label>
                  <input
                    type="email" name="email" autoComplete="email"
                    value={email} onChange={e => setEmail(e.target.value)}
                    placeholder={t('account.emailPh')}
                    className="w-full border border-divider rounded-2xl px-4 py-3 text-sm outline-none focus:border-brand"
                  />
                </div>
                <div>
                  <label className="block text-xs text-ink-secondary mb-1">{t('account.passwordLbl')}</label>
                  <input
                    type="password" name="password" autoComplete="current-password"
                    value={password} onChange={e => setPassword(e.target.value)}
                    placeholder={t('account.passwordPh')}
                    className="w-full border border-divider rounded-2xl px-4 py-3 text-sm outline-none focus:border-brand"
                  />
                </div>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} className="w-4 h-4 rounded accent-brand" />
                  <span className="text-sm text-ink-secondary">{t('account.rememberMe')}</span>
                </label>
                {error && <p className="text-xs text-danger">{error}</p>}
                <button
                  type="submit"
                  disabled={loggingIn || !email.trim() || !password.trim()}
                  className="w-full bg-ink-primary hover:bg-ink-secondary disabled:bg-ink-tertiary text-white py-3.5 rounded-2xl font-bold text-sm transition-colors"
                >
                  {loggingIn ? t('account.loggingIn') : t('account.loginBtn')}
                </button>
              </form>
            )}
          </div>
        )}

        {/* ── Register ── */}
        {step === 'register' && (
          <div className="max-w-md mx-auto bg-white rounded-3xl shadow-sm p-6">
            <div className="text-center mb-6">
              <div className="text-5xl mb-3">🎉</div>
              <h1 className="text-xl font-bold text-ink-primary">{t('account.setupBtn')}</h1>
              <p className="text-sm text-brand-darker font-medium mt-1">{t('account.setupSub')}</p>
            </div>
            <form onSubmit={handleRegisterSubmit} className="space-y-3">
              <div>
                <label className="block text-xs text-ink-secondary mb-1">{t('account.nameLbl')}</label>
                <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder={t('account.namePh')}
                  className="w-full border border-divider rounded-2xl px-4 py-3 text-sm outline-none focus:border-brand" />
              </div>
              <div>
                <label className="block text-xs text-ink-secondary mb-1">{bi('Ville', 'City')}</label>
                <select value={city} onChange={e => setCity(e.target.value)}
                  className="w-full border border-divider rounded-2xl px-4 py-3 text-sm outline-none focus:border-brand bg-white">
                  <option value="">{bi('Choisir', 'Select…')}</option>
                  <option value="Yaoundé">Yaoundé</option>
                  <option value="Abidjan">Abidjan</option>
                  <option value="Dakar">Dakar</option>
                  <option value="Lomé">Lomé</option>
                </select>
              </div>
              {error && <p className="text-xs text-danger">{error}</p>}
              <button type="submit" disabled={sending || !name.trim() || !city}
                className="w-full bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white py-3.5 rounded-2xl font-bold text-sm transition-colors">
                {sending ? t('account.sending') : t('account.sendOtp')}
              </button>
              <button type="button" onClick={() => { setStep('login'); setError('') }}
                className="w-full text-ink-tertiary text-sm py-2 hover:text-ink-secondary transition-colors">
                {t('account.changePhone')}
              </button>
            </form>
          </div>
        )}

        {/* ── OTP ── */}
        {step === 'otp' && (
          <div className="max-w-md mx-auto bg-white rounded-3xl shadow-sm p-6">
            <div className="text-center mb-6">
              <div className="text-5xl mb-3">💬</div>
              <h1 className="text-xl font-bold text-ink-primary">{t('account.otpLbl')}</h1>
              {knownName && (
                <p className="text-sm text-ink-primary font-semibold mt-1">👋 {knownName}</p>
              )}
              <p className="text-sm text-ink-secondary mt-1">{phone}</p>
              <p className="text-xs text-brand-darker font-medium mt-1">{t('account.checkWhatsApp')}</p>
            </div>
            <input
              type="text" inputMode="numeric"
              value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="1234"
              className="w-full border border-divider rounded-2xl px-4 py-3 text-sm outline-none focus:border-brand text-center tracking-[0.5em] font-mono text-xl mb-3"
            />
            {error && <p className="text-xs text-danger mb-3">{error}</p>}
            <button onClick={verifyOtp} disabled={verifying || otp.length < 4}
              className="w-full bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white py-3.5 rounded-2xl font-bold text-sm transition-colors mb-3">
              {verifying ? t('account.verifying') : t('account.verify')}
            </button>
            {(() => {
              const hitLimit = resendCount >= 3
              const disabled = resending || resendCooldown > 0 || hitLimit
              const label = hitLimit
                ? bi('Limite atteinte', 'Limit reached')
                : resendCooldown > 0
                  ? bi(`Renvoyer dans ${resendCooldown}s`, `Resend in ${resendCooldown}s`)
                  : resending
                    ? bi('Envoi…', 'Sending…')
                    : bi('Renvoyer le code', 'Resend code')
              return (
                <button
                  type="button"
                  onClick={handleResendCode}
                  disabled={disabled}
                  className="w-full text-brand-darker hover:text-brand-dark disabled:text-ink-tertiary disabled:cursor-not-allowed text-sm font-semibold py-2 transition-colors"
                >
                  {label}
                </button>
              )
            })()}
            <button onClick={() => { setStep('login'); setOtp(''); setError(''); setResendCooldown(0); setResendCount(0) }}
              className="w-full text-ink-tertiary text-sm py-2 hover:text-ink-secondary transition-colors">
              {t('account.changePhone')}
            </button>
          </div>
        )}

        {/* ── Dashboard ── */}
        {step === 'dashboard' && user && (
          <div>
            {/* Mode switcher previously lived in a banner at the very top
                of this view; it now only renders inside the Profile tab
                (see ModeToggle further down) so it stops competing with
                the main content for attention. */}

            {/* Header */}
            <div className="flex items-center justify-between mb-6">
              <div>
                <p className="text-xs text-ink-tertiary">{t('account.hello')}</p>
                <p className="font-bold text-ink-primary text-lg">
                  {dashView === 'admin' ? `🔐 ${user.name}` : user.name}
                  {dashView === 'admin' && <span className="ml-2 text-xs text-ink-tertiary font-normal">({user.role.replace('_', ' ')})</span>}
                </p>
              </div>
              <button onClick={handleSignOut}
                className="text-xs text-ink-tertiary hover:text-danger transition-colors px-3 py-1.5 rounded-xl hover:bg-brand-light">
                {t('account.signOut')}
              </button>
            </div>

            {/* ══════════════════════════════════════════════════════════
                ADMIN DASHBOARD
               ══════════════════════════════════════════════════════════ */}
            {dashView === 'admin' && (() => {
              const allAdminTabs: AdminSubTab[] = ['restaurants', 'orders', 'events', 'broadcasts', 'promotions', 'vouchers', 'reports', 'accounts', 'platformteam', 'profile']
              const visibleTabs = allAdminTabs.filter(adminCan)
              if (typeof window !== 'undefined') {
                console.log('[admin-tabs] user.role =', user.role, '| visible =', visibleTabs, '| profile visible?', visibleTabs.includes('profile'))
              }
              return (
              <div>
                <div className="flex flex-wrap gap-2 mb-5">
                  {visibleTabs
                    .map(sub => (
                      <button key={sub}
                        onClick={() => setAdminSubTab(sub)}
                        className={`px-4 py-2 rounded-xl text-sm font-semibold whitespace-nowrap transition-colors ${
                          adminSubTab === sub ? 'bg-ink-primary text-white' : 'bg-white text-ink-secondary shadow-sm hover:text-ink-primary'
                        }`}
                      >
                        {pickBi(ADMIN_TAB_LABELS[sub], locale)}
                      </button>
                    ))}
                </div>
                {adminSubTab === 'restaurants'  && <AdminRestaurants />}
                {adminSubTab === 'orders'       && <AdminOrders />}
                {adminSubTab === 'events'       && <AdminEvents />}
                {adminSubTab === 'broadcasts'   && <AdminBroadcasts />}
                {adminSubTab === 'promotions'   && <AdminPromotions />}
                {adminSubTab === 'vouchers'     && <AdminVouchers />}
                {adminSubTab === 'reports'      && <AdminReports />}
                {adminSubTab === 'accounts'     && <AdminAccounts />}
                {adminSubTab === 'platformteam' && <AdminPlatformTeam />}
                {adminSubTab === 'profile'      && <AdminProfilePanel />}
              </div>
              )
            })()}

            {/* ══════════════════════════════════════════════════════════
                CUSTOMER / VENDOR DASHBOARD
               ══════════════════════════════════════════════════════════ */}
            {dashView === 'customer' && (
              <>
                {welcomeVoucherCode && (
                  <div className="bg-brand-light border border-brand-badge/40 rounded-2xl p-4 mb-4 flex items-start gap-3">
                    <span className="text-2xl">🎉</span>
                    <div className="flex-1 text-sm">
                      <p className="font-bold text-brand-darker">
                        {bi(
                          `Bienvenue! Code ${welcomeVoucherCode} ajouté — 10% sur votre première commande!`,
                          `Welcome! Code ${welcomeVoucherCode} added — 10% off your first order!`,
                        )}
                      </p>
                      <p className="text-xs text-brand-dark mt-1">
                        {bi(
                          'Retrouvez-le dans l\'onglet Bons.',
                          'Find it in the Vouchers tab.',
                        )}
                      </p>
                    </div>
                    <button
                      onClick={() => setWelcomeVoucherCode(null)}
                      aria-label="Close"
                      className="text-brand-darker hover:text-ink-primary text-lg leading-none"
                    >
                      ✕
                    </button>
                  </div>
                )}
                {/* Tab bar — Orders + Vouchers up front (the customer
                    surfaces the user lands on from BottomNav 📦 / 🎫
                    deep-links), Profile last, then optional Restaurant /
                    Team for vendors. Mobile shows 3 per row (basis-1/3
                    in TabBtn); sm+ collapses to a single row. */}
                <div className="flex flex-wrap bg-white rounded-2xl p-1 shadow-sm mb-5 gap-1">
                  <TabBtn icon="📦" label={t('account.ordersTab')}   active={customerTab === 'orders'}   onClick={() => setCustomerTab('orders')} />
                  <TabBtn icon="🎫" label={t('account.vouchersTab')} active={customerTab === 'vouchers'} onClick={() => setCustomerTab('vouchers')} />
                  {/* Show the organizer tab when the user has any events OR has
                     ever submitted one — a submitted-but-not-yet-returned event
                     (pending approval, transient fetch hiccup) must not make the
                     tab vanish, else the organizer loses their only way in. */}
                  {(myEvents.length > 0 || (organizerTrust?.events_submitted_count ?? 0) > 0) && (
                    <TabBtn icon="🎉" label={bi('Mes événements', 'My events')} active={customerTab === 'events'} onClick={() => setCustomerTab('events')} />
                  )}
                  <TabBtn icon="👤" label={t('account.profileTab')}  active={customerTab === 'profile'}  onClick={() => setCustomerTab('profile')} />
                  {myRestaurants.length > 0 && (
                    <TabBtn icon="🏪" label={t('account.restaurantTab')} active={customerTab === 'restaurant'} onClick={() => setCustomerTab('restaurant')} />
                  )}
                  {myRestaurants.length > 0 && activeRest?.teamRole === 'owner' && (
                    <TabBtn icon="👥" label={t('account.teamTab')} active={customerTab === 'team'} onClick={() => setCustomerTab('team')} />
                  )}
                </div>

                {/* Vouchers */}
                {customerTab === 'vouchers' && (
                  <>
                    <VoucherClaimForm
                      onClaimed={() => user && loadCustomerData(user.id)}
                    />
                    {loadingData && <div className="text-center py-12"><div className="text-3xl animate-pulse text-ink-tertiary">…</div></div>}
                    {!loadingData && (
                      <div className="space-y-3">
                        {customerVouchers.length === 0 ? (
                          <div className="text-center py-12">
                            <div className="text-4xl mb-3">🏷️</div>
                            <p className="text-ink-tertiary text-sm">{t('account.noVouchers')}</p>
                          </div>
                        ) : customerVouchers.map(cv => cv.vouchers && (
                          <VoucherCard key={cv.id} voucher={cv.vouchers} customerVoucherId={cv.id} usedAt={cv.used_at} />
                        ))}
                      </div>
                    )}
                  </>
                )}

                {/* Orders */}
                {customerTab === 'orders' && (
                  <>
                    {loadingData && <div className="text-center py-12"><div className="text-3xl animate-pulse text-ink-tertiary">…</div></div>}
                    {!loadingData && (
                      <div className="space-y-6">
                        {eventReservations.length > 0 && (
                          <section>
                            <h3 className="text-sm font-bold text-ink-primary mb-2">
                              🎟 {bi('Mes réservations', 'My reservations')}
                            </h3>
                            <div className="space-y-3">
                              {eventReservations.map(r => (
                                <EventReservationCard
                                  key={r.id}
                                  reservation={r}
                                  onCancelled={() => user && loadCustomerData(user.id)}
                                />
                              ))}
                            </div>
                          </section>
                        )}

                        <section>
                          {eventReservations.length > 0 && (
                            <h3 className="text-sm font-bold text-ink-primary mb-2">
                              📦 {bi('Mes commandes', 'My orders')}
                            </h3>
                          )}
                          {orders.length === 0 && eventReservations.length === 0 ? (
                            <div className="text-center py-12">
                              <div className="text-4xl mb-3">📋</div>
                              <p className="text-ink-tertiary text-sm">{t('account.noOrders')}</p>
                              <Link href="/" className="mt-4 inline-block text-brand text-sm font-semibold underline">
                                Explorer les restaurants
                              </Link>
                            </div>
                          ) : orders.length === 0 ? null : (
                            <div className="space-y-3">
                              {orders.map(order => (
                                <OrderCard key={order.id} order={order} orderAtLabel={t('account.orderAt')} />
                              ))}
                            </div>
                          )}
                        </section>
                      </div>
                    )}
                  </>
                )}

                {/* My events — organizer dashboard. Hidden in the tab bar
                    when myEvents is empty, but the panel still renders if
                    someone deep-links to ?tab=events. */}
                {customerTab === 'events' && (
                  <MyEventsPanel events={myEvents} trust={organizerTrust} onChanged={() => user && loadCustomerData(user.id)} />
                )}

                {/* Profile */}
                {customerTab === 'profile' && (
                  <div className="bg-white rounded-2xl shadow-sm p-6 space-y-5">
                    <div className="flex items-start justify-between gap-4 flex-wrap">
                      <h2 className="font-bold text-ink-primary">👤 {t('account.profileTab')}</h2>
                      {profile && !profile.deleted_at && (
                        profileEditing ? (
                          <div className="flex gap-2">
                            <button
                              onClick={handleSaveProfile}
                              disabled={savingProfile}
                              className="bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white text-sm font-semibold px-3 py-1.5 rounded-xl transition-colors"
                            >
                              {savingProfile ? '…' : bi('Enregistrer', 'Save')}
                            </button>
                            <button
                              onClick={() => {
                                setProfileEditing(false)
                                setProfileName(profile.name ?? '')
                                setProfileCity(profile.city ?? '')
                              }}
                              className="bg-surface-muted hover:bg-divider text-ink-primary text-sm font-semibold px-3 py-1.5 rounded-xl transition-colors"
                            >
                              {bi('Annuler', 'Cancel')}
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setProfileEditing(true)}
                            className="bg-surface-muted hover:bg-divider text-ink-primary text-sm font-semibold px-3 py-1.5 rounded-xl transition-colors"
                          >
                            ✏️ {bi('Modifier', 'Edit')}
                          </button>
                        )
                      )}
                    </div>

                    {/* Fields */}
                    {profile ? (
                      <div className="space-y-4">
                        {/* Status + role badges */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <StatusBadge status={profile.deleted_at ? 'deleted' : profile.status} />
                          <ProfileRoleBadges restaurants={myRestaurants} />
                        </div>

                        {/* Name */}
                        <div>
                          <label className="block text-xs text-ink-tertiary mb-1">{bi('Nom', 'Name')}</label>
                          {profileEditing ? (
                            <input
                              value={profileName}
                              onChange={e => setProfileName(e.target.value)}
                              className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand"
                            />
                          ) : (
                            <p className="font-semibold text-ink-primary">{profile.name || '—'}</p>
                          )}
                        </div>

                        {/* Phone — read-only */}
                        <div>
                          <label className="block text-xs text-ink-tertiary mb-1">
                            {bi('Téléphone', 'Phone')} <span className="text-ink-tertiary">· {bi('non modifiable', 'not editable')}</span>
                          </label>
                          <p className="font-semibold text-ink-primary font-mono">{profile.phone}</p>
                        </div>

                        {/* City */}
                        <div>
                          <label className="block text-xs text-ink-tertiary mb-1">{bi('Ville', 'City')}</label>
                          {profileEditing ? (
                            <select
                              value={profileCity}
                              onChange={e => setProfileCity(e.target.value)}
                              className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand bg-white"
                            >
                              <option value="">—</option>
                              {PROFILE_CITIES.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                          ) : (
                            <p className="font-semibold text-ink-primary">{profile.city || '—'}</p>
                          )}
                        </div>

                        {/* Nickname — used to sign event comments. Has its
                            own save button (separate API + cooldown) so the
                            user can change it without re-saving the rest of
                            the profile. */}
                        <NicknameRow
                          profile={profile}
                          value={profileNickname}
                          onChange={setProfileNickname}
                          saving={savingNickname}
                          onSave={async () => {
                            setSavingNickname(true)
                            try {
                              const res = await fetch('/api/auth/nickname', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ nickname: profileNickname }),
                              })
                              const d = await res.json()
                              if (!res.ok) {
                                showToast(d?.error ?? bi('Erreur', 'Error'), false)
                                return
                              }
                              showToast(bi('Pseudo enregistré', 'Nickname saved'))
                              if (user) loadProfile()
                            } finally {
                              setSavingNickname(false)
                            }
                          }}
                        />

                        {/* Member since */}
                        <div>
                          <label className="block text-xs text-ink-tertiary mb-1">{bi('Membre depuis', 'Member since')}</label>
                          <p className="text-ink-primary text-sm">
                            {new Date(profile.created_at).toLocaleDateString('fr-FR', {
                              day: 'numeric', month: 'long', year: 'numeric',
                            })}
                          </p>
                        </div>

                        {/* Language toggle — lives here now instead of in TopNav. */}
                        <div>
                          <label className="block text-xs text-ink-tertiary mb-2">{bi('Langue', 'Language')}</label>
                          <LanguageToggle />
                        </div>

                        {/* Mode toggle — the single entry point for the
                            Client ⇄ Restaurant switch, now that the header
                            banner has been retired. Uses the "banner"
                            variant so the switch + its explanatory copy
                            stay findable inside the profile tab. Returns
                            null for users with no team role. */}
                        <ModeToggle variant="banner" />

                        {/* Low-data mode — saves ~90% of bandwidth on
                            image-heavy pages by replacing photos with
                            colored gradients. Lives in localStorage; no
                            DB write yet (profile sync is in the backlog). */}
                        <LowDataToggle />

                        {/* Event notifications */}
                        <div className="pt-2">
                          <NotificationsPanel />
                        </div>

                        {/* Paid broadcasts (only renders for eligible accounts) */}
                        <div className="pt-2">
                          <BroadcastPanel />
                        </div>

                        {/* Paid promotions (only renders for eligible accounts) */}
                        <div className="pt-2">
                          <PromotePanel />
                        </div>

                        {/* Suspension info */}
                        {profile.status === 'suspended' && profile.suspended_by && (
                          <div className="bg-surface-muted border border-divider rounded-xl p-3 text-sm text-warning">
                            Suspendu par <span className="font-semibold">{profile.suspended_by}</span>
                            {profile.suspended_at && ` · ${new Date(profile.suspended_at).toLocaleDateString('fr-FR')}`}
                            {profile.suspension_reason && (
                              <div className="text-xs mt-1">&quot;{profile.suspension_reason}&quot;</div>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-ink-tertiary">{bi('Chargement…', 'Loading…')}</p>
                    )}

                    {/* Vendor shortcuts — Team and Settings used to live on
                        the restaurant BottomNav but were moved here to keep
                        the bar at 4 tabs. Owners see both; managers/staff
                        only see Settings (their team view is read-only). */}
                    {myRestaurants.length > 0 && (
                      <div className="pt-4 border-t border-divider space-y-2">
                        <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-2">
                          {bi('Gestion du restaurant', 'Restaurant management')}
                        </p>
                        {activeRest?.teamRole === 'owner' && (
                          <button
                            onClick={() => setCustomerTab('team')}
                            className="w-full bg-surface-muted hover:bg-brand-light rounded-xl px-4 py-3 flex items-center justify-between gap-3 transition-colors text-left"
                          >
                            <span className="flex items-center gap-2 text-sm font-semibold text-ink-primary">
                              <span aria-hidden="true">👥</span>
                              {bi("Gérer l'équipe", 'Manage team')}
                            </span>
                            <span className="text-ink-tertiary">→</span>
                          </button>
                        )}
                        <button
                          onClick={() => setCustomerTab('restaurant')}
                          className="w-full bg-surface-muted hover:bg-brand-light rounded-xl px-4 py-3 flex items-center justify-between gap-3 transition-colors text-left"
                        >
                          <span className="flex items-center gap-2 text-sm font-semibold text-ink-primary">
                            <span aria-hidden="true">⚙️</span>
                            {bi('Paramètres restaurant', 'Restaurant settings')}
                          </span>
                          <span className="text-ink-tertiary">→</span>
                        </button>
                      </div>
                    )}

                    {/* Restaurant summary */}
                    {myRestaurants.length > 0 && (
                      <div className="pt-4 border-t border-divider">
                        <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-3">
                          {bi(`Mes restaurants (${myRestaurants.length})`, `My restaurants (${myRestaurants.length})`)}
                        </p>
                        <div className="space-y-2">
                          {myRestaurants.map(r => (
                            <button
                              key={r.id}
                              onClick={() => { setActiveRestId(r.id); setCustomerTab('restaurant') }}
                              className="w-full bg-surface-muted hover:bg-brand-light rounded-xl px-3 py-2.5 flex items-center justify-between gap-3 transition-colors text-left"
                            >
                              <div className="min-w-0">
                                <p className="font-semibold text-sm text-ink-primary truncate">{r.name}</p>
                                <p className="text-xs text-ink-secondary">{r.city}{r.neighborhood ? ` · ${r.neighborhood}` : ''}</p>
                              </div>
                              <StatusBadge status={r.deleted_at ? 'deleted' : r.status} />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Register a new restaurant via WhatsApp */}
                    {!accountDeletedAt && myRestaurants.length === 0 && (
                      <div className="pt-4 border-t border-divider">
                        <p className="text-xs text-ink-tertiary mb-3">{bi('Inscrire un restaurant', 'Register a restaurant')}</p>
                        <a href="https://wa.me/your-number?text=restaurant" target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 bg-brand hover:bg-brand-dark text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors">
                          🏪 {t('account.registerRest')} via WhatsApp
                        </a>
                      </div>
                    )}

                    {/* Account deletion */}
                    <div className="pt-4 border-t border-divider">
                      {accountDeletedAt ? (
                        <div className="space-y-3">
                          <div className="bg-surface-muted border border-divider rounded-xl p-3 text-sm text-warning">
                            ⚠️ Votre compte est en cours de suppression. Les données seront effacées après 30 jours.<br/>
                            Your account is pending deletion. Data will be erased after 30 days.
                          </div>
                          <button
                            onClick={handleUndoDeleteAccount}
                            className="bg-brand hover:bg-brand-dark text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
                          >
                            ↩️ {bi('Annuler la suppression', 'Undo deletion')}
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setVendorModal('delete-account')}
                          className="text-sm text-danger hover:text-danger font-medium hover:bg-brand-light px-3 py-2 rounded-xl transition-colors"
                        >
                          🗑️ {bi('Supprimer mon compte', 'Delete my account')}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Restaurant settings */}
                {customerTab === 'restaurant' && (
                  <div>
                    {/* Multi-restaurant selector */}
                    {myRestaurants.length > 1 && (
                      <div className="mb-4">
                        <label className="block text-xs text-ink-secondary mb-1.5">{t('account.selectRest')}</label>
                        <select
                          value={activeRestId}
                          onChange={e => setActiveRestId(e.target.value)}
                          className="w-full border border-divider rounded-xl px-4 py-2.5 text-sm outline-none focus:border-brand bg-white"
                        >
                          {myRestaurants.map(r => (
                            <option key={r.id} value={r.id}>{r.name} — {r.city}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    {activeRest && !activeRest.deleted_at && activeRest.status !== 'pending' && (
                      <Link
                        href="/dashboard"
                        className="block bg-brand hover:bg-brand-dark text-white rounded-2xl shadow-sm px-5 py-4 mb-4 transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          <div className="text-3xl">📦</div>
                          <div className="flex-1 min-w-0">
                            <p className="font-bold text-sm">{bi('Tableau de bord', 'Restaurant Dashboard')}</p>
                            <p className="text-xs text-white/80 mt-0.5">
                              {bi('Gérer commandes, menu et bons', 'Manage orders, menu and vouchers')}
                            </p>
                          </div>
                          <span className="text-xl">→</span>
                        </div>
                      </Link>
                    )}

                    {activeRest && (
                      <div className="bg-white rounded-2xl shadow-sm p-6">
                        <div className="flex items-start gap-4 mb-4">
                          {/* Photo */}
                          <div className="relative w-20 h-20 rounded-2xl overflow-hidden flex-shrink-0 bg-brand-light">
                            {activeRest.image_url ? (
                              <Image src={activeRest.image_url} alt={activeRest.name} fill sizes="80px" className="object-cover" />
                            ) : (
                              <span className="absolute inset-0 flex items-center justify-center text-3xl">🏪</span>
                            )}
                            {activeRest.teamRole === 'owner' && !activeRest.deleted_at && (
                              <label className="absolute inset-0 bg-black/50 text-white text-[10px] font-semibold flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity cursor-pointer">
                                {uploadingPhoto ? '…' : '📷 Changer'}
                                <input type="file" accept="image/*" className="hidden"
                                  disabled={uploadingPhoto}
                                  onChange={handleRestaurantPhotoUpload} />
                              </label>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2 flex-wrap">
                              <div>
                                <h2 className="font-bold text-ink-primary text-lg">{activeRest.name}</h2>
                                <p className="text-sm text-ink-secondary">{activeRest.city}{activeRest.neighborhood ? ` · ${activeRest.neighborhood}` : ''}</p>
                                <p className="text-xs text-ink-tertiary mt-0.5">{activeRest.cuisine_type} · Rôle: {activeRest.teamRole}</p>
                              </div>
                              <StatusBadge status={activeRest.deleted_at ? 'deleted' : activeRest.status} />
                            </div>
                          </div>
                        </div>

                        {/* Banners */}
                        {activeRest.deleted_at && (
                          <div className="bg-brand-light border border-divider rounded-xl p-3 mb-4 text-sm text-danger">
                            🗑️ {t('account.deletedBanner')}
                          </div>
                        )}
                        {!activeRest.deleted_at && activeRest.status === 'suspended' && (
                          <div className="bg-surface-muted border border-divider rounded-xl p-3 mb-4 text-sm text-warning">
                            ⏸️ {t('account.suspendedBanner')}
                            {activeRest.suspended_by === 'admin' && ' — contactez le support / contact support'}
                          </div>
                        )}

                        {/* Restaurant page link */}
                        <a href={`/restaurant/${activeRest.id}`} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-sm text-brand hover:text-brand-dark font-semibold mb-5">
                          ↗ {bi('Voir la page', 'View page')}
                        </a>

                        {/* Actions (owner only) */}
                        {activeRest.teamRole === 'owner' && (
                          <div className="border-t border-divider pt-4 space-y-3">
                            <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">{bi('Paramètres', 'Settings')}</p>

                            <div className="flex gap-3 flex-wrap">
                              {activeRest.deleted_at ? (
                                <button
                                  onClick={() => handleRestaurantAction('undo-delete')}
                                  disabled={restActionLoading === 'undo-delete'}
                                  className="bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
                                >
                                  {restActionLoading === 'undo-delete' ? '…' : `↩️ ${t('account.undoDelete')}`}
                                </button>
                              ) : (
                                <>
                                  {activeRest.status !== 'suspended' ? (
                                    <button
                                      onClick={() => { setModalReason(''); setVendorModal('suspend-rest') }}
                                      className="bg-surface-muted hover:bg-brand-light text-warning border border-divider px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
                                    >
                                      ⏸️ {t('account.suspend')}
                                    </button>
                                  ) : (
                                    activeRest.suspended_by === 'vendor' ? (
                                      <button
                                        onClick={() => handleRestaurantAction('reactivate')}
                                        disabled={restActionLoading === 'reactivate'}
                                        className="bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
                                      >
                                        {restActionLoading === 'reactivate' ? '…' : `✅ ${t('account.reactivate')}`}
                                      </button>
                                    ) : (
                                      <p className="text-xs text-warning py-1">{bi('Suspendu par l&apos;administration — contactez le support', 'Suspended by admin — contact support')}</p>
                                    )
                                  )}
                                  <button
                                    onClick={() => setVendorModal('delete-rest')}
                                    disabled={restActionLoading === 'delete'}
                                    className="bg-brand-light hover:bg-brand-light text-danger border border-divider px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
                                  >
                                    {restActionLoading === 'delete' ? '…' : `🗑️ ${t('account.delete')}`}
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Team management */}
                {customerTab === 'team' && activeRest?.teamRole === 'owner' && (
                  <div className="bg-white rounded-2xl shadow-sm p-6">
                    <h2 className="font-bold text-ink-primary mb-4">👥 {t('account.teamTitle')} — {activeRest.name}</h2>

                    {/* Add member form */}
                    <form onSubmit={handleAddTeamMember} className="flex gap-2 mb-5 flex-wrap">
                      <div className="flex-1 min-w-[180px]">
                        <PhoneInput
                          value={teamPhone}
                          onChange={(full) => setTeamPhone(full)}
                          autoComplete="off"
                        />
                      </div>
                      <select value={teamRole} onChange={e => setTeamRole(e.target.value)}
                        className="border border-divider rounded-xl px-3 py-2.5 text-sm outline-none focus:border-brand bg-white">
                        <option value="manager">{t('account.roleManager')}</option>
                        <option value="staff">{t('account.roleStaff')}</option>
                      </select>
                      <button type="submit" disabled={addingMember || !teamPhone.trim()}
                        className="bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors">
                        {addingMember ? '…' : t('account.addMember')}
                      </button>
                    </form>
                    {teamError && <p className="text-xs text-danger mb-3">{teamError}</p>}

                    {/* Team list */}
                    {loadingTeam ? (
                      <div className="text-center py-8 text-ink-tertiary">Chargement…</div>
                    ) : (
                      <div className="space-y-2">
                        {teamMembers.map(m => (
                          <div key={m.id} className="flex items-center justify-between py-2.5 border-b border-divider last:border-0 gap-2 flex-wrap">
                            <div className="flex-1 min-w-0">
                              <p className="font-semibold text-sm text-ink-primary">{m.customers.name}</p>
                              <p className="text-xs text-ink-tertiary font-mono">{m.customers.phone}</p>
                              {m.added_at && (
                                <p className="text-[11px] text-ink-tertiary mt-0.5">
                                  Ajouté le {new Date(m.added_at).toLocaleDateString('fr-FR')}
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              {m.role === 'owner' ? (
                                <span className="text-xs font-medium px-2 py-1 rounded-full bg-brand-light text-brand-darker">
                                  {bi('Propriétaire', 'Owner')}
                                </span>
                              ) : (
                                <select
                                  value={m.role}
                                  onChange={e => handleChangeRole(m.id, e.target.value)}
                                  className="text-xs border border-divider rounded-lg px-2 py-1 outline-none focus:border-brand bg-white"
                                >
                                  <option value="manager">{t('account.roleManager')}</option>
                                  <option value="staff">{t('account.roleStaff')}</option>
                                </select>
                              )}
                              {m.role !== 'owner' && (
                                <button
                                  onClick={() => handleRemoveTeamMember(m.id)}
                                  className="text-xs text-danger hover:text-danger font-medium px-2 py-1 hover:bg-brand-light rounded-lg transition-colors"
                                >
                                  {t('account.removeMember')}
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                        {teamMembers.length === 0 && <p className="text-ink-tertiary text-sm text-center py-4">{bi('Équipe vide', 'Empty team')}</p>}
                      </div>
                    )}

                    {/* Pending invitations — users who received a WhatsApp
                        invite but haven't replied yet. Owner can cancel. */}
                    <div className="mt-6 pt-5 border-t border-divider">
                      <h3 className="font-bold text-ink-primary mb-3 text-sm">
                        📨 {bi('Invitations en attente', 'Pending invitations')}
                        {pendingInvitations.length > 0 && (
                          <span className="ml-2 text-xs font-medium text-ink-tertiary">
                            ({pendingInvitations.length})
                          </span>
                        )}
                      </h3>
                      {loadingInvitations ? (
                        <div className="text-center py-4 text-ink-tertiary text-sm">Chargement…</div>
                      ) : pendingInvitations.length === 0 ? (
                        <p className="text-ink-tertiary text-sm text-center py-3">
                          {bi('Aucune invitation en attente', 'No pending invitations')}
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {pendingInvitations.map(inv => {
                            const created = new Date(inv.created_at)
                            const expires = new Date(inv.expires_at)
                            const now     = new Date()
                            const daysAgo = Math.max(0, Math.floor((now.getTime() - created.getTime()) / 86_400_000))
                            const daysLeft = Math.max(0, Math.ceil((expires.getTime() - now.getTime()) / 86_400_000))
                            const expired = daysLeft === 0
                            return (
                              <div key={inv.id} className="flex items-center justify-between py-2.5 border-b border-divider last:border-0 gap-2 flex-wrap">
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-semibold text-ink-primary font-mono truncate">{inv.phone}</p>
                                  <p className="text-xs text-ink-tertiary">
                                    <span className="capitalize">{inv.role}</span>
                                    {' · '}
                                    {bi(`envoyée il y a ${daysAgo}j`, `sent ${daysAgo}d ago`)}
                                    {' · '}
                                    {expired
                                      ? bi('expirée', 'expired')
                                      : bi(`expire dans ${daysLeft}j`, `expires in ${daysLeft}d`)}
                                  </p>
                                </div>
                                <button
                                  onClick={() => handleCancelInvitation(inv.id)}
                                  disabled={cancellingInvId === inv.id}
                                  className="text-xs text-danger hover:text-danger font-medium px-2 py-1 hover:bg-brand-light rounded-lg transition-colors"
                                >
                                  {cancellingInvId === inv.id ? '…' : bi('Annuler', 'Cancel')}
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* ── Vendor modals ── */}

            {/* Suspend restaurant */}
            {vendorModal === 'suspend-rest' && activeRest && (
              <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl">
                  <h3 className="font-bold text-ink-primary mb-1">{bi('⏸️ Suspendre le restaurant', 'Suspend restaurant')}</h3>
                  <p className="text-sm text-ink-secondary mb-3">{activeRest.name}</p>
                  <textarea
                    value={modalReason}
                    onChange={e => setModalReason(e.target.value)}
                    placeholder={bi('Raison (optionnel)', 'Reason (optional)')}
                    rows={3}
                    className="w-full border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand mb-4"
                  />
                  <div className="flex gap-3">
                    <button
                      onClick={() => handleRestaurantAction('suspend')}
                      disabled={restActionLoading === 'suspend'}
                      className="flex-1 bg-warning hover:bg-warning/90 disabled:bg-warning/50 text-white py-2.5 rounded-xl font-semibold text-sm transition-colors"
                    >
                      {restActionLoading === 'suspend' ? '…' : bi('Suspendre', 'Suspend')}
                    </button>
                    <button onClick={() => setVendorModal(null)}
                      className="flex-1 bg-surface-muted text-ink-primary py-2.5 rounded-xl font-semibold text-sm hover:bg-divider transition-colors">
                      {bi('Annuler', 'Cancel')}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Delete restaurant */}
            {vendorModal === 'delete-rest' && activeRest && (
              <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl">
                  <h3 className="font-bold text-ink-primary mb-1">{bi('🗑️ Supprimer le restaurant', 'Delete restaurant')}</h3>
                  <p className="text-sm text-ink-secondary mb-3">{activeRest.name}</p>
                  <p className="text-sm text-ink-secondary mb-4 bg-surface-muted border border-divider rounded-xl p-3">
                    ⚠️ Les données seront supprimées après 30 jours. Vous pouvez annuler dans ce délai.<br/><br/>
                    Data will be deleted after 30 days. You can undo within that period.
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={() => handleRestaurantAction('delete')}
                      disabled={restActionLoading === 'delete'}
                      className="flex-1 bg-danger hover:bg-danger disabled:bg-danger/50 text-white py-2.5 rounded-xl font-semibold text-sm transition-colors"
                    >
                      {restActionLoading === 'delete' ? '…' : bi('Supprimer', 'Delete')}
                    </button>
                    <button onClick={() => setVendorModal(null)}
                      className="flex-1 bg-surface-muted text-ink-primary py-2.5 rounded-xl font-semibold text-sm hover:bg-divider transition-colors">
                      {bi('Annuler', 'Cancel')}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Delete account */}
            {vendorModal === 'delete-account' && (
              <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl">
                  <h3 className="font-bold text-ink-primary mb-1">{bi('🗑️ Supprimer mon compte', 'Delete my account')}</h3>
                  <p className="text-sm text-ink-secondary mb-4 bg-brand-light border border-divider rounded-xl p-3">
                    ⚠️ Votre compte et tous vos restaurants seront supprimés après 30 jours. Vous pourrez annuler dans ce délai.<br/><br/>
                    Your account and all your restaurants will be deleted after 30 days. You can undo within that period.
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={handleDeleteAccount}
                      className="flex-1 bg-danger hover:bg-danger text-white py-2.5 rounded-xl font-semibold text-sm transition-colors"
                    >
                      {bi('Confirmer', 'Confirm')}
                    </button>
                    <button onClick={() => setVendorModal(null)}
                      className="flex-1 bg-surface-muted text-ink-primary py-2.5 rounded-xl font-semibold text-sm hover:bg-divider transition-colors">
                      {bi('Annuler', 'Cancel')}
                    </button>
                  </div>
                </div>
              </div>
            )}

          </div>
        )}

      </div>
    </div>
  )
}

// Claim-a-code input rendered at the top of the Vouchers tab. Successful
// claim re-runs loadCustomerData so the new claim appears without refresh.
function VoucherClaimForm({ onClaimed }: { onClaimed: () => void }) {
  const bi = useBi()
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  async function handleClaim(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = code.trim().toUpperCase()
    if (!trimmed) return
    setSubmitting(true)
    setError(''); setSuccess('')
    try {
      const res = await fetch('/api/customer/vouchers/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: trimmed }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? bi('Erreur', 'Error')); return }
      setSuccess(`✅ ${trimmed} ajouté / added`)
      setCode('')
      onClaimed()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleClaim} className="bg-white rounded-2xl shadow-sm p-4 mb-4">
      <label className="block text-xs text-ink-secondary mb-2 font-semibold">
        {bi('Ajouter un code', 'Add a code')}
      </label>
      <div className="flex gap-2">
        <input
          type="text"
          value={code}
          onChange={e => { setCode(e.target.value.toUpperCase()); setError(''); setSuccess('') }}
          placeholder="TCHOP-XXXX"
          className="flex-1 min-w-0 border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand uppercase font-mono"
        />
        <button
          type="submit"
          disabled={submitting || !code.trim()}
          className="bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white px-4 py-2 rounded-xl text-sm font-semibold transition-colors"
        >
          {submitting ? '…' : bi('Ajouter', 'Add')}
        </button>
      </div>
      {error && <p className="text-xs text-danger mt-2">{error}</p>}
      {success && <p className="text-xs text-brand-darker mt-2">{success}</p>}
    </form>
  )
}

function TabBtn({
  icon, label, active, onClick,
}: {
  icon: string
  label: string
  active: boolean
  onClick: () => void
}) {
  // basis ≈ 1/3 on mobile so 3 tabs fit per row and the 4th/5th wrap.
  // basis-0 + flex-1 on sm+ so 5 tabs share a single row evenly.
  // min-w-0 lets labels truncate if they ever get long.
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`basis-[calc(33.333%-0.25rem)] sm:basis-0 flex-1 min-w-0 flex flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-1 px-2 sm:px-3 py-2 rounded-xl text-xs font-semibold transition-colors ${
        active ? 'bg-brand text-white' : 'text-ink-secondary hover:text-ink-primary'
      }`}
    >
      <span aria-hidden="true" className="text-base leading-none">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}

function ProfileRoleBadges({ restaurants }: { restaurants: VendorRestaurant[] }) {
  const bi = useBi()
  const labels: Record<string, string> = {
    owner:   bi('Vendeur Propriétaire', 'Vendor Owner'),
    manager: bi('Vendeur Manager',      'Vendor Manager'),
    staff:   bi('Vendeur Staff',        'Vendor Staff'),
  }
  const uniqueRoles = Array.from(new Set(restaurants.map(r => r.teamRole)))
  const badges: React.ReactNode[] = [
    <span key="client" className="text-xs font-medium px-2 py-0.5 rounded-full bg-brand-light text-brand-darker">
      {bi('Client', 'Customer')}
    </span>,
  ]
  for (const role of uniqueRoles) {
    badges.push(
      <span key={role} className="text-xs font-medium px-2 py-0.5 rounded-full bg-brand-light text-brand-darker">
        {labels[role] ?? role}
      </span>
    )
  }
  return <>{badges}</>
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active:    'bg-brand-light text-brand-darker',
    pending:   'bg-brand-light text-warning',
    approved:  'bg-brand-light text-brand-darker',
    suspended: 'bg-brand-light text-warning',
    deleted:   'bg-brand-light text-danger',
  }
  return (
    <span className={`text-xs font-medium px-2.5 py-1 rounded-full flex-shrink-0 ${map[status] ?? 'bg-surface-muted text-ink-secondary'}`}>
      {status}
    </span>
  )
}

const ORDER_STATUS_STYLES: Record<string, { cls: string; label: string }> = {
  pending:   { cls: 'bg-brand-light text-warning',   label: '⏳ En attente / Pending' },
  confirmed: { cls: 'bg-brand-light text-brand-darker',     label: '✅ Confirmée / Confirmed' },
  preparing: { cls: 'bg-brand-light text-brand-darker', label: '👨‍🍳 En préparation / Preparing' },
  ready:     { cls: 'bg-brand-light text-brand-darker',   label: '🎉 Prête / Ready' },
  completed: { cls: 'bg-surface-muted text-ink-primary',     label: '🏁 Terminée / Completed' },
  cancelled: { cls: 'bg-brand-light text-danger',       label: '❌ Annulée / Cancelled' },
}

function OrderStatusBadge({ status }: { status: string }) {
  const { locale } = useLanguage()
  const s = ORDER_STATUS_STYLES[status] ?? { cls: 'bg-surface-muted text-ink-secondary', label: status }
  return (
    <span className={`text-xs font-medium px-2.5 py-1 rounded-full flex-shrink-0 ${s.cls}`}>
      {pickBi(s.label, locale)}
    </span>
  )
}

function orderShortId(id: string): string {
  return id.replace(/-/g, '').slice(-4).toUpperCase()
}

// Compact card for an event reservation. Lives at the top of the Orders
// tab when the customer has any. Payment badge mirrors the food-order
// PaymentBadge component; reservation_status uses its own colour set so
// 'attended' reads as positive rather than terminal.
// Organizer panel for the "Mes événements" tab. Hosts the event list with
// aggregate stats and a drill-down to the per-event reservation list. The
// list view stays in the same panel (rather than a route) so the data is
// already in scope — onChanged triggers a parent reload after any mutation.
interface MyEventsPanelEvent {
  id: string; title: string; date: string; time: string | null
  description?: string | null; neighborhood?: string | null; category?: string | null
  venue: string | null; city: string | null; cover_photo: string | null
  ticket_price: number | null; max_tickets: number | null; tickets_sold: number | null
  payment_enabled: boolean; payment_mode?: string | null; whatsapp_payment_enabled?: boolean
  organizer_name: string | null; event_status: string | null
  is_active: boolean
  requires_confirmation?: boolean
  reservations_open?:     boolean
  reservations_count: number; tickets_count: number
  revenue: number; commission: number; net_revenue: number; pending_count: number
  pending_approval_count?: number
}
interface MyEventsPanelTrust {
  events_submitted_count: number
  events_approved_count:  number
  event_auto_approve:     boolean
}
interface MyEventReservation {
  id: string; customer_name: string; customer_phone: string
  quantity: number; total_price: number
  payment_status: 'not_required' | 'pending' | 'paid' | 'failed'
  payment_method: string | null
  reservation_status: 'pending' | 'confirmed' | 'cancelled' | 'attended' | 'rejected'
  reservation_code: string | null
  created_at: string
}
interface EventEditForm {
  title: string; description: string; date: string; time: string
  venue: string; neighborhood: string; category: string
  ticket_price: string; max_tickets: string
  payment_mode: PaymentMode; whatsapp_payment_enabled: boolean
  cover_photo: string
}

function MyEventsPanel({
  events, trust, onChanged,
}: {
  events: MyEventsPanelEvent[]
  trust: MyEventsPanelTrust | null
  onChanged: () => void
}) {
  const bi = useBi()
  const { locale } = useLanguage()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reservations, setReservations] = useState<MyEventReservation[]>([])
  const [loadingResv, setLoadingResv] = useState(false)
  const [acting, setActing] = useState<string | null>(null)
  // Edit-event modal state.
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState<EventEditForm | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [editPhotoUploading, setEditPhotoUploading] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  // Message-attendees modal state.
  const [messaging, setMessaging] = useState(false)
  const [messageText, setMessageText] = useState('')
  const [sendingMsg, setSendingMsg] = useState(false)
  const [msgResult, setMsgResult] = useState<string | null>(null)
  // Transient banner shown on the detail view after an edit saves.
  const [savedBanner, setSavedBanner] = useState<string | null>(null)
  // Reservation list filter — All / Pending / Confirmed / Attended.
  // Defaults to All so the organizer sees everything by default.
  const [resvFilter, setResvFilter] = useState<'all' | 'pending' | 'confirmed' | 'attended'>('all')
  // Inline event-setting controls (open/close, manual approval, capacity).
  // Track in-flight to disable the buttons while a PATCH is mid-air.
  const [savingSettings, setSavingSettings] = useState(false)
  const [capacityDraft, setCapacityDraft] = useState<string>('')

  const selected = selectedId ? events.find(e => e.id === selectedId) ?? null : null

  async function openEvent(eventId: string) {
    setSelectedId(eventId)
    setLoadingResv(true)
    try {
      const r = await fetch(`/api/events/${eventId}/reservations`, { cache: 'no-store' })
      const d = await r.json()
      setReservations(Array.isArray(d?.reservations) ? d.reservations : [])
    } finally {
      setLoadingResv(false)
    }
  }

  async function cancel(resId: string) {
    const r = reservations.find(x => x.id === resId)
    const code = r?.reservation_code ?? resId.slice(-4).toUpperCase()
    const warn = r?.payment_status === 'paid'
      ? bi(
          `Annuler #${code}? Le client devra être remboursé.`,
          `Cancel #${code}? The customer will need a refund.`,
        )
      : bi(`Annuler #${code}?`, `Cancel #${code}?`)
    if (!confirm(warn)) return
    setActing(resId)
    try {
      const res = await fetch(`/api/events/${selectedId}/reservations/${resId}/cancel`, { method: 'POST' })
      if (res.ok && selectedId) {
        setReservations(prev => prev.map(x => x.id === resId ? { ...x, reservation_status: 'cancelled' } : x))
        onChanged()
      }
    } finally {
      setActing(null)
    }
  }

  async function attend(resId: string) {
    setActing(resId)
    try {
      const res = await fetch(`/api/events/${selectedId}/reservations/${resId}/attend`, { method: 'POST' })
      if (res.ok) {
        setReservations(prev => prev.map(x => x.id === resId ? { ...x, reservation_status: 'attended' } : x))
      }
    } finally {
      setActing(null)
    }
  }

  // New organizer actions for manual-approval flow.
  async function confirmRes(resId: string) {
    setActing(resId)
    try {
      const res = await fetch(`/api/events/${selectedId}/reservations/${resId}/confirm`, { method: 'POST' })
      if (res.ok) {
        setReservations(prev => prev.map(x => x.id === resId ? { ...x, reservation_status: 'confirmed' } : x))
        onChanged()
      }
    } finally {
      setActing(null)
    }
  }
  async function rejectRes(resId: string) {
    const reason = prompt(bi('Raison du refus (optionnel):', 'Reason for rejection (optional):'), '')
    if (reason === null) return
    setActing(resId)
    try {
      const res = await fetch(`/api/events/${selectedId}/reservations/${resId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || null }),
      })
      if (res.ok) {
        setReservations(prev => prev.map(x => x.id === resId ? { ...x, reservation_status: 'rejected' } : x))
        onChanged()
      }
    } finally {
      setActing(null)
    }
  }

  // Event-level toggles. Each PATCH refreshes the parent so the badge
  // counts in the header stay in sync with the buttons just clicked.
  async function toggleReservationsOpen() {
    if (!selected) return
    setSavingSettings(true)
    try {
      const res = await fetch(`/api/events/${selected.id}/reservations-status`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ open: !(selected.reservations_open !== false) }),
      })
      if (res.ok) onChanged()
    } finally { setSavingSettings(false) }
  }
  async function toggleRequiresConfirmation() {
    if (!selected) return
    setSavingSettings(true)
    try {
      const res = await fetch(`/api/events/${selected.id}/settings`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ requires_confirmation: !selected.requires_confirmation }),
      })
      if (res.ok) onChanged()
    } finally { setSavingSettings(false) }
  }
  async function saveCapacity() {
    if (!selected) return
    const n = Number.parseInt(capacityDraft, 10)
    if (!Number.isFinite(n) || n < 0) return
    setSavingSettings(true)
    try {
      const res = await fetch(`/api/events/${selected.id}/settings`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ max_tickets: n }),
      })
      if (res.ok) {
        setCapacityDraft('')
        onChanged()
      }
    } finally { setSavingSettings(false) }
  }

  // ── Edit event ──
  function openEdit() {
    if (!selected) return
    setEditForm({
      title:        selected.title ?? '',
      description:  selected.description ?? '',
      date:         selected.date ? String(selected.date).slice(0, 10) : '',
      time:         selected.time ?? '',
      venue:        selected.venue ?? '',
      neighborhood: selected.neighborhood ?? '',
      category:     selected.category ?? '',
      ticket_price: selected.ticket_price != null ? String(selected.ticket_price) : '',
      max_tickets:  selected.max_tickets != null ? String(selected.max_tickets) : '',
      payment_mode: (selected.payment_mode as PaymentMode) ?? 'reservation_only',
      whatsapp_payment_enabled: !!selected.whatsapp_payment_enabled,
      cover_photo:  selected.cover_photo ?? '',
    })
    setEditError(null)
    setEditing(true)
  }
  function setEdit<K extends keyof EventEditForm>(key: K, value: EventEditForm[K]) {
    setEditForm(prev => (prev ? { ...prev, [key]: value } : prev))
  }
  async function handleEditPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setEditPhotoUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('kind', 'event_cover')
      fd.append('pathPrefix', 'events')
      const r = await fetch('/api/upload/image', { method: 'POST', body: fd })
      if (r.ok) {
        const j = await r.json()
        if (typeof j?.url === 'string') setEdit('cover_photo', j.url)
      }
    } finally { setEditPhotoUploading(false) }
  }
  async function saveEdit() {
    if (!selected || !editForm) return
    if (!editForm.title.trim() || !editForm.date || !editForm.category) {
      setEditError(bi('Titre, date et catégorie requis.', 'Title, date and category are required.'))
      return
    }
    setSavingEdit(true)
    setEditError(null)
    try {
      const res = await fetch(`/api/events/${selected.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title:        editForm.title,
          description:  editForm.description,
          date:         editForm.date,
          time:         editForm.time,
          venue:        editForm.venue,
          neighborhood: editForm.neighborhood,
          category:     editForm.category,
          ticket_price: editForm.ticket_price === '' ? null : Number(editForm.ticket_price),
          max_tickets:  editForm.max_tickets === '' ? 0 : Number(editForm.max_tickets),
          payment_mode: editForm.payment_mode,
          whatsapp_payment_enabled: editForm.whatsapp_payment_enabled,
          cover_photo:  editForm.cover_photo || null,
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setEditError(d?.error ?? bi('Erreur', 'Error')); return }
      setEditing(false)
      setSavedBanner(
        d.notified_count > 0
          ? bi(`✅ Enregistré — ${d.notified_count} inscrit(s) notifié(s)`, `✅ Saved — ${d.notified_count} attendee(s) notified`)
          : bi('✅ Événement mis à jour', '✅ Event updated'),
      )
      setTimeout(() => setSavedBanner(null), 4000)
      onChanged()
    } finally { setSavingEdit(false) }
  }

  // ── Message attendees ──
  async function sendMessage() {
    if (!selected || !messageText.trim()) return
    setSendingMsg(true)
    setMsgResult(null)
    try {
      const res = await fetch(`/api/events/${selected.id}/message`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message: messageText.trim() }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setMsgResult(d?.error ?? bi('Erreur', 'Error')); return }
      setMsgResult(bi(`✅ Envoyé à ${d.sent_count} inscrit(s)`, `✅ Sent to ${d.sent_count} attendee(s)`))
      setMessageText('')
      setTimeout(() => { setMessaging(false); setMsgResult(null) }, 2000)
    } finally { setSendingMsg(false) }
  }

  if (events.length === 0) {
    return (
      <div className="bg-white rounded-2xl shadow-sm p-6 text-center">
        <div className="text-4xl mb-3">🎉</div>
        <p className="text-sm text-ink-tertiary">
          {bi('Vous n\'avez pas encore soumis d\'événement.', 'You haven\'t submitted an event yet.')}
        </p>
        <Link href="/events/submit" className="mt-3 inline-block text-brand text-sm font-semibold underline">
          {bi('Soumettre un événement', 'Submit an event')}
        </Link>
      </div>
    )
  }

  if (selected) {
    const dateStr = new Date(selected.date).toLocaleDateString('fr-FR', {
      day: '2-digit', month: 'long', year: 'numeric',
    })
    return (
      <div>
        <button
          onClick={() => setSelectedId(null)}
          className="text-xs text-brand hover:text-brand-dark font-semibold mb-3"
        >
          ← {bi('Retour à mes événements', 'Back to my events')}
        </button>
        <div className="bg-white rounded-2xl shadow-sm p-4 mb-4">
          <p className="font-bold text-ink-primary">{selected.title}</p>
          <p className="text-xs text-ink-tertiary mt-0.5">{dateStr}{selected.venue ? ` · ${selected.venue}` : ''}</p>
          <div className="grid grid-cols-3 gap-3 mt-3 text-center">
            <div>
              <p className="text-xs text-ink-tertiary">{bi('Réservations', 'Reservations')}</p>
              <p className="text-lg font-bold text-ink-primary">{selected.reservations_count}</p>
            </div>
            <div>
              <p className="text-xs text-ink-tertiary">{bi('Places', 'Tickets')}</p>
              <p className="text-lg font-bold text-ink-primary">
                {selected.tickets_count}{selected.max_tickets && selected.max_tickets > 0 ? `/${selected.max_tickets}` : ''}
              </p>
            </div>
            <div>
              <p className="text-xs text-ink-tertiary">{bi('Recettes brutes', 'Gross')}</p>
              <p className="text-lg font-bold text-brand">{Number(selected.revenue).toLocaleString()} FCFA</p>
            </div>
          </div>
          {/* Commission breakdown — only when there's actual revenue to split.
              The 10% line is informational; the organizer's payout is the
              net figure. */}
          {selected.revenue > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
              <div className="bg-surface-muted rounded-xl p-2 text-center">
                <p className="text-ink-tertiary">📊 {bi('Commission (10%)', 'Commission (10%)')}</p>
                <p className="font-semibold text-ink-primary">{Number(selected.commission).toLocaleString()} FCFA</p>
              </div>
              <div className="bg-brand-light rounded-xl p-2 text-center">
                <p className="text-brand-dark">💵 {bi('Net', 'Net')}</p>
                <p className="font-bold text-brand-darker">{Number(selected.net_revenue).toLocaleString()} FCFA</p>
              </div>
            </div>
          )}
        </div>

        {savedBanner && (
          <div className="bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-2xl px-4 py-2.5 text-sm font-semibold mb-4">
            {savedBanner}
          </div>
        )}

        {/* Organizer actions — edit details (notifies attendees on significant
            changes) and message everyone who reserved. */}
        <div className="flex gap-2 mb-4">
          <button
            onClick={openEdit}
            className="flex-1 text-sm font-semibold px-3 py-2.5 rounded-xl border border-brand text-brand bg-white hover:bg-brand-light transition-colors"
          >
            ✏️ {bi('Modifier', 'Edit')}
          </button>
          <button
            onClick={() => { setMessageText(''); setMsgResult(null); setMessaging(true) }}
            className="flex-1 text-sm font-semibold px-3 py-2.5 rounded-xl bg-brand text-white hover:bg-brand-dark transition-colors"
          >
            📨 {bi('Message aux inscrits', 'Message attendees')}
          </button>
        </div>

        {/* Ticket tiers panel — self-contained CRUD for the event's
            tiered pricing. Renders empty state when the event still
            uses the legacy single price. */}
        <EventTiersPanel eventId={selected.id} />

        {/* Promo codes — organizer creates event-scoped vouchers. */}
        <EventVouchersPanel eventId={selected.id} />

        {/* Event-level controls — reservations open/close, manual approval
            toggle, capacity bump. Each PATCH refreshes the parent so the
            stats above stay live. */}
        <div className="bg-white rounded-2xl shadow-sm p-4 mb-4 space-y-3">
          <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">
            ⚙️ {bi('Paramètres', 'Settings')}
          </p>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink-primary">
                {selected.reservations_open === false
                  ? bi('🔒 Réservations fermées', '🔒 Reservations closed')
                  : bi('🔓 Réservations ouvertes', '🔓 Reservations open')}
              </p>
            </div>
            <button
              onClick={toggleReservationsOpen}
              disabled={savingSettings}
              className={`text-xs px-3 py-1.5 rounded-full font-semibold transition-colors disabled:opacity-50 ${
                selected.reservations_open === false
                  ? 'bg-brand text-white hover:bg-brand-dark'
                  : 'bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100'
              }`}
            >
              {selected.reservations_open === false
                ? bi('🔓 Ouvrir', '🔓 Open')
                : bi('🔒 Fermer', '🔒 Close')}
            </button>
          </div>
          <div className="flex items-center justify-between gap-3 pt-3 border-t border-divider">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink-primary">
                📋 {bi('Approbation manuelle', 'Manual approval')}
              </p>
              <p className="text-xs text-ink-tertiary mt-0.5">
                {selected.requires_confirmation
                  ? bi('Chaque réservation reste en attente.', 'Each reservation stays pending.')
                  : bi('Les réservations sont confirmées automatiquement.', 'Reservations are auto-confirmed.')}
              </p>
            </div>
            <button
              onClick={toggleRequiresConfirmation}
              disabled={savingSettings}
              className={`text-xs px-3 py-1.5 rounded-full font-semibold transition-colors disabled:opacity-50 ${
                selected.requires_confirmation ? 'bg-brand text-white hover:bg-brand-dark' : 'bg-surface-muted text-ink-secondary hover:bg-divider'
              }`}
            >
              {selected.requires_confirmation
                ? bi('Désactiver', 'Disable')
                : bi('Activer', 'Enable')}
            </button>
          </div>
          <div className="pt-3 border-t border-divider">
            <p className="text-sm font-semibold text-ink-primary mb-1.5">
              🎟 {bi('Capacité', 'Capacity')}
            </p>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                value={capacityDraft}
                onChange={e => setCapacityDraft(e.target.value)}
                placeholder={String(selected.max_tickets ?? 0)}
                className="flex-1 bg-surface-muted border border-divider rounded-xl px-3 py-1.5 text-sm"
              />
              <button
                onClick={saveCapacity}
                disabled={savingSettings || !capacityDraft.trim()}
                className="text-xs px-3 py-1.5 rounded-full font-semibold bg-brand text-white hover:bg-brand-dark disabled:opacity-50"
              >
                💾 {bi('Mettre à jour', 'Update')}
              </button>
            </div>
            <p className="text-xs text-ink-tertiary mt-1">
              {bi('0 = illimité.', '0 = unlimited.')} {bi('Actuel:', 'Current:')} {selected.max_tickets ?? 0}
            </p>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1 bg-surface-muted p-1 rounded-xl w-fit mb-3 overflow-x-auto">
          {(['all', 'pending', 'confirmed', 'attended'] as const).map(f => (
            <button
              key={f}
              onClick={() => setResvFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${
                resvFilter === f ? 'bg-white text-ink-primary shadow-sm' : 'text-ink-secondary hover:text-ink-primary'
              }`}
            >
              {f === 'all' ? bi('Tous', 'All')
                : f === 'pending' ? bi('En attente', 'Pending')
                : f === 'confirmed' ? bi('Confirmées', 'Confirmed')
                : bi('Présents', 'Attended')}
            </button>
          ))}
        </div>

        {loadingResv ? (
          <div className="text-center py-12 text-ink-tertiary">…</div>
        ) : reservations.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm p-6 text-center text-sm text-ink-tertiary">
            {bi('Aucune réservation pour le moment.', 'No reservations yet.')}
          </div>
        ) : (
          <div className="space-y-2">
            {reservations.filter(r =>
              resvFilter === 'all'      ? true
              : resvFilter === 'pending'  ? r.reservation_status === 'pending'
              : resvFilter === 'confirmed' ? r.reservation_status === 'confirmed'
              : r.reservation_status === 'attended'
            ).map(r => {
              const wa = `https://wa.me/${r.customer_phone.replace(/[^\d]/g, '')}`
              const pillStatus =
                r.reservation_status === 'cancelled' ? { cls: 'bg-rose-50 text-rose-700 border border-rose-200',     label: '❌ ' + bi('Annulée',   'Cancelled') }
                : r.reservation_status === 'rejected' ? { cls: 'bg-rose-50 text-rose-700 border border-rose-200',     label: '❌ ' + bi('Refusée',   'Rejected') }
                : r.reservation_status === 'attended' ? { cls: 'bg-blue-50 text-blue-700 border border-blue-200',     label: '🎉 ' + bi('Présent',   'Attended') }
                : r.reservation_status === 'pending'  ? { cls: 'bg-amber-50 text-amber-700 border border-amber-200', label: '⏳ ' + bi('En attente', 'Pending') }
                : { cls: 'bg-brand-light text-brand-darker', label: '✅ ' + bi('Confirmée', 'Confirmed') }
              const pillPay =
                r.payment_status === 'paid'    ? { cls: 'bg-emerald-50 text-emerald-700 border border-emerald-200', label: '💰 ' + bi('Payé', 'Paid') }
                : r.payment_status === 'pending' ? { cls: 'bg-amber-50 text-amber-700 border border-amber-200',      label: '⏳ ' + bi('En attente', 'Pending') }
                : r.payment_status === 'failed'  ? { cls: 'bg-rose-50 text-rose-700 border border-rose-200',         label: '❌ ' + bi('Échec', 'Failed') }
                : null
              return (
                <div key={r.id} className="bg-white rounded-2xl shadow-sm p-3">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-ink-primary text-sm truncate">{r.customer_name}</p>
                        {r.reservation_code && (
                          <span className="text-[10px] font-bold font-mono px-1.5 py-0.5 rounded bg-ink-primary text-white tracking-wider">
                            #{r.reservation_code}
                          </span>
                        )}
                      </div>
                      <a href={wa} target="_blank" rel="noopener noreferrer"
                         className="text-xs text-brand-darker font-mono hover:underline">
                        📱 {r.customer_phone}
                      </a>
                      <p className="text-xs text-ink-tertiary mt-0.5">
                        🎟 {r.quantity}{r.total_price > 0 && <> · {Number(r.total_price).toLocaleString()} FCFA</>}
                      </p>
                    </div>
                    <div className="flex flex-col gap-1 items-end flex-shrink-0">
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${pillStatus.cls}`}>
                        {pillStatus.label}
                      </span>
                      {pillPay && (
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${pillPay.cls}`}>
                          {pillPay.label}
                        </span>
                      )}
                    </div>
                  </div>
                  {r.reservation_status === 'pending' && (
                    <div className="flex items-center gap-2 pt-2 border-t border-divider">
                      <button
                        onClick={() => confirmRes(r.id)}
                        disabled={acting === r.id}
                        className="text-xs px-3 py-1.5 rounded-full font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        ✅ {bi('Confirmer', 'Confirm')}
                      </button>
                      <button
                        onClick={() => rejectRes(r.id)}
                        disabled={acting === r.id}
                        className="text-xs px-3 py-1.5 rounded-full font-semibold bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 disabled:opacity-50"
                      >
                        ❌ {bi('Rejeter', 'Reject')}
                      </button>
                    </div>
                  )}
                  {r.reservation_status === 'confirmed' && (
                    <div className="flex items-center gap-2 pt-2 border-t border-divider">
                      <button
                        onClick={() => attend(r.id)}
                        disabled={acting === r.id}
                        className="text-xs px-3 py-1.5 rounded-full font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        ✅ {bi('Présent', 'Attended')}
                      </button>
                      <button
                        onClick={() => cancel(r.id)}
                        disabled={acting === r.id}
                        className="text-xs px-3 py-1.5 rounded-full font-semibold bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 disabled:opacity-50"
                      >
                        ❌ {bi('Annuler', 'Cancel')}
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* ── Edit event modal ── */}
        {editing && editForm && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 px-0 sm:px-4" onClick={() => !savingEdit && setEditing(false)}>
            <div className="bg-white rounded-t-3xl sm:rounded-2xl shadow-card w-full sm:max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
              <div className="p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-bold text-ink-primary">✏️ {bi('Modifier l\'événement', 'Edit event')}</h3>
                  <button onClick={() => !savingEdit && setEditing(false)} className="text-ink-tertiary hover:text-ink-primary text-xl leading-none">×</button>
                </div>

                <label className="block">
                  <span className="text-xs font-semibold text-ink-secondary">{bi('Titre', 'Title')}</span>
                  <input value={editForm.title} onChange={e => setEdit('title', e.target.value)}
                    className="mt-1 w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm" />
                </label>

                <label className="block">
                  <span className="text-xs font-semibold text-ink-secondary">{bi('Description', 'Description')}</span>
                  <textarea value={editForm.description} onChange={e => setEdit('description', e.target.value)} rows={3}
                    className="mt-1 w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm resize-none" />
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs font-semibold text-ink-secondary">{bi('Date', 'Date')}</span>
                    <input type="date" value={editForm.date} onChange={e => setEdit('date', e.target.value)}
                      className="mt-1 w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm" />
                  </label>
                  <label className="block">
                    <span className="text-xs font-semibold text-ink-secondary">{bi('Heure', 'Time')}</span>
                    <input type="time" value={editForm.time} onChange={e => setEdit('time', e.target.value)}
                      className="mt-1 w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm" />
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs font-semibold text-ink-secondary">{bi('Lieu', 'Venue')}</span>
                    <input value={editForm.venue} onChange={e => setEdit('venue', e.target.value)}
                      className="mt-1 w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm" />
                  </label>
                  <label className="block">
                    <span className="text-xs font-semibold text-ink-secondary">{bi('Quartier', 'Neighborhood')}</span>
                    <input value={editForm.neighborhood} onChange={e => setEdit('neighborhood', e.target.value)}
                      className="mt-1 w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm" />
                  </label>
                </div>

                <label className="block">
                  <span className="text-xs font-semibold text-ink-secondary">{bi('Catégorie', 'Category')}</span>
                  <select value={editForm.category} onChange={e => setEdit('category', e.target.value)}
                    className="mt-1 w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm">
                    <option value="">—</option>
                    {EVENT_EDIT_CATEGORIES.map(c => <option key={c} value={c}>{categoryLabel(c, locale)}</option>)}
                  </select>
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs font-semibold text-ink-secondary">{bi('Prix billet (FCFA)', 'Ticket price (FCFA)')}</span>
                    <input type="number" min={0} value={editForm.ticket_price} onChange={e => setEdit('ticket_price', e.target.value)}
                      placeholder={bi('0 = gratuit', '0 = free')}
                      className="mt-1 w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm" />
                  </label>
                  <label className="block">
                    <span className="text-xs font-semibold text-ink-secondary">{bi('Places max', 'Max tickets')}</span>
                    <input type="number" min={0} value={editForm.max_tickets} onChange={e => setEdit('max_tickets', e.target.value)}
                      placeholder={bi('0 = illimité', '0 = unlimited')}
                      className="mt-1 w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm" />
                  </label>
                </div>

                {/* Payment mode — only meaningful for paid events. */}
                {Number(editForm.ticket_price || 0) > 0 && (
                  <div className="space-y-2">
                    <span className="text-xs font-semibold text-ink-secondary">{bi('Paiement', 'Payment')}</span>
                    <div className="inline-flex rounded-xl bg-surface-muted p-0.5 w-full">
                      {([
                        ['reservation_only', bi('📋 Réservation', '📋 Reservation')],
                        ['payment_only',     bi('💰 Paiement', '💰 Payment')],
                        ['both',             bi('💰📋 Les deux', '💰📋 Both')],
                      ] as [PaymentMode, string][]).map(([value, label]) => (
                        <button key={value} type="button" onClick={() => setEdit('payment_mode', value)}
                          className={`flex-1 text-xs font-semibold px-2 py-1.5 rounded-lg transition-colors ${
                            editForm.payment_mode === value ? 'bg-white text-ink-primary shadow-sm' : 'text-ink-secondary hover:text-ink-primary'
                          }`}>
                          {label}
                        </button>
                      ))}
                    </div>
                    {canPayOnline(editForm.payment_mode) && (
                      <label className="flex items-center gap-2 text-sm text-ink-primary cursor-pointer">
                        <input type="checkbox" checked={editForm.whatsapp_payment_enabled}
                          onChange={e => setEdit('whatsapp_payment_enabled', e.target.checked)}
                          className="w-4 h-4 rounded border-divider text-brand" />
                        💬💰 {bi('Autoriser le paiement via WhatsApp', 'Allow payment via WhatsApp')}
                      </label>
                    )}
                  </div>
                )}

                <label className="block">
                  <span className="text-xs font-semibold text-ink-secondary">{bi('Photo de couverture', 'Cover photo')}</span>
                  <div className="mt-1 flex items-center gap-3">
                    {editForm.cover_photo && (
                      <Image src={editForm.cover_photo} alt="" width={56} height={56} className="w-14 h-14 rounded-xl object-cover" />
                    )}
                    <input type="file" accept="image/*" onChange={handleEditPhoto} className="text-xs flex-1" />
                    {editPhotoUploading && <span className="text-xs text-ink-tertiary">…</span>}
                  </div>
                </label>

                {editError && <p className="text-sm text-rose-600 font-medium">{editError}</p>}

                <div className="flex gap-2 pt-1">
                  <button onClick={() => setEditing(false)} disabled={savingEdit}
                    className="flex-1 text-sm font-semibold py-2.5 rounded-xl bg-surface-muted text-ink-secondary hover:bg-divider disabled:opacity-50">
                    {bi('Annuler', 'Cancel')}
                  </button>
                  <button onClick={saveEdit} disabled={savingEdit || editPhotoUploading}
                    className="flex-1 text-sm font-semibold py-2.5 rounded-xl bg-brand text-white hover:bg-brand-dark disabled:opacity-50">
                    {savingEdit ? '…' : bi('💾 Enregistrer', '💾 Save')}
                  </button>
                </div>
                <p className="text-[11px] text-ink-tertiary text-center">
                  {bi('Les inscrits sont notifiés si la date, l\'heure, le lieu ou le prix change.',
                     'Attendees are notified if the date, time, venue or price changes.')}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ── Message attendees modal ── */}
        {messaging && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 px-0 sm:px-4" onClick={() => !sendingMsg && setMessaging(false)}>
            <div className="bg-white rounded-t-3xl sm:rounded-2xl shadow-card w-full sm:max-w-md" onClick={e => e.stopPropagation()}>
              <div className="p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-bold text-ink-primary">📨 {bi('Message aux inscrits', 'Message attendees')}</h3>
                  <button onClick={() => !sendingMsg && setMessaging(false)} className="text-ink-tertiary hover:text-ink-primary text-xl leading-none">×</button>
                </div>
                <p className="text-sm text-ink-tertiary">
                  {bi(
                    `Ce message sera envoyé à ${selected.reservations_count} personne(s) inscrite(s).`,
                    `This message will be sent to ${selected.reservations_count} registered attendee(s).`,
                  )}
                </p>
                <textarea
                  value={messageText}
                  onChange={e => setMessageText(e.target.value.slice(0, 1000))}
                  rows={5}
                  placeholder={bi('Votre message…', 'Your message…')}
                  className="w-full bg-surface-muted border border-divider rounded-xl px-3 py-2 text-sm resize-none"
                />
                <div className="flex items-center justify-between text-xs text-ink-tertiary">
                  <span>{messageText.length}/1000</span>
                  <span>{bi('Max 2 messages/jour', 'Max 2 messages/day')}</span>
                </div>
                {msgResult && <p className="text-sm font-medium text-ink-primary">{msgResult}</p>}
                <div className="flex gap-2">
                  <button onClick={() => setMessaging(false)} disabled={sendingMsg}
                    className="flex-1 text-sm font-semibold py-2.5 rounded-xl bg-surface-muted text-ink-secondary hover:bg-divider disabled:opacity-50">
                    {bi('Annuler', 'Cancel')}
                  </button>
                  <button onClick={sendMessage} disabled={sendingMsg || !messageText.trim()}
                    className="flex-1 text-sm font-semibold py-2.5 rounded-xl bg-brand text-white hover:bg-brand-dark disabled:opacity-50">
                    {sendingMsg ? '…' : bi('Envoyer', 'Send')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-base font-bold text-ink-primary">🎉 {bi('Mes événements', 'My events')}</h2>
        {trust && (
          trust.event_auto_approve ? (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
              ✅ {bi('Éditeur vérifié', 'Verified publisher')}
            </span>
          ) : (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
              {trust.events_approved_count}/3 {bi('événements approuvés', 'events approved')}
            </span>
          )
        )}
      </div>
      {events.map(e => {
        const dateStr = new Date(e.date).toLocaleDateString('fr-FR', {
          day: '2-digit', month: 'short', year: 'numeric',
        })
        const ticketPrice = Number(e.ticket_price ?? 0)
        return (
          <button
            key={e.id}
            onClick={() => openEvent(e.id)}
            className="w-full text-left bg-white rounded-2xl shadow-sm p-3 hover:bg-surface-muted transition-colors"
          >
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="min-w-0">
                <p className="font-semibold text-ink-primary text-sm truncate">{e.title}</p>
                <p className="text-xs text-ink-tertiary mt-0.5">
                  {dateStr}{e.time ? ` · ${e.time}` : ''}{e.venue ? ` · ${e.venue}` : ''}
                </p>
              </div>
              {!e.is_active && (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 whitespace-nowrap">
                  ⏳ {bi('En attente d\'approbation', 'Pending approval')}
                </span>
              )}
              {e.event_status === 'cancelled' && (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200 whitespace-nowrap">
                  ❌ {bi('Annulé', 'Cancelled')}
                </span>
              )}
            </div>
            <div className="flex items-center gap-4 text-xs text-ink-secondary">
              <span>🎟 {e.tickets_count}{e.max_tickets && e.max_tickets > 0 ? `/${e.max_tickets}` : ''} {bi('places', 'tickets')}</span>
              <span>📋 {e.reservations_count} {bi('réservations', 'reservations')}</span>
              {ticketPrice > 0 && (
                <span className="text-brand font-semibold">
                  💰 {Number(e.revenue).toLocaleString()} FCFA
                </span>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}

function EventReservationCard({
  reservation, onCancelled,
}: {
  reservation: EventReservation
  onCancelled?: () => void
}) {
  const bi = useBi()
  const [cancelling, setCancelling] = useState(false)
  const ev = reservation.events
  const dateStr = ev?.date
    ? new Date(ev.date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })
    : ''
  const statusPill: Record<EventReservation['reservation_status'], { cls: string; label: string }> = {
    pending:   { cls: 'bg-amber-50 text-amber-700 border border-amber-200',     label: '⏳ ' + bi('En attente', 'Pending') },
    confirmed: { cls: 'bg-brand-light text-brand-darker',                       label: '✅ ' + bi('Confirmée', 'Confirmed') },
    cancelled: { cls: 'bg-rose-50 text-rose-700 border border-rose-200',        label: '❌ ' + bi('Annulée',   'Cancelled') },
    attended:  { cls: 'bg-emerald-50 text-emerald-700 border border-emerald-200', label: '🎉 ' + bi('Participée', 'Attended') },
    rejected:  { cls: 'bg-rose-50 text-rose-700 border border-rose-200',        label: '❌ ' + bi('Refusée',   'Rejected') },
  }
  const s = statusPill[reservation.reservation_status]

  // Customer self-cancel is allowed only for upcoming, confirmed reservations
  // — past events shouldn't surprise the organizer with a last-minute pull,
  // and cancelled/attended rows can't be un-set from here. The cancel API
  // performs its own checks too; this is a UI-side filter for clarity.
  const isUpcoming = ev?.date ? new Date(ev.date) >= new Date(new Date().toDateString()) : false
  const canCancel  = reservation.reservation_status === 'confirmed' && ev && isUpcoming

  async function handleCancel(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (!ev) return
    const id4 = reservation.reservation_code ?? reservation.id.slice(-4).toUpperCase()
    const warn = reservation.payment_status === 'paid'
      ? bi(
          `Annuler #${id4}? L'organisateur vous contactera pour le remboursement.`,
          `Cancel #${id4}? The organizer will contact you for a refund.`,
        )
      : bi(`Annuler #${id4}?`, `Cancel #${id4}?`)
    if (!confirm(warn)) return
    setCancelling(true)
    try {
      const res = await fetch(`/api/events/${ev.id}/reservations/${reservation.id}/cancel`, { method: 'POST' })
      if (res.ok) onCancelled?.()
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
      <Link
        href={ev ? `/events/${ev.id}` : '#'}
        className="block p-3 hover:bg-surface-muted transition-colors"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-ink-primary text-sm truncate">
              🎉 {ev?.title ?? bi('Événement supprimé', 'Event removed')}
            </p>
            <p className="text-xs text-ink-tertiary mt-0.5">
              {dateStr}{ev?.venue ? ` · ${ev.venue}` : ''}
            </p>
            <p className="text-xs text-ink-secondary mt-1">
              🎟 {reservation.quantity} {bi('place(s)', 'ticket(s)')}
              {reservation.total_price > 0 && (
                <> · {Number(reservation.total_price).toLocaleString()} FCFA</>
              )}
            </p>
            {reservation.reservation_code && (
              <p className="text-xs mt-1">
                <span className="font-semibold text-ink-tertiary">{bi('Code', 'Code')}: </span>
                <span className="font-bold font-mono tracking-wider text-ink-primary">#{reservation.reservation_code}</span>
              </p>
            )}
          </div>
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${s.cls}`}>
            {s.label}
          </span>
        </div>
      </Link>
      {canCancel && (
        <div className="px-3 pb-3 pt-1 flex justify-end">
          <button
            onClick={handleCancel}
            disabled={cancelling}
            className="text-xs px-3 py-1.5 rounded-full font-semibold bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 transition-colors disabled:opacity-50"
          >
            {cancelling ? bi('Annulation…', 'Cancelling…') : `❌ ${bi('Annuler', 'Cancel')}`}
          </button>
        </div>
      )}
    </div>
  )
}

// Nickname editor row inside the Profile card. Has its own save button so
// the 30-day cooldown failure surfaces here rather than as a blanket
// profile-save error. Cooldown counter renders in days when active.
function NicknameRow({
  profile, value, onChange, saving, onSave,
}: {
  profile: { nickname: string | null; nickname_updated_at: string | null }
  value: string
  onChange: (v: string) => void
  saving: boolean
  onSave: () => void
}) {
  const bi = useBi()
  const cooldownMs = 30 * 24 * 60 * 60 * 1000
  const lastChanged = profile.nickname_updated_at ? new Date(profile.nickname_updated_at).getTime() : 0
  const cooldownRemaining = lastChanged
    ? Math.max(0, Math.ceil((cooldownMs - (Date.now() - lastChanged)) / (24 * 60 * 60 * 1000)))
    : 0
  const dirty = value.trim() !== (profile.nickname ?? '')
  return (
    <div>
      <label className="block text-xs text-ink-tertiary mb-1">
        {bi('Pseudo / Nickname', 'Nickname')}
      </label>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={bi('Choisissez un pseudo', 'Choose a nickname')}
          maxLength={20}
          className="flex-1 border border-divider rounded-xl px-3 py-2 text-sm outline-none focus:border-brand bg-white"
        />
        <button
          onClick={onSave}
          disabled={saving || !dirty || cooldownRemaining > 0}
          className="bg-brand hover:bg-brand-dark disabled:bg-brand-badge text-white px-4 py-2 rounded-xl text-sm font-semibold transition-colors"
        >
          {saving ? '…' : bi('Enregistrer', 'Save')}
        </button>
      </div>
      <p className="text-[11px] text-ink-tertiary mt-1">
        {cooldownRemaining > 0
          ? bi(
              `Modifiable dans ${cooldownRemaining} jour${cooldownRemaining > 1 ? 's' : ''}.`,
              `Editable in ${cooldownRemaining} day${cooldownRemaining > 1 ? 's' : ''}.`,
            )
          : bi('Modifiable une fois par 30 jours. Affiché sur vos commentaires d\'événements.',
               'Editable once per 30 days. Shown on your event comments.')}
      </p>
    </div>
  )
}

function OrderCard({ order, orderAtLabel }: { order: Order; orderAtLabel: string }) {
  const bi = useBi()
  const { locale } = useLanguage()
  const [expanded, setExpanded] = useState(false)
  const items: Array<{ name: string; quantity: number; price?: number }> = Array.isArray(order.items) ? order.items : []
  const itemsSummary = items.map(i => `${i.quantity}× ${i.name}`).join(', ')

  return (
    <div className="bg-white rounded-2xl shadow-sm p-4">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full text-left"
      >
        <div className="flex items-center justify-between mb-1 gap-2">
          <p className="font-semibold text-ink-primary text-sm truncate">
            {orderAtLabel} {order.restaurants?.name ?? '—'}
            <span className="ml-2 text-ink-tertiary font-mono text-xs">#{orderShortId(order.id)}</span>
          </p>
          <span className="text-xs text-ink-tertiary flex-shrink-0">{new Date(order.created_at).toLocaleDateString('fr-FR')}</span>
        </div>
        <p className="text-xs text-ink-tertiary mb-2 truncate">{itemsSummary}</p>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="font-bold text-brand text-sm">{Number(order.total_price).toLocaleString()} FCFA</span>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <OrderStatusBadge status={order.status} />
            <PaymentBadge order={order} locale={locale} showRef />
            <span className="text-ink-tertiary text-sm">{expanded ? '▾' : '▸'}</span>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-divider space-y-2">
          {items.length === 0 ? (
            <p className="text-xs text-ink-tertiary">{bi('Aucun détail d&apos;article', 'No item details')}</p>
          ) : (
            <ul className="space-y-1">
              {items.map((it, idx) => (
                <li key={idx} className="flex items-center justify-between text-sm text-ink-primary">
                  <span>{it.quantity}× {it.name}</span>
                  {typeof it.price === 'number' && (
                    <span className="text-ink-secondary font-mono">{(it.quantity * it.price).toLocaleString()} FCFA</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center justify-between pt-2 border-t border-divider">
            <span className="text-xs text-ink-secondary uppercase tracking-wide">Total</span>
            <span className="font-bold text-ink-primary font-mono">{Number(order.total_price).toLocaleString()} FCFA</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Low-data mode toggle (mounted inside the Profile tab) ───────────────────
// Lives in localStorage via useDataMode(); flipping it instantly changes
// what /events, /, and /restaurant/[id] cards render (image vs gradient).
function LowDataToggle() {
  const { isLowData, toggle } = useDataMode()
  // useBi runs inside the LowDataToggle component (not at module scope)
  // so the toggle copy updates when the user flips the language.
  // Importing useBi via the already-imported language helpers up top.
  return (
    <div className="bg-white rounded-2xl shadow-sm p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-primary">
            📶 {isLowData ? 'Mode économique actif / Low-data mode on' : 'Mode économique / Low-data mode'}
          </p>
          <p className="text-xs text-ink-tertiary mt-0.5">
            {isLowData
              ? 'Photos remplacées par des dégradés colorés — économise ~90% de données. / Images replaced with gradients — saves ~90% data.'
              : 'Activez pour économiser de la data sur les pages avec beaucoup d\'images. / Toggle to save data on image-heavy pages.'}
          </p>
        </div>
        <button
          onClick={toggle}
          className={`flex-shrink-0 text-xs px-3 py-1.5 rounded-full font-semibold transition-colors ${
            isLowData ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-surface-muted text-ink-secondary hover:bg-divider'
          }`}
        >
          {isLowData ? 'Désactiver / Turn off' : 'Activer / Turn on'}
        </button>
      </div>
    </div>
  )
}

