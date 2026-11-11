import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebhookSource } from '../../workflow-runtime/triggers/webhook-source.js';
import { isSelfVerifiedGraphWebhookRequest } from './graph-route-allowlist.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function graphFile(id: string, path: string, auth?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'graph-route-'));
  dirs.push(dir);
  const file = join(dir, 'graph.yaml');
  writeFileSync(file, `graph_id: ${id}\ntriggers:\n  webhook:\n    method: POST\n    path: ${path}\n${auth !== undefined ? `    auth: { type: bearer, token: '${auth}' }\n` : ''}`);
  return file;
}

test('only an active exact graph route with its own auth crosses the bearer gate', async () => {
  const source = createWebhookSource();
  source.subscribeGraph(graphFile('secured', '/hooks/secured', 'graph-token'), async () => ({ ok: true, runId: 'graph-run' }));
  source.subscribeGraph(graphFile('open', '/hooks/open'), async () => ({ ok: true, runId: 'open-run' }));
  source.subscribeGraph(graphFile('empty', '/hooks/empty', ''), async () => ({ ok: true, runId: 'empty-run' }));
  const daemon = { isSelfVerifiedGraphWebhookRoute: source.isSelfVerifiedGraphRoute };
  const allowed = (method: string, path: string) => isSelfVerifiedGraphWebhookRequest(method, path, daemon);
  expect(allowed('POST', '/v1/workflows/webhooks/hooks/secured')).toBe(false);
  await source.start();
  expect(allowed('POST', '/v1/workflows/webhooks/hooks/secured')).toBe(true);
  expect(allowed('GET', '/v1/workflows/webhooks/hooks/secured')).toBe(false);
  expect(allowed('POST', '/v1/workflows/webhooks/hooks/secured/extra')).toBe(false);
  expect(allowed('POST', '/v1/workflows/webhooks/hooks/open')).toBe(false);
  expect(allowed('POST', '/v1/workflows/webhooks/hooks/empty')).toBe(false);
  expect(allowed('POST', '/v1/graph-plugins/secured/run')).toBe(false);
  expect((await source.dispatch({ method: 'POST', path: '/hooks/secured', body: '{}', headers: {} }))?.status).toBe(401);
  expect((await source.dispatch({ method: 'POST', path: '/hooks/secured', body: '{}',
    headers: { authorization: 'Bearer graph-token' } }))?.status).toBe(202);
  await source.stop();
  expect(allowed('POST', '/v1/workflows/webhooks/hooks/secured')).toBe(false);
});

test('colliding graph routes never acquire a self-verified gate exemption', async () => {
  const source = createWebhookSource();
  source.subscribeGraph(graphFile('one', '/hooks/shared', 'one'), async () => ({ ok: true, runId: 'one' }));
  await source.start();
  expect(source.isSelfVerifiedGraphRoute('POST', '/hooks/shared')).toBe(true);
  source.subscribeGraph(graphFile('two', '/hooks/shared', 'two'), async () => ({ ok: true, runId: 'two' }));
  expect(source.isSelfVerifiedGraphRoute('POST', '/hooks/shared')).toBe(false);
  await source.stop();

  const bootCollision = createWebhookSource();
  bootCollision.subscribeGraph(graphFile('three', '/hooks/shared', 'three'), async () => ({ ok: true, runId: 'three' }));
  bootCollision.subscribeGraph(graphFile('four', '/hooks/shared', 'four'), async () => ({ ok: true, runId: 'four' }));
  await bootCollision.start();
  expect(bootCollision.collisions()).toEqual([{ method: 'POST', path: '/hooks/shared' }]);
  expect(bootCollision.isSelfVerifiedGraphRoute('POST', '/hooks/shared')).toBe(false);
  await bootCollision.stop();
});
