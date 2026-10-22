// `/new` (alias `/session new`) — leave a session that outgrew its context without quitting next TUI.
// The old session is never deleted; only the active marker moves.
import { debug } from '../../debug/log.js';
import { createSession, setActiveSessionId } from '../../session/index.js';

export const NEW_SESSION_BUSY_STATUS = '응답 중에는 /new 를 받지 않습니다 · 완료(또는 Esc 취소) 뒤 다시';

/** Store placeholder for an untitled session (session/index.ts createSession). */
const UNTITLED = '(new session)';

export function isNewSessionCommand(text: string): boolean {
  const normalized = text.trim().split(/\s+/).join(' ');
  return normalized === '/new' || normalized === '/session new';
}

export function nextTuiTitle(meta: { readonly title?: string } | null | undefined): string {
  const title = meta?.title?.split('\n')[0]?.trim() ?? '';
  return !title || title === UNTITLED ? '새 대화' : title;
}

export type NewTuiSessionResult =
  | { readonly kind: 'started'; readonly id: string; readonly status: string }
  | { readonly kind: 'rejected'; readonly status: string };

export function requestNewTuiSession(input: { readonly busy: boolean; readonly from: string | null }): NewTuiSessionResult {
  const { busy, from } = input;
  if (busy) {
    debug.log('tui.next', 'session-new-rejected', { from, reason: 'busy' });
    return { kind: 'rejected', status: NEW_SESSION_BUSY_STATUS };
  }
  const id = createSession({ source: 'tui' }).id;
  setActiveSessionId(id);
  debug.log('tui.next', 'session-new', { from, to: id });
  return { kind: 'started', id, status: `새 대화 · 이전 = ${from ? from.slice(0, 8) : '없음'}` };
}
