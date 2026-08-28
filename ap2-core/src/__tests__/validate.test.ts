import { describe, expect, it } from 'vitest'
import { HttpError } from '../http'
import * as v from '../validate'

/**
 * The entity boundary, as a set of properties.
 *
 * Every entity is reachable by the agent over SigV4, and AP2 is explicit that an agent is to be
 * treated as an attacker — so "a caller would not send that" is not an argument, and the handlers
 * used to cast the body to a shape and check a field or two. What these tests pin is the line
 * between what the schemas cover (the envelope, the identifiers, the counts and the sizes, all of
 * which reach DynamoDB or KMS *before* any verification runs) and what they deliberately leave to
 * the cryptography.
 */

/** Runs a parse and returns the thrown HttpError, so status and code can be asserted. */
function refusal(run: () => unknown): HttpError {
  try {
    run()
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError)
    return e as HttpError
  }
  throw new Error('expected the request to be refused, but it was accepted')
}

describe('what the boundary accepts', () => {
  it('returns the parsed fields, typed, when a request is well formed', () => {
    const out = v.parseRequest(
      { op: 'x', journeyId: 'journey_abc', qty: 3, keep: true },
      { journeyId: v.identifier(), qty: v.integer({ min: 1, max: 10 }), keep: v.flag() },
    )

    expect(out).toEqual({ journeyId: 'journey_abc', qty: 3, keep: true })
  })

  it('lets every operation carry the identity token the client attaches to all of them', () => {
    // The entity client appends `identityToken` to every call, including the ones that resolve no
    // caller. A strict shape that did not know that would reject the catalog search.
    expect(() =>
      v.parseRequest(
        { op: 'search_products', identityToken: 'ey.token', query: 'bowl' },
        { query: v.optional(v.text({ min: 0, max: 200 })) },
      ),
    ).not.toThrow()
  })

  it('distinguishes an absent optional field from an explicit null', () => {
    const shape = { note: v.optional(v.text({ max: 10 })) }
    expect(v.parseRequest({}, shape)).toEqual({})
    expect(refusal(() => v.parseRequest({ note: null }, shape)).status).toBe(400)
  })
})

describe('what the boundary refuses', () => {
  it('rejects a field the operation does not have', () => {
    // Far more often a client that has drifted — a renamed field, a stale deploy — than a harmless
    // extra. Accepting it silently means the entity acts on a request nobody wrote.
    const err = refusal(() =>
      v.parseRequest(
        { op: 'x', journeyId: 'j', userId: 'someone-else' },
        { journeyId: v.identifier() },
      ),
    )

    expect(err.status).toBe(400)
    expect(err.message).toContain('userId')
  })

  it('rejects a missing required field by name', () => {
    expect(
      refusal(() => v.parseRequest({ op: 'x' }, { journeyId: v.identifier() })).message,
    ).toContain('journeyId')
  })

  it('bounds an identifier by length and by character set', () => {
    // These ids become DynamoDB keys, log lines, evidence sort keys and URL segments, each with its
    // own thing it would rather not receive.
    const shape = { journeyId: v.identifier(32) }
    expect(refusal(() => v.parseRequest({ journeyId: 'j'.repeat(33) }, shape)).status).toBe(400)
    expect(refusal(() => v.parseRequest({ journeyId: 'has spaces' }, shape)).status).toBe(400)
    expect(refusal(() => v.parseRequest({ journeyId: 'line\nbreak' }, shape)).status).toBe(400)
    expect(() => v.parseRequest({ journeyId: 'journey_a-b.c:d#1' }, shape)).not.toThrow()
  })

  it('never echoes a rejected value back to the caller', () => {
    // The message says which field and what about it, and nothing about what was sent — an error
    // that quotes its input is a reflection point and a log-poisoning one.
    const err = refusal(() =>
      v.parseRequest({ journeyId: '<script>alert(1)</script>' }, { journeyId: v.identifier() }),
    )
    expect(err.message).not.toContain('script')
  })

  it('bounds arrays before they are turned into objects and priced', () => {
    const shape = {
      items: v.list(v.group({ productId: v.identifier(), qty: v.integer({ min: 1 }) }), { max: 3 }),
    }

    expect(() => v.parseRequest({ items: [{ productId: 'a', qty: 1 }] }, shape)).not.toThrow()
    expect(
      refusal(() =>
        v.parseRequest(
          { items: Array.from({ length: 4 }, () => ({ productId: 'a', qty: 1 })) },
          shape,
        ),
      ).status,
    ).toBe(400)
  })

  it('is strict inside nested objects too', () => {
    const shape = { proof: v.group({ channel: v.text({ max: 8 }) }) }
    expect(
      refusal(() => v.parseRequest({ proof: { channel: 'WEB', extra: 1 } }, shape)).message,
    ).toContain('extra')
  })

  it('rejects a value outside a closed set rather than signing it into an artifact', () => {
    // `channel` is signed into `risk_data` on both mandates, where a verifier reads it as
    // authoritative — an unrecognized value would become part of a signed claim.
    const shape = { channel: v.oneOf(['WEB', 'WHATSAPP_FLOW'] as const) }
    expect(() => v.parseRequest({ channel: 'WEB' }, shape)).not.toThrow()
    expect(refusal(() => v.parseRequest({ channel: 'SMS' }, shape)).status).toBe(400)
  })

  it('refuses an oversized body before doing any of the work it would buy', () => {
    const err = refusal(() =>
      v.parseRequest({ blob: 'x'.repeat(v.MAX_BODY_BYTES + 1) }, { blob: v.opaque() }),
    )

    // 413, not 400: the request may be perfectly well formed and still be too large to accept.
    expect(err.status).toBe(413)
  })

  it('bounds a signed artifact without describing it', () => {
    // The domain verifies these cryptographically — a signature over the canonical form is a far
    // stronger check than a schema, and a second definition here would only drift from it. What is
    // needed is that an oversized one cannot reach storage or KMS first.
    const shape = { cartMandate: v.opaque(1024) }

    expect(() =>
      v.parseRequest({ cartMandate: { contents: { id: 'cart_1' } } }, shape),
    ).not.toThrow()
    expect(
      refusal(() => v.parseRequest({ cartMandate: { blob: 'x'.repeat(2048) } }, shape)).status,
    ).toBe(400)
    expect(refusal(() => v.parseRequest({ cartMandate: 42 }, shape)).status).toBe(400)
  })

  it('keeps an oversized artifact out of the consent session that would store it', () => {
    // A consent session persists the cart it was opened over. Unbounded, that write is the first
    // thing to notice — as a DynamoDB item-size failure, after the request was accepted.
    expect(v.MAX_ARTIFACT_BYTES).toBeLessThan(400 * 1024)
    expect(v.MAX_BODY_BYTES).toBeLessThan(400 * 1024)
  })
})
