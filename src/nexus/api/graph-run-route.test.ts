import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { resetUserConfig } from '../../user-config.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { NexusEventBus } from './event-bus.js';
import { routeRequest } from './http-server.js';
import { issueTempToken, revokeTempTokens } from '../../auth/temp-tokens.js';

const SECRET = 'op-proxy-secret-0123456789abcdef';
const OWNER = 'owner-token';
const dirs: string[] = [];

afterEach(() => {
  resetUserConfig();
  resetElanousConfigDir();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'graph-run-route-'));
  dirs.push(dir);
  setElanousConfigDir(dir);
  resetUserConfig();
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ operator: { enabled: true, proxySecretFile: join(dir, 'secret') } }));
  writeFileSync(join(dir, 'secret'), SECRET, { mode: 0o600 });
  chmodSync(join(dir, 'secret'), 0o600);
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const opts = { state, registry: new TabRegistry(state), eventBus: new NexusEventBus(), metaApi: { bearerToken: OWNER, noAuth: false } };
  return (path: string, headers: Record<string, string>, method = 'POST') =>
    routeRequest(new Request(`http://ops.test${path}`, { method, headers }), opts, {} as never, null, createDevProxyRuntimeRef());
}

test('CGE-RUN: run and run-state are operator-only — same-origin without a token and a forged proxy header are refused', async () => {
  const send = fixture();
  for (const path of ['/v1/graphs/demo-review-mine/run', '/v1/graphs/demo-review-mine/runs/ed-abc-123456']) {
    const method = path.endsWith('/run') ? 'POST' : 'GET';
    expect((await send(path, { 'sec-fetch-site': 'same-origin' }, method))?.status).toBe(403);
    expect((await send(path, { 'sec-fetch-site': 'cross-site', 'x-elanous-operator': 'forged-forged-forged-forged' }, method))?.status).toBe(403);
  }
  // 인증을 넘으면 실행 API 가 답한다(여기선 «mine» 에 그 그래프가 없어 404).
  expect((await send('/v1/graphs/demo-review-mine/run', { 'sec-fetch-site': 'cross-site', authorization: `Bearer ${OWNER}` }))?.status).toBe(404);
  expect((await send('/v1/graphs/demo-review-mine/run', { 'sec-fetch-site': 'cross-site', 'x-elanous-operator': SECRET }))?.status).toBe(404);
  expect((await send('/v1/graphs/demo-review-mine/run', { authorization: `Bearer ${OWNER}` }, 'DELETE'))?.status).toBe(405);
  // An owner-issued short-lived token (`elanous token issue` · how demo filming signs in) passes too; a revoked/unknown one does not.
  const temp = issueTempToken({ ttlMs: 60_000, label: 'test' });
  expect((await send('/v1/graphs/demo-review-mine/run', { 'sec-fetch-site': 'cross-site', authorization: `Bearer ${temp.token}` }))?.status).toBe(404);
  expect((await send('/v1/graphs/demo-review-mine/run', { 'sec-fetch-site': 'cross-site', authorization: `Bearer elt_${'x'.repeat(43)}` }))?.status).toBe(403);
  // Expired and revoked temp tokens are refused (the recipe allow-list stays the real safety net).
  const expired = issueTempToken({ ttlMs: 60_000, label: 'expired', now: Date.now() - 120_000 });
  expect((await send('/v1/graphs/demo-review-mine/run', { 'sec-fetch-site': 'cross-site', authorization: `Bearer ${expired.token}` }))?.status).toBe(403);
  expect(revokeTempTokens({ id: temp.id })).toBe(1);
  expect((await send('/v1/graphs/demo-review-mine/run', { 'sec-fetch-site': 'cross-site', authorization: `Bearer ${temp.token}` }))?.status).toBe(403);
});
