// `/resume` · `/session list` · `/session load <id>` for next TUI (TUI-RESUME-PICKER · backlog #16).
// Before this, next TUI had no handler: the words went to the model as a chat turn, so after an
// n8n restart «/resume» started an investigation instead of showing the sessions to pick from.
import { debug } from '../../debug/log.js';
import { listSessions, resolveSessionId, setActiveSessionId, type SessionMeta } from '../../session/index.js';

export const RESUME_BUSY_STATUS = '응답 중에는 /resume 을 받지 않습니다 · 완료(또는 Esc 취소) 뒤 다시';
/** Rows shown by `/resume` · `/session list`. */
export const RESUME_LIST_LIMIT = 12;

export type ResumeCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'load'; readonly prefix: string };

/** `/resume` · `/session` · `/session list|ls` → list; `/resume <id>` · `/session load|resume <id>` → load. */
export function parseResumeCommand(text: string): ResumeCommand | null {
  const [cmd, sub, arg, ...rest] = text.trim().split(/\s+/);
  if (rest.length > 0) return null;
  if (cmd === '/resume') {
    if (arg !== undefined) return null;
    return sub === undefined ? { kind: 'list' } : { kind: 'load', prefix: sub };
  }
  if (cmd === '/session' || cmd === '/sessions') {
    if (sub === undefined || ((sub === 'list' || sub === 'ls') && arg === undefined)) return { kind: 'list' };
    if ((sub === 'load' || sub === 'resume') && arg !== undefined) return { kind: 'load', prefix: arg };
  }
  return null;
}

/** Recent conversations, newest first — the rows `/resume` shows (empty scratch sessions hidden, the active one kept). */
export function resumeCandidates(activeId: string | null, limit = RESUME_LIST_LIMIT): SessionMeta[] {
  return listSessions({ limit, hideEmpty: true, ...(activeId ? { keepIds: [activeId] } : {}) });
}

/** One line per session: marker · 8-char id · updated · turns · title. */
export function resumeListLines(rows: readonly SessionMeta[], activeId: string | null): string[] {
  if (rows.length === 0) return ['저장된 대화 없음'];
  return [
    `최근 대화 ${rows.length}개 · /resume <id 앞자리> 로 이어 가기`,
    ...rows.map((m) => {
      const marker = m.id === activeId ? '▸' : ' ';
      const when = m.updatedAt.slice(5, 16).replace('T', ' ');
      const title = (m.title || '(제목 없음)').split('\n')[0]!.slice(0, 48);
      return `${marker} ${m.id.slice(0, 8)}  ${when}  ${String(m.messageCount).padStart(3)}t  ${title}`;
    }),
  ];
}

export type ResumeTuiSessionResult =
  | { readonly kind: 'started'; readonly id: string; readonly status: string }
  | { readonly kind: 'rejected'; readonly status: string };

/** Resolve the prefix and make that session active; rejects while a turn runs or when the prefix misses. */
export function requestResumeTuiSession(input: { readonly busy: boolean; readonly from: string | null; readonly prefix: string }): ResumeTuiSessionResult {
  const { busy, from, prefix } = input;
  if (busy) {
    debug.log('tui.next', 'session-resume-rejected', { from, prefix, reason: 'busy' });
    return { kind: 'rejected', status: RESUME_BUSY_STATUS };
  }
  let id: string | null;
  try {
    id = resolveSessionId(prefix);
  } catch (error) {
    debug.log('tui.next', 'session-resume-rejected', { from, prefix, reason: 'ambiguous' });
    return { kind: 'rejected', status: error instanceof Error ? error.message : String(error) };
  }
  if (!id) {
    debug.log('tui.next', 'session-resume-rejected', { from, prefix, reason: 'not-found' });
    return { kind: 'rejected', status: `"${prefix}" 로 시작하는 대화 없음 · /resume 으로 목록 보기` };
  }
  if (id === from) return { kind: 'rejected', status: `이미 이 대화다 · ${id.slice(0, 8)}` };
  setActiveSessionId(id);
  debug.log('tui.next', 'session-resume', { from, to: id });
  return { kind: 'started', id, status: `대화 이어 가기 · ${id.slice(0, 8)} · 이전 = ${from ? from.slice(0, 8) : '없음'}` };
}
