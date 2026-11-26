// ELS-AGENTS-GROUPED-TOGGLE-FU (OP #134722 ② · 0.3.35 P2 · HAND-ELN → HAND-TUI-D 이관): the agents panel's head
// word «grouped» is the mode — ctrl+b g flips it: 스페이스별 묶음(grouped) ↔ 상태순(status) across spaces.
// 시험 우주: 실화면 전후 · 리터럴(OP rule 11: typed out, never built from the product's tables).
import { expect, test } from 'bun:test';
import { layoutSpaceList, type SpaceTabRow } from './space-tabs-view.js';
import { createKeyRouter } from './attach-keys.js';
import { parsePaneRows } from './attach-view.js';
import { createAttachApp } from './attach-app.js';
import type { ElsRequest } from './server.js';

const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const trim = (lines: readonly string[]) => lines.map((line) => plain(line).trimEnd());

// typed universe: three spaces, four panes — every status word the panel's rank sort uses once.
const row = (ws: string, pane: string, title: string, state: string): SpaceTabRow =>
  ({ workspace: ws === 'w1' ? 'alpha' : ws === 'w2' ? 'beta' : 'gamma', wsId: ws, pane, title, state });
const ROWS: SpaceTabRow[] = [
  row('w1', 'p1', 'build', 'working'),
  row('w1', 'p2', 'old', 'idle'),
  row('w2', 'p3', 'review', 'blocked'),
  row('w3', 'p4', 'seed', 'failed'),
];

test('active acting seat is marked in spaces and agents, never inferred from title or remote rows', () => {
  const rows = parsePaneRows(JSON.stringify({ panes: [
    { address: 'w1/t1/p1', workspace: 'alpha', pane: 'p1', title: 'worker', seat: 'TC-1', state: 'working' },
    { address: 'w2/t2/p2', workspace: 'beta', pane: 'p2', title: 'TC-1', seat: 'OTHER', state: 'idle' },
  ] }));
  const remote: SpaceTabRow = { ...rows[0]!, pane: 'remote:p1', wsId: 'remote:w1', workspace: 'remote', remote: 'remote' };
  const draw = (acting?: string) => trim(layoutSpaceList([...rows, remote], 'p1', 28, 20, undefined, 0, [], undefined, 'grouped', acting).lines);
  const active = draw('TC-1');
  expect(active.filter(line => line.includes('[OP 대행]'))).toEqual([' [OP 대행] ALPHA', ' 🟢 [OP 대행] TC-1']);
  expect(active.some(line => line.includes('[OP 대행] BETA') || line.includes('[OP 대행] REMOTE'))).toBe(false);
  expect(draw().some(line => line.includes('[OP 대행]'))).toBe(false);
});

test('OP space shows its active delegate, including while OP has no pane', () => {
  const op: SpaceTabRow = { workspace: 'op', wsId: 'op', pane: 'op-pane', title: 'OP', state: 'idle', seat: 'OP', role: 'coordinator' };
  const draw = (rows: SpaceTabRow[], acting?: string) => trim(layoutSpaceList(rows, undefined, 40, 15, undefined, 0, rows.length ? [] : [{ wsId: 'op', name: 'OP' }], undefined, 'grouped', acting).lines);
  expect(draw([op], 'TC')).toContain(' ⭐ OP → TC acting');
  expect(draw([], 'TC')).toContain(' ⭐ OP → TC acting');
  expect(draw([op])).not.toContain(' ⭐ OP → TC acting');
});

test('status mode: the agents panel flattens — every space\'s panes in one rank order (working → blocked → idle → failed), the head reads «status»', () => {
  const layout = layoutSpaceList(ROWS, 'p1', 28, 18, '/Users/me', 0, [], undefined, 'status');
  expect(trim(layout.lines)).toEqual([
    ' spaces',
    ' ALPHA',
    '   2 agents · alpha',
    ' BETA',
    ' GAMMA',
    '────────────────────────────',
    ' ○ All · 4            status',
    ' 🟢 build',
    ' 🟡 review',
    ' ⚪ old',
    ' 🔴 seed',
    '',
    '',
    '',
    '',
    '',
    '',
    ' new · menu',
  ]);
  expect(layout.lines.every((line) => Bun.stringWidth(line) === 28)).toBe(true);
});

