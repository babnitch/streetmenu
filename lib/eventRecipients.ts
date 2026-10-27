// Who receives an event's notifications on the organiser side (C3):
//   - the organiser's account phone (else, for a legacy event with no
//     organiser account, events.whatsapp);
//   - plus events.notify_phone — the optional extra number set on the event
//     (pre-filled from the Pro profile).
// Same person twice ("237…" and "+237…") → one message (uniquePhones).
// Used for: new booking, paid booking, booking cancelled by the customer,
// event approved / rejected, event submitted.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { sendWhatsApp, getLangByPhone, type Lang, type SendOptions } from '@/lib/whatsapp'
import { uniquePhones } from '@/lib/phone'

export interface EventRecipientSource {
  id: string
  organizer_id?: string | null
  whatsapp?: string | null
  // undefined = not selected by the caller → read here.
  notify_phone?: string | null
}

// Fields the caller didn't select (undefined) are read from the event row.
async function complete(event: EventRecipientSource): Promise<Required<EventRecipientSource>> {
  if (event.organizer_id !== undefined && event.whatsapp !== undefined && event.notify_phone !== undefined) {
    return event as Required<EventRecipientSource>
  }
  const { data } = await supabaseAdmin
    .from('events').select('organizer_id, whatsapp, notify_phone').eq('id', event.id).maybeSingle()
  return {
    id:           event.id,
    organizer_id: event.organizer_id !== undefined ? event.organizer_id : (data?.organizer_id as string | null) ?? null,
    whatsapp:     event.whatsapp     !== undefined ? event.whatsapp     : (data?.whatsapp as string | null) ?? null,
    notify_phone: event.notify_phone !== undefined ? event.notify_phone : (data?.notify_phone as string | null) ?? null,
  }
}

// The organiser's main number: the account phone, else the event's contact.
export async function organizerPrimaryPhone(event: EventRecipientSource): Promise<string | null> {
  const e = await complete(event)
  if (e.organizer_id) {
    const { data: o } = await supabaseAdmin
      .from('customers').select('phone').eq('id', e.organizer_id).maybeSingle()
    if (o?.phone) return o.phone as string
  }
  return e.whatsapp
}

export async function organizerPhones(event: EventRecipientSource, primary?: string | null): Promise<string[]> {
  const e = await complete(event)
  const main = primary !== undefined ? primary : await organizerPrimaryPhone(e)
  return uniquePhones([main, e.notify_phone])
}

// Sends one message to every organiser number, each in its own language.
// Never throws; returns how many sends Twilio accepted.
export async function notifyOrganizer(
  event: EventRecipientSource,
  build: (lang: Lang) => string,
  opts: SendOptions,
  primary?: string | null,
): Promise<number> {
  const phones = await organizerPhones(event, primary)
  let ok = 0
  for (const p of phones) {
    try {
      const lang = await getLangByPhone(p)
      const r = await sendWhatsApp(p, build(lang), opts)
      if (r.ok) ok++
    } catch (e) {
      console.warn('[event-recipients] send failed to=%s: %s', p, (e as Error).message)
    }
  }
  return ok
}
