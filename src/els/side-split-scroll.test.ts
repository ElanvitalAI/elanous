// ELS-SIDE-SPLIT-SCROLL (대표 11-25 22:3x «스페이스 영역은 고정 · 에이전트 영역만 스크롤»): the side list is two regions — the
// spaces (fixed, up to 40% of the rows) and the agents (the only region the wheel / PgUp / PgDn / Home / End move), with the
// «─» rule and the «○ All · n … grouped» head pinned between them. Expectations are typed-out literals (OP rule 11).
import { describe, expect, test } from 'bun:test';
import { interpretMouse, type MouseLayout } from './attach-mouse.js';
import { parsePaneRows, sidebarWidthFor } from './attach-view.js';
import { layoutSpaceList, splitRooms, withCommands } from './space-tabs-view.js';

const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

function world(spaces: number, agents: number) {
  const names = Array.from({ length: spaces }, (_, i) => `sp${i}`);
  const used = Math.min(spaces, agents);
  const panes = Array.from({ length: agents }, (_, i) => {
    const ws = names[i % used]!;
    return { address: `${ws}/t${i}/p${i}`, workspace: ws, tab: `t${i}`, pane: `p${i}`, title: `S${i}`, seat: `S${i}`, state: i % 3 ? 'idle' : 'working',
      activityState: i % 3 ? 'idle' : 'working', kind: 'codex', command: ['codex'], fgCommand: ['codex'], lastEventAtMs: Date.now() };
  });
  const json = JSON.stringify({ panes });
  const empty = names.slice(used).map((name) => ({ wsId: `empty-${name}`, name }));
  return { rows: withCommands(parsePaneRows(json), json), empty };
}

test('region rooms: all spaces up to 40% of the rows; under 8 rows one list', () => {
  expect(splitRooms(33, 4)).toEqual({ spaces: 4, agents: 27 });
  expect(splitRooms(33, 21)).toEqual({ spaces: 13, agents: 18 });
  expect(splitRooms(21, 9)).toEqual({ spaces: 8, agents: 11 });
  expect(splitRooms(7, 3)).toBeUndefined();
  expect(splitRooms(33, -1)).toBeUndefined();
});

describe('split scroll sim matrix', () => {
  for (const [cols, rowsN] of [[120, 36], [200, 50], [80, 24]] as const) {
    for (const spaces of [3, 8, 20]) {
      for (const agents of [5, 40, 120]) {
        test(`${cols}×${rowsN} · ${spaces} spaces · ${agents} agents: spaces never move when the agents scroll`, () => {
          const { rows, empty } = world(spaces, agents);
          const width = sidebarWidthFor(cols, true);
          const height = rowsN - 2;
          const draw = (top?: number) => layoutSpaceList(rows, 'p0', width, height, undefined, 0, empty, undefined, 'grouped', undefined, top);
          const first = draw();
          expect(first.lines).toHaveLength(height);
          expect(first.lines.every((line) => Bun.stringWidth(plain(line)) === width)).toBe(true);
          const top = first.agentsTop!;
          expect(top).toBeGreaterThan(3);
          expect(plain(first.lines[top - 3]!)).toBe('─'.repeat(width));
          expect(plain(first.lines[top - 2]!).startsWith(' ○ All · ')).toBe(true);
          const fixed = first.lines.slice(0, top - 1);
          for (const at of [0, 7, 1000]) {
            const moved = draw(at);
            expect(moved.lines.slice(0, top - 1)).toEqual(fixed);     // spaces + pinned head: byte-identical
            expect(moved.lines).toHaveLength(height);
            expect(moved.lines.every((line) => Bun.stringWidth(plain(line)) === width)).toBe(true);
          }
          if (first.scroll) {
            expect(first.scroll.y).toBe(top);
            const layout: MouseLayout = { cols, rows: rowsN, sidebarWidth: width, sidebar: [], tabs: [], sidebarScroll: first.scroll, agentsTop: top,
              ...(first.spacesScroll ? { spacesScroll: first.spacesScroll } : {}) };
            const wheel = (y: number) => interpretMouse({ button: 65, x: 3, y, release: false, bytes: `\u001b[<65;3;${y}M` }, layout);
            expect(wheel(top)).toEqual({ kind: 'list-scroll', delta: 3 });
            expect(wheel(top - 2)).toBeNull();                                // pinned head
            expect(wheel(2)).toEqual(first.spacesScroll ? { kind: 'spaces-scroll', delta: 1 } : null);
          }
        });
      }
    }
  }
});

test('120×36 · 3 spaces · 40 agents: spaces = 4 rows (3 names + the selected one\'s line), agents start at row 8', () => {
  const { rows, empty } = world(3, 40);
  const layout = layoutSpaceList(rows, 'p0', 28, 34, undefined, 0, empty);
  expect(layout.agentsTop).toBe(8);
  expect(plain(layout.lines[1]!).trim()).toBe('SP0');
  expect(plain(layout.lines[3]!).trim()).toBe('SP1');
  expect(plain(layout.lines[4]!).trim()).toBe('SP2');
  expect(layout.spacesScroll).toBeUndefined();
});

test('20 spaces over a 21-row list: the spaces get their own small scroll of 8 rows', () => {
  const { rows, empty } = world(20, 40);
  const layout = layoutSpaceList(rows, 'p0', 28, 23, undefined, 0, empty);
  expect(layout.spacesScroll).toEqual({ start: 0, total: 21, room: 8, x: 28, y: 2 });
  const down = layoutSpaceList(rows, 'p0', 28, 23, undefined, 0, empty, undefined, 'grouped', undefined, undefined, new Map(), false, 5);
  expect(down.spacesScroll!.start).toBe(5);
  expect(down.lines.slice(10)).toEqual(layout.lines.slice(10));     // the agents region did not move
});
