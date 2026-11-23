// Node-catalog v2 (2026-05-11) — trigger registry + scheduler +
// webhook router tests.

import { describe, expect, it } from 'bun:test';
import {
  buildTriggerRegistry,
  findWebhookCollisions,
  type TriggerRegistry,
} from '../src/workflow-runtime/triggers/registry.js';
import { startScheduler } from '../src/workflow-runtime/triggers/scheduler.js';
import {
  buildWebhookRouter,
  checkAuth,
  type WebhookRouterRequest,
} from '../src/workflow-runtime/triggers/webhook-router.js';
import type { WorkflowEntry } from '../src/workflow-runtime/types.js';

function wf(name: string, ...nodes: object[]): WorkflowEntry {
  return {
    source: { source: 'project', path: `/tmp/${name}.yaml` },
    definition: { name, description: 'd', nodes: nodes as never },
  };
}

describe('buildTriggerRegistry (pure)', () => {
  it('returns empty registry for empty input', () => {
    expect(buildTriggerRegistry([])).toEqual({ schedules: [], webhooks: [] });
  });

  it('returns empty registry when workflows have no trigger nodes', () => {
    const r = buildTriggerRegistry([wf('demo', { id: 'a', bash: 'echo' })]);
    expect(r.schedules).toEqual([]);
    expect(r.webhooks).toEqual([]);
  });

  it('extracts schedule trigger entries', () => {
    const r = buildTriggerRegistry([
      wf('daily', { id: 't', scheduleTrigger: { type: 'cron', cron: '0 9 * * *' } }),
    ]);
    expect(r.schedules).toEqual([{
      workflowName: 'daily',
      nodeId: 't',
      trigger: { type: 'cron', cron: '0 9 * * *' },
    }]);
  });

  it('extracts webhook trigger entries', () => {
    const r = buildTriggerRegistry([
      wf('hook', { id: 'wh', webhookTrigger: { method: 'POST', path: '/hooks/x' } }),
    ]);
    expect(r.webhooks).toEqual([{
      workflowName: 'hook',
      nodeId: 'wh',
      trigger: { method: 'POST', path: '/hooks/x' },
    }]);
  });

  it('extracts multiple triggers per workflow', () => {
    const r = buildTriggerRegistry([
      wf('multi',
        { id: 's', scheduleTrigger: { type: 'interval', interval: 60000 } },
        { id: 'w', webhookTrigger: { method: 'GET', path: '/ping' } },
      ),
    ]);
    expect(r.schedules.length).toBe(1);
    expect(r.webhooks.length).toBe(1);
  });
});

describe('findWebhookCollisions (pure)', () => {
  it('reports collisions on duplicate (method, path)', () => {
    const r: TriggerRegistry = {
      schedules: [],
      webhooks: [
        { workflowName: 'a', nodeId: 'w', trigger: { method: 'POST', path: '/x' } },
        { workflowName: 'b', nodeId: 'w', trigger: { method: 'POST', path: '/x' } },
      ],
    };
    expect(findWebhookCollisions(r)).toEqual([{
      method: 'POST',
      path: '/x',
      entries: r.webhooks,
    }]);
  });

  it('returns [] when paths differ', () => {
    const r: TriggerRegistry = {
      schedules: [],
      webhooks: [
        { workflowName: 'a', nodeId: 'w', trigger: { method: 'POST', path: '/x' } },
        { workflowName: 'b', nodeId: 'w', trigger: { method: 'POST', path: '/y' } },
      ],
    };
    expect(findWebhookCollisions(r)).toEqual([]);
  });

  it('returns [] when methods differ on same path', () => {
    const r: TriggerRegistry = {
      schedules: [],
      webhooks: [
        { workflowName: 'a', nodeId: 'w', trigger: { method: 'GET', path: '/x' } },
        { workflowName: 'b', nodeId: 'w', trigger: { method: 'POST', path: '/x' } },
      ],
    };
    expect(findWebhookCollisions(r)).toEqual([]);
  });
});

