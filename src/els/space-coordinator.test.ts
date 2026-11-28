import { expect, test } from 'bun:test';
import { createElsCore } from './core.js';
import { widgetLaunch } from './widget-registry.js';
import { validJournal } from './journal.js';
import type { SpaceJournal } from './space.js';

function fixture() {
  const ws = (id: string) => ({ id, name: id, rootCwd: '/work', purpose: '', host: 'local' });
  const tab = (id: string, workspaceId: string) => ({ id, workspaceId, label: id, focusPaneId: `p-${id}` });
  const pane = (id: string, cwd: string) => ({ id: `p-${id}`, tabId: id, kind: 'pty' as const, title: id, cwd, command: ['eln'], state: 'idle' as const, restore: 'cwd' as const, ptyId: `pty-${id}`, scrollback: '' });
  const initial: SpaceJournal = { version: 1, workspaces: [ws('OP'), ws('alpha'), ws('beta')],
    tabs: [tab('a-hand', 'alpha'), tab('a-lead', 'alpha'), tab('b-hand', 'beta'), tab('b-lead', 'beta')],
    panes: [pane('a-hand', '/hq/seats/A-HAND'), pane('a-lead', '/hq/seats/A/subdir'), pane('b-hand', '/hq/seats/B-HAND'), pane('b-lead', '/hq/seats/B')] };
  let disk = JSON.stringify(initial), writes = 0, fail = false;
  const make = () => {
    const core = createElsCore({ load: () => validJournal(JSON.parse(disk)), save: journal => { writes++; if (fail) throw new Error('disk full'); disk = JSON.stringify(journal); }, spawn: () => { throw new Error('unexpected spawn'); }, mailBadges: () => new Map() });
    expect(core.start()).toBeUndefined();
    return core;
  };
  return { make, disk: () => disk, writes: () => writes, fail: (value: boolean) => { fail = value; } };
}

function list(core: ReturnType<typeof createElsCore>) {
  return JSON.parse(core.list().message) as { workspaces: { id: string; coordinatorSeat?: string; role?: string }[]; panes: { pane: string; spaceCoordinator?: boolean }[] };
}

test('two independent assignments persist and put each coordinator tab first without rewriting tab order', () => {
  const f = fixture(); let core = f.make();
  expect(core.setCoordinator('beta').exitCode).toBe(0);
  expect(core.setSpaceCoordinator('alpha', 'A').exitCode).toBe(0);
  expect(core.setSpaceCoordinator('beta', 'B').exitCode).toBe(0);
  const saved = JSON.parse(f.disk());
  expect(saved.tabs.map((t: { id: string }) => t.id)).toEqual(['a-hand', 'a-lead', 'b-hand', 'b-lead']);
  expect(saved.workspaces.map((w: { coordinatorSeat?: string }) => w.coordinatorSeat ?? null)).toEqual([null, 'A', 'B']);
  const before = f.disk(), writes = f.writes();
  expect(core.setSpaceCoordinator('alpha', 'A').message).toContain('unchanged');
  expect(f.writes()).toBe(writes); expect(f.disk()).toBe(before);
  core = f.make();
  expect(list(core).workspaces.map(w => [w.id, w.coordinatorSeat ?? null, w.role ?? null])).toEqual([['beta', 'B', 'coordinator'], ['OP', null, null], ['alpha', 'A', null]]);
  expect(list(core).panes.map(p => p.pane)).toEqual(['p-b-lead', 'p-b-hand', 'p-a-lead', 'p-a-hand']);
  expect(list(core).panes.map(p => [p.pane, p.spaceCoordinator ?? false])).toEqual([['p-b-lead', true], ['p-b-hand', false], ['p-a-lead', true], ['p-a-hand', false]]);
});

test('invalid, foreign, ambiguous and failed-save assignment never changes state', () => {
  const f = fixture(), core = f.make();
  expect(core.setSpaceCoordinator('alpha', 'A').exitCode).toBe(0);
  const before = f.disk(), view = list(core);
  for (const [workspace, seat, code] of [['alpha', '', 2], ['missing', 'A', 1], ['alpha', 'B', 1], ['alpha', 'MISSING', 1]] as const)
    expect(core.setSpaceCoordinator(workspace, seat).exitCode).toBe(code);
  f.fail(true);
  expect(core.setSpaceCoordinator('beta', 'B').message).toContain('disk full');
  expect(f.disk()).toBe(before); expect(list(core)).toEqual(view);
  const raw = JSON.parse(before); raw.panes.push({ ...raw.panes[1], id: 'duplicate', tabId: 'b-hand' });
  const ambiguous = createElsCore({ load: () => validJournal(raw), save: () => { throw new Error('must not save'); }, spawn: () => ({ id: 'spawned', isAlive: () => true, renderScreen: async () => '', write() {}, resize() {}, kill() {}, onData() {}, onExit() {} }), mailBadges: () => new Map() });
  expect(ambiguous.start()).toBeUndefined();
  expect(ambiguous.setSpaceCoordinator('alpha', 'A').message).toContain('duplicated');
});

test('journal refuses invalid or duplicate assigned seats but reads legacy records', () => {
  const f = fixture(); const raw = JSON.parse(f.disk());
  expect(validJournal(raw).workspaces[0]!.coordinatorSeat).toBeUndefined();
  raw.workspaces[0].coordinatorSeat = 'A'; raw.workspaces[1].coordinatorSeat = 'A';
  expect(() => validJournal(raw)).toThrow('duplicate coordinator seats');
  raw.workspaces[1].coordinatorSeat = 'invalid seat';
  expect(() => validJournal(raw)).toThrow();
});

