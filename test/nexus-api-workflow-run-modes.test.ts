import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setElanousConfigDir, resetElanousConfigDir } from '../src/elanous-config-dir.js';
import { setWorkflowPin } from '../src/workflow-runtime/pin-data.js';
import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import { setWorkflowRunEventBus } from '../src/nexus/api/workflow-run-event-bridge.js';
import {
  _resetWorkflowRunRegistryForTest, _setWorkflowRunsRootForTest,
  handleWorkflowRunStart, handleWorkflowRunGet,
} from '../src/nexus/api/workflows.js';

let root: string;
let cwd: string;
let priorRunsDir: string | undefined;
const opts = { noAuth: true };
const name = 'run-modes-fixture';
const url = `http://localhost/v1/workflows/${name}/run`;

beforeEach(() => {
  cwd = process.cwd();
  priorRunsDir = process.env.ELANOUS_WORKFLOWS_RUNS_DIR;
  root = mkdtempSync(join(tmpdir(), 'wf-run-modes-'));
  setElanousConfigDir(root);
  process.env.ELANOUS_WORKFLOWS_RUNS_DIR = join(root, 'runs');
  _setWorkflowRunsRootForTest(join(root, 'runs'));
  mkdirSync(join(root, '.elanous', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.elanous', 'workflows', `${name}.yaml`), `name: ${name}
description: Run mode verification
nodes:
  - id: a
    set:
      fields:
        value: original
  - id: b
    depends_on: [a]
    template:
      template: "{{ a.output.value }}"
  - id: c
    depends_on: [b]
    bash: echo real-side-effect
`);
  process.chdir(root);
  _resetWorkflowRunRegistryForTest();
});

afterEach(() => {
  process.chdir(cwd);
  _resetWorkflowRunRegistryForTest();
  setWorkflowRunEventBus(null);
  _setWorkflowRunsRootForTest(null);
  resetElanousConfigDir();
  if (priorRunsDir === undefined) delete process.env.ELANOUS_WORKFLOWS_RUNS_DIR;
  else process.env.ELANOUS_WORKFLOWS_RUNS_DIR = priorRunsDir;
  rmSync(root, { recursive: true, force: true });
});

async function start(body: Record<string, unknown>) {
  const response = await handleWorkflowRunStart(new Request(url, {
    method: 'POST', headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), name, opts);
  return { status: response.status, data: await response.json() as { runId: string; mode: string; reason?: string } };
}

async function settled(runId: string) {
  for (let i = 0; i < 100; i++) {
    const response = handleWorkflowRunGet(new Request(`http://localhost/v1/workflows/runs/${runId}`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    }), runId, opts);
    const data = await response.json() as {
      ok?: boolean; mode: string; outputs: Record<string, unknown>;
      events: Array<{ type: string; nodeId?: string; mode: string; result?: { error?: string } }>;
    };
    if (data.ok !== undefined) return data;
    await Bun.sleep(10);
  }
  throw new Error('run did not settle');
}

test('onlyNode executes exactly one node and mode is carried through response, events, SSE and persisted run', async () => {
  const bus = new NexusEventBus();
  const published: Array<{ detail: unknown }> = [];
  bus.subscribe(event => { published.push({ detail: event.detail }); }, ['workflow.run.']);
  setWorkflowRunEventBus(bus);
  const { status, data } = await start({ onlyNode: 'b' });
  expect(status).toBe(202);
  expect(data.mode).toBe('only');
  const result = await settled(data.runId);
  expect(result.mode).toBe('only');
  expect(result.events.filter(e => e.type === 'node_start').map(e => e.nodeId)).toEqual(['b']);
  expect(result.events.every(e => e.mode === 'only')).toBe(true);
  expect(published.length).toBeGreaterThan(0);
  expect(published.every(e => (e.detail as { mode?: string }).mode === 'only')).toBe(true);
  expect(JSON.parse(readFileSync(join(root, 'runs', data.runId, 'run.json'), 'utf8')).mode).toBe('only');
});

test('fromNode consumes previous run output instead of rerunning upstream nodes, including disk-only history', async () => {
  setWorkflowPin(name, 'c', 'first-run-pin');
  const first = await start({});
  expect((await settled(first.data.runId)).outputs.a).toEqual({ value: 'original' });
  const yamlPath = join(root, '.elanous', 'workflows', `${name}.yaml`);
  writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8').replace('value: original', 'value: changed-after-first-run'));
  _resetWorkflowRunRegistryForTest();
  const second = await start({ fromNode: 'b', fromRunId: first.data.runId });
  expect(second.status).toBe(202);
  expect(second.data.mode).toBe('from');
  const result = await settled(second.data.runId);
  expect(result.events.filter(e => e.type === 'node_start').map(e => e.nodeId)).toEqual(['b', 'c']);
  expect(result.outputs.b).toBe('original');
  expect(result.outputs.a).toEqual({ value: 'original' });
  expect(result.events.every(e => e.mode === 'from')).toBe(true);
  expect(JSON.parse(readFileSync(join(root, 'runs', second.data.runId, 'run.json'), 'utf8')).mode).toBe('from');
});

test('test mode stops on an unpinned external side-effect node and a pin permits safe execution', async () => {
  const yamlPath = join(root, '.elanous', 'workflows', `${name}.yaml`);
  writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8').replace('bash: echo real-side-effect',
    `bash: touch ${join(root, 'side-effect-marker')}`));
  const blocked = await start({ mode: 'test', onlyNode: 'c' });
  const result = await settled(blocked.data.runId);
  expect(blocked.data.mode).toBe('test');
  expect(result.ok).toBe(false);
  expect(result.events.find(e => e.type === 'node_done')?.result?.error).toBe('pin required');
  expect(result.events.some(e => e.type === 'workflow_failed')).toBe(true);
  expect(result.events.every(e => e.mode === 'test')).toBe(true);
  expect(existsSync(join(root, 'side-effect-marker'))).toBe(false);
  expect(JSON.parse(readFileSync(join(root, 'runs', blocked.data.runId, 'run.json'), 'utf8')).mode).toBe('test');
  setWorkflowPin(name, 'c', 'pinned output');
  const pinned = await start({ mode: 'test', onlyNode: 'c' });
  expect((await settled(pinned.data.runId)).outputs.c).toBe('pinned output');
  expect(existsSync(join(root, 'side-effect-marker'))).toBe(false);
});

