import { HttpError, type RequestBody } from './http'

/**
 * Request validation for the entity boundary.
 *
 * **What this is for, and what it deliberately is not.** The handlers used to cast the parsed body
 * to a shape and check a field or two — so a caller could send a `journeyId` of any length, an
 * `items` array of any size, or a cart of any weight, and the first thing to notice would be
 * DynamoDB refusing a 400 KB item, KMS being asked to sign something enormous, or a 500 with a
 * stack trace. Every entity is reachable by the agent over SigV4, and AP2 is explicit that an agent
 * is to be treated as an attacker, so "the caller would not send that" is not an argument.
 *
 * It does **not** re-describe the mandates. A Cart Mandate's structure is already checked by
 * something far stronger than a schema — a signature over its canonical form — and writing a second
 * definition of it here would create two sources of truth that drift, with the weaker one running
 * first. Artifacts are therefore bounded, not parsed: `opaque()` says "an object, this big at most",
 * and the domain says whether it is genuine.
 *
 * So the rule is: schemas cover what nothing else covers — the envelope, the identifiers, the
 * counts and the sizes, all of which reach storage or KMS *before* any verification happens.
 */

/**
 * Ceiling on a whole request body.
 *
 * Sized against what these bodies actually carry — a signed cart with its disclosures is the
 * largest — and well under the 400 KB DynamoDB item limit that a consent session, which stores the
 * cart it was opened over, would otherwise hit at write time rather than at the door.
 */
export const MAX_BODY_BYTES = 256 * 1024

/** Ceiling on one signed artifact inside a request. */
export const MAX_ARTIFACT_BYTES = 128 * 1024

/** One validated field. `optional` is on the field rather than the shape so it reads at the use. */
export interface Field<T> {
  parse(value: unknown, path: string): T
  optional: boolean
}

type Shape = Record<string, Field<unknown>>
type Parsed<S extends Shape> = { [K in keyof S]: ReturnType<S[K]['parse']> }

function reject(path: string, problem: string): never {
  // One code for every shape failure. A caller correcting a request needs to know *which field* and
  // *what about it* — both of which are in the message — and a distinct code per rule would only
  // give an attacker a finer-grained oracle for what the entity accepts.
  throw new HttpError(400, `${path} ${problem}`, 'INVALID_REQUEST')
}

const field = <T>(parse: (value: unknown, path: string) => T): Field<T> => ({
  parse,
  optional: false,
})

/** Makes a field omissible. An explicit `null` is still a rejection: absent and empty are not equal. */
export function optional<T>(inner: Field<T>): Field<T | undefined> {
  return {
    optional: true,
    parse: (value, path) => (value === undefined ? undefined : inner.parse(value, path)),
  }
}

export interface TextOptions {
  max: number
  min?: number
  /** Anchored by the caller. Rejected values are never echoed back — only the constraint is. */
  pattern?: RegExp
}

export function text(opts: TextOptions): Field<string> {
  return field((value, path) => {
    if (typeof value !== 'string') return reject(path, 'must be a string')
    if (value.length < (opts.min ?? 1)) return reject(path, `must be at least ${opts.min ?? 1} characters`)
    if (value.length > opts.max) return reject(path, `exceeds ${opts.max} characters`)
    if (opts.pattern && !opts.pattern.test(value)) {
      return reject(path, 'contains characters that are not allowed here')
    }
    return value
  })
}

/**
 * The character set every id in this system uses.
 *
 * An allowlist rather than a denylist: these ids end up in DynamoDB keys, log lines, evidence sort
 * keys and URLs, and each of those has its own thing it would rather not receive. Naming what is
 * permitted survives being used somewhere nobody anticipated.
 */
const ID_PATTERN = /^[A-Za-z0-9_.:#-]+$/

/** An identifier: journey, session, mandate, payment, product, method reference. */
export function identifier(max = 128): Field<string> {
  return text({ max, pattern: ID_PATTERN })
}

export function integer(opts: { min?: number; max?: number } = {}): Field<number> {
  return field((value, path) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return reject(path, 'must be a whole number')
    }
    if (opts.min !== undefined && value < opts.min) return reject(path, `must be at least ${opts.min}`)
    if (opts.max !== undefined && value > opts.max) return reject(path, `must be at most ${opts.max}`)
    return value
  })
}

