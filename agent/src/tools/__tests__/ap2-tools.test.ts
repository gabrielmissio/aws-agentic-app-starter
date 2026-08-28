import { describe, expect, it } from 'vitest'
import { ap2Tools } from '../ap2/tools'
import { entityUrlsFromEnv } from '../ap2/entity-client'

const CONFIGURED = {
  MERCHANT_URL: 'https://merchant.lambda-url.us-east-1.on.aws/',
  CONSENT_URL: 'https://consent.lambda-url.us-east-1.on.aws/',
  CP_URL: 'https://cp.lambda-url.us-east-1.on.aws/',
} as NodeJS.ProcessEnv

describe('entityUrlsFromEnv', () => {
  it('resolves the three URLs when all are set', () => {
    expect(entityUrlsFromEnv(CONFIGURED)).toEqual({
      merchantUrl: CONFIGURED.MERCHANT_URL,
      consentUrl: CONFIGURED.CONSENT_URL,
      cpUrl: CONFIGURED.CP_URL,
    })
  })

  it('resolves to null when any is missing, rather than half-configuring', () => {
    // Partial configuration would register tools that fail on one entity and not another — a worse
    // failure than not offering them, because it looks like an outage rather than a setup gap.
    expect(entityUrlsFromEnv({} as NodeJS.ProcessEnv)).toBeNull()
    expect(entityUrlsFromEnv({ ...CONFIGURED, CP_URL: undefined })).toBeNull()
    expect(entityUrlsFromEnv({ ...CONFIGURED, MERCHANT_URL: '' })).toBeNull()
  })
})

describe('ap2Tools', () => {
  it('offers nothing when the entities are not configured', () => {
    expect(ap2Tools({} as NodeJS.ProcessEnv)).toEqual([])
  })

  it('offers exactly the four propose-only tools', () => {
    const names = ap2Tools(CONFIGURED).map((t) => t.toolSpec.name)
    expect(names).toEqual([
      'search_products',
      'create_merchant_cart',
      'list_payment_methods',
      'initiate_consent_session',
    ])
  })

  it('gives the agent no tool that could move money', () => {
    // The toolset is the enforcement boundary, not the prompt. Signing a mandate, issuing a
    // credential and settling all live in the BFF behind a human approval the agent never sees — so
    // a tool named for any of them appearing here would be a real regression, not a rename.
    const names = ap2Tools(CONFIGURED).map((t) => t.toolSpec.name)
    for (const forbidden of [
      'submit_consent_decision',
      'request_payment_credential',
      'initiate_payment',
      'redeem',
      'poll_consent_status',
      'get_payment_status',
    ]) {
      expect(names).not.toContain(forbidden)
    }
  })

  it('takes no user id as a tool parameter', () => {
    // An identity the model can pass is an identity a prompt can change. The tools read the caller
    // the BFF verified from the request scope instead — see tools/ap2/caller.ts.
    //
    // Asserted against `toolSpec`, which is exactly what is put in front of the model: a parameter
    // absent from the schema is one the model has no way to supply.
    const specs = JSON.stringify(ap2Tools(CONFIGURED).map((t) => t.toolSpec))
    expect(specs).not.toContain('userId')
  })
})
