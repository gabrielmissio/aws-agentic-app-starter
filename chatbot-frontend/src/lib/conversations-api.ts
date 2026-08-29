/**
 * Client for the BFF's conversation routes — the sidebar's data.
 *
 * Listing and reading are separate calls on purpose, matching the server: the list comes from an
 * index that holds only titles and timestamps, so opening the app never reads anyone's messages. A
 * transcript is fetched only for the conversation actually opened.
 */
import { requestJson } from './bff-client'

export interface ConversationSummary {
  sessionId: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface TranscriptMessage {
  role: 'user' | 'agent'
  content: string
}

/** Most recently updated first — the server sorts, so two clients cannot disagree about order. */
export async function listConversations(): Promise<ConversationSummary[]> {
  const { conversations } = await requestJson<{ conversations?: ConversationSummary[] }>(
    '/conversations',
  )
  return conversations ?? []
}

export async function readConversation(sessionId: string): Promise<TranscriptMessage[]> {
  const { messages } = await requestJson<{ messages?: TranscriptMessage[] }>(
    `/conversations/${encodeURIComponent(sessionId)}`,
  )
  return messages ?? []
}

/** Erases the stored turns and the index row. Irreversible — the caller confirms, not this. */
export async function deleteConversation(sessionId: string): Promise<void> {
  // The route answers 204 with no body, which `requestJson` returns as `undefined`.
  await requestJson<undefined>(`/conversations/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  })
}
