// `task` node — a signed webhook's provider item becomes a TOX task with its origin
// (RFC external tasks §A8 · X5b). The in-process path goes through the same
// `dispatchTaskCreate` as POST /v1/tasks, so approval and dedup are TOX's.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflowToCompletion, type WorkflowDefinition, type WorkflowDeps } from '../src/workflow-runtime/index.js';
import { validateWorkflow } from '../src/workflow-runtime/schema.js';
import { getNodeSpec } from '../src/workflow-runtime/node-catalog.js';
import type { WorkflowTaskRequest } from '../src/workflow-runtime/types.js';
import { TaskGraph } from '../src/task-orchestrator/graph.js';
import { TaskStore } from '../src/task-orchestrator/store.js';
import { setToxRuntimeDeps, resetToxRuntimeDepsForTest } from '../src/task-orchestrator/runtime-deps.js';
import { setElanousConfigDir, resetElanousConfigDir } from '../src/elanous-config-dir.js';
import { tasksDbPath } from '../src/task-orchestrator/paths.js';

const dir = mkdtempSync(join(tmpdir(), 'wf-task-node-'));
const previousTasksDb = process.env.ELANOUS_TASKS_DB;

afterAll(() => {
  resetToxRuntimeDepsForTest(); resetElanousConfigDir();
  if (previousTasksDb === undefined) delete process.env.ELANOUS_TASKS_DB;
  else process.env.ELANOUS_TASKS_DB = previousTasksDb;
  rmSync(dir, { recursive: true, force: true });
});

const BODY = JSON.stringify({ webhookId: 'evt-1', data: { identifier: 'ELA-7', title: 'Fix the flaky gate', url: 'https://linear.app/x/ELA-7', priority: 'high' } });

const workflow = (task: Record<string, unknown>): WorkflowDefinition => ({
  name: 'linear-to-tox', description: 'd',
  nodes: [
    { id: 'hook', webhookTrigger: { method: 'POST', path: '/linear' } },
    { id: 'file', depends_on: ['hook'], task },
  ],
} as unknown as WorkflowDefinition);

const linearTask = {
  title: '$hook.output.body.data.title',
  priority: '$hook.output.body.data.priority',
  eventId: '$hook.output.body.webhookId',
  external: { provider: 'linear', ref: '$hook.output.body.data.identifier', url: '$hook.output.body.data.url' },
};

function deps(over: Partial<WorkflowDeps> = {}): WorkflowDeps {
  return { callLLM: async () => '', runBash: async () => ({ stdout: '', stderr: '', exitCode: 0 }), ...over };
}

async function run(task: Record<string, unknown>, d: WorkflowDeps, args = BODY) {
  return runWorkflowToCompletion({ workflow: workflow(task), arguments: args, artifactsDir: mkdtempSync(join(dir, 'art-')) }, d);
}

