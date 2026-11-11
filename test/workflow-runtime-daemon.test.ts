// Scheduler retirement R2 (2026-05-11) — workflow-runtime daemon
// orchestrator tests.
//
// Verifies that the daemon:
//  - subscribes schedule + webhook entries from a workflow list
//  - fires runWorkflow when a schedule entry ticks (fake setInterval)
//  - routes inbound webhook requests through the registered router
//  - reports collisions + skipped entries via status()
//  - stops + releases on stop()

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetEffectiveInstanceRoot } from '../src/instance/resolve';
import { latestGraphRun } from '../src/graph-runner/runner';
import { createWorkflowRuntimeDaemon } from '../src/workflow-runtime/daemon';
import { createScheduleSource } from '../src/workflow-runtime/triggers/schedule-source';
import { createWebhookSource } from '../src/workflow-runtime/triggers/webhook-source';
import type { WorkflowDeps, WorkflowEntry } from '../src/workflow-runtime/types';

const stubDeps: WorkflowDeps = {} as WorkflowDeps;

function wfWithSchedule(name: string, cron = '0 9 * * *'): WorkflowEntry {
  return {
    source: { source: 'global', path: `/tmp/${name}.yaml` },
    definition: {
      name,
      nodes: [{ id: 'tick', scheduleTrigger: { type: 'cron', cron } }],
    },
  } as unknown as WorkflowEntry;
}

function wfWithInterval(name: string, intervalMs: number): WorkflowEntry {
  return {
    source: { source: 'global', path: `/tmp/${name}.yaml` },
    definition: {
      name,
      nodes: [{ id: 'tick', scheduleTrigger: { type: 'interval', interval: intervalMs } }],
    },
  } as unknown as WorkflowEntry;
}

function wfWithWebhook(name: string, path: string, method = 'POST'): WorkflowEntry {
  return {
    source: { source: 'global', path: `/tmp/${name}.yaml` },
    definition: {
      name,
      nodes: [{ id: 'hook', webhookTrigger: { method, path } }],
    },
  } as unknown as WorkflowEntry;
}

describe('workflow-runtime daemon — lifecycle', () => {
  test('installed graph schedule starts a graph tick through the daemon', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'graph-schedule-daemon-'));
    const file = join(dir, 'graph.yaml');
    writeFileSync(join(dir, 'recipes.yaml'), '{}\n');
    writeFileSync(file, `graph_id: scheduled-graph
version: 1
entry_node: done
terminal_nodes: [done]
triggers:
  schedule: { type: interval, interval: 2000 }
nodes:
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
edges: []
`);
    let intervalCb: (() => void) | undefined;
    const scheduleSource = createScheduleSource({
      setInterval: cb => { intervalCb = cb; return 1 as unknown as ReturnType<typeof setInterval>; },
      clearInterval: () => {},
    });
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = dir;
    resetEffectiveInstanceRoot();
    const daemon = createWorkflowRuntimeDaemon({ workflows: [], graphFiles: [file], deps: stubDeps, scheduleSource });
    try {
      await daemon.start();
      expect(daemon.status().schedule.activeIntervals).toBe(1);
      expect(daemon.status().subscriptions.some(sub => sub.workflowName === 'graph:scheduled-graph')).toBe(true);
      intervalCb?.();
      const deadline = Date.now() + 5_000; // Source: #36711 daemon schedule integration test timeout.
      while (Date.now() < deadline && latestGraphRun('scheduled-graph', dir)?.status !== 'done')
        await new Promise(resolve => setTimeout(resolve, 20));
      expect(latestGraphRun('scheduled-graph', dir)?.status).toBe('done');
    } finally {
      await daemon.stop();
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
      resetEffectiveInstanceRoot();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('start() → schedule + webhook sources connect', async () => {
    let intervalCb: (() => void) | null = null;
    const scheduleSource = createScheduleSource({
      setInterval: (cb) => { intervalCb = cb; return 1 as unknown as ReturnType<typeof setInterval>; },
      clearInterval: () => {},
    });
    const webhookSource = createWebhookSource();
    const runs: string[] = [];
    const daemon = createWorkflowRuntimeDaemon({
      workflows: [wfWithInterval('hello', 2000), wfWithWebhook('hook', '/hi')],
      deps: stubDeps,
      runWorkflow: async (opts) => {
        runs.push(opts.workflow.name);
        return { outputs: {}, events: [], ok: true };
      },
      scheduleSource,
      webhookSource,
    });
    await daemon.start();
    expect(daemon.status().started).toBe(true);
    expect(daemon.status().schedule.activeIntervals).toBe(1);
    expect(daemon.status().subscriptions.length).toBe(2);

    // fire interval — should invoke runWorkflow
    intervalCb!();
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toEqual(['hello']);

    // route webhook
    const res = await daemon.dispatchWebhook({
      method: 'POST',
      path: '/hi',
      headers: {},
      body: '{"a":1}',
    });
    expect(res?.status).toBe(202);
    expect(runs).toEqual(['hello', 'hook']);

    await daemon.stop();
    expect(daemon.status().started).toBe(false);
  });

  test('stop() is idempotent', async () => {
    const daemon = createWorkflowRuntimeDaemon({
      workflows: [],
      deps: stubDeps,
      runWorkflow: async () => ({ outputs: {}, events: [], ok: true }),
    });
    await daemon.start();
    await daemon.stop();
    await daemon.stop(); // no throw
    expect(daemon.status().started).toBe(false);
  });

  test('dispatchWebhook before start returns null', async () => {
    const daemon = createWorkflowRuntimeDaemon({
      workflows: [],
      deps: stubDeps,
      runWorkflow: async () => ({ outputs: {}, events: [], ok: true }),
    });
    const res = await daemon.dispatchWebhook({
      method: 'POST',
      path: '/x',
      headers: {},
      body: '',
    });
    expect(res).toBeNull();
  });
});

