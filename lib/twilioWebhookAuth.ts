// Twilio webhooks without TWILIO_AUTH_TOKEN (no way to check the
// X-Twilio-Signature): refused in production — a missing variable must
// never open the webhook to forged requests — and allowed elsewhere (the
// local test server and dev), with a warning, as before.

export function isProductionDeploy(): boolean {
  return process.env.VERCEL_ENV === 'production'
}

// What to do when the token is missing: 'refuse' in production (an error is
// logged), 'allow' elsewhere (a warning is logged).
export function missingTwilioTokenPolicy(route: string): 'refuse' | 'allow' {
  if (isProductionDeploy()) {
    console.error(`[${route}] TWILIO_AUTH_TOKEN is not set in production — request REFUSED (403). Set it in Vercel.`)
    return 'refuse'
  }
  console.warn(`[${route}] TWILIO_AUTH_TOKEN not set — skipping signature validation (dev mode).`)
  return 'allow'
}
