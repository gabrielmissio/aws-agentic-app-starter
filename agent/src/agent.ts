import * as strands from '@strands-agents/sdk'
import { createTools } from './tools'

/**
 * Shared across requests on purpose: `BedrockModel`'s constructor builds a `BedrockRuntimeClient`,
 * so a per-request model would mean a per-request connection pool and a TLS handshake on the
 * critical path of every call. The client itself is stateless between invocations — unlike the
 * `Agent` built around it below, which is why that part is not shared.
 */
const bedrockModel = new strands.BedrockModel({
  region: process.env.AWS_REGION || 'us-east-1',
  modelId: process.env.BEDROCK_MODEL_ID || 'global.anthropic.claude-sonnet-4-6',
})

/** Resolved once at module load: the toolset is a function of the deployment, not of the request. */
const tools = createTools()

/**
 * The agent's instructions.
 *
 * Kept short on purpose. This is a template: a long prompt tuned to one product is the first thing
 * a new project has to unpick, and every extra rule here is one more thing competing for the
 * model's attention with the rules that actually matter to *your* domain. Replace the "What you can
 * do" section as you add tools, and leave the rest.
 */
const systemPrompt = `
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
 * Builds a fresh agent for one request — never a shared one.
 *
 * A Strands `Agent` retains its own `messages` array across turns. A module-level agent reused
 * across requests in a warm container therefore accumulates conversation state *across callers*,
 * which is wrong in two ways: one user's conversation can leak into the next user's prompt, and two
 * concurrent invocations landing on the same warm container interleave their appends into one array.
 *
 * `messages` seeds the agent with this session's prior turns so the model has conversation context.
 * The agent object itself is cheap to allocate — a prompt, a tool list and an optional history —
 * the expensive part, the Bedrock client, is the module-level `bedrockModel` shared above.
 */
export function createAgent(messages?: strands.Agent['messages']): strands.Agent {
  return new strands.Agent({
    systemPrompt,
    model: bedrockModel,
    messages,
    tools: [...tools],
  })
}
