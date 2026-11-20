// ELS-HERDR-IMPORT: a fake herdr snapshot (no real herdr) → `els import herdr` against a real els owner core with fake PTYs.
// Expectations are literals: the workspace/tab/cwd strings below are written out, not derived from the product code.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HerdrCliRunner } from '../pty-shell/herdr-prompt.js';
import { createElsCore, type ElsPty, type ElsResult } from './core.js';
import { importHerdr } from './herdr-import.js';
import type { ElsRequest } from './server.js';
import { emptyJournal, type SpaceJournal } from './space.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), 'els-herdr-import-')); dirs.push(dir); return dir; };

// Trimmed from a real `herdr api snapshot` (herdr 0.9.1): result.snapshot.{workspaces,tabs,panes}.
const SNAPSHOT = { id: 'cli:api:snapshot', result: { snapshot: {
  workspaces: [{ workspace_id: 'w1', label: 'OP' }, { workspace_id: 'w2', label: 'REL' }],
  tabs: [
    { tab_id: 'w1:t2', workspace_id: 'w1', label: 'main' },
    { tab_id: 'w1:t7', workspace_id: 'w1', label: 'mvp' },
    { tab_id: 'w2:t1', workspace_id: 'w2', label: '' },
  ],
  panes: [
    { pane_id: 'w1:p2', tab_id: 'w1:t2', workspace_id: 'w1', agent: 'claude', agent_status: 'working', cwd: '/work/OP', terminal_title: '◑ OP' },
    { pane_id: 'w1:p3', tab_id: 'w1:t2', workspace_id: 'w1', agent_status: 'unknown', cwd: '/work/OP', terminal_title: 'zsh' },
    { pane_id: 'w1:p7', tab_id: 'w1:t7', workspace_id: 'w1', agent_status: 'unknown', cwd: '/work/MVP-B' },
    { pane_id: 'w2:p2', tab_id: 'w2:t1', workspace_id: 'w2', agent: 'codex', agent_status: 'idle', cwd: '/work/REL' },
  ] } } };

function fakePty(id: string): ElsPty {
  return { id, isAlive: () => true, write: () => {}, writeAll: async () => {}, bracketedPasteEnabled: () => true,
    renderScreen: async () => '', onExit: () => {}, kill: () => {} };
}

/** A real els owner core over an in-memory journal; spawns are recorded, no process starts. */
function els(options: { failNewFor?: string } = {}) {
  let stored: SpaceJournal = emptyJournal();
  const spawned: { command: string[]; cwd: string; title: string }[] = [];
  const core = createElsCore({
    load: () => stored,
    save: (journal) => { stored = journal; },
    spawn: (command, cwd, title) => { spawned.push({ command: [...command], cwd, title }); return fakePty(`pty_${spawned.length}`); },
  });
  expect(core.start()).toBeUndefined();
  const requests: string[] = [];
  const request = async (req: ElsRequest): Promise<ElsResult> => {
    requests.push(req.op);
    if (req.op === 'ls') return core.list();
    if (req.op === 'new') {
      if (options.failNewFor && req.cwd === options.failNewFor) return { exitCode: 1, message: 'els new: failed to spawn: disk full' };
      return core.newPane({ ws: req.ws, cwd: req.cwd, command: req.command, ...(req.title ? { title: req.title } : {}) });
    }
    return { exitCode: 2, message: `unexpected ${req.op}` };
  };
  const layout = () => {
    const listed = JSON.parse(core.list().message) as { tabs: { id: string; label: string }[]; panes: { workspace: string; tab: string; cwd: string; command: string[] }[] };
    return listed.panes.map((pane) => [pane.workspace, listed.tabs.find((tab) => tab.id === pane.tab)?.label, pane.cwd, pane.command.join(' ')]);
  };
  return { request, requests, spawned, layout, setFailNew: (cwd: string | undefined) => { options.failNewFor = cwd; } };
}

