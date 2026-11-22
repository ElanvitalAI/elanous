import type { Key } from '../../tui.js';
import type { InlinePanelSpec } from './inline-panel.js';
import type { NextTuiQueueItem } from '../core/queue.js';

/**
 * ELN-QUEUE-ITEM-CONTROLS (IMPL-TASK-QUEUE-1117 · contract 내부 문서 `ELN-STEER-AND-TOOL-WATCHDOG` §6).
 * Screen and key layout for per-item queue controls over the ELN-QUEUE-ITEM-STATE read model: this module only
 * reads items and returns intents; entry.ts applies them through the queue (which refuses non-`queued` items).
 */
/** The ITEM-STATE read model (`queue.items`); only the fields this panel reads. */
export type QueuePanelItem = Pick<NextTuiQueueItem, 'id' | 'seq' | 'kind' | 'delivery' | 'mode' | 'status' | 'text' | 'replacementCandidateFor'>;

export type QueuePanelAction =
  | { readonly kind: 'moved' | 'closed' }
  /** Not a panel key (typing, Backspace …): the panel closes and the key reaches the composer as typed. */
  | { readonly kind: 'pass' }
  | { readonly kind: 'toggle-delivery'; readonly id: string; readonly to: 'steer' | 'queue' }
  | { readonly kind: 'cancel'; readonly id: string }
  | { readonly kind: 'edit'; readonly id: string; readonly text: string }
  /** v: open the selected item's full text — read-only, the queue keeps (OP #128306 ② · JUD-B #128270). */
  | { readonly kind: 'view'; readonly id: string }
  | { readonly kind: 'view-close' }
  | { readonly kind: 'view-scroll'; readonly delta: number }
  | { readonly kind: 'refused'; readonly id: string; readonly reason: string };

/** Panel order = drain order: user before notice, steer before queue, then seq (contract invariant 1). */
export function queuePanelOrder(items: readonly QueuePanelItem[]): QueuePanelItem[] {
  const rank = (item: QueuePanelItem) => [item.kind === 'user' ? 0 : 1, item.delivery === 'steer' ? 0 : 1] as const;
  return items.filter((item) => item.status === 'queued').sort((left, right) => {
    const [lk, ld] = rank(left);
    const [rk, rd] = rank(right);
    return lk - rk || ld - rd || left.seq - right.seq;
  });
}

export const QUEUE_PANEL_HINT = 'v full text · Tab steer↔queue · Delete cancel · Enter edit · Esc close';

const firstLine = (text: string) => text.split('\n', 1)[0]!.trim();

/** The open queue panel. An item being edited is not listed: Enter takes it out of the queue (cancel «edited»), so no drain can send it. */
export function queuePanelSpec(items: readonly QueuePanelItem[], selected: number): InlinePanelSpec {
  const rows = queuePanelOrder(items);
  return {
    title: 'Queue',
    rows: rows.map((item) => ({
      label: `${item.delivery === 'steer' ? 'steer' : 'queued'} · ${firstLine(item.text)}`,
      description: [
        item.kind === 'notice' ? 'notice' : '',
        item.mode === 'command' ? 'command' : item.mode === 'shell' ? 'shell' : '',
        item.replacementCandidateFor ? `may replace ${item.replacementCandidateFor}` : '',
      ].filter(Boolean).join(' · ') || undefined,
    })),
    selected: rows.length ? Math.max(0, Math.min(selected, rows.length - 1)) : 0,
    hint: QUEUE_PANEL_HINT,
    enterAction: 'edit',
  };
}

/**
 * ELS P0 (OP #127947 · #127912): waiting-utterance rows for the base screen. What the person sent while a
 * turn runs waits in the queue (TUI-NEXT-QUEUE-AND-WAKE); the base screen shows one row per waiting
 * utterance — the original text (newlines joined ⏎, like the channel snapshot line), the person's
 * identity («나:») and a separate waiting mark («대기 i/n») — in the drain order (invariant 1), so the
 * person reads what waits before ↑ opens this panel. Notices wait on their own surfaces, not here.
 * Screen room first: the rest is counted, not listed (↑ then Enter edit shows any full text).
 */
export function queueWaitRows(items: readonly QueuePanelItem[], compact: boolean): string[] {
  const waiting = queuePanelOrder(items).filter((item) => item.kind === 'user');
  if (waiting.length === 0) return [];
  // OP #129544 ②: the head row counts the PERSON utterances waiting (알림·notice counts live on
  // their own surfaces — the alarm's queued count never covers this one).
  const rows = [`사람 대기 ${waiting.length}개`];
  // 출처: OP #127947 대기 발화 표시 — 화면 여유 기준: 넓은 화면 최대 3행, 좁은 화면(compact) 2행.
  const max = compact ? 2 : 3;
  rows.push(...waiting.slice(0, max).map((item, index) =>
    `대기 ${index + 1}/${waiting.length} · 나: ${item.text.replace(/\n/g, '⏎')}`));
  if (waiting.length > max) rows.push(`대기 외 ${waiting.length - max}건 · ↑ 패널에서 전문`);
  return rows;
}

/**
 * ELS-QUEUE-WAIT-DISPLAY r2 (OP #128306 ② · JUD-B #128270/#128315): the read-only full-text view of one queued
 * item. Reading never empties the queue — Enter edit stays the separate, destructive path. `scroll` is a line
 * cursor; the render clamps it to what fits and writes the clamp back.
 */
