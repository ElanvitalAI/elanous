import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createWebhookSource } from '../workflow-runtime/triggers/webhook-source.js';
import { dispatchGraphTriggerRun } from '../loops/graph-trigger-dispatch.js';
import { listGraphRuns } from './runner.js';
import { graphApiTrigger, handlePluginGraphApiRun, handlePluginGraphWebhook } from './plugin-graph-entry.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-graph-entry-'));
  dirs.push(dir);
  const file = join(dir, 'graph.yaml');
  writeFileSync(file, `graph_id: fixture\ntriggers:\n  api:\n    auth: operator\n    run_scope: instance\n    input_schema:\n      type: object\n      required: [item]\n      properties:\n        item: { type: string }\n  webhook:\n    method: POST\n    path: /hooks/fixture\n    auth: { type: bearer, token: test-secret }\n`);
  return file;
}

test('plugin graph API validates declared input before enqueue and rejects ambiguous IDs', async () => {
  const file = fixture();
  const calls: unknown[] = [];
  const dispatch = (async (input: unknown) => { calls.push(input); return {} as never; }) as NonNullable<Parameters<typeof handlePluginGraphApiRun>[2]>['dispatch'];
  const request = (body: string, key = 'request-0001') => new Request('http://localhost/v1/graph-plugins/fixture/run', {
    method: 'POST', headers: { 'idempotency-key': key }, body,
  });
  const deps = { graphFiles: [file], stateRoot: dirname(file), dispatch };
  expect((await handlePluginGraphApiRun(request('{"item":7}'), 'fixture', deps)).status).toBe(422);
  expect((await handlePluginGraphApiRun(request('bad'), 'fixture', deps)).status).toBe(400);
  expect((await handlePluginGraphApiRun(new Request('http://localhost/v1/graph-plugins/fixture/run', {
    method: 'POST', body: '{"item":"ok"}',
  }), 'fixture', deps)).status).toBe(400);
  expect(calls).toHaveLength(0);
  const accepted = await handlePluginGraphApiRun(request('{"item":"ok"}'), 'fixture', deps);
  expect(accepted.status).toBe(202);
  expect((await accepted.json()).runId).toBeString();
  expect(calls).toHaveLength(1);
  expect((await handlePluginGraphApiRun(request('{"item":"ok"}'), 'fixture', { graphFiles: [file, file], dispatch })).status).toBe(409);
});

test('API declaration rejects missing operator auth and malformed schema', () => {
  expect(() => graphApiTrigger({ graph_id: 'fixture', triggers: { api: { auth: 'none', input_schema: { type: 'object' } } } })).toThrow();
  expect(() => graphApiTrigger({ graph_id: 'fixture', triggers: { api: { auth: 'operator', input_schema: { type: 'object', properties: { item: { type: 'secret' } } } } } })).toThrow();
  expect(() => graphApiTrigger({ graph_id: 'fixture', triggers: { api: { auth: 'operator', input_schema: { type: 'object' } } } })).toThrow('run_scope: instance');
  expect(() => graphApiTrigger({ graph_id: 'fixture', triggers: { api: { auth: 'operator', run_scope: 'global', input_schema: { type: 'object' } } } })).toThrow('run_scope: instance');
});

test('unrelated broken installed graphs are isolated, while a duplicate target ID is refused', async () => {
  const file = fixture();
  const badYaml = join(dirname(file), 'broken.yaml');
  const badApi = join(dirname(file), 'unrelated.yaml');
  const duplicate = join(dirname(file), 'duplicate.yaml');
  writeFileSync(badYaml, 'graph_id: [');
  writeFileSync(badApi, 'graph_id: unrelated\ntriggers:\n  api: { auth: none }\n');
  writeFileSync(duplicate, 'graph_id: fixture\ntriggers:\n  api: { auth: none }\n');
  const calls: unknown[] = [];
  const dispatch = (async (input: unknown) => { calls.push(input); return {} as never; }) as NonNullable<Parameters<typeof handlePluginGraphApiRun>[2]>['dispatch'];
  const request = () => new Request('http://localhost/v1/graph-plugins/fixture/run', {
    method: 'POST', headers: { 'idempotency-key': 'request-0001' }, body: '{"item":"ok"}',
  });
  expect((await handlePluginGraphApiRun(request(), 'fixture', { graphFiles: [badYaml, badApi, file], stateRoot: dirname(file), dispatch })).status).toBe(202);
  expect(calls).toHaveLength(1);
  expect((await handlePluginGraphApiRun(request(), 'fixture', { graphFiles: [file, duplicate], dispatch })).status).toBe(409);
  expect((await handlePluginGraphApiRun(request(), 'fixture', { graphFiles: [duplicate], dispatch })).status).toBe(503);
});

