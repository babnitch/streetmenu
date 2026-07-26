'use client'

import { useRef, useEffect, useCallback } from 'react'

export interface OtpInputProps {
  // Current code as a compact string (e.g. "12" while half-typed).
  value: string
  // Fired on every change with the sanitised digits-only string.
  onChange: (code: string) => void
  // Fired once the code reaches `length` digits — used to auto-submit.
  onComplete?: (code: string) => void
  length?: number
  autoFocus?: boolean
  disabled?: boolean
}

// Four (by default) single-digit boxes wired for the iOS SMS/WhatsApp
// one-time-code autofill flow:
//  - The FIRST box carries autocomplete="one-time-code" so iOS surfaces the
//    code from the notification as a keyboard suggestion. When tapped, iOS
//    injects the whole code into that box; handleChange detects the multi-
//    character insert and spreads it across every box, then auto-submits.
//  - Typing a digit advances focus; Backspace on an empty box steps back.
//  - Paste fills all boxes from the caret box onward.
export default function OtpInput({
  value,
  onChange,
  onComplete,
  length = 4,
  autoFocus = false,
  disabled = false,
}: OtpInputProps) {
  const refs = useRef<Array<HTMLInputElement | null>>([])

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus()
  }, [autoFocus])

  const focusIndex = useCallback((i: number) => {
    const clamped = Math.max(0, Math.min(i, length - 1))
    refs.current[clamped]?.focus()
    refs.current[clamped]?.select()
  }, [length])

  // Write `digits` into the boxes starting at `start`, emit the new compact
  // value, move focus to the next empty box, and fire onComplete if full.
  const fill = useCallback((start: number, digits: string) => {
    const arr = value.split('')
    for (let k = 0; k < digits.length && start + k < length; k++) {
      arr[start + k] = digits[k]
    }
    const next = arr.join('').slice(0, length)
    onChange(next)
    focusIndex(start + digits.length)
    if (next.length === length) onComplete?.(next)
  }, [value, length, onChange, onComplete, focusIndex])

  function handleChange(i: number, raw: string) {
    const digits = raw.replace(/\D/g, '')
    // Empty means the box was cleared via input (not Backspace, handled below).
    if (!digits) {
      const arr = value.split('')
      arr[i] = ''
      onChange(arr.join('').slice(0, length))
      return
    }
    // A single keystroke lands one digit; iOS autofill / paste lands many —
    // both funnel through fill() starting at this box.
    fill(i, digits)
  }

  function handleKeyDown(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace') {
      e.preventDefault()
      const arr = value.split('')
      if (arr[i]) {
        arr[i] = ''
        onChange(arr.join('').slice(0, length))
      } else if (i > 0) {
        arr[i - 1] = ''
        onChange(arr.join('').slice(0, length))
        focusIndex(i - 1)
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      focusIndex(i - 1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      focusIndex(i + 1)
    }
  }

  function handlePaste(i: number, e: React.ClipboardEvent<HTMLInputElement>) {
    const digits = e.clipboardData.getData('text').replace(/\D/g, '')
    if (!digits) return
    e.preventDefault()
    fill(i, digits)
  }

  return (
    <div className="flex justify-center gap-2 mb-3" role="group" aria-label="Verification code">
      {Array.from({ length }, (_, i) => (
        <input
          key={i}
          ref={el => { refs.current[i] = el }}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          // Only the first box advertises one-time-code so iOS attaches the
          // suggestion to a single field; the rest opt out of autofill.
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          disabled={disabled}
          aria-label={`Digit ${i + 1}`}
          value={value[i] ?? ''}
          onChange={e => handleChange(i, e.target.value)}
          onKeyDown={e => handleKeyDown(i, e)}
          onPaste={e => handlePaste(i, e)}
          onFocus={e => e.target.select()}
          className="w-12 h-14 sm:w-14 sm:h-16 border border-divider rounded-2xl text-center font-mono text-2xl text-ink-primary outline-none focus:border-brand disabled:opacity-60 bg-white"
        />
      ))}
    </div>
  )
}
