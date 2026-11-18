// Shared status words for every els surface (left list = ELS1, child tabs = ELS2, TUI side tab, herdr meta).
// One table: the state comes from the ledger event once; nobody recomputes it. Same words and colors as agents.
export type StatusWord = 'working' | 'blocked' | 'idle' | 'done' | 'failed';
export type StatusColor = 'green' | 'yellow' | 'dim' | 'red';

export const STATUS: Readonly<Record<StatusWord, { readonly mark: string; readonly color: StatusColor; readonly label: string }>> = {
  working: { mark: '●', color: 'green', label: 'working' },
  blocked: { mark: '◐', color: 'yellow', label: 'blocked' },
  idle: { mark: '○', color: 'dim', label: 'idle' },
  done: { mark: '✓', color: 'dim', label: 'done' },
  failed: { mark: '✕', color: 'red', label: 'failed' },
};

/** Kind glyphs of a sub-component in the left list. */
export const KIND_GLYPH = { harness: '⎇', subagent: '◇', 'graph': '⎔', mission: '▣', shell: '⌁' } as const;
export type ChildKind = keyof typeof KIND_GLYPH;

/** «2분 전» style age, from milliseconds. */
export function agoText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}초 전` : s < 3600 ? `${Math.floor(s / 60)}분 전` : `${Math.floor(s / 3600)}시간 전`;
}

/** Parent line suffix «⎇3 ●2 ✕1» (total, then each non-zero status except done). Empty when no children. */
export function childSummary(states: readonly StatusWord[]): string {
  if (states.length === 0) return '';
  const parts = [`⎇${states.length}`];
  for (const word of ['working', 'blocked', 'idle', 'failed'] as const) {
    const n = states.filter((s) => s === word).length;
    if (n > 0) parts.push(`${STATUS[word].mark}${n}`);
  }
  return parts.join(' ');
}