test('widgets and channel observers sharing OP cwd are not seats or coordinator duplicates', () => {
  const ws = { id: 'w', name: 'OP', rootCwd: '/hq/seats/OP', purpose: '', host: 'local' };
  const commands = [['eln'], ['zsh', '/hq/tools/fed-board.sh'], ['elanous', 'release', 'graph', 'board'], ['bun', 'elanous.mjs', 'side', 'channel', 'view', 'ws:supervisors'], ['elanous', 'side', 'obsidian'], ['zsh']];
  const titles = ['OP', '▦ fed-board', '▦ release-board', '# ws:supervisors', '▦ obsidian', 'terminal'];
  const tabs = commands.map((_, i) => ({ id: `t${i}`, workspaceId: 'w', label: titles[i], focusPaneId: `p${i}` }));
  const panes = commands.map((command, i) => ({ id: `p${i}`, tabId: `t${i}`, kind: 'pty', title: titles[i], cwd: '/hq/seats/OP', command, state: 'idle', restore: 'cwd', ptyId: `pty${i}`, scrollback: '', ...(i === 0 ? { seatIdentity: 'OP' } : {}) }));
  let disk = JSON.stringify({ version: 1, workspaces: [ws], tabs, panes });
  const badgeRequests: string[][] = [];
  const core = createElsCore({ load: () => validJournal(JSON.parse(disk)), save: j => { disk = JSON.stringify(j); }, spawn: () => ({ id: 'spawned', isAlive: () => true, renderScreen: async () => '', write() {}, resize() {}, kill() {}, onData() {}, onExit() {} }), mailBadges: seats => { badgeRequests.push([...seats]); return new Map(); } });
  core.start();
  expect(core.setHqCoordinator('OP').exitCode).toBe(0);
  const listed = JSON.parse(core.list().message);
  expect(listed.panes.map((p: { seat: string | null }) => p.seat)).toEqual(['OP', null, null, null, null, null]);
  expect(badgeRequests.at(-1)).toEqual(['OP']);

  // Simulate the widget registry -> new pane -> list path in an isolated journal.
  const widget = widgetLaunch('release-board', {});
  if (!widget.ok) throw new Error('release-board unavailable');
  const created = core.newPane({ ws: 'OP', cwd: '/hq/seats/OP', title: widget.title, command: widget.command });
  expect(created.exitCode).toBe(0);
  const addedId = JSON.parse(created.message).pane;
  const after = JSON.parse(core.list().message);
  const added = after.panes.find((p: { pane: string }) => p.pane === addedId);
  expect(added).toBeDefined();
  expect(added.seat).toBeNull();
  expect(after.panes.filter((p: { seat: string | null }) => p.seat === 'OP')).toHaveLength(1);
});

test('legacy hand tabs without seatIdentity keep their seat by cwd; a plain shell in a seat dir does not', () => {
  const ws = { id: 'w', name: 'HANDS', rootCwd: '/hq/seats', purpose: '', host: 'local' };
  const rows: { cwd: string; command: string[]; title: string }[] = [
    { cwd: '/hq/seats/TC-H-1', command: ['/Users/u/.local/share/elanous/bin/elanous', '--resume', 'sess-123'], title: 'TC-H-1' },
    { cwd: '/hq/seats/UX', command: ['/Users/u/.bun/bin/bun', '/Users/u/.bun/install/global/node_modules/elanous/bin/elanous.mjs', '--name', 'ux'], title: 'UX' },
    { cwd: '/hq/seats/JUD-2', command: ['codex', '-p', 'seat'], title: 'JUD-2' },
    { cwd: '/hq/seats/MK', command: ['eln'], title: 'MK' },
    { cwd: '/hq/seats/REVIEW-1', command: ['zsh'], title: 'terminal' },
    { cwd: '/hq/seats/REVIEW-1', command: ['/bin/bash'], title: 'terminal' },
    { cwd: '/hq/tmp', command: ['codex', '-p', 'seat'], title: 'loose' },
  ];
  const tabs = rows.map((r, i) => ({ id: `t${i}`, workspaceId: 'w', label: r.title, focusPaneId: `p${i}` }));
  const panes = rows.map((r, i) => ({ id: `p${i}`, tabId: `t${i}`, kind: 'pty', title: r.title, cwd: r.cwd, command: r.command, state: 'idle', restore: 'cwd', ptyId: `pty${i}`, scrollback: '' }));
  let disk = JSON.stringify({ version: 1, workspaces: [ws], tabs, panes });
  const badgeRequests: string[][] = [];
  const core = createElsCore({ load: () => validJournal(JSON.parse(disk)), save: j => { disk = JSON.stringify(j); }, spawn: () => ({ id: 'spawned', isAlive: () => true, renderScreen: async () => '', write() {}, resize() {}, kill() {}, onData() {}, onExit() {} }), mailBadges: seats => { badgeRequests.push([...seats]); return new Map(); } });
  core.start();
  const listed = JSON.parse(core.list().message);
  expect(listed.panes.map((p: { seat: string | null }) => p.seat)).toEqual(['TC-H-1', 'UX', 'JUD-2', 'MK', null, null, null]);
  expect(badgeRequests.at(-1)).toEqual(['TC-H-1', 'UX', 'JUD-2', 'MK']);
});
