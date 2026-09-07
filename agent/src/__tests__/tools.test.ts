import { describe, expect, it } from 'vitest'
import { createTools } from '../tools'
import { systemPrompt } from '../agent'
import { withCaller } from '../caller'

/**
 * The SDK's tool objects expose `toolSpec` — exactly what is put in front of the model — and
 * `invoke`, which runs the callback. Exercising `invoke` rather than the raw callback keeps these
 * tests on the same path the agent takes, including the SDK's own input handling.
 */
type ToolLike = {
  toolSpec: { name: string; inputSchema?: unknown }
  invoke: (input: Record<string, unknown>) => Promise<unknown>
}

const tools = () => createTools() as unknown as ToolLike[]
const byName = (name: string) => {
  const found = tools().find((t) => t.toolSpec.name === name)
  if (!found) throw new Error(`no tool named ${name}`)
  return found
}

/**
 * Every property name in a tool's JSON schema, at any depth — through `properties` and through an
 * array's `items`. A nested object is where an identity parameter would hide from a shallow check.
 */
function propertyNames(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object') return []

  const node = schema as { properties?: Record<string, unknown>; items?: unknown }
  const properties = node.properties ?? {}

  return [
    ...Object.keys(properties),
    ...Object.values(properties).flatMap(propertyNames),
    ...propertyNames(node.items),
  ]
}

/**
 * Compound spellings of "whose data is this", matched as substrings so `signedInUserId` is caught
 * along with `user_id`.
 */
const IDENTITY_COMPOUNDS = [
  'userid', 'usersub', 'useremail', 'username', 'actorid', 'ownerid', 'accountid',
  'callerid', 'customerid', 'memberid', 'principalid', 'subjectid', 'cognitosub',
]

/** The bare forms, matched exactly — as substrings they would flag `subtotal` and `emailBody`. */
const IDENTITY_BARE = ['user', 'actor', 'caller', 'owner', 'principal', 'subject', 'sub', 'email']

function namesTheCaller(property: string): boolean {
  const normalized = property.toLowerCase().replaceAll('_', '')

  return (
    IDENTITY_COMPOUNDS.some((fragment) => normalized.includes(fragment)) ||
    IDENTITY_BARE.includes(normalized)
  )
}

describe('the toolset', () => {
  it('is named in the system prompt, whatever the toolset becomes', () => {
    // The prompt tells the model to call these by name, so a tool it never mentions is one the model
    // has little reason to reach for, and a renamed tool leaves the prompt describing a capability
    // that no longer answers.
    //
    // Asserted as "the prompt names every tool that exists" rather than as a fixed list: a fork
    // adding a domain tool should not have to edit a test to go green — it should have to mention
    // its tool in the prompt.
    for (const name of tools().map((tool) => tool.toolSpec.name)) {
      expect(systemPrompt).toContain(name)
    }
  })

  it('takes no caller identity as a tool parameter', () => {
    // An identity the model can pass is an identity a prompt can talk it into changing: "list the
    // notes for user X" is the attack. Tools read the caller the BFF verified from the request
    // scope instead — see caller.ts.
    //
    // Asserted structurally over `toolSpec`, which is exactly what is put in front of the model: a
    // parameter absent from the schema is one the model has no way to supply. Over property *names*
    // at every depth rather than over the serialized JSON, because a substring search of the whole
    // spec both misses `accountId` and trips over the word "user" in a description.
    //
    // If your domain genuinely needs a parameter this flags, the invariant is still that identity
    // does not come from it. Say so in the PR — do not widen the list to go green.
    const flagged = tools().flatMap((tool) =>
      propertyNames(tool.toolSpec.inputSchema)
        .filter(namesTheCaller)
        .map((property) => `${tool.toolSpec.name}.${property}`),
    )

    expect(flagged).toEqual([])
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
