import { ConditionalCheckFailedException, type DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb'

export interface RateLimitConfig {
  /** Max calls a single caller gets per window. */
  limit: number
  windowSeconds: number
}

/** Generous for a real conversation, tight enough that a runaway loop is caught in a minute. */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = { limit: 20, windowSeconds: 60 }

/**
 * Falls back silently on a bad value rather than throwing, unlike infra's `resolveApiThrottle`: that
 * one runs at synth, this at cold start, where throwing takes the whole chat route down.
 */
export function resolveRateLimitConfig(
  env: Record<string, string | undefined> = process.env,
): RateLimitConfig {
  const limit = Number(env.USER_RATE_LIMIT)
  const windowSeconds = Number(env.USER_RATE_LIMIT_WINDOW_SECONDS)

  return {
    limit: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_RATE_LIMIT.limit,
    windowSeconds:
      Number.isFinite(windowSeconds) && windowSeconds > 0
        ? windowSeconds
        : DEFAULT_RATE_LIMIT.windowSeconds,
  }
}

export interface RateLimitResult {
  allowed: boolean
  /** Seconds until the caller can retry — only set when `allowed` is false. */
  retryAfterSeconds?: number
}

/**
 * Fixed-window quota, one DynamoDB item per (caller, window). The conditional `UpdateItem` makes the
 * check-and-increment atomic across concurrent invocations — no read-then-write gap for two requests
 * to both slip in over the limit. The window key rolls on its own, and the item's TTL prunes it.
 */
export async function checkRateLimit(
  client: Pick<DynamoDBClient, 'send'>,
  tableName: string,
  callerId: string,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const nowSeconds = Math.floor(now / 1000)
  const windowStart = Math.floor(nowSeconds / config.windowSeconds) * config.windowSeconds
  const pk = `${callerId}#${windowStart}`
  const ttl = windowStart + config.windowSeconds * 2

  try {
    await client.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: { S: pk } },
        UpdateExpression: 'ADD callCount :incr SET expiresAt = if_not_exists(expiresAt, :ttl)',
        ConditionExpression: 'attribute_not_exists(callCount) OR callCount < :limit',
        ExpressionAttributeValues: {
          ':incr': { N: '1' },
          ':limit': { N: String(config.limit) },
          ':ttl': { N: String(ttl) },
        },
      }),
    )

    return { allowed: true }
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return { allowed: false, retryAfterSeconds: Math.max(windowStart + config.windowSeconds - nowSeconds, 1) }
    }

    throw err
  }
}
