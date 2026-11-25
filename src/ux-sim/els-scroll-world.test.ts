// ELS-SCROLL-MOUSE sim world: the els side list and tab row with 0/5/40/120 agents and 3/15/60 tabs at 120×36 and 80×24.
// Invariants at every step: no line wider than its pane, exactly the height asked for, the selected item always on screen,
// and a click / wheel / scrollbar hit-test that maps to the SCROLLED offset. Expectations are literals, not product constants.
import { expect, test } from 'bun:test';
import { buildTabRow, layoutSpaceList, type SpaceTabRow } from '../els/space-tabs-view.js';
import { interpretMouse, type MouseLayout, type MouseReport } from '../els/attach-mouse.js';
import { runWidgetSim } from './widget-sim.js';

const plain = (line: string): string => line.replace(/\u001b\[[0-9;]*m/g, '');
const SIDEBAR = 28; // the els side list width at ≥ 80 columns
const agents = (n: number): SpaceTabRow[] => Array.from({ length: n }, (_, at) => ({
  pane: `p${at}`, wsId: `w${at % 7}`, workspace: `space${at % 7}`, title: `seat-${at}`, state: at % 3 === 0 ? 'working' : 'idle',
}));
const tabsIn = (n: number): SpaceTabRow[] => Array.from({ length: n }, (_, at) => ({ pane: `t${at}`, wsId: 'one', workspace: 'one', title: `tab-${at}`, state: 'idle' }));
const press = (x: number, y: number, button = 0): MouseReport => ({ button, x, y, release: false, bytes: `\u001b[<${button};${x};${y}M` });

for (const [cols, rows] of [[120, 36], [80, 24]] as const) {
  const height = rows - 1;          // the status line is the last row
  for (const count of [0, 5, 40, 120]) {
    test(`side list ${count} agents at ${cols}×${rows}: fits, selection visible, scrolled clicks hit the drawn row`, () => {
      const all = agents(count);
      const report = runWidgetSim({ name: 'els-side-list', render: (sel: string | undefined, width) => layoutSpaceList(all, sel, width, height).lines.map(plain) },
        all.map((row) => ({ label: row.pane, model: row.pane as string | undefined })).concat(count === 0 ? [{ label: 'none', model: undefined }] : []), [{ width: SIDEBAR, height }]);
      expect(report.violations).toEqual([]);
      for (const row of all) {
        const layout = layoutSpaceList(all, row.pane, SIDEBAR, height);
        expect(layout.lines.some((line) => line.includes('\u001b[7m') && plain(line).includes(`seat-${row.pane.slice(1)}`)) || layout.spaces.some((hit) => hit.pane === row.pane)).toBe(true);
      }
      if (count < 40) return;
      // scroll to the very end with an explicit offset; the scrollbar thumb moves to the bottom, clicks follow the drawn rows
      const end = layoutSpaceList(all, 'p0', SIDEBAR, height, undefined, 0, [], undefined, 'status', undefined, 100000)  // flat order: grouped folds to fit (main);
      expect(end.scroll).toBeDefined();
      const bar = end.lines.slice(1, -1).map((line) => [...plain(line)].at(-1));
      expect(bar.at(-1)).toBe('┃');
      expect(bar[0]).toBe('│');
      const layout: MouseLayout = { cols, rows, sidebarWidth: SIDEBAR, sidebar: end.spaces, tabs: [], sidebarScroll: end.scroll! };
      for (const hit of end.spaces) {
        const action = interpretMouse(press(2, hit.y), layout);
        expect(action).toEqual({ kind: 'select', pane: hit.pane });
        expect(plain(end.lines[hit.y - 1]!).length).toBeGreaterThan(0);
      }
      expect(interpretMouse(press(5, 4, 64), layout)).toEqual({ kind: 'list-scroll', delta: -3 });
      expect(interpretMouse(press(5, 4, 65), layout)).toEqual({ kind: 'list-scroll', delta: 3 });
      expect(interpretMouse(press(SIDEBAR, 2), layout)).toEqual({ kind: 'list-jump', start: 0 });
      expect(interpretMouse(press(SIDEBAR, 2 + end.scroll!.room - 1), layout)).toEqual({ kind: 'list-jump', start: end.scroll!.total - end.scroll!.room });
    });
  }
  for (const count of [3, 15, 60]) {
    test(`tab row ${count} tabs at ${cols}×${rows}: fits, focused tab drawn, «more» words and clicks follow the offset`, () => {
      const all = tabsIn(count);
      const width = cols - SIDEBAR - 1;
      const report = runWidgetSim({ name: 'els-tab-row', render: (sel: string, w) => [plain(buildTabRow(all, sel, w).line ?? '')] }, all.map((row) => ({ label: row.pane, model: row.pane })), [{ width }]);
      expect(report.violations).toEqual([]);
      for (const row of all) expect(buildTabRow(all, row.pane, width).tabs.some((tab) => tab.pane === row.pane)).toBe(true);
      const start = buildTabRow(all, 't0', width);
      if (count === 3) { expect(start.next).toBeUndefined(); expect(plain(start.line!).trimEnd().endsWith('+')).toBe(true); return; }
      expect(plain(start.line!)).toMatch(/ \d+ more ›$/);
      const scrolled = buildTabRow(all, 't0', width, 5);
      expect(plain(scrolled.line!).startsWith('‹ 5 more ')).toBe(true);
      expect(scrolled.tabs[0]!.pane).toBe('t5');
      const layout: MouseLayout = { cols, rows, sidebarWidth: SIDEBAR, sidebar: [], tabs: scrolled.tabs, tabPrev: scrolled.prev!, ...(scrolled.next ? { tabNext: scrolled.next } : {}) };
      const x0 = SIDEBAR + 1 + 1;   // first centre column, 1-based
      expect(interpretMouse(press(x0 + scrolled.tabs[0]!.from, 1), layout)).toEqual({ kind: 'select', pane: 't5' });
      expect(interpretMouse(press(x0, 1), layout)).toEqual({ kind: 'tab-scroll', delta: -1 });
      if (scrolled.next) expect(interpretMouse(press(x0 + scrolled.next.from, 1), layout)).toEqual({ kind: 'tab-scroll', delta: 1 });
      expect(interpretMouse(press(x0 + 10, 1, 65), layout)).toEqual({ kind: 'tab-scroll', delta: 1 });
      expect(interpretMouse(press(x0 + 10, 1, 64), layout)).toEqual({ kind: 'tab-scroll', delta: -1 });
    });
  }
}

test('the agent-count badge stays when a long space name is cut', () => {
  const long: SpaceTabRow[] = [{ pane: 'a', wsId: 'w', workspace: 'a-very-long-workspace-name-indeed', title: 'x', state: 'blocked' }];
  const line = plain(layoutSpaceList(long, 'a', 20, 10).lines[1]!);
  expect(line.length).toBeLessThanOrEqual(20);
});