describe('task node — interpolation and request shape', () => {
  test('the daemon-shaped $ARGUMENTS ({ trigger: { kind: webhook, body } }) exposes the same body', async () => {
    const seen: WorkflowTaskRequest[] = [];
    const daemonArgs = JSON.stringify({ trigger: { kind: 'webhook', method: 'POST', path: '/linear', body: BODY }, nodeId: 'hook' });
    const { outputs } = await run(linearTask, deps({ createTask: async (req) => { seen.push(req); return { taskId: 'task:d' }; } }), daemonArgs);
    expect(outputs['hook']?.output).toMatchObject({ body: { webhookId: 'evt-1' } });
    expect(seen[0]).toMatchObject({ title: 'Fix the flaky gate', external: { ref: 'ELA-7' } });
  });

  test('webhook JSON body fields fill the task and its external origin', async () => {
    const seen: WorkflowTaskRequest[] = [];
    const { outputs } = await run(linearTask, deps({ createTask: async (req) => { seen.push(req); return { taskId: 'task:abc', deduplicated: false }; } }));
    expect(outputs['hook']?.output).toMatchObject({ kind: 'webhook', body: { webhookId: 'evt-1' } });
    expect(seen).toEqual([{
      title: 'Fix the flaky gate', priority: 'high', eventId: 'evt-1',
      external: { provider: 'linear', ref: 'ELA-7', url: 'https://linear.app/x/ELA-7' },
    }]);
    expect(outputs['file']).toMatchObject({ ok: true, output: { taskId: 'task:abc', deduplicated: false } });
  });

  test('an empty resolved ref, an out-of-range priority, or a refused create fails the node', async () => {
    const create = async () => ({ taskId: 'task:x' });
    const noRef = await run({ ...linearTask, external: { provider: 'linear', ref: '$hook.output.body.missing' } }, deps({ createTask: create }));
    expect(noRef.outputs['file']).toMatchObject({ ok: false });
    const urgent = await run({ ...linearTask, priority: 'urgent-ish' }, deps({ createTask: create }), JSON.stringify({ data: { title: 't', identifier: 'ELA-1' } }));
    expect(urgent.outputs['file']?.ok).toBe(false);
    const refused = await run(linearTask, deps({ createTask: async () => ({ error: 'TOX not initialized — graph unavailable' }) }));
    expect(refused.outputs['file']).toMatchObject({ ok: false, error: 'TOX not initialized — graph unavailable' });
  });
});

describe('task node — in-process TOX (no injected createTask)', () => {
  test('creates a pending backlog task with the external origin, and the same ref deduplicates', async () => {
    process.env.ELANOUS_TASKS_DB = join(dir, 'tasks.db');
    setElanousConfigDir(dir);
    const graph = new TaskGraph();
    const store = new TaskStore({ path: tasksDbPath(), noWal: true });
    setToxRuntimeDeps({ getGraph: () => graph, getDispatcher: () => null, getGenerator: () => null, getStore: () => store });
    try {
      const first = await run(linearTask, deps());
      const out = first.outputs['file']?.output as { taskId: string; deduplicated: boolean };
      expect(first.outputs['file']?.ok).toBe(true);
      expect(out.deduplicated).toBe(false);
      expect(graph.getTask(out.taskId)).toMatchObject({
        title: 'Fix the flaky gate',
        generatedBy: { kind: 'external', provider: 'linear', ref: 'ELA-7' },
        status: 'backlog',
        approval: { state: 'pending' },
      });
      const again = await run(linearTask, deps(), JSON.stringify({ webhookId: 'evt-2', data: { identifier: 'ELA-7', title: 'Fix the flaky gate (edited)' } }));
      expect(again.outputs['file']?.output).toEqual({ taskId: out.taskId, deduplicated: true });
      expect(graph.size()).toBe(1);
    } finally {
      store.close();
      resetToxRuntimeDepsForTest();
    }
  });
});

describe('task node — schema and catalog', () => {
  const wf = (task: unknown) => validateWorkflow({ name: 'w', description: 'd', nodes: [{ id: 'file', task }] });

  test('accepts title + external, including interpolated provider and priority', () => {
    expect(wf({ title: 'x', external: { provider: 'linear', ref: 'ELA-1' } }).ok).toBe(true);
    expect(wf({ title: '$a.output', priority: '$a.output.p', external: { provider: '$a.output.p', ref: '$a.output.r' } }).ok).toBe(true);
  });

  test('rejects a missing external, an unknown literal provider, and a literal urgent priority', () => {
    expect(wf({ title: 'x' }).ok).toBe(false);
    expect(wf({ title: 'x', external: { provider: 'jira', ref: 'J-1' } }).ok).toBe(false);
    expect(wf({ title: 'x', priority: 'urgent', external: { provider: 'linear', ref: 'L' } }).ok).toBe(false);
  });

  test('the node catalog lists task with its required fields', () => {
    expect(getNodeSpec('task')).toMatchObject({ yamlKey: 'task', required: ['title', 'external'], category: 'integration' });
  });
});
