import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The authenticated caller for the request being served — the extension point a tool uses instead of
 * taking a user id, since an identity the model can pass is one it can be talked into changing.
 *
 * What makes that safe is the transport, not this parser. The block is plain text, so it is only as
 * trustworthy as whoever could write it — and the runtime accepts SigV4 alone, with only the BFF's
 * role granted `InvokeAgentRuntime` (`infra/src/stacks/agent-stack.ts`).
 *
 * `AsyncLocalStorage`, not a module-level variable: a warm container serves concurrent invocations,
 * and a shared variable would leak one caller's identity into another's tool call.
 */
export interface Caller {
  userId: string
  email?: string
  displayName?: string
}

const store = new AsyncLocalStorage<Caller>()

/** Runs `fn` with `caller` bound to the current async context. */
export function withCaller<T>(caller: Caller | undefined, fn: () => T): T {
  return caller ? store.run(caller, fn) : fn()
}

/** The caller for this request, or undefined when the prompt carried no verified identity. */
export function currentCaller(): Caller | undefined {
  return store.getStore()
}

/** The marker the BFF wraps the identity block in. */
const CONTEXT_HEADER = '[Session context — verified]'
const MESSAGE_HEADER = '[User message]'

/**
 * Splits a BFF-injected prompt into the verified identity and the user's own text.
 *
 * A prompt with no context block yields no caller, and a tool that acts for a person then declines.
 * In a correctly deployed stack that never happens — every invocation comes from the BFF, which
 * always prepends one — so reaching it means the runtime was invoked by something else holding IAM
 * credentials, and declining is the only sound response.
 *
 * Only the *first* block is honored, and only at the very start of the prompt. A user who types the
 * header into their own message cannot introduce a second identity, because everything after
 * `[User message]` is treated as text no matter what it looks like.
 */
export function parsePrompt(raw: string): { caller?: Caller; message: string } {
  if (!raw.startsWith(CONTEXT_HEADER)) return { message: raw }

  const messageAt = raw.indexOf(MESSAGE_HEADER)
  if (messageAt === -1) return { message: raw }

  const block = raw.slice(CONTEXT_HEADER.length, messageAt)
  const message = raw.slice(messageAt + MESSAGE_HEADER.length).replace(/^\n+/, '')

  const field = (name: string): string | undefined => {
    // `name` is never caller-supplied: every call site below passes a string literal, so there is no
    // input here for a ReDoS pattern to arrive through. Kept dynamic because the alternative is three
    // near-identical regexes that could drift from the wire format the BFF emits.
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    const match = new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(block)
    return match?.[1]?.trim() || undefined
  }

  const userId = field('userId')
  if (!userId) return { message }

  return {
    caller: {
      userId,
      ...(field('email') ? { email: field('email') } : {}),
      ...(field('displayName') ? { displayName: field('displayName') } : {}),
    },
    message,
  }
}

/** Builds the block the BFF prepends. Exported so the BFF and the parser cannot drift apart. */
export function formatSessionContext(caller: Caller): string {
  const lines = [
    CONTEXT_HEADER,
    `userId: ${caller.userId}`,
    ...(caller.email ? [`email: ${caller.email}`] : []),
    ...(caller.displayName ? [`displayName: ${caller.displayName}`] : []),
    '',
    MESSAGE_HEADER,
    '',
  ]
  return lines.join('\n')
}
