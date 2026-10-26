// `/resume` · `/session list` · `/session load <id>` for next TUI (TUI-RESUME-PICKER · backlog #16).
// Before this, next TUI had no handler: the words went to the model as a chat turn, so after an
// n8n restart «/resume» started an investigation instead of showing the sessions to pick from.
import { debug } from '../../debug/log.js';
import { listSessions, resolveSessionId, setActiveSessionId, type SessionMeta } from '../../session/index.js';
import { RESUME_BUSY_STATUS, RESUME_LIST_LIMIT } from './resume-command.js';
import { idPrefixCell, sessionIdPrefixes, sessionListTime } from '../../session/id-prefix.js';
export { RESUME_BUSY_STATUS, RESUME_LIST_LIMIT, parseResumeCommand } from './resume-command.js';
export type { ResumeCommand } from './resume-command.js';

/** Recent conversations, newest first — the rows `/resume` shows (empty scratch sessions hidden, the active one kept). */
export function resumeCandidates(activeId: string | null, limit = RESUME_LIST_LIMIT): SessionMeta[] {
  return listSessions({ limit, hideEmpty: true, ...(activeId ? { keepIds: [activeId] } : {}) });
}

/**
 * One numbered line per session: number · marker · unique id prefix · updated · turns · title.
 * The number is what `/resume <n>` takes (next TUI has no arrow picker — the list is the picker);
 * the prefix grows past 8 characters when another stored session shares them.
 */
export function resumeListLines(rows: readonly SessionMeta[], activeId: string | null): string[] {
  if (rows.length === 0) return ['저장된 대화 없음'];
  const prefixes = sessionIdPrefixes(rows.map((m) => m.id));
  const numberWidth = String(rows.length).length;
  return [
    `최근 대화 ${rows.length}개 · /resume <번호> 또는 /resume <id 앞자리> 로 이어 가기`,
    ...rows.map((m, i) => {
      const marker = m.id === activeId ? '▸' : ' ';
      const when = sessionListTime(m.updatedAt);
      const title = (m.title || '(제목 없음)').split('\n')[0]!.slice(0, 48);
      return `${String(i + 1).padStart(numberWidth)}. ${marker} ${idPrefixCell(prefixes, m.id)}  ${when}  ${String(m.messageCount).padStart(3)}t  ${title}`;
    }),
  ];
}

/** `/resume 3` → the 3rd row of the list the user saw. Only 1–3 digits within the list count as a number. */
export function resumeRowByNumber(arg: string, rows: readonly SessionMeta[]): SessionMeta | null {
  if (!/^\d{1,3}$/.test(arg)) return null;
  const n = Number(arg);
  return n >= 1 && n <= rows.length ? rows[n - 1]! : null;
}

export type ResumeTuiSessionResult =
  | { readonly kind: 'started'; readonly id: string; readonly status: string }
  | { readonly kind: 'rejected'; readonly status: string };

/** Resolve the prefix and make that session active; rejects while a turn runs or when the prefix misses. */
export function requestResumeTuiSession(input: {
  readonly busy: boolean;
  readonly from: string | null;
  readonly prefix: string;
  /** The rows the last `/resume` list showed, so `/resume <n>` picks the row the user saw. */
  readonly rows?: readonly SessionMeta[];
}): ResumeTuiSessionResult {
  const { busy, from, prefix } = input;
  if (busy) {
    debug.log('tui.next', 'session-resume-rejected', { from, prefix, reason: 'busy' });
    return { kind: 'rejected', status: RESUME_BUSY_STATUS };
  }
  const byNumber = input.rows ? resumeRowByNumber(prefix, input.rows) : null;
  let id: string | null = byNumber?.id ?? null;
  try {
    if (!byNumber) id = resolveSessionId(prefix);
  } catch (error) {
    debug.log('tui.next', 'session-resume-rejected', { from, prefix, reason: 'ambiguous' });
    return { kind: 'rejected', status: error instanceof Error ? error.message : String(error) };
  }
  if (!id) {
    debug.log('tui.next', 'session-resume-rejected', { from, prefix, reason: 'not-found' });
    return { kind: 'rejected', status: `"${prefix}" 번호·앞자리에 맞는 대화 없음 · /resume 으로 목록 보기` };
  }
  const shortId = sessionIdPrefixes([id]).get(id) ?? id;
  if (id === from) return { kind: 'rejected', status: `이미 이 대화다 · ${shortId}` };
  setActiveSessionId(id);
  debug.log('tui.next', 'session-resume', { from, to: id, by: byNumber ? 'number' : 'prefix' });
  const shortFrom = from ? (sessionIdPrefixes([from]).get(from) ?? from) : '없음';
  return { kind: 'started', id, status: `대화 이어 가기 · ${shortId} · 이전 = ${shortFrom}` };
}
