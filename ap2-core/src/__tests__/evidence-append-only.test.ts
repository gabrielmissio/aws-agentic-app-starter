import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The audit trail is append-only at the *write*, not only at the grant.
 *
 * The entity roles hold `dynamodb:PutItem` and nothing else, which is what the IAM policy calls
 * append-only — and it does stop an `UpdateItem` or a `DeleteItem`. But `PutItem` on a key that
 * already exists is an overwrite, so the grant alone left the one table whose whole purpose is to
 * be trustworthy afterwards editable by anything that could write to it.
 *
 * These are unit tests over the command the adapter builds, because the property lives in the
 * request rather than in any behaviour reachable in memory: what has to hold is that the write
 * carries a condition, and that the key it is conditioned on cannot be guessed.
 */

const send = vi.fn()
const randomBytesSpy = vi.fn()

// Delegates to the real implementation while counting the calls: the property being pinned is
// *which source* the suffix comes from, and that is not observable in the output — `Math.random()`
// produces eight hex characters and fifty distinct values just as happily.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    randomBytes: (n: number) => {
      randomBytesSpy(n)
      return actual.randomBytes(n)
    },
  }
})

// The adapter only constructs these; nothing here calls into them.
vi.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: function DynamoDBClient() {} }))
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send }) },
  PutCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  QueryCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}))

async function record(): Promise<Record<string, unknown>> {
  const { DynamoEvidence } = await import('../adapters-aws/evidence-dynamo')
  await new DynamoEvidence().record({ journeyId: 'j_1', entity: 'mpp', type: 'PAYMENT_RECEIPT' })
  return (send.mock.calls.at(-1)?.[0] as { input: Record<string, unknown> }).input
}

describe('appending to the evidence store', () => {
  beforeEach(() => {
    process.env.TABLE_EVIDENCE = 'evidence'
    send.mockReset()
    send.mockResolvedValue({})
    randomBytesSpy.mockReset()
  })

  it('refuses to write over an entry that already exists', () => {
    // Without the condition, a second write to the same key silently replaces the first — the audit
    // trail losing a step, or being made to say something else, with no trace that it happened.
    return record().then((input) => {
      expect(input.ConditionExpression).toBe('attribute_not_exists(sk)')
    })
  })

  it('separates two entries written in the same millisecond', async () => {
    // Two entities legitimately record inside one millisecond. Without a distinguishing suffix the
    // condition above would reject the *legitimate* second write, turning an integrity control into
    // a lost step — so the suffix is what makes append-only survive concurrency.
    vi.setSystemTime(new Date('2026-08-27T12:00:00.000Z'))
    const first = await record()
    const second = await record()

    expect(first.Item).not.toEqual(second.Item)
    const sk = (i: Record<string, unknown>) => (i.Item as { sk: string }).sk
    expect(sk(first)).not.toBe(sk(second))
    expect(sk(first).startsWith('2026-08-27T12:00:00.000Z#PAYMENT_RECEIPT#')).toBe(true)
  })

  it('draws the suffix from a CSPRNG, not from Math.random', async () => {
    // A predictable suffix lets a writer aim a second write at an existing key, which is the one
    // thing the condition above exists to prevent — so the guarantee is only as good as the source.
    const suffixes = new Set<string>()
    for (let i = 0; i < 50; i++) {
      suffixes.add(((await record()).Item as { sk: string }).sk.split('#')[2] as string)
    }

    expect(randomBytesSpy).toHaveBeenCalledTimes(50)
    expect(randomBytesSpy).toHaveBeenCalledWith(4)
    expect(suffixes.size).toBe(50)
    for (const suffix of suffixes) expect(suffix).toMatch(/^[0-9a-f]{8}$/)
  })
})
