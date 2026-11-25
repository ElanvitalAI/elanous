import { expect, test } from 'bun:test';
import { createElsCore } from './core.js';
import { createChildTabs } from './child-tabs.js';
import { emptyJournal, type SpaceJournal } from './space.js';
import { childSummary } from './status-vocab.js';

function rig(maxTabs?: number, paneSize?: { cols: number; rows: number }) {
  let stored: SpaceJournal = emptyJournal();
  const core = createElsCore({ load: () => stored, save: (j) => { stored = j; }, spawn: () => { throw new Error('no pty'); } });
  core.start();
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const lines: string[] = [];
  let clock = 0;
  const tabs = createChildTabs({ core, ...(maxTabs ? { maxTabs } : {}), ...(paneSize ? { paneSize: () => paneSize } : {}), now: () => clock, notifyParent: (_ws, line) => lines.push(line),
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; }, clearTimer: (h) => { (h as { live: boolean }).live = false; } });
  const fire = (ms = 10_000) => { for (const t of timers.filter((x) => x.ms === ms)) { timers.splice(timers.indexOf(t), 1); if (t.live) t.fn(); } };
  const aged = () => fire(60_000); // 60 s pass: long-lived children get their tabs
  const titles = () => stored.panes.map((p) => p.title);
  return { aged, tabs, stored: () => stored, timers, lines, fire, titles, tick: (ms: number) => { clock += ms; } };
}
const start = (r: ReturnType<typeof rig>, id: string, extra = {}) => r.tabs.start({ id, ws: 'OP', source: 'harness', label: id, ...extra });

test('3 children: 3 tabs · 2 succeed and close after the delay · 1 fails and stays · pin keeps', () => {
  const r = rig();
  for (const id of ['a', 'b', 'c']) expect(start(r, id).exitCode).toBe(0);
  expect(r.stored().tabs).toHaveLength(0); // nothing is 60 s old yet
  r.aged();
  expect(r.stored().tabs).toHaveLength(3);
  expect(r.titles()[0]).toBe('↳ ⎇ harness · a 🟢');
  r.tabs.progress('a', 'step 1');
  expect(r.stored().panes[0]!.scrollback).toBe('step 1');
  r.tabs.pin('b');
  expect(r.tabs.end('a', true, 'ok').message).toContain('done');
  r.tabs.end('b', true, 'ok');
  expect(r.tabs.end('c', false, 'boom').message).toContain('FAILED');
  expect(r.lines).toHaveLength(3);
  expect(r.stored().tabs).toHaveLength(3);
  expect(r.timers.map((t) => t.ms)).toEqual([10_000]); // only the unpinned success closes
  r.fire();
  expect(r.titles()).toEqual(['↳ ⎇ harness · b ✅', '↳ ⎇ harness · c 🔴']);
  expect(r.stored().panes[1]!.state).toBe('done');
  r.tabs.unpin('b'); r.fire();
  expect(r.titles()).toEqual(['↳ ⎇ harness · c 🔴']);
  r.tabs.dismiss('c');
  expect(r.stored().tabs).toHaveLength(0);
});

test('short-lived child: no tab, only the parent summary; shell never gets a tab until pinned', () => {
  const r = rig();
  start(r, 'quick');
  start(r, 's1', { source: 'shell' }); start(r, 's2', { source: 'shell' });
  expect(r.tabs.summary('OP')).toBe('⎇3 🟢3 ⌁2'.replace('⎇3 🟢3 ', '⎇1 🟢1 '));
  r.tabs.end('quick', true, 'ok');
  r.aged(); // quick's promotion timer was cancelled by its end
  expect(r.stored().tabs).toHaveLength(0);
  r.tabs.pin('s1');
  expect(r.titles()).toEqual(['↳ ⌁ shell · s1 🟢']);
  expect(r.tabs.tree('OP').filter((row) => row.id.startsWith('s'))).toHaveLength(2); // the expandable list
});

test('per-parent cap 4: the 5th long-lived child of one parent goes to the «⎇ +n» bundle', () => {
  const r = rig();
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) start(r, id);
  r.aged();
  expect(r.stored().tabs).toHaveLength(5); // 4 own tabs + 1 bundle
  expect(r.titles()[4]).toBe('↳ ⎇ +2 more 🟢');
});