test('full mode and invalid resume selectors', async () => {
  const full = await start({});
  expect(full.data.mode).toBe('full');
  const result = await settled(full.data.runId);
  expect(result.mode).toBe('full');
  expect(result.events.every(e => e.mode === 'full')).toBe(true);
  expect((await start({ fromNode: 'b' })).status).toBe(400);
  expect((await start({ onlyNode: 'a', fromRunId: full.data.runId })).status).toBe(400);
  expect((await start({ onlyNode: 'missing' })).status).toBe(400);
  expect((await start({ usePins: false })).status).toBe(400);
  expect((await start({ fromNode: 'b', fromRunId: 'wf-missing' })).status).toBe(400);
});

test('pins bypass requires and judgment prechecks in full, only and from runs', async () => {
  const yamlPath = join(root, '.elanous', 'workflows', `${name}.yaml`);
  writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8').replace('    bash: echo real-side-effect',
    '    bash: echo real-side-effect\n    model: gpt-4o-mini\n    requires: { minContextSize: 999999999 }\n    judgment: evaluator\n    observes: [screen]'));
  const withoutPin = await start({ onlyNode: 'c' });
  expect((await settled(withoutPin.data.runId)).events.find(e => e.type === 'node_done')?.result?.error)
    .toContain('requires unmet');
  setWorkflowPin(name, 'c', 'pinned-before-prechecks');
  const first = await start({});
  expect(first.status).toBe(202);
  expect((await settled(first.data.runId)).outputs.c).toBe('pinned-before-prechecks');
  const only = await start({ onlyNode: 'c' });
  expect((await settled(only.data.runId)).outputs.c).toBe('pinned-before-prechecks');
  const resumed = await start({ fromNode: 'c', fromRunId: first.data.runId });
  expect(resumed.status).toBe(202);
  expect((await settled(resumed.data.runId)).outputs.c).toBe('pinned-before-prechecks');
});

test('a pinned judgment node bypasses its unavailable screen and judgment dependency', async () => {
  const yamlPath = join(root, '.elanous', 'workflows', `${name}.yaml`);
  writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8').replace('    bash: echo real-side-effect',
    '    bash: echo real-side-effect\n    judgment: evaluator\n    observes: [screen]'));
  const withoutPin = await start({ onlyNode: 'c' });
  expect((await settled(withoutPin.data.runId)).events.find(e => e.type === 'node_done')?.result?.error)
    .toContain('judgment contract unmet');
  setWorkflowPin(name, 'c', 'pinned-judgment');
  const pinned = await start({ onlyNode: 'c' });
  expect((await settled(pinned.data.runId)).outputs.c).toBe('pinned-judgment');
});

test('onlyNode combined with dryRun skips the selected trigger', async () => {
  const yamlPath = join(root, '.elanous', 'workflows', `${name}.yaml`);
  writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8').replace('    bash: echo real-side-effect',
    '    manualTrigger: {}'));
  const run = await start({ onlyNode: 'c', dryRun: true });
  expect(run.status).toBe(202);
  const result = await settled(run.data.runId);
  expect(result.ok).toBe(true);
  expect(result.events.filter(e => e.type === 'node_start')).toHaveLength(0);
  expect(result.events.filter(e => e.type === 'node_skipped')).toEqual([
    expect.objectContaining({ nodeId: 'c', reason: 'dry-run', mode: 'only' }),
  ]);
});
