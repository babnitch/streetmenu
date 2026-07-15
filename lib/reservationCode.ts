import { supabaseAdmin } from '@/lib/supabaseAdmin'

// Short reservation codes (e.g. "A3F7") — the event-reservation analogue of an
// order's #XXXX. Customers quote them to organizers; organizers check people in
// by them. Stored in event_reservations.reservation_code (UNIQUE).
//
// Alphabet excludes visually ambiguous characters (0/O, 1/I) so a code read
// aloud or typed on a phone keypad can't be mistaken. 32^4 ≈ 1M combinations.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function randomReservationCode(len = 4): string {
  let s = ''
  for (let i = 0; i < len; i++) {
    s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  }
  return s
}

// Returns a code not currently present in event_reservations. Pre-checks each
// candidate against the DB so collisions are caught before insert; the UNIQUE
// index is the final backstop for the rare concurrent race. Widens to 5 then 6
// chars if the 4-char space ever proves crowded (defensive — never expected).
export async function generateReservationCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomReservationCode(attempt < 6 ? 4 : attempt < 9 ? 5 : 6)
    const { data } = await supabaseAdmin
      .from('event_reservations')
      .select('id')
      .eq('reservation_code', code)
      .maybeSingle()
    if (!data) return code
  }
  return randomReservationCode(6)
}

// Generate N distinct codes in one call (for multi-row/tiered bookings), each
// checked against the DB and against the others picked in this batch.
export async function generateReservationCodes(n: number): Promise<string[]> {
  const codes: string[] = []
  const taken = new Set<string>()
  for (let i = 0; i < n; i++) {
    let code = await generateReservationCode()
    // Guard against picking the same code twice within this batch (the DB
    // pre-check can't see rows we haven't inserted yet).
    let guard = 0
    while (taken.has(code) && guard++ < 10) code = await generateReservationCode()
    taken.add(code)
    codes.push(code)
  }
  return codes
}
