import type { ChatMessage } from './chat-runtime';
import type { SessionsStoreApi } from './sessions-store-api';

export type ForkConversationResult =
  | { kind: 'forked'; id: string }
  | { kind: 'empty' }
  | { kind: 'error'; error: string };

/** Fork the persisted transcript, not the local chat message buffer. */
export async function forkConversation(
  api: SessionsStoreApi,
  sessionId: string,
  opts: { beforeUser?: number } = {},
): Promise<ForkConversationResult> {
  try {
    const result = await api.fork(sessionId, opts);
    if (result.ok && result.id) return { kind: 'forked', id: result.id };
    if (!result.ok && (result.error === 'not_found' || /^HTTP 404(?=\s|:|$)/.test(result.error ?? ''))) return { kind: 'empty' };
    return { kind: 'error', error: (result.error ?? 'Fork failed').split(/\r?\n/, 1)[0]! };
  } catch (error) {
    if ((error as { status?: number })?.status === 404) return { kind: 'empty' };
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'not_found' || /^HTTP 404(?=\s|:|$)/.test(message)) return { kind: 'empty' };
    return { kind: 'error', error: message.split(/\r?\n/, 1)[0]! };
  }
}

/** Count user prompts only; assistant, meta and system messages are not turns. */
export function userTurns(messages: readonly Pick<ChatMessage, 'role'>[]): number {
  return messages.filter((message) => message.role === 'user').length;
}
