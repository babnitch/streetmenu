'use client'

// Login code screen: for the first 30 s "Renvoyer dans N s"; after that
// "Pas reçu ?" with Renvoyer (same channel) and Recevoir par SMS (when the
// code went on WhatsApp). The server keeps its own 30 s gap between sends.

import { useBi } from '@/lib/languageContext'

export default function CodeNotReceived({ cooldown, channel, busy, onResend }: {
  cooldown: number
  channel: 'whatsapp' | 'sms'
  busy: false | 'whatsapp' | 'sms'
  onResend: (channel: 'whatsapp' | 'sms') => void
}) {
  const bi = useBi()
  if (cooldown > 0) {
    return (
      <p className="text-center text-sm text-ink-tertiary py-2" aria-live="polite">
        {bi(`Pas reçu ? Renvoyer dans ${cooldown} s`, `Not received? Resend in ${cooldown} s`)}
      </p>
    )
  }
  const btn = 'flex-1 text-sm font-semibold py-2 rounded-full border border-divider bg-white hover:bg-surface-muted disabled:opacity-50 transition-colors'
  return (
    <div className="pt-1">
      <p className="text-center text-sm font-semibold text-ink-secondary mb-2">{bi('Pas reçu ?', 'Not received?')}</p>
      <div className="flex gap-2">
        <button type="button" disabled={!!busy} onClick={() => onResend(channel)} className={btn}>
          {busy === channel ? bi('Envoi…', 'Sending…') : `🔁 ${bi('Renvoyer', 'Resend')}`}
        </button>
        {channel === 'whatsapp' && (
          <button type="button" disabled={!!busy} onClick={() => onResend('sms')} className={btn}>
            {busy === 'sms' ? bi('Envoi du SMS…', 'Sending SMS…') : `💬 ${bi('Recevoir par SMS', 'Get it by SMS')}`}
          </button>
        )}
      </div>
    </div>
  )
}
