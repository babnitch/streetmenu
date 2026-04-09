import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'

function deriveToken(password: string): string {
  return crypto.createHmac('sha256', password).update('streetmenu-admin-v1').digest('hex')
}

export async function POST(req: NextRequest) {
  const { password } = await req.json()
  const adminPassword = process.env.ADMIN_PASSWORD

  if (!adminPassword) {
    return NextResponse.json({ error: 'ADMIN_PASSWORD not set on server' }, { status: 500 })
  }

  if (password !== adminPassword) {
    return NextResponse.json({ error: 'Incorrect password' }, { status: 401 })
  }

  const token = deriveToken(adminPassword)
  return NextResponse.json({ token })
}

// Used by layout to verify a stored token is still valid
export async function GET(req: NextRequest) {
  const token = req.headers.get('x-admin-token')
  const adminPassword = process.env.ADMIN_PASSWORD

  if (!adminPassword || !token) {
    return NextResponse.json({ valid: false }, { status: 401 })
  }

  const expected = deriveToken(adminPassword)
  return NextResponse.json({ valid: token === expected })
}
