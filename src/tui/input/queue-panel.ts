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

export const QUEUE_PANEL_HINT = 'Tab steer↔queue · Delete cancel · Enter edit · Esc close';

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
  };
}

/** Key map for the open panel. `selected` indexes `queuePanelOrder(items)`. */
export function queuePanelKey(
  key: Pick<Key, 'name' | 'shift' | 'alt' | 'ctrl'>,
  items: readonly QueuePanelItem[],
  selected: number,
): QueuePanelAction | null {
  const rows = queuePanelOrder(items);
  // Wheel and clicks neither act on the panel nor close it.
  if (key.name === 'mouse') return null;
  if (key.name === 'escape') return { kind: 'closed' };
  if (key.name === 'up' || key.name === 'down') return rows.length ? { kind: 'moved' } : null;
  const item = rows[selected];
  if (!item) return { kind: 'pass' };
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