test('over the global cap: one bundle tab lists the rest and closes when all are done', () => {
  const r = rig(2);
  for (const id of ['a', 'b', 'c', 'd']) start(r, id);
  r.aged();
  expect(r.stored().tabs).toHaveLength(3);
  expect(r.stored().panes[2]!.scrollback).toBe('🟢 harness · c\n🟢 harness · d');
  r.tabs.end('c', true, 'ok'); r.tabs.end('d', true, 'ok');
  expect(r.stored().panes[2]!.state).toBe('done');
  r.fire();
  expect(r.stored().tabs).toHaveLength(2);
});

test('graph run: nodes inside the run tab, blocked node, harness under a node one level deeper, shared summary', () => {
  const r = rig();
  r.tabs.start({ id: 'g', ws: 'OP', source: 'graph', label: 'app-build · 891dc068' });
  r.aged();
  expect(start(r, 'bad', { source: 'graph-node', parent: 'x' }).exitCode).toBe(1);
  for (const n of ['grounding', 'verify-repair', 'materialize']) r.tabs.start({ id: n, ws: 'OP', source: 'graph-node', label: n, parent: 'g' });
  r.tabs.end('grounding', true, '');
  r.tabs.progress('verify-repair', 'r6');
  r.tabs.status('materialize', 'blocked');
  const text = r.stored().panes[0]!.scrollback;
  expect(text.endsWith('\n\n  ✅ grounding\n  🟢 verify-repair · r6\n  🟡 materialize · 승인 대기')).toBe(true);
  expect(text.split('\n')[1]).toBe('✓ grounding ═ ◐ verify-repair ─ ◐ materialize'); // graph-view edge line
  expect(r.stored().tabs).toHaveLength(1); // nodes are not tabs
  r.tabs.start({ id: 'h', ws: 'OP', source: 'harness', label: 'repair', parent: 'verify-repair' });
  r.aged();
  expect(r.titles()[1]).toBe('    ↳ ⎇ harness · repair 🟢'); // run depth 0 → node 1 → harness 2
  expect(r.tabs.tree('OP').map((row) => [row.depth, row.text, row.state])).toEqual([
    [0, '↳ ⎔ graph · app-build · 891dc068', 'working'],
    [1, '  ✅ grounding', 'done'], [1, '  🟢 verify-repair · r6', 'working'],
    [2, '    ↳ ⎇ harness · repair', 'working'], [1, '  🟡 materialize · 승인 대기', 'blocked']]);
  expect(r.tabs.summary('OP')).toBe('⎇1 🟢1');
  r.tabs.end('h', true, 'fixed');
  r.tabs.end('g', true, 'built');
  expect(childSummary(['working', 'working', 'failed'])).toBe('⎇3 🟢2 🔴1');
});

test('graph dashboard uses the launchd truecolor environment, but does not invent color when absent', () => {
  const previousColor = process.env.COLORTERM;
  const previousTerm = process.env.TERM;
  try {
    delete process.env.TERM;
    for (const color of [undefined, 'truecolor']) {
      if (color === undefined) delete process.env.COLORTERM;
      else process.env.COLORTERM = color;
      const r = rig(undefined, { cols: 120, rows: 40 });
      r.tabs.start({ id: 'g', ws: 'OP', source: 'graph', label: 'run' });
      r.aged();
      r.tabs.start({ id: 'n', ws: 'OP', source: 'graph-node', label: 'node', parent: 'g' });
      expect(/\x1b\[(?:38|48);2;\d+;\d+;\d+m/.test(r.stored().panes[0]!.scrollback)).toBe(color === 'truecolor');
    }
  } finally {
    if (previousColor === undefined) delete process.env.COLORTERM; else process.env.COLORTERM = previousColor;
    if (previousTerm === undefined) delete process.env.TERM; else process.env.TERM = previousTerm;
  }
});

test('closing a graph run keeps its running harness: it moves up and stays in the tree', () => {
  const r = rig();
  r.tabs.start({ id: 'g', ws: 'OP', source: 'graph', label: 'run' });
  r.tabs.start({ id: 'n', ws: 'OP', source: 'graph-node', label: 'node', parent: 'g' });
  start(r, 'h', { parent: 'n' });
  r.tabs.end('n', true, ''); r.tabs.end('g', true, 'done');
  r.aged(); r.fire();
  expect(r.tabs.tree('OP').map((row) => [row.id, row.depth])).toEqual([['h', 0]]);
});