function herdr(options: { code?: number | null; stderr?: string; stdout?: string } = {}) {
  const calls: string[][] = [];
  const before = JSON.stringify(SNAPSHOT);
  const run: HerdrCliRunner = async (argv) => {
    calls.push([...argv]);
    if (options.code !== undefined) return { code: options.code, stdout: '', stderr: options.stderr ?? '' };
    return { code: 0, stdout: options.stdout ?? JSON.stringify(SNAPSHOT), stderr: '' };
  };
  return { run, calls, unchanged: () => JSON.stringify(SNAPSHOT) === before };
}

const approve = () => {
  const asked: string[] = [];
  return { asked, confirm: async (question: string) => { asked.push(question); return 'approve' as const; } };
};

test('mock herdr → els import herdr → same workspace/tab/cwd panes in els; a second run creates 0; herdr only read', async () => {
  const lockDir = join(scratch(), 'import-herdr.lock');
  const side = els();
  const h = herdr();
  const first = approve();
  const once = await importHerdr({ run: h.run, request: side.request, confirm: first.confirm, shell: '/bin/zsh', lockDir });
  expect(once.exitCode).toBe(0);
  expect(side.layout()).toEqual([
    ['OP', 'main', '/work/OP', '/bin/zsh'],
    ['OP', 'main', '/work/OP', '/bin/zsh'],
    ['OP', 'mvp', '/work/MVP-B', '/bin/zsh'],
    ['REL', 't1', '/work/REL', '/bin/zsh'],
  ]);
  expect(first.asked.length).toBe(1);
  expect(first.asked[0]).toContain('els import herdr: plan — create 4 · skip 0 (already in els) · cannot place 0');
  expect(first.asked[0]).toContain('  + create  OP/main  /work/OP  (herdr w1:p2 · claude)');
  expect(first.asked[0]).toContain('create 4 els pane(s)? [y/N] ');
  expect(once.message.split('\n').at(-1)).toBe('els import herdr: created 4 · skipped 0 · failed 0');
  expect(once.message).toContain('created  REL/t1  /work/REL  (herdr w2:p2 · codex) → els ');

  const second = approve();
  const again = await importHerdr({ run: h.run, request: side.request, confirm: second.confirm, shell: '/bin/zsh', lockDir });
  expect(again.exitCode).toBe(0);
  expect(second.asked).toEqual([]);                             // nothing to create: no question
  expect(side.spawned.length).toBe(4);
  expect(side.layout().length).toBe(4);
  expect(again.message.split('\n').at(-1)).toBe('els import herdr: created 0 · skipped 4 · failed 0');
  expect(again.message).toContain('skipped  OP/mvp  /work/MVP-B  (herdr w1:p7): already in els');

  // herdr side: only the read call, twice; the snapshot it served is the same before and after.
  expect(h.calls).toEqual([['api', 'snapshot'], ['api', 'snapshot']]);
  expect(h.unchanged()).toBe(true);
});

test('not confirmed (deny or no terminal) → nothing created, plan still printed', async () => {
  const lockDir = join(scratch(), 'import-herdr.lock');
  for (const said of ['deny', 'timeout'] as const) {
    const side = els();
    const result = await importHerdr({ run: herdr().run, request: side.request, confirm: async () => said, shell: '/bin/sh', lockDir });
    expect(result.exitCode).toBe(1);
    expect(result.message.split('\n').at(-1)).toBe(`els import herdr: not confirmed (${said}); nothing was created`);
    expect(side.spawned).toEqual([]);
    expect(side.requests).toEqual(['ls']);
  }
});

test('herdr absent or failing → rc 1, els not touched', async () => {
  const lockDir = join(scratch(), 'import-herdr.lock');
  const absent = els();
  const missing = await importHerdr({ run: herdr({ code: null, stderr: 'spawn herdr ENOENT' }).run, request: absent.request, confirm: approve().confirm, shell: '/bin/sh', lockDir });
  expect(missing).toEqual({ exitCode: 1, message: 'els import herdr: cannot read herdr (spawn herdr ENOENT); nothing was created' });
  expect(absent.requests).toEqual([]);
  const broken = els();
  const notJson = await importHerdr({ run: herdr({ stdout: 'oops' }).run, request: broken.request, confirm: approve().confirm, shell: '/bin/sh', lockDir });
  expect(notJson).toEqual({ exitCode: 1, message: 'els import herdr: herdr snapshot is not JSON; nothing was created' });
  expect(broken.requests).toEqual([]);
});