test('default stays grouped: each space\'s own panes together, status order inside the space, the head reads «grouped»', () => {
  const layout = layoutSpaceList(ROWS, 'p1', 28, 18, '/Users/me');
  expect(trim(layout.lines)).toEqual([
    ' spaces         ▾ all ▸ all',
    ' ALPHA',
    '   2 agents · alpha',
    ' BETA',
    ' GAMMA',
    '────────────────────────────',
    ' ○ All · 4           grouped',
    ' ⌄ ALPHA                  2',
    ' 🟢 build',
    ' ⚪ old',
    ' ⌄ BETA                   1',
    ' 🟡 review',
    ' ⌄ GAMMA                  1',
    ' 🔴 seed',
    '',
    '',
    '',
    ' new · menu',
  ]);
});

test('app repaints the badge when the active baton changes or expires', async () => {
  const screens: string[] = [];
  let acting: string | undefined = 'TC-1';
  const listing = JSON.stringify({ panes: [{ address: 'w1/t1/p1', workspace: 'alpha', pane: 'p1', title: 'worker', seat: 'TC-1', state: 'working' }] });
  const app = createAttachApp({
    request: async () => ({ exitCode: 0, message: listing }),
    attach: () => ({ input() {}, resize() {}, scroll() {}, detach() {} }),
    write: s => { screens.push(plain(s)); }, size: () => ({ cols: 100, rows: 18 }), cwd: '/alpha', env: {},
    actingSeat: () => acting,
    setInterval: () => 0, clearInterval() {}, pollMs: 1000, chatCommand: ['eln'], memory: { load: () => ({}), save() {} },
  });
  await app.start('p1');
  expect((screens.at(-1)!.match(/\[OP 대행\]/g) ?? []).length).toBe(2);
  acting = undefined;
  app.resized();
  expect(screens.at(-1)).not.toContain('[OP 대행]');
  app.key('\u0002q');
});

test('ctrl+b g toggles the agents order; the upper-case G stays free (herdr keeps its own words)', () => {
  const router = createKeyRouter();
  expect(router.feed('\u0002g')).toEqual([{ kind: 'action', action: 'toggle-agents-order' }]);
  expect(router.feed('\u0002G')).toEqual([{ kind: 'unknown', key: 'G' }]);
});

const listing = JSON.stringify({
  workspaces: [{ id: 'w1', name: 'alpha' }, { id: 'w2', name: 'beta' }],
  panes: [
    { address: 'w1/t1/p1', workspace: 'w1', pane: 'p1', title: 'build', state: 'working' },
    { address: 'w1/t1/p2', workspace: 'w1', pane: 'p2', title: 'old', state: 'idle' },
    { address: 'w2/t2/p3', workspace: 'w2', pane: 'p3', title: 'review', state: 'blocked' },
  ],
});

test('the app flips the panel on ctrl+b g and back: grouped (an earlier space\'s idle ahead of a later space\'s blocked) → status (blocked ahead of the idle)', async () => {
  const screens: string[] = [];
  const app = createAttachApp({
    request: async (_r: ElsRequest) => ({ exitCode: 0, message: listing }),
    attach: () => ({ input() {}, resize() {}, scroll() {}, detach() {} }),
    remote: { list: async () => ({ exitCode: 0, message: JSON.stringify({ hosts: [], panes: [], remoteWorkspaces: [] }) }), read: async () => ({ exitCode: 0, message: '' }) },
    write: (s: string) => { screens.push(plain(s)); }, size: () => ({ cols: 100, rows: 20 }), cwd: '/alpha', env: {},
    setInterval: () => 0, clearInterval() {}, pollMs: 1000, chatCommand: ['eln'], memory: { load: () => ({}), save() {} },
  });
  await app.start('p1'); await Bun.sleep(20);
  const side = () => (screens.at(-1) ?? '').split('\r\n').map((line) => line.split('│')[0] ?? '');
  const head = () => side().find((line) => /^(○ All|◉ Active)/.test(line.trim()));
  const agentAt = (needle: string) => side().findIndex((line, at) => at > side().findIndex((l) => l === head()) && line.includes(needle));
  expect(head()).toContain('grouped');
  expect(agentAt('⚪')).toBeLessThan(agentAt('🟡'));          // grouped: w1's idle before w2's blocked
  app.key('\u0002g'); await Bun.sleep(20);
  expect(head()).toContain('status');
  expect(agentAt('🟢')).toBeLessThan(agentAt('🟡'));
  expect(agentAt('🟡')).toBeLessThan(agentAt('⚪'));          // status: one flat rank order across spaces
  app.key('\u0002g'); await Bun.sleep(20);
  expect(head()).toContain('grouped');
  expect(agentAt('⚪')).toBeLessThan(agentAt('🟡'));
  app.key('\u0002q');
});