describe('startScheduler', () => {
  it('registers an interval timer per entry', () => {
    const fired: string[] = [];
    let nextId = 0;
    const fakeHandles: number[] = [];
    const handle = startScheduler({
      registry: [
        { workflowName: 'a', nodeId: 't1', trigger: { type: 'interval', interval: 60_000 } },
        { workflowName: 'b', nodeId: 't2', trigger: { type: 'interval', interval: 30_000 } },
      ],
      runWorkflow: (e) => { fired.push(e.workflowName); },
      setInterval: ((cb, ms) => {
        void ms;
        const id = ++nextId;
        fakeHandles.push(id);
        // Don't actually fire; the test asserts on `active` count.
        void cb;
        return id as unknown as ReturnType<typeof globalThis.setInterval>;
      }) as never,
      clearInterval: ((h) => {
        const idx = fakeHandles.indexOf(h as unknown as number);
        if (idx >= 0) fakeHandles.splice(idx, 1);
      }) as never,
    });
    expect(handle.active).toBe(2);
    expect(handle.skipped).toEqual([]);
    handle.stop();
    expect(fakeHandles).toEqual([]);
  });

  it('registers cron entries via injected cronSchedule (R2 daemon v2)', () => {
    // Scheduler-retirement R2: cron entries register via node-cron.
    // Tests inject `cronSchedule` so we don't depend on wall-clock.
    const cronCalls: string[] = [];
    const handle = startScheduler({
      registry: [
        { workflowName: 'a', nodeId: 't', trigger: { type: 'cron', cron: '0 9 * * *' } },
      ],
      runWorkflow: () => {},
      cronSchedule: (expr) => { cronCalls.push(expr); return { stop: () => {} }; },
    });
    expect(handle.active).toBe(1);
    expect(handle.activeIntervals).toBe(0);
    expect(handle.activeCrons).toBe(1);
    expect(cronCalls).toEqual(['0 9 * * *']);
    expect(handle.skipped).toEqual([]);
    handle.stop();
  });

  it('invalid cron expression surfaces via skipped', () => {
    const handle = startScheduler({
      registry: [
        { workflowName: 'a', nodeId: 't', trigger: { type: 'cron', cron: 'not-a-pattern' } },
      ],
      runWorkflow: () => {},
      cronSchedule: () => { throw new Error('should not register invalid cron'); },
    });
    expect(handle.active).toBe(0);
    expect(handle.skipped.length).toBe(1);
    expect(handle.skipped[0].reason).toContain('invalid cron');
    handle.stop();
  });

  it('skips interval entries below the minimum threshold', () => {
    const handle = startScheduler({
      registry: [
        { workflowName: 'a', nodeId: 't', trigger: { type: 'interval', interval: 100 } },
      ],
      runWorkflow: () => {},
      setInterval: (() => 0 as unknown as ReturnType<typeof globalThis.setInterval>) as never,
      clearInterval: (() => {}) as never,
    });
    expect(handle.active).toBe(0);
    expect(handle.skipped[0].reason).toContain('below minimum');
    handle.stop();
  });

  it('invokes runWorkflow when the interval fires (via fake setInterval)', () => {
    let firedFor = '';
    let registeredCb: (() => void) | null = null;
    const handle = startScheduler({
      registry: [
        { workflowName: 'demo', nodeId: 't', trigger: { type: 'interval', interval: 60_000 } },
      ],
      runWorkflow: (e) => { firedFor = e.workflowName; },
      setInterval: ((cb) => { registeredCb = cb; return 1 as unknown as ReturnType<typeof globalThis.setInterval>; }) as never,
      clearInterval: (() => {}) as never,
    });
    expect(handle.active).toBe(1);
    expect(registeredCb).not.toBeNull();
    registeredCb!();
    expect(firedFor).toBe('demo');
    handle.stop();
  });

  it('keys one cron minute and one interval window even when the callback clock drifts by milliseconds', () => {
    const fires: Array<{ nodeId: string; scheduledAt: number }> = [];
    let cronCb: (() => void) | null = null;
    let intervalCb: (() => void) | null = null;
    let clock = Date.parse('2026-11-17T15:00:00.250Z');
    const handle = startScheduler({
      registry: [
        { workflowName: 'graph:tick-test', nodeId: 'schedule:0', trigger: { type: 'cron', cron: '0 15 * * *' } },
        { workflowName: 'graph:tick-test', nodeId: 'schedule:1', trigger: { type: 'interval', interval: 60_000 } },
      ],
      now: () => clock,
      runWorkflow: (entry, fire) => { fires.push({ nodeId: entry.nodeId, scheduledAt: fire.scheduledAt }); },
      cronSchedule: (_expr: string, cb: () => void, _timeZone: string) => { cronCb = cb; return { stop: () => {} }; },
      setInterval: ((cb: () => void) => { intervalCb = cb; return 1 as unknown as ReturnType<typeof globalThis.setInterval>; }) as never,
      clearInterval: (() => {}) as never,
    });
    cronCb!();
    clock = Date.parse('2026-11-17T15:00:00.900Z');
    cronCb!();
    intervalCb!();
    clock = Date.parse('2026-11-17T15:00:59.999Z');
    intervalCb!();
    expect(fires).toEqual([
      { nodeId: 'schedule:0', scheduledAt: Date.parse('2026-11-17T15:00:00.000Z') },
      { nodeId: 'schedule:0', scheduledAt: Date.parse('2026-11-17T15:00:00.000Z') },
      { nodeId: 'schedule:1', scheduledAt: Date.parse('2026-11-17T15:00:00.000Z') },
      { nodeId: 'schedule:1', scheduledAt: Date.parse('2026-11-17T15:00:00.000Z') },
    ]);
    handle.stop();
  });
});

