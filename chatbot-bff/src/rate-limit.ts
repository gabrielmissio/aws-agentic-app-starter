import { ConditionalCheckFailedException, type DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb'

export interface RateLimitConfig {
  /** Max calls a single caller gets per window. */
  limit: number
  windowSeconds: number
}

/**
 * Generous enough that a real conversation never trips it, bounded enough that a runaway client
 * loop is caught in a minute, not an invoice — the same reasoning as `API_RATE_LIMIT` in infra, one
 * layer down: that one bounds the whole account, this one bounds a single caller.
 */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = { limit: 20, windowSeconds: 60 }

/**
 * Reads USER_RATE_LIMIT / USER_RATE_LIMIT_WINDOW_SECONDS, falling back to `DEFAULT_RATE_LIMIT`.
 *
 * Silently falls back rather than throwing on a bad value — unlike infra's own `resolveApiThrottle`,
 * which throws at `cdk synth` time, where a loud failure just stops a deploy. This runs at Lambda
 * cold start; throwing here would take the whole chat route down over a malformed env var instead of
 * over the thing the var actually controls.
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
 * Fixed-window quota, one caller at a time, backed by one DynamoDB item per (caller, window).
 *
 * `UpdateItem`'s conditional write is what makes the check-and-increment atomic across concurrent
 * Lambda invocations for the same caller — there is no read-then-write gap for two requests racing
 * each other to both slip in over the limit. The window key changes every `windowSeconds`, so a
 * throttled caller recovers automatically at the next boundary; the item's own DynamoDB TTL (set two
 * windows out, past its own boundary) is what cleans it up afterward, so nothing here has to.
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
