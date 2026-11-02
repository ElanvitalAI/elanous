import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultMsgStorePath, openMsgStore } from '../msg/msg-store.js';
import { runGraph } from '../graph-runner/runner.js';
import { emitReleaseStageTransition, postReleaseStageMail, startReleaseStageStallWatch, type ReleaseStageState } from './stage-mail.js';

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

test('release stage transitions are durable, routed from config, and idempotent per run/node/state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-stage-mail-')); scratch.push(dir);
  const configPath = join(dir, 'config.json');
  const dbPath = join(dir, 'messages.db');
  writeFileSync(configPath, JSON.stringify({ release: { loop: { stageMailTo: 'MK' } } }));
  const openStore = () => openMsgStore(dbPath);
  const start = postReleaseStageMail({ runId: 'run-1', nodeId: 'gate', state: 'start' }, { configPath, openStore });
  const duplicate = postReleaseStageMail({ runId: 'run-1', nodeId: 'gate', state: 'start' }, { configPath, openStore });
  writeFileSync(configPath, JSON.stringify({ release: { loop: { stageMailTo: 'OP' } } }));
  const recipientChanged = postReleaseStageMail({ runId: 'run-1', nodeId: 'gate', state: 'start' }, { configPath, openStore });
  writeFileSync(configPath, JSON.stringify({ release: { loop: { stageMailTo: 'MK' } } }));
  const done = postReleaseStageMail({ runId: 'run-1', nodeId: 'gate', state: 'ok' }, { configPath, openStore });
  const read = openMsgStore(dbPath);
  try {
    expect(start).toMatchObject({ id: duplicate.id, from: 'TC', to: 'MK', kind: 'progress' });
    expect(recipientChanged).toMatchObject({ id: start.id, to: 'MK' });
    expect(done).toMatchObject({ to: 'MK', kind: 'progress' });
    expect(read.listByRecipient('MK')).toHaveLength(2);
    expect(read.listByRecipient('OP')).toHaveLength(0);
  } finally { read.close(); }
});

test('release stage identity keeps run and node boundaries distinct', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-stage-identity-')); scratch.push(dir);
  const dbPath = join(dir, 'messages.db');
  const openStore = () => openMsgStore(dbPath);
  const base = { runId: 'a.b', nodeId: 'c', state: 'start' as const };
  const distinct = { runId: 'a', nodeId: 'b.c', state: 'start' as const };
  const first = postReleaseStageMail(base, { openStore });
  const second = postReleaseStageMail(distinct, { openStore });
  expect(second.id).not.toBe(first.id);
});

test('failed and stalled release transitions use alert mail and the default recipient is OP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-stage-mail-')); scratch.push(dir);
  const dbPath = join(dir, 'messages.db');
  const openStore = () => openMsgStore(dbPath);
  const failed = postReleaseStageMail({ runId: 'run-2', nodeId: 'gate', state: 'fail' }, { configPath: join(dir, 'missing.json'), openStore });
  const stalled = postReleaseStageMail({ runId: 'run-2', nodeId: 'gate', state: 'stall' }, { configPath: join(dir, 'missing.json'), openStore });
  expect(failed).toMatchObject({ to: 'OP', kind: 'alert' });
  expect(stalled).toMatchObject({ to: 'OP', kind: 'alert' });
});

test('release stage watchdog emits one stall transition after a quiet interval and can be stopped', () => {
  const callbacks: Array<() => void> = [];
  const emitted: string[] = [];
  let cancelled = 0;
  const logged: string[] = [];
  const stop = startReleaseStageStallWatch({ runId: 'run-watch', nodeId: 'gate' }, {
    graphId: 'release-loop', dryRun: false,
    afterMs: 5, schedule: (callback) => { callbacks.push(callback); return setTimeout(() => {}, 60_000); },
    cancel: (timer) => { cancelled++; clearTimeout(timer); }, emit: (mail) => { emitted.push(mail.state); }, log: (event) => { logged.push(event); },
  });
  callbacks[0]!();
  stop();
  callbacks[0]!();
  expect(emitted).toEqual(['stall']);
  expect(logged).toContain('no-progress-stall');
  expect(cancelled).toBe(1);
});

test('stall watcher is a no-op outside real release-loop runs', () => {
  const emitted: string[] = [];
  for (const context of [{ graphId: 'document-loop', dryRun: false }, { graphId: 'release-loop', dryRun: true }]) {
    const callbacks: Array<() => void> = [];
    const stop = startReleaseStageStallWatch({ runId: 'run-filtered', nodeId: 'gate' }, { ...context,
      schedule: (callback) => { callbacks.push(callback); return setTimeout(() => {}, 60_000); },
      cancel: (timer) => clearTimeout(timer),
      emit: (mail) => { emitted.push(mail.state); }, log: () => {},
    });
    callbacks[0]!();
    stop();
  }
  expect(emitted).toEqual([]);
});

