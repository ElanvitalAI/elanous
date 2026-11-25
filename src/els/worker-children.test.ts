// DEMO-FANOUT-LIVE-OP-SEAT — worker children an agent opens through the tool door: journal link, env, list, agents column.
// Expectations are written as literals here (never built from the product's own constants or render helpers).
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElsCore, type ElsPty } from './core.js';
import { emptyJournal } from './space.js';
import { validJournal } from './journal.js';
import { parsePaneRows } from './attach-view.js';
import { layoutSpaceList, nestWorkerChildren, withCommands, workerProgress } from './space-tabs-view.js';
import { workerChildCwd } from './server.js';
import { detectSeat } from '../seat/seat-boot-preamble.js';
import { buildWorkerTabAddendum } from '../prompt-library/universal-preamble.js';
import type { AgentEventFrame } from '../agent-events/protocol.js';

function harness() {
  let journal = emptyJournal(), count = 0;
  const envs: Record<string, Record<string, string>> = {};
  const core = createElsCore({ load: () => journal, save: (next) => { journal = next; }, now: () => 500_000,
    spawn: (_command, _cwd, title, env) => { const id = `pty${++count}`; envs[title] = { ...env };
      return { id, isAlive: () => true, write: () => {}, renderScreen: async () => '', onExit: () => {}, kill: () => {}, lastOutputAt: () => 1 } as ElsPty; },
    mailBadges: () => new Map() });
  core.start();
  const open = (input: Parameters<typeof core.newPane>[0]) => (JSON.parse(core.newPane(input).message) as { pane: string }).pane;
  return { core, envs, open, journal: () => journal };
}

const turn = (pane: string, seq: number, phase: 'start' | 'end', id: string): AgentEventFrame =>
  ({ op: 'event', v: 1, ws: 'HQ', pane, sid: `s-${pane}`, seq, at: 500_000, event: { kind: 'turn', phase, id } });

test('a worker child gets its parent pane in env and journal, never the owner seat as ELANOUS_TRACK', () => {
  const h = harness();
  const op = h.open({ ws: 'HQ', cwd: '/u/seats/OP', command: ['eln'], title: 'OP', ownerSeat: 'OP', seatIdentity: 'OP' });
  const child = h.open({ ws: 'HQ', cwd: '/u/els/workers/w1', command: ['eln'], title: 'news', ownerSeat: 'OP', parentPane: op });
  expect(h.envs.OP!.ELANOUS_TRACK).toBe('OP');
  expect(h.envs.news!.ELANOUS_TRACK).toBeUndefined();
  expect(h.envs.news!.ELANOUS_ELS_PARENT_PANE).toBe(op);
  expect(h.envs.news!.ELANOUS_ELS_PARENT_SEAT).toBe('OP');
  expect(h.envs.news!.ELANOUS_ELS_WORKER_ID).toBe(`OP-${child.toUpperCase()}`);
  const row = h.journal().panes.find((p) => p.id === child)!;
  expect(row.parentPane).toBe(op);
  expect(row.ownerSeat).toBe('OP');
  // An owner pane with no parent keeps the old seat env.
  h.open({ ws: 'HQ', cwd: '/u/x', command: ['sh'], title: 'plain', ownerSeat: 'OP' });
  expect(h.envs.plain!.ELANOUS_TRACK).toBe('OP');
});

test('the listing carries parentPane and finished turns; a child in a seat folder is not listed as that seat', () => {
  const h = harness();
  const op = h.open({ ws: 'HQ', cwd: '/u/seats/OP', command: ['eln'], title: 'OP', ownerSeat: 'OP', seatIdentity: 'OP' });
  const child = h.open({ ws: 'HQ', cwd: '/u/seats/OP', command: ['eln'], title: 'news', ownerSeat: 'OP', parentPane: op });
  h.core.setForegrounds(new Map([[child, { kind: 'eln', pid: 7, command: ['eln'] }]]));
  const rowOf = () => (JSON.parse(h.core.list().message) as { panes: Array<Record<string, unknown>> }).panes.find((p) => p.pane === child)!;
  expect(rowOf().parentPane).toBe(op);
  expect(rowOf().turnsDone).toBe(0);
  expect(rowOf().seat).toBeNull();
  expect(h.core.agentEvent(child, turn(child, 1, 'start', 't1')).exitCode).toBe(0);
  expect(rowOf().turnsDone).toBe(0);
  expect(rowOf().activityState).toBe('working');
  expect(h.core.agentEvent(child, turn(child, 2, 'end', 't1')).exitCode).toBe(0);
  expect(rowOf().turnsDone).toBe(1);
  expect(rowOf().activityState).toBe('idle');
});

