import { fitCells, type DialogBox } from './attach-view.js';

export interface MoveDestination { readonly id: string; readonly name: string }

/** Keyboard-only destination picker. It never sends input to the attached pane. */
export function createMoveTabPicker(destinations: readonly MoveDestination[]) {
  let cursor = 0;
  return {
    feed(key: string): { kind: 'cancel' } | { kind: 'select'; id: string } | { kind: 'continue' } {
      if (key === '\u001b') return { kind: 'cancel' };
      if (key === '\r' || key === '\n') return destinations[cursor] ? { kind: 'select', id: destinations[cursor]!.id } : { kind: 'continue' };
      if (key === 'j' || key === '\u001b[B') cursor = Math.min(cursor + 1, destinations.length - 1);
      if (key === 'k' || key === '\u001b[A') cursor = Math.max(cursor - 1, 0);
      return { kind: 'continue' };
    },
    box(cols: number, rows: number, sidebar = 0): DialogBox {
      const available = Math.max(0, cols - sidebar);
      const width = Math.min(44, available);
      const count = Math.max(0, Math.min(destinations.length, rows - 4));
      const start = Math.max(0, Math.min(cursor - count + 1, destinations.length - count));
      const lines = [' Move tab to space', ...destinations.slice(start, start + count).map((item, index) => `${start + index === cursor ? ' > ' : '   '}${item.name}`), ' Enter move  Esc cancel'].map(line => fitCells(line, width));
      return { x: sidebar + Math.floor((available - width) / 2), y: Math.max(0, Math.floor((rows - lines.length) / 2)), width, lines };
    },
  };
}
