// Shared status words for every els surface (left list = ELS1, child tabs = ELS2, TUI side tab, herdr meta).
// One table: the state comes from the ledger event once; nobody recomputes it. Same words and colors as agents.
// 출처: OP #134199 ELS-SIDEBAR-STATUS-VISIBLE (11-23 실화면 지적) · #134208 어휘 정정 — 상태를 색 이모지 마크로, agoText 영어.
import type { SeatState } from '../agent-events/protocol.js';
export type StatusWord = 'working' | 'blocked' | 'idle' | 'done' | 'failed' | 'stalled' | 'unknown';
export type StatusColor = 'green' | 'yellow' | 'dim' | 'red';

export const STATUS: Readonly<Record<StatusWord, { readonly mark: string; readonly color: StatusColor; readonly label: string }>> = {
  working: { mark: '🟢', color: 'green', label: 'working' },
  blocked: { mark: '🟡', color: 'yellow', label: 'blocked' },
  idle: { mark: '⚪', color: 'dim', label: 'idle' },
  done: { mark: '✅', color: 'dim', label: 'done' },
  failed: { mark: '🔴', color: 'red', label: 'failed' },
  stalled: { mark: '⏸', color: 'yellow', label: 'stalled' },
  unknown: { mark: '?', color: 'dim', label: 'unknown' },
};

/** Kind glyphs of a sub-component in the left list. */
export const KIND_GLYPH = { harness: '⎇', subagent: '◇', 'graph': '⎔', mission: '▣', shell: '⌁' } as const;
export type ChildKind = keyof typeof KIND_GLYPH;

/** «5s ago» style age, from milliseconds. 출처: OP #134199 ③ — «초 전/분 전» 대신 s/m/h ago. */
export function agoText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
}

/** Parent line suffix «⎇3 🟢2 🔴1» (total, then each non-zero status except done). Empty when no children. */
export function childSummary(states: readonly StatusWord[]): string {
  if (states.length === 0) return '';
  const parts = [`⎇${states.length}`];
  for (const word of ['working', 'blocked', 'stalled', 'idle', 'failed'] as const) {
    const n = states.filter((s) => s === word).length;
    if (n > 0) parts.push(`${STATUS[word].mark}${n}`);
  }
  return parts.join(' ');
}

/** SEAT-STATE-ENUM: the status word (mark and colour) of a seat state code — WAITING_APPROVAL/BLOCKED 🟡, STALLED ⏸.
 *  EXITED keeps the exited row (dimmed ✅) until the pane's exit code is tracked. Codes only; no screen text is read. */
export function wordOfSeatState(state: SeatState): StatusWord | 'exited' {
  switch (state) {
    case 'WORKING': return 'working';
    case 'IDLE': case 'WAITING_REPLY': return 'idle';
    case 'WAITING_APPROVAL': case 'BLOCKED': return 'blocked';
    case 'STALLED': return 'stalled';
    case 'EXITED': return 'exited';
  }
}