test('agents column: children sit under their parent with done/total, ✓ once a task turn finished', () => {
  const h = harness();
  const op = h.open({ ws: 'HQ', cwd: '/u/seats/OP', command: ['eln'], title: 'OP', ownerSeat: 'OP', seatIdentity: 'OP' });
  const kids = ['news', 'sentiment', 'market'].map((title) => h.open({ ws: 'HQ', cwd: `/u/w/${title}`, command: ['eln'], title, ownerSeat: 'OP', parentPane: op }));
  h.core.setForegrounds(new Map([[op, { kind: 'eln', pid: 1, command: ['eln'] }], ...kids.map((k, i) => [k, { kind: 'eln' as const, pid: 10 + i, command: ['eln'] }] as const)]));
  const shown = () => { const json = h.core.list().message; return layoutSpaceList(withCommands(parsePaneRows(json), json), op, 30, 20).lines.join('\n'); };
  expect(shown()).toContain('OP 0/3');
  expect(shown()).toContain('↳ ');
  h.core.agentEvent(kids[0]!, turn(kids[0]!, 1, 'start', 'a'));
  h.core.agentEvent(kids[0]!, turn(kids[0]!, 2, 'end', 'a'));
  expect(shown()).toContain('OP 1/3');
  expect(shown()).toContain('news ✓');
  for (const k of kids.slice(1)) { h.core.agentEvent(k, turn(k, 1, 'start', 'b')); h.core.agentEvent(k, turn(k, 2, 'end', 'b')); }
  expect(shown()).toContain('OP 3/3');
  // The children follow their parent row, in the order they were opened.
  const lines = shown().split('\n');
  const at = (name: string) => lines.findIndex((line) => line.includes(name));
  expect(at('OP 3/3')).toBeLessThan(at('news'));
  expect(at('news')).toBeLessThan(at('sentiment'));
  expect(at('sentiment')).toBeLessThan(at('market'));
});

test('nesting and progress helpers: an orphan child stays in place; no children = no progress', () => {
  const row = (pane: string, parentPane?: string, turnsDone = 0, state = 'idle') =>
    ({ row: { pane, wsId: 'w', workspace: 'HQ', title: pane, state, ...(parentPane ? { parentPane, turnsDone } : {}) } });
  const order = nestWorkerChildren([row('c1', 'P', 1), row('X'), row('P'), row('c2', 'P'), row('o', 'GONE')]).map((e) => e.row.pane);
  expect(order).toEqual(['X', 'P', 'c1', 'c2', 'o']);
  const rows = [row('P').row, row('c1', 'P', 1).row, row('c2', 'P', 1, 'working').row, row('c3', 'P').row];
  expect(workerProgress('P', rows)).toEqual({ done: 1, total: 3 });
  expect(workerProgress('c1', rows)).toBeUndefined();
});

test('journal round-trips parentPane and refuses an empty one', () => {
  const pane = { id: 'p2', tabId: 't1', kind: 'pty', title: 'news', cwd: '/w', command: ['eln'], state: 'idle', restore: 'cwd', ptyId: '', scrollback: '' };
  const base = { version: 1, workspaces: [{ id: 'w1', name: 'HQ', rootCwd: '/w', purpose: '', host: 'local' }], tabs: [{ id: 't1', workspaceId: 'w1', label: 'news', focusPaneId: 'p2' }] };
  const ok = validJournal({ ...base, panes: [{ ...pane, parentPane: 'p1' }] });
  expect(ok.panes[0]!.parentPane).toBe('p1');
  expect(() => validJournal({ ...base, panes: [{ ...pane, parentPane: '' }] })).toThrow();
});

test('a worker child opened from a seat folder works in its own folder under els; any other folder is kept', () => {
  const root = mkdtempSync(join(tmpdir(), 'wchild-'));
  try {
    const moved = workerChildCwd(root, '/Users/x/elanous-hq/seats/OP');
    expect(moved.startsWith(join(root, 'els', 'workers', 'w'))).toBe(true);
    expect(statSync(moved).isDirectory()).toBe(true);
    expect(workerChildCwd(root, '/Users/x/project')).toBe('/Users/x/project');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('detectSeat: a pane opened as another pane\'s worker child is no seat, even inside a seat folder', () => {
  expect(detectSeat('/h/elanous-hq/seats/OP', {})).toEqual({ seat: 'OP', source: 'cwd' });
  expect(detectSeat('/h/elanous-hq/seats/OP', { ELANOUS_ELS_PARENT_PANE: 'p1' })).toBeNull();
  expect(detectSeat('/tmp', { COORD_ID: 'TC', ELANOUS_ELS_PARENT_PANE: 'p1' })).toBeNull();
});

test('worker tab preamble: own mail id and the seat to report to; nothing outside a worker tab', () => {
  const [msg] = buildWorkerTabAddendum({ ELANOUS_ELS_PARENT_PANE: 'p75a03a07', ELANOUS_ELS_PARENT_SEAT: 'OP', ELANOUS_ELS_WORKER_ID: 'OP-P58E87548' });
  expect(String(msg!.content)).toContain('MsgPost from="OP-P58E87548" to="OP"');
  expect(String(msg!.content)).toContain('You are not a seat.');
  expect(buildWorkerTabAddendum({})).toEqual([]);
  expect(String(buildWorkerTabAddendum({ ELANOUS_ELS_PARENT_PANE: 'p1', ELANOUS_ELS_WORKER_ID: 'WORKER-P2' })[0]!.content)).toContain('leave the result as your final answer');
});
