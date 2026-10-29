// Twilio webhooks without TWILIO_AUTH_TOKEN: refused in production (the
// signature can't be checked), allowed locally / in dev and on previews.

import { missingTwilioTokenPolicy, isProductionDeploy } from '@/lib/twilioWebhookAuth'
import { assertEq, step, finish } from '../testkit/assert'

const SUITE = 'unit-twilio-webhook-auth'

async function main(): Promise<void> {
  const saved = process.env.VERCEL_ENV
  const quiet = { error: console.error, warn: console.warn }
  console.error = () => {}; console.warn = () => {}
  try {
    await step('production refuses, everything else allows', () => {
      process.env.VERCEL_ENV = 'production'
      assertEq(isProductionDeploy(), true, 'production detected')
      assertEq(missingTwilioTokenPolicy('t'), 'refuse', 'production → refuse')
      process.env.VERCEL_ENV = 'preview'
      assertEq(missingTwilioTokenPolicy('t'), 'allow', 'preview → allow')
      delete process.env.VERCEL_ENV
      assertEq(missingTwilioTokenPolicy('t'), 'allow', 'local → allow')
    })
  } finally {
    console.error = quiet.error; console.warn = quiet.warn
    if (saved === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = saved
  }
  finish(SUITE)
}

void main()
