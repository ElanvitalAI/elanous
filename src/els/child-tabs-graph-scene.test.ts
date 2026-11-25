// DEMO-GRAPH-TAB-POLISH · DEMO-INVEST-SCENE-WIRE — a graph run's tab opens at once at 120×36, stays open after the run,
// and draws a scene (the invest research widgets) fitted to the pane; a resize redraws it. Literal expectations (rule 11).
import { expect, test } from 'bun:test';
import { createElsCore } from './core.js';
import { createChildTabs } from './child-tabs.js';
import { emptyJournal, type SpaceJournal } from './space.js';

function rig() {
  let stored: SpaceJournal = emptyJournal();
  const core = createElsCore({ load: () => stored, save: (j) => { stored = j; }, spawn: () => { throw new Error('no pty'); } });
  core.start();
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const tabs = createChildTabs({ core, now: () => 0, tickMs: 0, paneSize: (pane) => core.paneSize(pane),
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; }, clearTimer: (h) => { (h as { live: boolean }).live = false; } });
  const fireAll = () => { for (const t of timers.splice(0)) if (t.live) t.fn(); };
  return { core, tabs, stored: () => stored, fireAll };
}

const MODEL = {
  title: 'Research · 005930.KO',
  fanout: { parent: { name: 'Graph run', state: 'running' as const }, children: [
    { name: 'Macro', modelTail: 'eln glm-4.6', state: 'done' as const, progress: 1, elapsedMs: 2000, lastLine: 'HOLD 5/10' },
    { name: 'HBM', modelTail: 'codex gpt-6.2-sol', state: 'running' as const, progress: null, elapsedMs: 1000 },
  ] },
  steps: [{ label: 'Plan', state: 'done' as const }, { label: 'Panel', state: 'active' as const, note: '1 of 2 answered in parallel' }],
};

test('graph run: tab at start (no 60 s wait), sized 120×36; with an end card it stays open after done and every timer', () => {
  const r = rig();
  expect(r.tabs.start({ id: 'graph:R', ws: 'demo', source: 'graph', label: 'invest-orch-demo · R' }).exitCode).toBe(0);
  expect(r.stored().panes).toHaveLength(1);
  const pane = r.stored().panes[0]!.id;
  expect(r.core.paneSize(pane)).toEqual({ cols: 120, rows: 36 });
  r.tabs.end('graph:R', true, 'done');
  r.tabs.scene('graph:R', { kind: 'invest-research', model: MODEL }); // the end card arrives after the run ended
  r.fireAll();
  expect(r.stored().panes.map((p) => p.id)).toEqual([pane]);
  expect(r.tabs.dismiss('graph:R').exitCode).toBe(0);
  expect(r.stored().panes).toHaveLength(0);
  // A plain graph run (no scene) still closes after success.
  r.tabs.start({ id: 'graph:S', ws: 'demo', source: 'graph', label: 'release · S' });
  r.tabs.end('graph:S', true, 'done');
  r.fireAll();
  expect(r.stored().panes).toHaveLength(0);
});

test('scene: the tab draws the widgets, fitted to the pane; a resize to 40×8 redraws within bounds; non-graph refused', () => {
  const r = rig();
  r.tabs.start({ id: 'graph:R', ws: 'demo', source: 'graph', label: 'run' });
  expect(r.tabs.scene('graph:R', { kind: 'invest-research', model: MODEL }).exitCode).toBe(0);
  const pane = r.stored().panes[0]!.id;
  expect(r.stored().panes[0]!.scrollback).toBe([
    'Research · 005930.KO',
    '● Graph run — 2 agents · 1 running · 1 done',
    '├─ ✓ Macro  eln glm-4.6        ██████████ 100%     2s  HOLD 5/10',
    '└─ ● HBM    codex gpt-6.2-sol  ░░░░░░░░░░    —     1s',
    '',
    '✓ Plan',
    '▸ Panel · 1 of 2 answered in parallel',
  ].join('\n'));
  r.core.resize(pane, 40, 8);
  r.tabs.redraw(pane);
  // 40 columns: the board drops model and bar, the parent row is cut with «…».
  expect(r.stored().panes[0]!.scrollback.split('\n')).toEqual([
    'Research · 005930.KO',
    '● Graph run — 2 agents · 1 running · 1…',
    '├─ ✓ Macro  100%     2s  HOLD 5/10',
    '└─ ● HBM       —     1s',
    '',
    '✓ Plan',
    '▸ Panel · 1 of 2 answered in parallel',
  ]);
  r.tabs.start({ id: 'h', ws: 'demo', source: 'harness', label: 'h' });
  expect(r.tabs.scene('h', { kind: 'invest-research', model: MODEL }).exitCode).toBe(1);
  expect(r.tabs.scene('graph:R', { kind: 'nope', model: MODEL } as never).exitCode).toBe(1);
});
