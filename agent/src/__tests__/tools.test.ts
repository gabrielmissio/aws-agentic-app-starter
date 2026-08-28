import { describe, expect, it } from 'vitest'
import { createTools } from '../tools'
import { withCaller } from '../caller'

/**
 * The SDK's tool objects expose `toolSpec` — exactly what is put in front of the model — and
 * `invoke`, which runs the callback. Exercising `invoke` rather than the raw callback keeps these
 * tests on the same path the agent takes, including the SDK's own input handling.
 */
type ToolLike = {
  toolSpec: { name: string }
  invoke: (input: Record<string, unknown>) => Promise<unknown>
}

const tools = () => createTools() as unknown as ToolLike[]
const byName = (name: string) => {
  const found = tools().find((t) => t.toolSpec.name === name)
  if (!found) throw new Error(`no tool named ${name}`)
  return found
}

describe('the toolset', () => {
  it('offers the tools the system prompt names', () => {
    // The prompt tells the model to call these by name. A rename here without a matching prompt
    // edit produces a model that describes a capability it cannot reach.
    expect(tools().map((t) => t.toolSpec.name)).toEqual(['get_current_time', 'get_signed_in_user'])
  })

  it('takes no user id as a tool parameter', () => {
    // An identity the model can pass is an identity a prompt can change. Tools read the caller the
    // BFF verified from the request scope instead — see caller.ts. This is the invariant a new
    // tool has to preserve, which is why it is asserted over the whole toolset rather than one tool.
    //
    // Asserted against `toolSpec`, which is exactly what is put in front of the model: a parameter
    // absent from the schema is one the model has no way to supply.
    const specs = JSON.stringify(tools().map((t) => t.toolSpec))
    expect(specs).not.toContain('userId')
    expect(specs).not.toContain('user_id')
  })
})

describe('get_current_time', () => {
  it('answers in the requested timezone', async () => {
    const result = (await byName('get_current_time').invoke({
      timezone: 'America/Sao_Paulo',
    })) as Record<string, string>

    expect(result.timezone).toBe('America/Sao_Paulo')
    expect(result.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(result.localTime).toMatch(/^\d{2}:\d{2}$/)
    expect(Date.parse(result.iso as string)).not.toBeNaN()
  })

  it('defaults to UTC when no timezone is given', async () => {
    const result = (await byName('get_current_time').invoke({})) as Record<string, string>
    expect(result.timezone).toBe('UTC')
  })

  it('explains a bad timezone instead of throwing', async () => {
    // `Intl` throws on an unknown zone. An exception out of a callback reaches the model as an
    // opaque tool failure; a message naming the bad value is something it can recover from.
    const result = (await byName('get_current_time').invoke({
      timezone: 'Mars/Olympus_Mons',
    })) as Record<string, string>
    expect(result.error).toContain('Mars/Olympus_Mons')
  })
})

describe('get_signed_in_user', () => {
  it('reads the caller from the request scope', async () => {
    const result = await withCaller({ userId: 'sub-123', email: 'ana@example.com' }, () =>
      byName('get_signed_in_user').invoke({}),
    )
    expect(result).toEqual({ userId: 'sub-123', email: 'ana@example.com', displayName: null })
  })

  it('declines when the turn carries no verified identity', async () => {
    // Reached only when something other than the BFF invoked the runtime — the one moment a tool
    // must not act for anyone. It explains itself rather than guessing at a user.
    const result = (await byName('get_signed_in_user').invoke({})) as Record<string, string>
    expect(result.error).toContain('no server-verified identity')
    expect(result.userId).toBeUndefined()
  })
})
