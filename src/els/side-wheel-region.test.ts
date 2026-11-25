// ELS-SIDE-WHEEL-REGION (대표 11-25 21:4x): wheel hit-testing by screen region — literal expectations, independent of the product.
import { describe, expect, test } from 'bun:test';
import { interpretMouse, type MouseLayout } from './attach-mouse.js';

const UP = 64, DOWN = 65;
const wheel = (button: number, x: number, y: number) => ({ button, x, y, release: false, bytes: `\u001b[<${button};${x};${y}M` });
const base = (cols: number, rows: number, over: boolean, tabsOver: boolean): MouseLayout => ({
  cols, rows, sidebarWidth: 24, sidebar: [{ y: 2, ws: 'w1', pane: 'p1' }],
  tabs: [{ from: 0, to: 10, pane: 'p1' }],
  ...(over ? { sidebarScroll: { x: 24, y: 2, room: rows - 3, total: 60, start: 0 } } : {}),
  ...(tabsOver ? { tabNext: { from: 40, to: 50 } } : {}),
});

describe('side wheel region matrix', () => {
  for (const [cols, rows] of [[120, 36], [200, 50]] as const) {
    for (const mode of ['flat-overflow', 'grouped-fits'] as const) {
      const over = mode === 'flat-overflow';
      const layout = base(cols, rows, over, true);
      test(`${cols}x${rows} ${mode}: side list`, () => {
        expect(interpretMouse(wheel(DOWN, 5, 10), layout)).toEqual(over ? { kind: 'list-scroll', delta: 3 } : null);
        expect(interpretMouse(wheel(UP, 24, 20), layout)).toEqual(over ? { kind: 'list-scroll', delta: -3 } : null);
      });
      test(`${cols}x${rows} ${mode}: divider column`, () => {
        expect(interpretMouse(wheel(DOWN, 25, 10), layout)).toEqual(over ? { kind: 'list-scroll', delta: 3 } : null);
      });
      test(`${cols}x${rows} ${mode}: tab row`, () => {
        expect(interpretMouse(wheel(DOWN, 60, 1), layout)).toEqual({ kind: 'tab-scroll', delta: 1 });
        expect(interpretMouse(wheel(DOWN, 60, 1), base(cols, rows, over, false))).toBeNull();
      });
      test(`${cols}x${rows} ${mode}: pane`, () => {
        expect(interpretMouse(wheel(UP, 80, 10), layout)).toEqual({ kind: 'scroll', lines: 3 });
        expect(interpretMouse(wheel(DOWN, 80, 10), layout)).toEqual({ kind: 'scroll', lines: -3 });
      });
      test(`${cols}x${rows} ${mode}: status line ignored`, () => {
        expect(interpretMouse(wheel(DOWN, 5, rows), layout)).toBeNull();
        expect(interpretMouse(wheel(DOWN, 80, rows), layout)).toBeNull();
      });
    }
  }
});
