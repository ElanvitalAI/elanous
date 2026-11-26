// GOAL-ORCHESTRATION-NL: the bare els window switches to the staged tile view when a goal run starts in one of its
// workspaces (stageWatch), and applies the feed's layout commands (grid · zoom) once per seq. Literal expectations.
import { expect, test } from 'bun:test';
import type { Attached } from './attach-client.js';
import { createAttachApp } from './attach-app.js';
import { createAppFrameWriter } from './attach-view.js';
import type { ElsResult } from './core.js';

const plain = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const listing = JSON.stringify({ workspaces: [], tabs: [], panes: [
  { address: 'w1/t1/p1', workspace: 'demo', pane: 'p1', title: 'eln', state: 'idle' },
  { address: 'w2/t2/p2', workspace: 'orch-ab12', pane: 'p2', title: 'ORCH·optimist', state: 'working' },
  { address: 'w2/t3/p3', workspace: 'orch-ab12', pane: 'p3', title: 'ORCH·risk', state: 'working' },
] });

function app(watch: (workspaces: readonly string[]) => { key: string; ws: string; readFeed: () => string | undefined } | undefined) {
  const out: string[] = [];
  const ticks: (() => void)[] = [];
  const view = createAttachApp({
    request: async (request): Promise<ElsResult> => ({ exitCode: 0, message: request.op === 'ls' ? listing : request.op === 'tile-frame' ? '[screen 40x10]\nthinking…' : '' }),
    attach: (): Attached => ({ input: () => {}, resize: () => {}, scroll: () => {}, detach: () => {} }),
    write: createAppFrameWriter((text) => { out.push(text); }),
    size: () => ({ cols: 160, rows: 40 }),
    cwd: '/work', env: { SHELL: '/bin/zsh' },
    setInterval: (fn: () => void) => { ticks.push(fn); return ticks.length; }, clearInterval: () => {}, pollMs: 1000,
    chatCommand: ['/opt/elanous/bin/elanous'],
    memory: { load: () => ({}), save: () => {} },
    stageWatch: watch,
  });
  const tick = async (): Promise<void> => { for (const fn of [...ticks]) fn(); await new Promise((r) => setTimeout(r, 5)); };
  return { view, out, tick, screen: () => plain(out.join('')) };
}

test('a run that already existed when the window opened is not ours; a new run switches to its staged tiles', async () => {
  let run: { key: string; ws: string; readFeed: () => string | undefined } | undefined = { key: 'orch-old', ws: 'orch-ab12', readFeed: () => undefined };
  const feed = ['{"phase":"work","nodes":["plan","spawn","work","reduce"],"receipt":"MET · 1 round(s)"}'];
  const a = app(() => run);
  await a.view.start('p1');
  await a.tick();
  expect(a.screen()).not.toContain('conductor');
  run = { key: 'orch-new', ws: 'orch-ab12', readFeed: () => feed.join('\n') };
  await a.tick();
  await a.tick();
  const s = a.screen();
  expect(s).toContain('◆ conductor');
  expect(s).toContain('ORCH·optimist');
  expect(s).toContain('ORCH·risk');
});

test('a run in a workspace this window does not list is ignored', async () => {
  const a = app(() => undefined);
  await a.view.start('p1');
  const b = app((() => { let n = 0; return () => (n++ ? { key: 'orch-x', ws: 'elsewhere', readFeed: () => '{}' } : undefined); })());
  await b.view.start('p1');
  await b.tick(); await b.tick();
  expect(b.screen()).not.toContain('conductor');
});

test('a run already active when the window opens (seen only after the first listing) is not treated as new', async () => {
  const active = { key: 'orch-running', ws: 'orch-ab12', readFeed: () => '{"phase":"work"}' };
  const a = app((workspaces) => (workspaces.includes('orch-ab12') ? active : undefined));
  await a.view.start('p1');
  await a.tick(); await a.tick();
  expect(a.screen()).not.toContain('conductor');
});