describe('checkAuth (pure)', () => {
  it('returns null when entry has no auth (open)', () => {
    const entry = { workflowName: 'w', nodeId: 'n', trigger: { method: 'POST' as const, path: '/x' } };
    expect(checkAuth(entry, {})).toBeNull();
  });

  it('rejects missing authorization header', () => {
    const entry = {
      workflowName: 'w', nodeId: 'n',
      trigger: { method: 'POST' as const, path: '/x', auth: { type: 'bearer' as const, token: 't' } },
    };
    const r = checkAuth(entry, {});
    expect(r?.status).toBe(401);
  });

  it('accepts valid bearer', () => {
    const entry = {
      workflowName: 'w', nodeId: 'n',
      trigger: { method: 'POST' as const, path: '/x', auth: { type: 'bearer' as const, token: 'abc' } },
    };
    expect(checkAuth(entry, { authorization: 'Bearer abc' })).toBeNull();
  });

  it('rejects wrong bearer', () => {
    const entry = {
      workflowName: 'w', nodeId: 'n',
      trigger: { method: 'POST' as const, path: '/x', auth: { type: 'bearer' as const, token: 'abc' } },
    };
    const r = checkAuth(entry, { authorization: 'Bearer xyz' });
    expect(r?.status).toBe(401);
  });

  it('accepts valid basic credentials', () => {
    const entry = {
      workflowName: 'w', nodeId: 'n',
      trigger: { method: 'POST' as const, path: '/x', auth: { type: 'basic' as const, username: 'alice', password: 'secret' } },
    };
    expect(checkAuth(entry, { authorization: 'Basic YWxpY2U6c2VjcmV0' })).toBeNull();
  });
});

