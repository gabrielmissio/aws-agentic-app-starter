import { describe, expect, it } from 'vitest'
import { MAX_BODY_BYTES, MAX_BODY_LENGTH } from '../limits.js'

describe('limits', () => {
  it('defaults MAX_BODY_LENGTH to a positive number', () => {
    expect(MAX_BODY_LENGTH).toBeGreaterThan(0)
  })

  // MAX_BODY_BYTES has to clear MAX_BODY_LENGTH's worst-case UTF-8 cost (4 bytes/char), or
  // express.raw() would reject an oversized-but-legal-length body before the character check in
  // index.ts ever runs — which is exactly the silent-HTML-413 bug this pair of constants exists to
  // avoid. See the note in limits.ts.
  it('sizes the byte ceiling to never trip before the character ceiling does', () => {
    expect(MAX_BODY_BYTES).toBe(`${MAX_BODY_LENGTH * 4}b`)

    const worstCaseUtf8Bytes = MAX_BODY_LENGTH * 4
    const byteLimit = Number(MAX_BODY_BYTES.replace(/b$/, ''))
    expect(byteLimit).toBeGreaterThanOrEqual(worstCaseUtf8Bytes)
  })
})
