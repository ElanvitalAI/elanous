// `/new` (`/clear` and `/session new` aliases) — leave the old session without quitting next TUI.
// The old session is never deleted; only the active marker moves.
import { debug } from '../../debug/log.js';
import { NEXT_TUI_NEW_SESSION_SLASHES } from '../core/registry.js';

export const NEW_SESSION_BUSY_STATUS = '/new is not accepted while a reply is running · retry when done (or Esc cancel)';

/** Store placeholder for an untitled session (session/index.ts createSession). */
const UNTITLED = '(new session)';

export function isNewSessionCommand(text: string): boolean {
  const normalized = text.trim().split(/\s+/).join(' ');
  return (NEXT_TUI_NEW_SESSION_SLASHES as readonly string[]).includes(normalized);
}

/** The title a fresh, untitled conversation shows. */
export const NEW_CHAT_TITLE = 'New chat';

/** Status after `/new`: names the conversation left behind (an 8-char prefix, or «none»). */
export function newChatStatus(previous: string | null): string {
  return `${NEW_CHAT_TITLE} · previous = ${previous ?? 'none'}`;
}

export function nextTuiTitle(meta: { readonly title?: string } | null | undefined): string {
  const title = meta?.title?.split('\n')[0]?.trim() ?? '';
  return !title || title === UNTITLED ? NEW_CHAT_TITLE : title;
}

export type NewTuiSessionResult =
  | { readonly kind: 'started'; readonly id: string; readonly status: string }
  | { readonly kind: 'rejected'; readonly status: string };

export async function requestNewTuiSession(input: { readonly busy: boolean; readonly from: string | null }): Promise<NewTuiSessionResult> {
  const { busy, from } = input;
  if (busy) {
    debug.log('tui.next', 'session-new-rejected', { from, reason: 'busy' });
    return { kind: 'rejected', status: NEW_SESSION_BUSY_STATUS };
  }
  const { createSession, setActiveSessionId } = await import('../../session/index.js');
  const id = createSession({ source: 'tui' }).id;
  setActiveSessionId(id);
  debug.log('tui.next', 'session-new', { from, to: id });
  return { kind: 'started', id, status: newChatStatus(from ? from.slice(0, 8) : null) };
}

/** TUI-NEW-SESSION-KEEPS-PROVIDER: the session-scoped provider/model (e.g. `--provider glm --model glm-5`
 *  or `/provider use`) belongs to the TUI, not to one conversation. Without this carry-over `/new` silently
 *  fell back to the global default (a paid codex route). Returns the carried selection, if any. */
export async function carrySessionProvider(from: string | null, to: string): Promise<string | null> {
  if (!from || from === to) return null;
  const { getSessionProvider, setSessionProvider } = await import('../../tui-client/session-provider.js');
  const selection = getSessionProvider(from);
  if (!selection) return null;
  setSessionProvider(to, selection);
  debug.log('tui.next', 'session-new-provider-carried', { from, to, provider: selection.provider, model: selection.model ?? null });
  return selection.model ? `${selection.provider}/${selection.model}` : selection.provider;
}
