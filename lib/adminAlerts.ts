// WhatsApp to the platform's admins (super_admin + admin, active, with a
// phone), each in their own language. One shared helper: protected payments
// (problems, refunds) and the event discovery morning report.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { sendWhatsApp, getLangByPhone, pickLang } from '@/lib/whatsapp'

export interface AlertOptions {
  /** Recipients instead of the admin list (tests). */
  phones?: string[]
  /** Sender instead of WhatsApp (tests). */
  send?: (to: string, message: string, relatedId: string) => Promise<unknown>
}

export async function adminAlertPhones(): Promise<string[]> {
  const { data: admins } = await supabaseAdmin.from('admin_users').select('phone')
    .in('role', ['super_admin', 'admin']).eq('status', 'active').not('phone', 'is', null)
  return Array.from(new Set((admins ?? []).map(a => a.phone as string).filter(Boolean)))
}

/** Sends to every admin; returns how many were tried. Never throws. */
export async function alertAdmins(fr: string, en: string, relatedId: string, opts: AlertOptions = {}): Promise<number> {
  const phones = opts.phones ?? await adminAlertPhones()
  await Promise.allSettled(phones.map(async phone => {
    const message = pickLang(fr, en, await getLangByPhone(phone))
    return opts.send ? opts.send(phone, message, relatedId) : sendWhatsApp(phone, message, { context: 'account_notice', relatedId })
  }))
  return phones.length
}
