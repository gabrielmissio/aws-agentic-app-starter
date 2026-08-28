import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb'

/**
 * The OTP attempt ceiling — the control that turns a six-digit code into a real one.
 *
 * A million possibilities only bound an attacker if the number of attempts is bounded too. Before
 * this, a wrong code returned 401 and left the intent `pending`, so it could be presented again
 * until the window closed; the only ceiling was the account-wide stage throttle, shared with every
 * other caller.
 */
const send = vi.fn()
vi.mock('@aws-sdk/lib-dynamodb', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/lib-dynamodb')>('@aws-sdk/lib-dynamodb')
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send: (...a: unknown[]) => send(...a) }) },
  }
})

process.env.INTENTS_TABLE = 'test-intents'
const { consumeOtpAttempt } = await import('../ap2/intent-store.js')

beforeEach(() => send.mockReset())

describe('consumeOtpAttempt', () => {
  it('spends an attempt with a conditional ADD, so concurrent confirms cannot both slip past', async () => {
    send.mockResolvedValueOnce({})
    await expect(consumeOtpAttempt('cs_1', 5)).resolves.toBe(true)

    const command = send.mock.calls[0][0] as { input: Record<string, unknown> }
    expect(command.input.UpdateExpression).toBe('ADD otpAttempts :one')
    // The condition is what makes the ceiling real: a read-then-write would let two requests both
    // observe "4 used" and both proceed.
    expect(command.input.ConditionExpression).toBe(
      'attribute_not_exists(otpAttempts) OR otpAttempts < :max',
    )
    expect(command.input.ExpressionAttributeValues).toMatchObject({ ':one': 1, ':max': 5 })
  })

  it('reports the budget as spent when the condition fails, rather than throwing', async () => {
    send.mockRejectedValueOnce(
      new ConditionalCheckFailedException({ $metadata: {}, message: 'exhausted' }),
    )
    await expect(consumeOtpAttempt('cs_1', 5)).resolves.toBe(false)
  })

  it('propagates a real failure instead of silently granting an attempt', async () => {
    // Swallowing this would fail *open*: a throttled table would hand out unlimited attempts.
    send.mockRejectedValueOnce(new Error('ProvisionedThroughputExceeded'))
    await expect(consumeOtpAttempt('cs_1', 5)).rejects.toThrow('ProvisionedThroughputExceeded')
  })
})