test('mock transition sender covers fail, skip, and wait states and filters non-release runs', () => {
  const emitted: ReleaseStageState[] = [];
  const states: ReleaseStageState[] = ['start', 'ok', 'fail', 'skip', 'wait'];
  for (const state of states) expect(emitReleaseStageTransition('release-loop', false,
    { runId: 'run-mock', nodeId: 'gate', state }, (mail) => emitted.push(mail.state))).toBe(true);
  expect(emitted).toEqual(states);
  expect(emitReleaseStageTransition('release-loop', true, { runId: 'dry', nodeId: 'gate', state: 'start' },
    (mail) => emitted.push(mail.state))).toBe(true);
  expect(emitReleaseStageTransition('document-loop', false, { runId: 'other', nodeId: 'node', state: 'start' },
    (mail) => emitted.push(mail.state))).toBe(true);
  expect(emitted).toEqual(states);
  expect(emitReleaseStageTransition('release-loop', false, { runId: 'failed-delivery', nodeId: 'gate', state: 'wait' },
    () => { throw new Error('store unavailable'); })).toBe(false);
});

test('release graph runner emits start and terminal result transitions through the injected mail hook', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-stage-runner-')); scratch.push(root);
  const graph = join(root, 'release-loop.yaml');
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  writeFileSync(graph, [
    'graph_id: release-loop', 'version: 1', 'entry_node: done', 'terminal_nodes: [done, failed]', 'nodes:',
    '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }', '',
  ].join('\n'));
  const emitted: Array<{ runId: string; nodeId: string; state: ReleaseStageState }> = [];
  const run = await runGraph(graph, { runId: 'stage-mail-graph-run', deps: { root,
    releaseStageMail: (mail) => { emitted.push(mail); },
  } });
  expect(run.status).toBe('done');
  expect(emitted).toEqual([
    { runId: 'stage-mail-graph-run', nodeId: 'done', state: 'start' },
    { runId: 'stage-mail-graph-run', nodeId: 'done', state: 'ok' },
  ]);
});

test('release graph default stage mail stays in the graph runner state root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-stage-isolated-root-')); scratch.push(root);
  const foreignStateRoot = mkdtempSync(join(tmpdir(), 'release-stage-foreign-state-')); scratch.push(foreignStateRoot);
  const previousStateRoot = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = foreignStateRoot;
  try {
    const externalStorePath = defaultMsgStorePath();
    const externalEntriesBefore = readdirSync(foreignStateRoot);
    expect(externalStorePath).toBe(join(foreignStateRoot, 'msg', 'messages.db'));
    const graph = join(root, 'release-loop.yaml');
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    writeFileSync(graph, [
      'graph_id: release-loop', 'version: 1', 'entry_node: done', 'terminal_nodes: [done]', 'nodes:',
      '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }', '',
    ].join('\n'));
    const run = await runGraph(graph, { runId: 'isolated-stage-mail-run', deps: { root } });
    expect(run.status).toBe('done');
    const isolated = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      expect(isolated.listByRecipient('OP')).toHaveLength(2);
      expect(isolated.listByRecipient('TC')).toHaveLength(0);
      expect(readdirSync(foreignStateRoot)).toEqual(externalEntriesBefore);
      expect(existsSync(externalStorePath)).toBe(false);
    } finally { isolated.close(); }
  } finally {
    if (previousStateRoot === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousStateRoot;
  }
});

test('non-release approval remains notified as a no-op for release mail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-stage-nonrelease-')); scratch.push(root);
  const graph = join(root, 'approval.yaml');
  writeFileSync(join(root, 'recipes.yaml'), 'approval:\n  approval: "Approve this?"\n');
  writeFileSync(graph, [
    'graph_id: document-loop', 'version: 1', 'entry_node: approve', 'terminal_nodes: [landed, needs-human]', 'nodes:',
    "  - { node_id: approve, kind: judge, recipe: 'approval:approval', max_visits: 1 }",
    '  - { node_id: landed, kind: gate, recipe: none, max_visits: 1 }',
    '  - { node_id: needs-human, kind: gate, recipe: none, max_visits: 1 }',
    'edges:', '  - { from: approve, on: outcome, map: { ok: landed, fail: needs-human } }', '',
  ].join('\n'));
  const run = await runGraph(graph, { runId: 'nonrelease-approval', deps: { root } });
  expect(run).toMatchObject({ status: 'awaiting-approval', pending: { nodeId: 'approve', notifiedAt: expect.any(String) } });
});
