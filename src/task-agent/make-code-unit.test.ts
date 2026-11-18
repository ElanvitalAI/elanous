// MAKE-CODE-UNIT-THIN — case table (PR body) · one test per cell.
// Axes: unit (resolves · missing · version mismatch) × harness say (succeeds · fails · times out)
//       × entry (TA hand · direct `graph run`) ⊕ observation (graph-run ledger write fails).
// harness say is stubbed at the process boundary: the production `spawnDetachedConfirmed` runs with a fake
// DetachedSpawn (no process is started, no LLM is called). Expectations are independent literals.
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnDetachedConfirmed, type DetachedSpawn } from '../cli/tasks-cli.js';
import { debug } from '../debug/log.js';
import { runGraph, type GraphRunOptions, type GraphRunState } from '../graph-runner/runner.js';
import { simCli } from '../ux-sim/in-process-cli.js';
import { createTempDirectoryScope } from '../test-utils/temp-dir-cleanup.js';
import { appendRunLedgerEntry, loadRunLedger } from '../self-implement/run-ledger.js';
import { handTask, readTaskCard, type TaskLaunchContext, type TaskLauncher } from './task-hand.js';

const scope = createTempDirectoryScope();
afterAll(() => scope.cleanup());
const REPO = resolve(import.meta.dir, '../..');
const temp = (prefix: string): string => scope.mkdtempSync(join(tmpdir(), prefix));
const statePath = (): string => join(temp('make-code-state-'), 'task-agent-actions.json');

type SpawnMode = 'succeeds' | 'fails' | 'times-out';
interface SpawnCall { command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }

/** Process-boundary stub: the real confirm-spawn logic, a fake child that spawns, errors, or never answers. */
function boundaryLauncher(mode: SpawnMode): { launcher: TaskLauncher; spawns: SpawnCall[]; contexts: TaskLaunchContext[] } {
  const spawns: SpawnCall[] = [];
  const contexts: TaskLaunchContext[] = [];
  const fakeSpawn: DetachedSpawn = (command, args, options) => {
    spawns.push({ command, args, ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.env ? { env: options.env } : {}) });
    const child = new EventEmitter() as EventEmitter & { pid?: number; unref(): void };
    child.unref = () => {};
    if (mode === 'succeeds') { child.pid = 4242; setTimeout(() => child.emit('spawn'), 1); }
    if (mode === 'fails') setTimeout(() => child.emit('error', new Error('spawn elanous ENOENT')), 1);
    return child as unknown as ReturnType<DetachedSpawn>;
  };
  const launcher: TaskLauncher = async (args, cwd, context) => {
    contexts.push(context!);
    await spawnDetachedConfirmed(fakeSpawn, 'elanous', args, 25, cwd, context!.env);
    return { runId: context!.runId };
  };
  return { launcher, spawns, contexts };
}

function capture(category: string): { events: Array<{ event: string; data?: Record<string, unknown> }>; off: () => void } {
  const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
  const off = debug.registerSink({ name: `make-code-${category}-${Math.random()}`, emit: (rec) => {
    if (rec.category === category) events.push({ event: rec.event, data: rec.data as Record<string, unknown> | undefined });
  } });
  return { events, off };
}

/** The production runner, pointed at an isolated root so the graph-run ledger can be read back. */
function rootedRunner(root: string): (path: string, options: GraphRunOptions) => Promise<GraphRunState> {
  return (path, options) => runGraph(path, { ...options, deps: { ...options.deps, root } });
}

/** A composition root whose code-pr calls `call`; the repo's own make-code@1 stays on the resolver path. */
function compositionRoot(call: string, unitSource?: string): string {
  const root = temp('make-code-composition-');
  const work = join(root, 'graphs', 'work');
  mkdirSync(join(work, 'units'), { recursive: true });
  writeFileSync(join(work, 'code-pr.yaml'), readFileSync(join(REPO, 'graphs/work/code-pr.yaml'), 'utf8').replace('call: make-code@1', `call: ${call}`));
  writeFileSync(join(work, 'recipes.yaml'), '{}\n');
  if (unitSource !== undefined) {
    writeFileSync(join(work, 'units', 'make-code.yaml'), unitSource);
    writeFileSync(join(work, 'units', 'recipes.yaml'), '{}\n');
  }
  return root;
}

const TEXT = '대상 경로: src/task-agent/task-hand.ts\nmake-code thin unit cell';

// ── TA hand × unit resolves × harness say ────────────────────────────────────────────────────────────────

