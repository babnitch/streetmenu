import { redirect } from 'next/navigation'

// /join — the old public, ownerless restaurant signup. Retired in C3: adding a
// restaurant needs an account (the owner), so /join now goes to the
// logged-in form; logged-out visitors pass through /login first.
export default function JoinPage() {
  redirect('/pro/restaurants/new')
}
