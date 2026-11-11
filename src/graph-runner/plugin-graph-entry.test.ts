import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createWebhookSource } from '../workflow-runtime/triggers/webhook-source.js';
import { graphApiTrigger, handlePluginGraphApiRun, handlePluginGraphWebhook } from './plugin-graph-entry.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-graph-entry-'));
  dirs.push(dir);
  const file = join(dir, 'graph.yaml');
  writeFileSync(file, `graph_id: fixture\ntriggers:\n  api:\n    auth: operator\n    input_schema:\n      type: object\n      required: [item]\n      properties:\n        item: { type: string }\n  webhook:\n    method: POST\n    path: /hooks/fixture\n    auth: { type: bearer, token: test-secret }\n`);
  return file;
}

test('plugin graph API validates declared input before enqueue and rejects ambiguous IDs', async () => {
  const file = fixture();
  const calls: unknown[] = [];
  const run = (async (_file: string, options: unknown) => { calls.push(options); return {} as never; }) as NonNullable<Parameters<typeof handlePluginGraphApiRun>[2]>['run'];
  const request = (body: string) => new Request('http://localhost/v1/graph-plugins/fixture/run', { method: 'POST', body });
  const deps = { graphFiles: [file], run };
  expect((await handlePluginGraphApiRun(request('{"item":7}'), 'fixture', deps)).status).toBe(422);
  expect((await handlePluginGraphApiRun(request('bad'), 'fixture', deps)).status).toBe(400);
  expect(calls).toHaveLength(0);
  const accepted = await handlePluginGraphApiRun(request('{"item":"ok"}'), 'fixture', deps);
  expect(accepted.status).toBe(202);
  expect((await accepted.json()).runId).toBeString();
  expect(calls).toHaveLength(1);
  expect((await handlePluginGraphApiRun(request('{"item":"ok"}'), 'fixture', { graphFiles: [file, file], run })).status).toBe(409);
});

test('API declaration rejects missing operator auth and malformed schema', () => {
  expect(() => graphApiTrigger({ graph_id: 'fixture', triggers: { api: { auth: 'none', input_schema: { type: 'object' } } } })).toThrow();
  expect(() => graphApiTrigger({ graph_id: 'fixture', triggers: { api: { auth: 'operator', input_schema: { type: 'object', properties: { item: { type: 'secret' } } } } } })).toThrow();
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
  const run = (async (_file: string, options: unknown) => { calls.push(options); return {} as never; }) as NonNullable<Parameters<typeof handlePluginGraphApiRun>[2]>['run'];
  const request = () => new Request('http://localhost/v1/graph-plugins/fixture/run', { method: 'POST', body: '{"item":"ok"}' });
  expect((await handlePluginGraphApiRun(request(), 'fixture', { graphFiles: [badYaml, badApi, file], run })).status).toBe(202);
  expect(calls).toHaveLength(1);
  expect((await handlePluginGraphApiRun(request(), 'fixture', { graphFiles: [file, duplicate], run })).status).toBe(409);
  expect((await handlePluginGraphApiRun(request(), 'fixture', { graphFiles: [duplicate], run })).status).toBe(503);
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
