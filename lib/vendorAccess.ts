import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

// Server-only. Shared owner|manager gate for vendor write routes.
//
// Lives here rather than inline in each route because the menu collection
// and item routes need the identical check, and a Next.js route.ts may only
// export HTTP handlers — so it can't be shared between them directly.
//
// Resolution order, matching the open / hours / override / vouchers routes:
//   1. no session                          → 401
//   2. admin role                          → allowed
//   3. non-customer, non-admin             → 401
//   4. restaurants.customer_id === session → allowed, treated as owner.
//      "Implicit owners" are real: a restaurant can exist with customer_id
//      set and no explicit team row (see app/api/vendor/restaurants).
//   5. active restaurant_team row, owner|manager → allowed
//   6. anything else (including staff)     → 403
//
// Staff are deliberately excluded: they get read-only menu access, matching
// navConfig's minRole 'manager' on the Menu tab.
//
// Returns null when the caller is authorized, or the NextResponse to return
// when they are not.
export async function denyUnlessOwnerOrManager(
  req: NextRequest,
  restaurantId: string,
): Promise<NextResponse | null> {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  if (['super_admin', 'admin', 'moderator'].includes(session.role)) return null
  if (session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data: direct } = await supabaseAdmin
    .from('restaurants').select('id')
    .eq('id', restaurantId).eq('customer_id', session.id).maybeSingle()
  if (direct) return null

  const { data: team } = await supabaseAdmin
    .from('restaurant_team').select('role')
    .eq('restaurant_id', restaurantId).eq('customer_id', session.id)
    .eq('status', 'active').in('role', ['owner', 'manager']).maybeSingle()
  if (!team) {
    return NextResponse.json({ error: 'Non autorisé / Not authorized' }, { status: 403 })
  }
  return null
}

// ── Last-owner protection ───────────────────────────────────────────────────
// A restaurant must always keep at least one ACTIVE owner.
//
// Without this, an owner could remove or demote their own team row, get a
// 200, and be permanently locked out: every write route below authorizes
// solely via an active role='owner' restaurant_team row, none of them admits
// the implicit owner from restaurants.customer_id, and they answer 401 to an
// admin session — so there is no in-app recovery. Six user-facing paths could
// each reach that state (two on /team/[memberId], POST /team, POST /invite,
// and the WhatsApp "retirer" and "ajouter" handlers), which is why the rule
// lives here once instead of six times.
//
// Counts restaurant_team rows ONLY, never restaurants.customer_id. Deleted
// accounts keep a customer_id pointing at an anonymised, status='deleted'
// customer (see lib/releaseAccount.ts), and counting that would treat a
// deleted user as a live owner.
//
// NOT used by lib/releaseAccount.ts, deliberately: account deletion removes
// team rows directly through supabaseAdmin and MUST be able to remove the
// last owner. This guard protects the user-facing doors, not the data layer.

export const LAST_OWNER_ERROR =
  'Un restaurant doit garder au moins un propriétaire / A restaurant must keep at least one owner'

// True iff applying this change would leave the restaurant with zero active
// owners. `nextRole` is the role being assigned; pass null/undefined for a
// removal.
//
// Only ever blocks DROPPING to zero. Adding an owner, adding an ordinary
// member, or touching anyone who is not currently the last active owner all
// return false — so a restaurant that already has no owner can still have one
// added, and the guard can never wedge anything.
export async function wouldStripLastOwner(
  restaurantId: string,
  targetCustomerId: string,
  nextRole?: string | null,
): Promise<boolean> {
  // Promoting to (or keeping) owner can never reduce the count.
  if (nextRole === 'owner') return false

  // Is the target currently an active owner? If not, nothing is being lost.
  const { data: target } = await supabaseAdmin
    .from('restaurant_team').select('role')
    .eq('restaurant_id', restaurantId)
    .eq('customer_id', targetCustomerId)
    .eq('status', 'active')
    .maybeSingle()
  if (!target || target.role !== 'owner') return false

  // They are an owner — is anyone else? A non-head select so a missing table
  // surfaces as an error rather than a silent count of null.
  const { data: owners, error } = await supabaseAdmin
    .from('restaurant_team').select('customer_id')
    .eq('restaurant_id', restaurantId)
    .eq('role', 'owner')
    .eq('status', 'active')
  if (error) {
    console.error('[wouldStripLastOwner] owner count failed:', error.message)
    // Fail closed: refuse the destructive change rather than risk the lockout.
    return true
  }
  return (owners ?? []).length <= 1
}