export interface QueuePanelViewing {
  readonly id: string;
  scroll: number;
}

export const QUEUE_VIEW_HINT = '↑↓ scroll · v list · Esc close';

export interface QueueFullTextView {
  readonly title: string;
  readonly lines: string[];
  readonly position: string | null;
  /** The clamped first shown line — the caller writes it back so the cursor never floats past the text. */
  readonly scroll: number;
  readonly total: number;
  readonly pageSize: number;
  readonly hint: string;
}

/** Grapheme segmentation for the cell wrap — a combining mark never splits from its base. */
const segmenter = new Intl.Segmenter();

/**
 * Real newlines break lines; a long line hard-wraps at `columns` TERMINAL CELLS — a 한글 syllable or emoji
 * fills 2 cells, not 1 code point (OP #128451 · JUD-B #128446: wrapping by code points left 42 syllables on
 * one 97-cell line, the render cut it at the terminal width and the tail never showed). A grapheme wider
 * than the line starts the line anyway — the view never cuts text, only wraps it.
 */
function wrapFullText(text: string, columns: number): string[] {
  const width = Math.max(8, Math.floor(columns));
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    let line = '';
    let used = 0;
    for (const { segment } of segmenter.segment(raw)) {
      const cells = Bun.stringWidth(segment);
      if (used > 0 && used + cells > width) { lines.push(line); line = ''; used = 0; }
      line += segment;
      used += cells;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * The paged full text of one queued item (the shell-approval pager pattern). `null` when the item left the queue
 * (delivered/cancelled/edited out) — the caller falls back to the list.
 */
export function queueFullTextView(
  items: readonly QueuePanelItem[],
  viewing: QueuePanelViewing,
  columns: number,
  pageSize: number,
): QueueFullTextView | null {
  const order = queuePanelOrder(items);
  const index = order.findIndex((entry) => entry.id === viewing.id);
  const item = index >= 0 ? order[index] : undefined;
  if (!item) return null;
  const size = Math.max(1, Math.floor(pageSize));
  const lines = wrapFullText(item.text, columns);
  const scroll = Math.max(0, Math.min(viewing.scroll, Math.max(0, lines.length - size)));
  const shown = lines.slice(scroll, scroll + size);
  return {
    title: `Queue · ${item.delivery === 'steer' ? 'steer' : 'queued'} full text ${index + 1}/${order.length}`,
    lines: shown,
    position: lines.length > size ? `lines ${scroll + 1}-${scroll + shown.length}/${lines.length} · ↑↓ scroll` : null,
    scroll,
    total: lines.length,
    pageSize: size,
    hint: QUEUE_VIEW_HINT,
  };
}

/** Key map for the open panel. `selected` indexes `queuePanelOrder(items)`; an open view redirects ↑↓/v/Enter/Delete. */
export function queuePanelKey(
  key: Pick<Key, 'name' | 'shift' | 'alt' | 'ctrl'>,
  items: readonly QueuePanelItem[],
  selected: number,
  viewing: QueuePanelViewing | null = null,
): QueuePanelAction | null {
  // Full-text view: ↑↓ scrolls a line, v/Enter/Delete return to the list; nothing here cancels, edits or sends.
  if (viewing) {
    if (key.name === 'mouse') return null;
    if (key.name === 'escape') return { kind: 'closed' };
    if (key.name === 'up' || key.name === 'down') return { kind: 'view-scroll', delta: key.name === 'up' ? -1 : 1 };
    if ((key.name === 'v' && !key.shift && !key.ctrl && !key.alt) || key.name === 'enter' || key.name === 'return' || key.name === 'delete') return { kind: 'view-close' };
    return { kind: 'pass' };
  }
  const rows = queuePanelOrder(items);
  // Wheel and clicks neither act on the panel nor close it.
  if (key.name === 'mouse') return null;
  if (key.name === 'escape') return { kind: 'closed' };
  if (key.name === 'up' || key.name === 'down') return rows.length ? { kind: 'moved' } : null;
  const item = rows[selected];
  if (!item) return { kind: 'pass' };
  // OP #128306 ② (JUD-B #128270): v reads the selected item's full text — read-only, the queue is kept.
  if (key.name === 'v' && !key.shift && !key.ctrl && !key.alt) return { kind: 'view', id: item.id };
  if (key.name === 'tab' && !key.shift) {
    // Slash commands and `!` shell always wait for the idle boundary (contract «delivery 키»).
    if (item.delivery === 'queue' && item.mode !== 'chat') return { kind: 'refused', id: item.id, reason: 'commands and shell lines cannot steer' };
    return { kind: 'toggle-delivery', id: item.id, to: item.delivery === 'steer' ? 'queue' : 'steer' };
  }
  // Delete only: Backspace is a typing key and must never cancel an item (#38095 r1).
  if (key.name === 'delete') return { kind: 'cancel', id: item.id };
  if ((key.name === 'enter' || key.name === 'return') && !key.shift && !key.alt && !key.ctrl) return { kind: 'edit', id: item.id, text: item.text };
  return { kind: 'pass' };
}

/** Selection after a move, wrapping like the other inline pickers. */
export function queuePanelMove(items: readonly QueuePanelItem[], selected: number, direction: 'up' | 'down'): number {
  const count = queuePanelOrder(items).length;
  if (count === 0) return 0;
  return (selected + (direction === 'up' ? -1 : 1) + count) % count;
}
