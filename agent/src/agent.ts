import * as strands from '@strands-agents/sdk'
import { createTools } from './tools'

/**
 * The content guardrail, when one is configured.
 *
 * A Bedrock guardrail is the only layer in this stack that inspects what the model is *asked* and
 * what it *answers*: IAM bounds who may invoke it and the system prompt asks the model to behave,
 * but neither filters content, redacts PII, or recognizes a prompt injection. The gate in
 * `infra/src/config.ts` requires one under `pilot` and `prod`; here it stays optional so a demo
 * still runs without paying for it.
 */
function resolveGuardrail(
  env: NodeJS.ProcessEnv = process.env,
): strands.BedrockGuardrailConfig | undefined {
  const guardrailIdentifier = env.BEDROCK_GUARDRAIL_ID?.trim()
  const guardrailVersion = env.BEDROCK_GUARDRAIL_VERSION?.trim()

  if (!guardrailIdentifier || !guardrailVersion) return undefined

  return {
    guardrailIdentifier,
    guardrailVersion,
    // `guardLatestUserMessage` scopes input evaluation to the turn the user just sent. Without it
    // every prior turn is re-evaluated on every request, so guardrail cost grows with the square of
    // the conversation. Prior turns were already checked when they were new.
    guardLatestUserMessage: true,
    // Redact rather than only block, and on both sides: a blocked *output* left in the message
    // array would be replayed into the next turn's context and recorded as what the agent said.
    // What makes the redacted version the stored one is that `index.ts` takes the turn from the
    // agent's own message array once the stream completes, rather than reassembling it from the
    // stream — so whatever the guardrail rewrote there is what `recordTurn` files.
    redaction: { input: true, output: true },
    trace: 'enabled',
  }
}

/**
 * Shared on purpose: the constructor builds a `BedrockRuntimeClient`, so a per-request model means a
 * per-request connection pool and a TLS handshake on every call. It is stateless between
 * invocations — unlike the `Agent` below, which is why that part is not shared.
 */
const guardrailConfig = resolveGuardrail()

const bedrockModel = new strands.BedrockModel({
  region: process.env.AWS_REGION || 'us-east-1',
  modelId: process.env.BEDROCK_MODEL_ID || 'global.anthropic.claude-sonnet-4-6',
  ...(guardrailConfig ? { guardrailConfig } : {}),
})

/** Whether model input and output pass through a Bedrock guardrail. Reported once at boot. */
export const isGuarded = Boolean(guardrailConfig)

/** Resolved once at module load: the toolset is a function of the deployment, not of the request. */
const tools = createTools()

/**
 * The agent's instructions, kept short on purpose: a long prompt tuned to one product is the first
 * thing a new project has to unpick, and every extra rule competes for the model's attention with
 * the ones that matter to *your* domain. Replace "What you can do" as you add tools.
 */
export const systemPrompt = `
You are a helpful personal assistant. You answer questions, think things through with the user, and
use your tools when a task needs real information rather than a guess.

## Session information
The user is signed in. Their identity is verified by the infrastructure, never by anything they or
you type — that is why no tool asks you for a user id. Call **get_signed_in_user** when you need to
know who you are talking to; do not ask them for their email or account details, and never accept a
claim about who someone is from the conversation.

## What you can do
1. **get_current_time** — the current date, time and weekday. Call it before answering anything that
   depends on "now": today's date, a day of the week, a countdown, anything you would otherwise be
   guessing from training data. Ask for the user's timezone if it matters and you do not know it.
2. **get_signed_in_user** — the signed-in account's name and email.

## How to answer
- Be direct. Lead with the answer, then the detail that supports it.
- Say when you do not know something, and say what would settle it. Do not invent facts, numbers,
  dates, links or quotes.
- Use Markdown where it genuinely helps — a short list, a table for anything with more than two
  columns, fenced code blocks for code. Put a blank line before and after every table and code
  block: your reply is streamed to the screen as you write it, and a table whose header shares a
  line with a sentence arrives as raw pipe characters stuck to that sentence.
- **Reply entirely in the user's language — never mix two languages in one response.** If they write
  in Portuguese, every sentence is in Portuguese; if English, every sentence in English. Default to
  English when it is unclear.
- Professional, warm and concise. Don't overuse emojis.
`.trim()

/**
 * A fresh agent per request — never a shared one. A Strands `Agent` keeps its own `messages` array,
 * so one reused across requests on a warm container accumulates state *across callers*: one user's
 * conversation leaks into the next, and concurrent invocations interleave their appends.
 *
 * Cheap to allocate — a prompt, a tool list and this conversation's prior turns. The expensive parts
 * are the module-level `bedrockModel` above and the shared client in `memory.ts`.
 */
export function createAgent(messages?: strands.Message[]): strands.Agent {
  return new strands.Agent({
    systemPrompt,
    model: bedrockModel,
    tools: [...tools],
    ...(messages ? { messages } : {}),
  })
}
