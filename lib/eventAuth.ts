// Who owns an event, for authorization purposes.
//
// Events link to their publisher through TWO columns: `organizer_id` (the
// current submit flow) and `submitted_by` (legacy rows, plus the backfill in
// supabase-optimization.sql that matched events.whatsapp against a customer).
// /api/events/my already lists an event when EITHER column matches — but the
// action routes used to check `organizer_id` alone, so an organizer whose
// event was linked through `submitted_by` could see their event and its
// reservations and then get a 403 on every action (confirm, reject, cancel,
// check-in…). This helper is the single rule both sides use.

export interface EventOwnerFields {
  organizer_id?:  string | null
  submitted_by?:  string | null
}

// Column list to include in the `.select()` of any route that authorizes an
// organizer, so the check below always has what it needs.
export const EVENT_OWNER_COLUMNS = 'organizer_id, submitted_by'

export function isEventOrganizer(
  event: EventOwnerFields | null | undefined,
  sessionId: string | null | undefined,
): boolean {
  if (!event || !sessionId) return false
  return event.organizer_id === sessionId || event.submitted_by === sessionId
}