export function flag(): Field<boolean> {
  return field((value, path) =>
    typeof value === 'boolean' ? value : reject(path, 'must be true or false'),
  )
}

export function oneOf<L extends string>(values: readonly L[]): Field<L> {
  return field((value, path) =>
    typeof value === 'string' && (values as readonly string[]).includes(value)
      ? (value as L)
      : reject(path, `must be one of: ${values.join(', ')}`),
  )
}

export function list<T>(item: Field<T>, opts: { max: number; min?: number }): Field<T[]> {
  return field((value, path) => {
    if (!Array.isArray(value)) return reject(path, 'must be an array')
    if (value.length < (opts.min ?? 1)) return reject(path, `must have at least ${opts.min ?? 1} entries`)
    if (value.length > opts.max) return reject(path, `must have at most ${opts.max} entries`)
    return value.map((entry, i) => item.parse(entry, `${path}[${i}]`))
  })
}

/** A nested object, strict like the top level: an unexpected key is a rejection, not a passenger. */
export function group<S extends Shape>(shape: S): Field<Parsed<S>> {
  return field((value, path) => {
    if (!isPlainObject(value)) return reject(path, 'must be an object')
    return applyShape(value, shape, `${path}.`)
  })
}

/**
 * A signed artifact: bounded, but not described.
 *
 * The domain verifies these cryptographically, so all that is needed here is that the thing is of
 * the right kind and cannot be used to push an oversized item into storage or an oversized message
 * into KMS before that verification runs.
 */
export function opaque(maxBytes = MAX_ARTIFACT_BYTES): Field<unknown> {
  return field((value, path) => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'string')) {
      return reject(path, 'must be an object or a compact serialization')
    }
    if (byteLength(value) > maxBytes) return reject(path, `exceeds ${maxBytes} bytes`)
    return value
  })
}

/** A compact JWS or SD-JWT string — an artifact that travels serialized. */
export function compact(maxBytes = MAX_ARTIFACT_BYTES): Field<string> {
  return field((value, path) => {
    if (typeof value !== 'string' || value.length === 0) {
      return reject(path, 'must be a compact serialization')
    }
    if (Buffer.byteLength(value, 'utf8') > maxBytes) return reject(path, `exceeds ${maxBytes} bytes`)
    return value
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value) ?? '', 'utf8')
}

/**
 * Keys every entity request may carry regardless of operation.
 *
 * `identityToken` is attached by the entity client to **every** call, including the ones that do not
 * resolve a caller, so a strict shape that did not know about it would reject the catalog search.
 */
const ENVELOPE_KEYS = new Set(['op', 'identityToken'])

function applyShape<S extends Shape>(
  body: Record<string, unknown>,
  shape: S,
  prefix: string,
): Parsed<S> {
  const out: Record<string, unknown> = {}

  for (const [key, spec] of Object.entries(shape)) {
    const value = body[key]
    if (value === undefined) {
      if (!spec.optional) reject(`${prefix}${key}`, 'is required')
      continue
    }
    out[key] = spec.parse(value, `${prefix}${key}`)
  }

  // Strict. An unknown key is far more often a client that has drifted from the contract — a renamed
  // field, a stale deploy — than a harmless extra, and accepting it silently means the entity acts
  // on a request nobody wrote. It also closes the door on a body carrying attributes that ride
  // straight through into a DynamoDB item, which `record_evidence` did.
  const unexpected = Object.keys(body).filter(
    (key) => !(key in shape) && !(prefix === '' && ENVELOPE_KEYS.has(key)),
  )
  if (unexpected.length > 0) {
    reject(
      `${prefix}${unexpected[0] as string}`,
      unexpected.length === 1 ? 'is not a field of this operation' : 'and other unexpected fields are not part of this operation',
    )
  }

  return out as Parsed<S>
}

/**
 * Validates one operation's body against its shape, returning a typed result.
 *
 * The size check runs first and on the raw body, because everything after it — parsing, bounds,
 * the handler — is work an oversized request should not be able to buy.
 */
export function parseRequest<S extends Shape>(body: RequestBody, shape: S): Parsed<S> {
  if (byteLength(body) > MAX_BODY_BYTES) {
    throw new HttpError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`, 'INVALID_REQUEST')
  }
  return applyShape(body, shape, '')
}