describe('workflow-runtime daemon — cron registration', () => {
  test('cron entries register with node-cron via injected schedule fn', async () => {
    const cronCalls: string[] = [];
    let cronCb: (() => void) | null = null;
    const scheduleSource = createScheduleSource({
      cronSchedule: (expr, cb) => {
        cronCalls.push(expr);
        cronCb = cb;
        return { stop: () => {} };
      },
    });
    const runs: string[] = [];
    const daemon = createWorkflowRuntimeDaemon({
      workflows: [wfWithSchedule('daily', '0 9 * * *')],
      deps: stubDeps,
      runWorkflow: async (opts) => {
        runs.push(opts.workflow.name);
        return { outputs: {}, events: [], ok: true };
      },
      scheduleSource,
    });
    await daemon.start();
    expect(cronCalls).toEqual(['0 9 * * *']);
    expect(daemon.status().schedule.activeCrons).toBe(1);

    cronCb!();
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toEqual(['daily']);
    await daemon.stop();
  });

  test('invalid cron expression → surfaced via status().schedule.skipped', async () => {
    const scheduleSource = createScheduleSource({
      cronSchedule: () => ({ stop: () => {} }),
    });
    const daemon = createWorkflowRuntimeDaemon({
      workflows: [wfWithSchedule('bad', 'not-a-cron-pattern')],
      deps: stubDeps,
      runWorkflow: async () => ({ outputs: {}, events: [], ok: true }),
      scheduleSource,
    });
    await daemon.start();
    expect(daemon.status().schedule.skipped).toBe(1);
    expect(daemon.status().schedule.activeCrons).toBe(0);
    await daemon.stop();
  });
});

describe('workflow-runtime daemon — webhook collisions', () => {
  test('two workflows on (POST, /hook) → collision reported, both still routable', async () => {
    const daemon = createWorkflowRuntimeDaemon({
      workflows: [wfWithWebhook('a', '/hook'), wfWithWebhook('b', '/hook')],
      deps: stubDeps,
      runWorkflow: async () => ({ outputs: {}, events: [], ok: true }),
    });
    await daemon.start();
    expect(daemon.status().webhook.collisions.length).toBe(1);
    expect(daemon.status().webhook.collisions[0]).toEqual({ method: 'POST', path: '/hook' });
    // first registration wins on dispatch (router's find()-first behaviour)
    const res = await daemon.dispatchWebhook({ method: 'POST', path: '/hook', headers: {}, body: '' });
    expect(res?.status).toBe(202);
    await daemon.stop();
  });
});

describe('workflow-runtime daemon — auth', () => {
  test('webhook with bearer auth rejects missing header', async () => {
    const wf: WorkflowEntry = {
      source: { source: 'global', path: '/tmp/a.yaml' },
      definition: {
        name: 'protected',
        nodes: [{
          id: 'hook',
          webhookTrigger: { method: 'POST', path: '/p', auth: { type: 'bearer', token: 'secret' } },
        }],
      },
    } as unknown as WorkflowEntry;

    const daemon = createWorkflowRuntimeDaemon({
      workflows: [wf],
      deps: stubDeps,
      runWorkflow: async () => ({ outputs: {}, events: [], ok: true }),
    });
    await daemon.start();
    const noAuth = await daemon.dispatchWebhook({
      method: 'POST',
      path: '/p',
      headers: {},
      body: '',
    });
    expect(noAuth?.status).toBe(401);
    const okAuth = await daemon.dispatchWebhook({
      method: 'POST',
      path: '/p',
      headers: { authorization: 'Bearer secret' },
      body: '',
    });
    expect(okAuth?.status).toBe(202);
    await daemon.stop();
  });
});