describe('buildWebhookRouter', () => {
  const entry = {
    workflowName: 'demo', nodeId: 'wh',
    trigger: { method: 'POST' as const, path: '/hooks/x' },
  };
  const req = (method: string, path: string, body = '', headers: Record<string, string> = {}): WebhookRouterRequest => ({
    method, path, body, headers,
  });

  it('returns 404 for an unregistered route', async () => {
    const router = buildWebhookRouter({
      registry: [entry],
      runWorkflow: async () => ({ ok: true, runId: 'r1' }),
    });
    const r = await router(req('POST', '/nope'));
    expect(r.status).toBe(404);
  });

  it('returns 202 + runId on a matched route', async () => {
    const router = buildWebhookRouter({
      registry: [entry],
      runWorkflow: async () => ({ ok: true, runId: 'r123' }),
    });
    const r = await router(req('POST', '/hooks/x', '{"data":1}'));
    expect(r.status).toBe(202);
    expect(r.body).toContain('r123');
  });

  it('forwards the body to the runner', async () => {
    let seenBody = '';
    const router = buildWebhookRouter({
      registry: [entry],
      runWorkflow: async (_e, body) => {
        seenBody = body;
        return { ok: true, runId: 'r1' };
      },
    });
    await router(req('POST', '/hooks/x', 'raw-payload'));
    expect(seenBody).toBe('raw-payload');
  });

  it('returns 401 on missing auth', async () => {
    const router = buildWebhookRouter({
      registry: [{
        ...entry,
        trigger: { ...entry.trigger, auth: { type: 'bearer', token: 't' } },
      }],
      runWorkflow: async () => ({ ok: true, runId: 'r1' }),
    });
    const r = await router(req('POST', '/hooks/x'));
    expect(r.status).toBe(401);
  });

  it('surfaces runner error as 500', async () => {
    const router = buildWebhookRouter({
      registry: [entry],
      runWorkflow: async () => ({ ok: false, error: 'workflow boom' }),
    });
    const r = await router(req('POST', '/hooks/x'));
    expect(r.status).toBe(500);
    expect(r.body).toContain('workflow boom');
  });

  describe('register / unregister · post-start route mutation', () => {
    it('register adds a new (method, path) that dispatch can route to', async () => {
      const router = buildWebhookRouter({
        registry: [],
        runWorkflow: async () => ({ ok: true, runId: 'late' }),
      });
      const before = await router(req('POST', '/hooks/late'));
      expect(before.status).toBe(404);
      router.register({
        workflowName: 'late', nodeId: 'wh',
        trigger: { method: 'POST', path: '/hooks/late' },
      });
      const after = await router(req('POST', '/hooks/late'));
      expect(after.status).toBe(202);
    });

    it('register on the same (method, path) replaces the entry', async () => {
      const calls: string[] = [];
      const router = buildWebhookRouter({
        registry: [{ workflowName: 'first', nodeId: 'wh', trigger: { method: 'POST', path: '/p' } }],
        runWorkflow: async (e) => { calls.push(e.workflowName); return { ok: true, runId: '1' }; },
      });
      router.register({ workflowName: 'second', nodeId: 'wh', trigger: { method: 'POST', path: '/p' } });
      await router(req('POST', '/p'));
      expect(calls).toEqual(['second']);
    });

    it('unregister removes a route · 404 after, idempotent on miss', async () => {
      const router = buildWebhookRouter({
        registry: [entry],
        runWorkflow: async () => ({ ok: true, runId: 'r' }),
      });
      expect(router.unregister('POST', '/hooks/x')).toBe(true);
      const r = await router(req('POST', '/hooks/x'));
      expect(r.status).toBe(404);
      expect(router.unregister('POST', '/hooks/x')).toBe(false);
    });

    it('routes() snapshot reflects mutations', async () => {
      const router = buildWebhookRouter({
        registry: [entry],
        runWorkflow: async () => ({ ok: true, runId: 'r' }),
      });
      expect(router.routes()).toEqual([{ method: 'POST', path: '/hooks/x' }]);
      router.register({
        workflowName: 'b', nodeId: 'wh',
        trigger: { method: 'GET', path: '/hooks/y' },
      });
      const sorted = [...router.routes()].sort((a, b) => a.path.localeCompare(b.path));
      expect(sorted).toEqual([
        { method: 'POST', path: '/hooks/x' },
        { method: 'GET', path: '/hooks/y' },
      ]);
    });
  });
});
