// Canonical bilingual role labels.
//
// Roles show up in at least three places (the /account profile, the admin
// accounts list, restaurant team lists) and used to drift apart — "Vendeur
// Propriétaire", "Vendeur Owner", "Propriétaire". One source of truth here
// keeps them identical everywhere.
//
// Every export is a [fr, en] tuple, so a component with `const bi = useBi()`
// renders one with `bi(...ROLE_LABELS[role])`.

export type TeamRole = 'owner' | 'manager' | 'staff'

export type BiLabel = readonly [fr: string, en: string]

// Someone with no restaurant attached. Deliberately "Client" in both
// languages — it reads naturally in English and matches how the team
// refers to these accounts.
export const CLIENT_LABEL: BiLabel = ['Client', 'Client']

export const ROLE_LABELS: Record<TeamRole, BiLabel> = {
  owner:   ['Restaurateur', 'Restaurant Owner'],
  manager: ['Manager', 'Manager'],
  staff:   ['Staff', 'Staff'],
}

// Falls back to the raw role string for any value not in the map (a role
// added to the DB before the UI knows about it).
export function roleLabel(role: string): BiLabel {
  return ROLE_LABELS[role as TeamRole] ?? [role, role]
}

// ── Event publisher ─────────────────────────────────────────────────────────
// An orthogonal role: anyone — plain customer or restaurateur — becomes a
// publisher by submitting an event, and a *verified* publisher once an admin
// has granted event_auto_approve (see app/api/admin/events/[id]/approve).
export interface PublisherTrust {
  events_submitted_count?: number | null
  event_auto_approve?:     boolean | null
}

export const PUBLISHER_LABEL:          BiLabel = ['📢 Éditeur', '📢 Publisher']
export const VERIFIED_PUBLISHER_LABEL: BiLabel = ['✅ Éditeur vérifié', '✅ Verified Publisher']

// Returns the badge to show alongside the account's primary role, or null
// when the account has never submitted an event.
export function publisherLabel(trust: PublisherTrust | null | undefined): BiLabel | null {
  if (!trust) return null
  if ((trust.events_submitted_count ?? 0) <= 0) return null
  return trust.event_auto_approve ? VERIFIED_PUBLISHER_LABEL : PUBLISHER_LABEL
}
