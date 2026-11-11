import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { addItem, listChecklist } from '../../release-loop/checklist.js';
import { readRemoteChecklist } from '../../cli/release-checklist-remote.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';

test('Nexus exposes the HQ checklist only through authenticated GET', async () => {
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const opts = { state, registry: new TabRegistry(state), eventBus: new NexusEventBus(),
    metaApi: { bearerToken: 'owner-token', noAuth: false },
    checklistReader: (version: string) => ({ version, released: '', dev: version, history: [], items: [
      { id: 'CELL-A', title: 'HQ cell', status: 'yellow' as const, updatedAt: '2026-11-11T00:00:00Z', updatedBy: 'OP' },
    ] }),
  } as NexusHttpServerOpts;
  const call = (path: string, init: RequestInit = {}) => routeRequest(
    new Request(`http://127.0.0.1${path}`, init), opts, {} as never, null, createDevProxyRuntimeRef());
  const path = '/v1/release/checklist?version=0.3.10';
  expect((await call(path))?.status).toBe(401);
  const noAuthOpts = { ...opts, metaApi: { bearerToken: 'owner-token', noAuth: true } } as NexusHttpServerOpts;
  expect((await routeRequest(new Request(`http://127.0.0.1${path}`), noAuthOpts, {} as never, null, createDevProxyRuntimeRef()))?.status).toBe(401);
  expect((await call(path, { method: 'POST', headers: { authorization: 'Bearer owner-token' } }))?.status).toBe(405);
  expect((await call('/v1/release/checklist?version=../private', { headers: { authorization: 'Bearer owner-token' } }))?.status).toBe(400);
  const response = await call(path, { headers: { authorization: 'Bearer owner-token' } });
  expect(response?.status).toBe(200);
  expect(response?.headers.get('cache-control')).toBe('no-store');
  expect(await response?.json()).toMatchObject({ version: '0.3.10', items: [{ id: 'CELL-A' }] });
});

test('Nexus reads the actual HQ checklist ledger without changing it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-checklist-ledger-'));
  setElanousConfigDir(dir);
  try {
    addItem('0.3.10', { id: 'REAL-CELL', title: 'Owned by HQ', owner: 'OP' });
    const before = listChecklist('0.3.10');
    const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
    const opts = { state, registry: new TabRegistry(state), eventBus: new NexusEventBus(),
      metaApi: { bearerToken: 'owner-token', noAuth: false },
    } as NexusHttpServerOpts;
    const response = await routeRequest(
      new Request('http://127.0.0.1/v1/release/checklist?version=0.3.10', { headers: { authorization: 'Bearer owner-token' } }),
      opts, {} as never, null, createDevProxyRuntimeRef());
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ version: '0.3.10', items: [{ id: 'REAL-CELL', owner: 'OP' }] });
    const tokenFile = join(dir, 'nexus-token');
    writeFileSync(tokenFile, 'owner-token', { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
    const remote = await readRemoteChecklist('0.3.10', { url: 'http://127.0.0.1:31415', tokenFile,
      fetch: async (url, init) => (await routeRequest(new Request(url, init), opts, {} as never, null, createDevProxyRuntimeRef()))!,
    });
    expect(remote?.items.map(item => item.id)).toEqual(['REAL-CELL']);
    expect(listChecklist('0.3.10')).toEqual(before);
  } finally {
    resetElanousConfigDir();
    rmSync(dir, { recursive: true, force: true });
  }
});