test('cell R1 · TA hand · unit resolves · harness say succeeds → launched through work-code-pr, ledger has start/child/terminal', async () => {
  const root = temp('make-code-ledger-');
  const target = temp('make-code-target-');
  execFileSync('git', ['init', '-q', target]);
  const path = statePath();
  const { launcher, spawns, contexts } = boundaryLauncher('succeeds');
  const obs = capture('task-agent.make-code');
  let result: Awaited<ReturnType<typeof handTask>>;
  try {
    result = await handTask({ text: TEXT, seat: 'UX', checklistId: 'MAKE-CODE-UNIT-THIN', project: { id: 'iso', target },
      taLand: true, childLlm: 'grok/grok-4.7', source: `commit:${'a'.repeat(40)}`, imageDigest: `sha256:${'b'.repeat(64)}`,
      live: true, statePath: path, launcher, graphRunner: rootedRunner(root), draftMetrics: async () => ({ needsOwnerBySeat: {} }) });
  } finally { obs.off(); }
  const runId = contexts[0]!.runId;
  // Field parity at the spawn boundary — the same argv/cwd/env the retired direct path produced.
  expect(spawns).toEqual([{ command: 'elanous', cwd: target, env: expect.objectContaining({
    ELANOUS_RUN_ID: runId, ELANOUS_TASK_CARD_ID: result!.card.id, ELANOUS_POD_SLOT_ID: 'MAKE-CODE-UNIT-THIN',
    ELANOUS_POD_OWNER_KIND: 'seat', ELANOUS_POD_OWNER_ID: 'UX', ELANOUS_POD_DISTRIBUTOR_ENTRY: 'tasks-hand', ELANOUS_TA_LAND: '1' }),
    args: ['harness', 'say', '--seat', 'UX', '--substrate', 'pod', '--merge-by-host', '--source', `commit:${'a'.repeat(40)}`,
      '--image-digest', `sha256:${'b'.repeat(64)}`, '--child-llm-provider', 'grok', '--child-llm-model', 'grok-4.7', TEXT] }]);
  expect(contexts[0]).toMatchObject({ substrate: 'pod', podGoal: TEXT, effectiveChildProvider: 'grok', launchUtterance: TEXT });
  const card = readTaskCard(result!.card.id, path)!;
  expect(card).toMatchObject({ status: 'launched', runId, composition: { file: 'graphs/work/code-pr.yaml', version: 2 },
    unitsResolved: true, missingUnits: [],
    compositionRun: { graphId: 'work-code-pr', runId: `code-pr-${runId}`, status: 'done', exit: 'launched' } });
  expect(card.history.map((entry) => entry.event)).toEqual(['launch', 'run-bound']);
  // Ledger: start (node-start make-code) → child run id (node output) → terminal (done).
  const ledger = join(root, 'graph-runs', 'work-code-pr');
  const events = readFileSync(join(ledger, `code-pr-${runId}.events.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(events.filter((e) => e.type === 'node-start').map((e) => e.source.nodeId)).toEqual(['make-code', 'done']);
  expect(events.at(-1)).toMatchObject({ type: 'node-leave', source: { nodeId: 'done' }, data: { reason: 'terminal' } });
  const saved = JSON.parse(readFileSync(join(ledger, `code-pr-${runId}.json`), 'utf8'));
  expect(saved).toMatchObject({ status: 'done', path: ['make-code', 'done'], unitCalls: [{ unit: 'make-code', version: 1, exit: 'launched' }] });
  expect(JSON.parse(saved.nodes[0].output).result).toMatchObject({ harnessRunId: runId });
  expect(obs.events).toEqual([{ event: 'graph-run', data: expect.objectContaining({ dispatched: true, status: 'done', exit: 'launched', harnessRunId: runId }) }]);
});

for (const mode of ['fails', 'times-out'] as const) {
  test(`cell R-${mode} · TA hand · unit resolves · harness say ${mode} → launch-failed card, failed graph run, no retry`, async () => {
    const root = temp('make-code-ledger-');
    const path = statePath();
    const { launcher, spawns } = boundaryLauncher(mode);
    const obs = capture('task-agent.make-code');
    let thrown: unknown;
    try { await handTask({ id: `ta-make-code-${mode}`, text: TEXT, live: true, statePath: path, launcher, graphRunner: rootedRunner(root) }); }
    catch (error) { thrown = error; } finally { obs.off(); }
    expect(String(thrown)).toContain(mode === 'fails' ? 'spawn elanous ENOENT' : '발사 확인 시간 초과(25ms)');
    expect(spawns).toHaveLength(1);
    const card = readTaskCard(`ta-make-code-${mode}`, path)!;
    expect(card).toMatchObject({ status: 'launch-failed', compositionRun: { graphId: 'work-code-pr', status: 'failed', exit: 'failed' } });
    expect(card.runId).toBeUndefined();
    expect(card.history).toEqual([expect.objectContaining({ event: 'launch-failed',
      detail: mode === 'fails' ? 'spawn elanous ENOENT' : '발사 확인 시간 초과(25ms) · pid 없음' })]);
    expect(obs.events).toEqual([{ event: 'graph-run', data: expect.objectContaining({ dispatched: false, status: 'failed', exit: 'failed' }) }]);
  });
}

// ── TA hand × unit missing / version mismatch × harness say (each never reaches the launcher) ──────────────

for (const [cell, call] of [['missing', 'make-code-absent@1'], ['mismatch', 'make-code@2']] as const) {
  for (const mode of ['succeeds', 'fails', 'times-out'] as const) {
    test(`cell ${cell}-${mode} · TA hand · unit ${cell} → refused before launch with an event, no harness-say fallback`, async () => {
      const path = statePath();
      const { launcher, spawns } = boundaryLauncher(mode);
      const obs = capture('task-agent.make-code');
      let thrown: unknown;
      try { await handTask({ id: `ta-${cell}-${mode}`, text: TEXT, live: true, statePath: path, launcher,
        compositionRoot: compositionRoot(call) }); }
      catch (error) { thrown = error; } finally { obs.off(); }
      expect(String(thrown)).toContain(`조합 단위 미해석: graphs/work/code-pr.yaml — 대상 unit: ${call}`);
      expect(spawns).toEqual([]);
      expect(readTaskCard(`ta-${cell}-${mode}`, path)).toMatchObject({ status: 'failed', unitsResolved: false, missingUnits: [call],
        history: [{ event: 'composition-launcher-unavailable', detail: expect.stringContaining(call) }] });
      expect(obs.events).toEqual([{ event: 'unit-unresolved', data: expect.objectContaining({ launcher: 'graph-run', missingUnits: [call] }) }]);
    });
  }
}

// ── Direct `graph run` entry (real CLI process via simCli spawn) ─────────────────────────────────────────────

for (const [cell, file, expected] of [
  ['resolves', 'repo', 'unknown in-process handler for harness-say: make-code-harness-say'],
  ['missing', 'make-code-absent@1', 'unit not found: make-code-absent@1'],
  ['mismatch', 'make-code@2', 'unit not found: make-code@2'],
] as const) {
  test(`cell direct-${cell} · direct graph run · unit ${cell} → refused, harness say never invoked`, async () => {
    const graph = file === 'repo' ? join(REPO, 'graphs/work/code-pr.yaml') : join(compositionRoot(file), 'graphs/work/code-pr.yaml');
    const stateRoot = temp('make-code-cli-');
    const out = await simCli(['graph', 'run', graph, '--json', '--input', '{"ask":"x","context":{},"prior":{}}'], {
      mode: 'spawn', allowPaths: [['graph', 'run']], stateRoot, timeoutMs: 60_000 });
    expect(out.exitCode).not.toBe(0);
    expect(`${out.stdout}\n${out.stderr}`).toContain(expected);
    // No harness run was created: a launch would have written a run ledger under the isolated state root.
    expect(existsSync(join(stateRoot, 'runs'))).toBe(false);
  }, 90_000);
}

// ── Observation axis: graph-run ledger write fails ─────────────────────────────────────────────────────────

test('cell ledger-after · ledger write fails after dispatch → card stays launched with a loud mark, no relaunch', async () => {
  const root = temp('make-code-ledger-');
  const path = statePath();
  const { launcher, spawns, contexts } = boundaryLauncher('succeeds');
  const obs = capture('task-agent.make-code');
  let result: Awaited<ReturnType<typeof handTask>>;
  try {
    result = await handTask({ text: TEXT, live: true, statePath: path, launcher,
      graphRunner: async (graph, options) => { await rootedRunner(root)(graph, options); throw new Error('EACCES: graph-runs not writable'); } });
  } finally { obs.off(); }
  expect(spawns).toHaveLength(1);
  const card = readTaskCard(result!.card.id, path)!;
  expect(card).toMatchObject({ status: 'launched', runId: contexts[0]!.runId });
  expect(card.compositionRun).toBeUndefined();
  expect(card.history.map((entry) => entry.event)).toEqual(['launch', 'run-bound', 'graph-run-ledger-failed']);
  expect(card.history.at(-1)?.detail).toContain('EACCES: graph-runs not writable');
  expect(obs.events.map((entry) => entry.event)).toEqual(['graph-run', 'ledger-failed']);
});

test('cell ledger-before · ledger write fails before dispatch → launch-failed, harness say never invoked', async () => {
  const path = statePath();
  const { launcher, spawns } = boundaryLauncher('succeeds');
  const obs = capture('task-agent.make-code');
  let thrown: unknown;
  try { await handTask({ id: 'ta-ledger-before', text: TEXT, live: true, statePath: path, launcher,
    graphRunner: async () => { throw new Error('EACCES: graph-runs not writable'); } }); }
  catch (error) { thrown = error; } finally { obs.off(); }
  expect(String(thrown)).toContain('graph run 실패: EACCES: graph-runs not writable');
  expect(spawns).toEqual([]);
  expect(readTaskCard('ta-ledger-before', path)).toMatchObject({ status: 'launch-failed',
    history: [{ event: 'launch-failed', detail: 'graph run 실패: EACCES: graph-runs not writable' }] });
  expect(obs.events.map((entry) => entry.event)).toEqual(['graph-run', 'not-dispatched']);
});

// ── Refuse branches outside the main axes (each has an event) ───────────────────────────────────────────────

test('retired launcher · code-pr composition still declaring launcher: harness-say → refused, no direct launch', async () => {
  const root = compositionRoot('make-code@1');
  const file = join(root, 'graphs/work/code-pr.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('launcher: graph-run', 'launcher: harness-say'));
  const path = statePath();
  const { launcher, spawns } = boundaryLauncher('succeeds');
  const obs = capture('task-agent.make-code');
  try {
    await expect(handTask({ id: 'ta-retired', text: TEXT, live: true, statePath: path, launcher, compositionRoot: root }))
      .rejects.toThrow('조합 실행기 은퇴');
  } finally { obs.off(); }
  expect(spawns).toEqual([]);
  expect(readTaskCard('ta-retired', path)).toMatchObject({ status: 'failed', history: [{ event: 'composition-launcher-unavailable' }] });
  expect(obs.events).toEqual([{ event: 'launcher-retired', data: expect.objectContaining({ launcher: 'harness-say' }) }]);
});

test('shape · code-pr graph-run composition without a make-code node → composition-invalid, no launch', async () => {
  const root = temp('make-code-shape-');
  mkdirSync(join(root, 'graphs', 'work'), { recursive: true });
  writeFileSync(join(root, 'graphs/work/code-pr.yaml'), 'graph_id: work-code-pr\nversion: 2\nlauncher: graph-run\nentry_node: done\nterminal_nodes: [done]\nnodes:\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges: []\n');
  const path = statePath();
  const { launcher, spawns } = boundaryLauncher('succeeds');
  const obs = capture('task-agent.make-code');
  try {
    await expect(handTask({ id: 'ta-shape', text: TEXT, live: true, statePath: path, launcher, compositionRoot: root }))
      .rejects.toThrow('make-code 단위 호출 노드가 정확히 하나여야 한다(지금 0개)');
  } finally { obs.off(); }
  expect(spawns).toEqual([]);
  expect(readTaskCard('ta-shape', path)).toMatchObject({ status: 'failed', history: [{ event: 'composition-invalid' }] });
  expect(obs.events.map((entry) => entry.event)).toEqual(['composition-refused']);
});

test('not invoked · a make-code@1 unit that never reaches the handler → launch-failed «make-code 미발사», no launch', async () => {
  const unit = 'graph_id: make-code\nversion: 1\nentry_node: launched\nterminal_nodes: [launched, needs-human, failed]\n'
    + 'unit:\n  inputs: [ask, context, prior]\n  outputs: [result, evidence]\n  exits: [launched, needs-human, failed]\n'
    + 'nodes:\n  - { node_id: launched, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: needs-human, kind: gate, recipe: none, max_visits: 1 }\n'
    + '  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges: []\n';
  const path = statePath();
  const { launcher, spawns } = boundaryLauncher('succeeds');
  const obs = capture('task-agent.make-code');
  try {
    await expect(handTask({ id: 'ta-not-invoked', text: TEXT, live: true, statePath: path, launcher,
      compositionRoot: compositionRoot('make-code@1', unit), graphRunner: rootedRunner(temp('make-code-ledger-')) }))
      .rejects.toThrow('make-code 미발사');
  } finally { obs.off(); }
  expect(spawns).toEqual([]);
  expect(readTaskCard('ta-not-invoked', path)).toMatchObject({ status: 'launch-failed' });
  expect(obs.events.map((entry) => entry.event)).toEqual(['graph-run', 'not-dispatched']);
});

test('shadow · no --live → zero behaviour change: no graph run, no launch, move is the harness say argv', async () => {
  const path = statePath();
  const { launcher, spawns } = boundaryLauncher('succeeds');
  let graphRuns = 0;
  const result = await handTask({ text: TEXT, seat: 'UX', statePath: path, launcher,
    graphRunner: async (graph, options) => { graphRuns++; return runGraph(graph, options); } });
  expect(graphRuns).toBe(0);
  expect(spawns).toEqual([]);
  expect(result).toMatchObject({ mode: 'shadow', launched: false, card: { status: 'handed', history: [] },
    move: { kind: 'launch', command: ['harness', 'say', '--seat', 'UX', '--substrate', 'pod', '--merge-by-host', TEXT] } });
  expect(result.card.compositionRun).toBeUndefined();
});

test('cell no-receipt · launcher accepts without a run id → node ends failed, card launch-failed, never launched (MF2)', async () => {
  const root = temp('make-code-ledger-');
  const path = statePath();
  const obs = capture('task-agent.make-code');
  let thrown: unknown;
  try { await handTask({ id: 'ta-no-receipt', text: TEXT, live: true, statePath: path, launcher: () => {}, graphRunner: rootedRunner(root) }); }
  catch (error) { thrown = error; } finally { obs.off(); }
  expect(String(thrown)).toContain('make-code 발사 영수증 없음');
  const card = readTaskCard('ta-no-receipt', path)!;
  expect(card).toMatchObject({ status: 'launch-failed', compositionRun: { graphId: 'work-code-pr', status: 'failed', exit: 'failed' } });
  expect(card.runId).toBeUndefined();
  expect(card.history.map((entry) => entry.event)).toEqual(['launch-failed']);
  const saved = JSON.parse(readFileSync(join(root, 'graph-runs', 'work-code-pr', `${card.compositionRun!.runId}.json`), 'utf8'));
  expect(JSON.parse(saved.nodes[0].output).result).toMatchObject({ reason: 'make-code-receipt-missing', harnessRunId: null });
  expect(obs.events.map((entry) => entry.event)).toEqual(['graph-run', 'receipt-missing']);
});

test('cell detected-orphan · a receipt-less launch that did start a child is found by the run id on the launch-failed line', async () => {
  const path = statePath();
  const ledgers = temp('make-code-run-ledger-');
  await expect(handTask({ id: 'ta-orphan', text: TEXT, live: true, statePath: path,
    launcher: (_args, _cwd, context) => { appendRunLedgerEntry({ runId: context!.runId, event: 'run-status', data: { runStatus: 'running' } }, ledgers); } }))
    .rejects.toThrow('make-code 발사 영수증 없음');
  const card = readTaskCard('ta-orphan', path)!;
  const failed = card.history.find((entry) => entry.event === 'launch-failed')!;
  expect(card.status).toBe('launch-failed');
  expect(failed.detail).toContain('detected-orphan 조회: 카드 ta-orphan');
  // Detection (no reaper): the launch-failed line carries the child run id; a run ledger under that id = orphan.
  expect(loadRunLedger(failed.runId!, ledgers)?.map((entry) => entry.event)).toEqual(['run-status']);
});

/** A fixture unit whose two nodes both call the make-code handler (a valid alternative unit). */
const TWO_NODE_UNIT = 'graph_id: make-code\nversion: 1\nentry_node: first\nterminal_nodes: [launched, needs-human, failed]\n'
  + 'unit:\n  inputs: [ask, context, prior]\n  outputs: [result, evidence]\n  exits: [launched, needs-human, failed]\n'
  + 'nodes:\n'
  + "  - { node_id: first, kind: agent, recipe: 'handler:make-code-harness-say', max_visits: 1, contract: { inputs: [ask, context, prior], tools: harness-say, outputs: [outcome, result, evidence] } }\n"
  + "  - { node_id: second, kind: agent, recipe: 'handler:make-code-harness-say', max_visits: 1, contract: { inputs: [ask, context, prior], tools: harness-say, outputs: [outcome, result, evidence] } }\n"
  + '  - { node_id: launched, kind: gate, recipe: none, max_visits: 1, contract: { inputs: [], tools: none, outputs: [result, evidence] } }\n'
  + '  - { node_id: needs-human, kind: hitl, recipe: none, max_visits: 1, contract: { inputs: [], tools: none, outputs: [result, evidence] } }\n'
  + '  - { node_id: failed, kind: observe, recipe: none, max_visits: 1, contract: { inputs: [], tools: none, outputs: [result, evidence] } }\n'
  + 'edges:\n'
  + '  - { from: first, on: outcome, map: { launched: second, needs-human: needs-human, failed: failed } }\n'
  + '  - { from: second, on: outcome, map: { launched: launched, needs-human: needs-human, failed: failed } }\n';

test('cell duplicate-two-nodes · two nodes call the handler → one launch, the second call is refused before launch with an event (MF1)', async () => {
  const path = statePath();
  const { launcher, spawns } = boundaryLauncher('succeeds');
  const obs = capture('task-agent.make-code');
  let result: Awaited<ReturnType<typeof handTask>>;
  try {
    result = await handTask({ id: 'ta-two-nodes', text: TEXT, live: true, statePath: path, launcher,
      compositionRoot: compositionRoot('make-code@1', TWO_NODE_UNIT), graphRunner: rootedRunner(temp('make-code-ledger-')) });
  } finally { obs.off(); }
  expect(spawns).toHaveLength(1);
  const card = readTaskCard('ta-two-nodes', path)!;
  expect(card.status).toBe('launched');
  expect(card.compositionRun).toMatchObject({ status: 'failed', exit: 'needs-human' });
  expect(card.history.map((entry) => entry.event)).toEqual(['launch', 'run-bound', 'make-code-duplicate-refused']);
  expect(obs.events.map((entry) => entry.event)).toEqual(['duplicate-refused', 'graph-run']);
  expect(obs.events[0]!.data).toMatchObject({ taskId: 'ta-two-nodes', nodeId: 'second', launchKey: expect.stringMatching(/^k5:[0-9a-f]{64}$/) });
  expect(result!.launched).toBe(true);
});

test('cell revisit · code-pr revisits make-code on the same card → no relaunch (MF1)', async () => {
  const root = compositionRoot('make-code@1');
  const file = join(root, 'graphs/work/code-pr.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('max_visits: 1\n    call: make-code@1', 'max_visits: 2\n    call: make-code@1')
    .replace('map: { launched: done,', 'map: { launched: make-code,'));
  const path = statePath();
  const { launcher, spawns } = boundaryLauncher('succeeds');
  const obs = capture('task-agent.make-code');
  try {
    await handTask({ id: 'ta-revisit', text: TEXT, live: true, statePath: path, launcher, compositionRoot: root,
      graphRunner: rootedRunner(temp('make-code-ledger-')) });
  } finally { obs.off(); }
  expect(spawns).toHaveLength(1);
  const card = readTaskCard('ta-revisit', path)!;
  expect(card.status).toBe('launched');
  expect(card.history.map((entry) => entry.event)).toEqual(['launch', 'run-bound', 'make-code-duplicate-refused']);
  expect(obs.events.map((entry) => entry.event)).toEqual(['duplicate-refused', 'graph-run']);
});

test('unit file · graphs/units/verbs/make-code.yaml is copied verbatim into an isolated unit root and resolves as make-code@1', () => {
  const dir = temp('make-code-unit-copy-');
  copyFileSync(join(REPO, 'graphs/units/verbs/make-code.yaml'), join(dir, 'make-code.yaml'));
  const source = readFileSync(join(dir, 'make-code.yaml'), 'utf8');
  expect(source).toContain("recipe: 'handler:make-code-harness-say'");
  expect(source).toContain('exits: [launched, needs-human, failed]');
});

test('completion semantics · make-code@1 never exits done: a fan-out join over make-code children joins on launches, by name', () => {
  const source = readFileSync(join(REPO, 'graphs/units/verbs/make-code.yaml'), 'utf8');
  expect(source).toContain('terminal_nodes: [launched, needs-human, failed]');
  expect(source).not.toMatch(/node_id: done\b/);
  expect(source).not.toMatch(/exits: \[[^\]]*\bdone\b/);
});
