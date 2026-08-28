import * as strands from '@strands-agents/sdk'
import { z } from 'zod'
import { currentCaller } from './caller'

/**
 * The agent's toolset — and where a new project adds its own. These two are deliberately trivial;
 * what they demonstrate is the part that is easy to get wrong.
 *
 * **No tool takes a user id.** `get_signed_in_user` acts for a person and still has an empty input
 * schema, because identity comes from `currentCaller()` (see `caller.ts`). A `userId` parameter
 * would make the answer a function of whatever the model was persuaded to pass, and the model reads
 * attacker-influenceable text.
 *
 * A tool reaching a backend follows the same rule: grant the runtime role access to it, sign with
 * SigV4, and let the *service* scope the read to the caller. Never let a tool argument decide whose
 * data comes back.
 */

/**
 * Structurally identical to the SDK's un-exported `JSONValue`. Annotating each callback's return
 * with it makes TypeScript check every `return` independently, instead of widening the
 * success-or-error union into a shape the SDK's index signature rejects.
 */
type Json = string | number | boolean | null | { [k: string]: Json } | Json[]

/**
 * The identity the BFF verified, or an explanation the model can relay. A correctly deployed runtime
 * always carries one, so a turn without it means the runtime was reached some other way — exactly
 * when a tool must not act for anyone.
 */
function requireCaller(): { userId: string; email?: string; displayName?: string } | { error: string } {
  const caller = currentCaller()
  if (!caller) {
    return {
      error:
        'This session carries no server-verified identity, so personal details are unavailable ' +
        'here. Tell the user you can still help with everything else. Do not ask them to sign in ' +
        'again — they are.',
    }
  }
  return caller
}

export function createTools() {
  const getCurrentTime = strands.tool({
    name: 'get_current_time',
    description:
      'The current date and time. Call this before answering anything that depends on "now" — ' +
      'today\'s date, what day of the week it is, how long until something, or scheduling. Never ' +
      'guess the date from your training data.',
    inputSchema: z.object({
      timezone: z
        .string()
        .optional()
        .describe('IANA timezone, e.g. "America/Sao_Paulo" or "Europe/Lisbon". Defaults to UTC.'),
    }),
    async callback({ timezone }): Promise<Json> {
      const zone = timezone?.trim() || 'UTC'
      const now = new Date()
      try {
        return {
          timezone: zone,
          iso: now.toISOString(),
          // `en-CA` renders as YYYY-MM-DD, which is unambiguous to a model in any locale.
          localDate: new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(now),
          localTime: new Intl.DateTimeFormat('en-GB', {
            timeZone: zone,
            hour: '2-digit',
            minute: '2-digit',
          }).format(now),
          weekday: new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long' }).format(now),
        }
      } catch {
        // `Intl` throws on an unknown zone; the model can recover from being told which one.
        return { error: `"${zone}" is not a valid IANA timezone. Try "UTC" or a "Region/City" name.` }
      }
    },
  })

  const getSignedInUser = strands.tool({
    name: 'get_signed_in_user',
    description:
      "The signed-in user's account details — how to address them, and which email their account " +
      'uses. Takes no arguments: the user is whoever is signed in to this session.',
    inputSchema: z.object({}),
    async callback(): Promise<Json> {
      const caller = requireCaller()
      if ('error' in caller) return caller
      return {
        userId: caller.userId,
        email: caller.email ?? null,
        displayName: caller.displayName ?? null,
      }
    },
  })

  return [getCurrentTime, getSignedInUser]
}