test('API trigger binds concurrent and restarted delivery to one run and rejects a changed body', async () => {
  const file = fixture();
  const root = dirname(file);
  writeFileSync(file, `${readFileSync(file, 'utf8')}version: 1\nentry_node: done\nterminal_nodes: [done]\nnodes:\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges: []\n`);
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  const deliveries: Array<ReturnType<typeof dispatchGraphTriggerRun>> = [];
  const dispatch: typeof dispatchGraphTriggerRun = (input, options) => {
    const delivery = dispatchGraphTriggerRun(input, options);
    deliveries.push(delivery);
    return delivery;
  };
  const request = (body = '{"item":"ok"}') => new Request('http://localhost/v1/graph-plugins/fixture/run', {
    method: 'POST', headers: { 'idempotency-key': 'request-0001' }, body,
  });
  const deps = { graphFiles: [file], stateRoot: root, dispatch };
  const [first, concurrent] = await Promise.all([
    handlePluginGraphApiRun(request(), 'fixture', deps), handlePluginGraphApiRun(request(), 'fixture', deps),
  ]);
  expect(first.status).toBe(202);
  expect(concurrent.status).toBe(202);
  const runId = (await first.json()).runId;
  expect((await concurrent.json()).runId).toBe(runId);
  expect((await handlePluginGraphApiRun(request('{"item":"changed"}'), 'fixture', deps)).status).toBe(409);
  const malformed = await handlePluginGraphApiRun(request('bad'), 'fixture', deps);
  expect(malformed.status).toBe(409);
  expect(await malformed.json()).toEqual({ error: 'idempotency-conflict' });
  const wrongSchema = await handlePluginGraphApiRun(request('{"item":7}'), 'fixture', deps);
  expect(wrongSchema.status).toBe(409);
  expect(await wrongSchema.json()).toEqual({ error: 'idempotency-conflict' });
  expect(deliveries).toHaveLength(2);
  await Promise.all(deliveries);
  const restarted = await handlePluginGraphApiRun(request(), 'fixture', { graphFiles: [file], stateRoot: root, dispatch });
  expect((await restarted.json()).runId).toBe(runId);
  await Promise.all(deliveries);
  expect(listGraphRuns(root).runs.filter(run => run.graphId === 'fixture')).toHaveLength(1);
  const state = JSON.parse(readFileSync(join(root, 'graph-runs', 'fixture', `${runId}.json`), 'utf8')) as { input: unknown; status: string };
  expect(state.input).toEqual({ item: 'ok' });
  expect(state.status).toBe('done');
});

test('graph webhook uses shared router auth and forwards body to graph tick', async () => {
  const file = fixture();
  const inputs: unknown[] = [];
  const tick = (async (_file: string, options: unknown) => {
    inputs.push(options);
    return { action: 'started', runId: 'graph-run-1' };
  }) as Parameters<typeof handlePluginGraphWebhook>[2];
  const source = createWebhookSource();
  source.subscribeGraph(file, request => handlePluginGraphWebhook(file, request, tick));
  await source.start();
  const request = { method: 'POST', path: '/hooks/fixture', body: '{"item":"ok"}' };
  expect((await source.dispatch({ ...request, headers: {} }))?.status).toBe(401);
  expect(inputs).toHaveLength(0);
  const accepted = await source.dispatch({ ...request, headers: { authorization: 'Bearer test-secret' } });
  expect(accepted?.status).toBe(202);
  expect(inputs).toEqual([{ startIfIdle: true, input: { webhook: { method: 'POST', path: '/hooks/fixture', body: { item: 'ok' } } } }]);
  const waiting = await handlePluginGraphWebhook(file, request,
    (async () => ({ action: 'waiting', runId: 'old-run' })) as Parameters<typeof handlePluginGraphWebhook>[2]);
  expect(waiting.ok).toBe(false);
  await source.stop();
});