test('partial create failure → failed line, rc 1; the rerun creates only the missing pane', async () => {
  const lockDir = join(scratch(), 'import-herdr.lock');
  const side = els({ failNewFor: '/work/MVP-B' });
  const h = herdr();
  const partial = await importHerdr({ run: h.run, request: side.request, confirm: approve().confirm, shell: '/bin/sh', lockDir });
  expect(partial.exitCode).toBe(1);
  expect(partial.message).toContain('failed   OP/mvp  /work/MVP-B  (herdr w1:p7): els new: failed to spawn: disk full');
  expect(partial.message.split('\n').at(-1)).toBe('els import herdr: created 3 · skipped 0 · failed 1');
  side.setFailNew(undefined);
  const rerun = await importHerdr({ run: h.run, request: side.request, confirm: approve().confirm, shell: '/bin/sh', lockDir });
  expect(rerun.exitCode).toBe(0);
  expect(rerun.message.split('\n').at(-1)).toBe('els import herdr: created 1 · skipped 3 · failed 0');
  expect(side.spawned.map((row) => row.cwd)).toEqual(['/work/OP', '/work/OP', '/work/REL', '/work/MVP-B']);
});

test('one import at a time: a live holder refuses; a dead holder\'s lock is taken over and released', async () => {
  const lockDir = join(scratch(), 'import-herdr.lock');
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, 'pid'), '4242');
  const busy = els();
  const refused = await importHerdr({ run: herdr().run, request: busy.request, confirm: approve().confirm, shell: '/bin/sh', lockDir, isAlive: (pid) => pid === 4242 });
  expect(refused).toEqual({ exitCode: 1, message: 'els import herdr: another els import herdr is running (pid 4242); nothing was created' });
  expect(busy.requests).toEqual([]);
  const stale = els();
  const taken = await importHerdr({ run: herdr().run, request: stale.request, confirm: approve().confirm, shell: '/bin/sh', lockDir, isAlive: () => false });
  expect(taken.exitCode).toBe(0);
  expect(stale.spawned.length).toBe(4);
  // released: the next run takes the lock again without a holder check.
  const next = await importHerdr({ run: herdr().run, request: stale.request, confirm: approve().confirm, shell: '/bin/sh', lockDir, isAlive: () => true });
  expect(next.message.split('\n').at(-1)).toBe('els import herdr: created 0 · skipped 4 · failed 0');
});

test('a herdr pane without cwd or with a foreign id is a failed line, the rest still imports', async () => {
  const lockDir = join(scratch(), 'import-herdr.lock');
  const odd = { result: { snapshot: { workspaces: [{ workspace_id: 'w1', label: 'OP' }], tabs: [{ tab_id: 'w1:t1', label: 'one' }], panes: [
    { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', cwd: '/a' },
    { pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1' },
    { pane_id: 'w9:p1', tab_id: 'w1:t1', workspace_id: 'w1', cwd: '/b' },
  ] } } };
  const side = els();
  const result = await importHerdr({ run: herdr({ stdout: JSON.stringify(odd) }).run, request: side.request, confirm: approve().confirm, shell: '/bin/sh', lockDir });
  expect(result.exitCode).toBe(1);
  expect(result.message).toContain('failed   herdr w1:p2: herdr reports no cwd');
  expect(result.message).toContain('failed   herdr w9:p1: pane/tab id does not belong to its workspace');
  expect(result.message.split('\n').at(-1)).toBe('els import herdr: created 1 · skipped 0 · failed 2');
  expect(side.layout()).toEqual([['OP', 'one', '/a', '/bin/sh']]);
});
