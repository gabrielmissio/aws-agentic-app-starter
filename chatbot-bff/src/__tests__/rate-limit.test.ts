import { ConditionalCheckFailedException, type UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { describe, expect, it } from 'vitest'
import { DEFAULT_RATE_LIMIT, checkRateLimit, resolveRateLimitConfig } from '../rate-limit.js'

/**
 * Replicates just enough of DynamoDB's conditional-write semantics for `checkRateLimit`'s
 * `ADD callCount :incr` + `attribute_not_exists(callCount) OR callCount < :limit` to behave the same
 * as the real table: absent → always succeeds (creates the item at count 1); present → succeeds and
 * increments only while `count < limit`, otherwise throws, exactly like a real conditional check
 * failure would.
 */
function fakeRateLimitTable() {
  const counts = new Map<string, number>()

  return {
    async send(command: UpdateItemCommand) {
      const pk = command.input.Key?.pk?.S as string
      const limit = Number(command.input.ExpressionAttributeValues?.[':limit']?.N)
      const current = counts.get(pk) ?? 0

      if (current >= limit) {
        throw new ConditionalCheckFailedException({ message: 'conditional check failed', $metadata: {} })
      }

      counts.set(pk, current + 1)
      return {}
    },
  }
}

describe('checkRateLimit', () => {
  const TABLE = 'test-rate-limit'
  const config = { limit: 2, windowSeconds: 60 }
  const now = Date.parse('2026-08-12T10:00:00Z')

  it('allows calls up to the limit and rejects the one after', async () => {
    const client = fakeRateLimitTable()

    expect(await checkRateLimit(client, TABLE, 'alice', config, now)).toEqual({ allowed: true })
    expect(await checkRateLimit(client, TABLE, 'alice', config, now)).toEqual({ allowed: true })

    const third = await checkRateLimit(client, TABLE, 'alice', config, now)
    expect(third.allowed).toBe(false)
    expect(third.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('tracks each caller independently', async () => {
    const client = fakeRateLimitTable()

    await checkRateLimit(client, TABLE, 'alice', config, now)
    await checkRateLimit(client, TABLE, 'alice', config, now)

    // Alice is exhausted; Bob has never called and is unaffected.
    expect(await checkRateLimit(client, TABLE, 'bob', config, now)).toEqual({ allowed: true })
  })

  it('resets once the window rolls over', async () => {
    const client = fakeRateLimitTable()

    await checkRateLimit(client, TABLE, 'alice', config, now)
    await checkRateLimit(client, TABLE, 'alice', config, now)
    expect((await checkRateLimit(client, TABLE, 'alice', config, now)).allowed).toBe(false)

    const nextWindow = now + config.windowSeconds * 1000
    expect(await checkRateLimit(client, TABLE, 'alice', config, nextWindow)).toEqual({ allowed: true })
  })

  it('propagates an unrelated DynamoDB error instead of treating it as throttled', async () => {
    const client = {
      async send(): Promise<never> {
        throw new Error('ProvisionedThroughputExceededException')
      },
    }

    await expect(checkRateLimit(client, TABLE, 'alice', config, now)).rejects.toThrow(
      'ProvisionedThroughputExceededException',
    )
  })
})

describe('resolveRateLimitConfig', () => {
  it('falls back to the default when unset', () => {
    expect(resolveRateLimitConfig({})).toEqual(DEFAULT_RATE_LIMIT)
  })

  it('reads both values from the given env', () => {
    expect(
      resolveRateLimitConfig({ USER_RATE_LIMIT: '5', USER_RATE_LIMIT_WINDOW_SECONDS: '30' }),
    ).toEqual({ limit: 5, windowSeconds: 30 })
  })

  // Cold-start config parsing fails open rather than throwing — see the note in rate-limit.ts.
  it('falls back per-field on a non-positive or non-numeric value instead of throwing', () => {
    expect(resolveRateLimitConfig({ USER_RATE_LIMIT: 'lots' })).toEqual(DEFAULT_RATE_LIMIT)
    expect(resolveRateLimitConfig({ USER_RATE_LIMIT: '0' })).toEqual(DEFAULT_RATE_LIMIT)
    expect(resolveRateLimitConfig({ USER_RATE_LIMIT_WINDOW_SECONDS: '-5' })).toEqual(DEFAULT_RATE_LIMIT)
  })
})
