import { expect, test, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listOutputs, type OutputEntry } from '../../outputs/ledger.js';
import { debug } from '../../debug/log.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';
import { handleOutputsGet } from './outputs-route.js';
import { isPublicRoute } from './public-routes.js';

const req = (query = '') => new Request(`http://nexus.test/v1/outputs${query}`);
const rows: OutputEntry[] = [
  { kind: 'report', title: '최근 보고', path: '/private/outputs/recent.md', source: 'exec', sourceId: 'r1', seat: 'OP', at: '2026-10-03T08:00:00Z' },
  { kind: 'file', title: '현장 파일', path: '/private/outputs/clip.mp4', source: 'field-reel', sourceId: 'r2', at: '2026-10-02T08:00:00Z' },
];

test('GET /v1/outputs stays private and reaches the handler through routeRequest', async () => {
  expect(isPublicRoute('GET', '/v1/outputs', { setupMode: false })).toBe(false);
  const opts = { metaApi: { bearerToken: 'owner-token', noAuth: false }, outputs: { list: () => rows } } as NexusHttpServerOpts;
  const dispatch = (request: Request) => routeRequest(request, opts, {} as never, null, createDevProxyRuntimeRef());
  const unauthorized = await dispatch(req());
  expect(unauthorized?.status).toBe(401);
  expect((await dispatch(new Request(req().url, { headers: { authorization: 'Bearer wrong-token' } })))?.status).toBe(401);
  const authorized = await dispatch(new Request(req().url, { headers: { authorization: 'Bearer owner-token' } }));
  expect(authorized?.status).toBe(200);
  expect((await authorized?.json() as { outputs: unknown[] }).outputs).toEqual([
    { kind: 'report', kindLabel: '한 장 보고서', title: '최근 보고', fileName: 'recent.md', source: 'exec', seat: 'OP', at: rows[0]!.at },
    { kind: 'file', kindLabel: '파일', title: '현장 파일', fileName: 'clip.mp4', source: 'field-reel', at: rows[1]!.at },
  ]);
});

test('GET /v1/outputs lists actual ledger rows newest-first despite out-of-order writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-outputs-route-'));
  try {
    mkdirSync(join(root, 'outputs'));
    const oldest: OutputEntry = { kind: 'report', title: '오래된 보고', path: '/private/old.md', source: 'exec', sourceId: 'old', at: '2026-10-01T00:00:00Z' };
    const newest: OutputEntry = { kind: 'file', title: '최신 파일', path: '/private/new.mp4', source: 'field-reel', sourceId: 'new', at: '2026-10-03T00:00:00Z' };
    const middle: OutputEntry = { kind: 'report', title: '중간 보고', path: '/private/middle.md', source: 'exec', sourceId: 'middle', at: '2026-10-02T00:00:00Z' };
    writeFileSync(join(root, 'outputs', 'outputs-2026-10.jsonl'), [oldest, newest, middle].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const opts = {
      metaApi: { bearerToken: 'owner-token', noAuth: false },
      outputs: { list: (filters: Parameters<typeof listOutputs>[0]) => listOutputs(filters, root) },
    } as NexusHttpServerOpts;
    const response = await routeRequest(new Request(req().url, { headers: { authorization: 'Bearer owner-token' } }),
      opts, {} as never, null, createDevProxyRuntimeRef());
    expect(response?.status).toBe(200);
    const body = await response?.json() as { outputs: { at: string; title: string; fileName: string }[] };
    expect(body.outputs.map(({ at }) => at)).toEqual([newest.at, middle.at, oldest.at]);
    expect(body.outputs.map(({ title }) => title)).toEqual(['최신 파일', '중간 보고', '오래된 보고']);
    expect(body.outputs[0]?.fileName).toBe('new.mp4');
    expect(JSON.stringify(body)).not.toContain('/private/');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('limit defaults to 50, accepts 200, and rejects out-of-range or malformed values', async () => {
  const list = mock((_options: { limit?: number }) => rows);
  const deps = { list: list as typeof import('../../outputs/ledger.js').listOutputs };
  await handleOutputsGet(req(), deps);
  expect(list).toHaveBeenLastCalledWith({ limit: 50 });
  await handleOutputsGet(req('?limit=200'), deps);
  expect(list).toHaveBeenLastCalledWith({ limit: 200 });
  for (const value of ['0', '201', '-1', '1.5', 'abc', '01']) {
    expect((await handleOutputsGet(req(`?limit=${value}`), deps)).status).toBe(400);
  }
  expect(list).toHaveBeenCalledTimes(2);
});

test('source is restricted to ledger values; since is ISO and both filters reach list', async () => {
  const list = mock((_options: object) => rows);
  const deps = { list: list as typeof import('../../outputs/ledger.js').listOutputs };
  for (const source of ['exec', 'field-reel', 'field-feed']) {
    expect((await handleOutputsGet(req(`?source=${source}`), deps)).status).toBe(200);
  }
  expect((await handleOutputsGet(req('?source=other'), deps)).status).toBe(400);
  expect((await handleOutputsGet(req('?since=bad'), deps)).status).toBe(400);
  expect((await handleOutputsGet(req('?since=2026-02-30T00%3A00%3A00Z'), deps)).status).toBe(400);
  await handleOutputsGet(req('?source=exec&since=2026-10-01T00%3A00%3A00Z'), deps);
  expect(list).toHaveBeenLastCalledWith({ limit: 50, source: 'exec', since: '2026-10-01T00:00:00.000Z' });
  await handleOutputsGet(req('?since=2026-10-01T09%3A00%3A00%2B09%3A00'), deps);
  expect(list).toHaveBeenLastCalledWith({ limit: 50, since: '2026-10-01T00:00:00.000Z' });
});

test('response preserves ledger order and maps labels, never exposing absolute paths', async () => {
  const response = await handleOutputsGet(req(), { list: () => rows });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ outputs: [
    { kind: 'report', kindLabel: '한 장 보고서', title: '최근 보고', fileName: 'recent.md', source: 'exec', seat: 'OP', at: rows[0]!.at },
    { kind: 'file', kindLabel: '파일', title: '현장 파일', fileName: 'clip.mp4', source: 'field-reel', at: rows[1]!.at },
  ] });
  expect(JSON.stringify(body)).not.toContain('/private/');
});

test('listed observation records the returned count, source and limit', () => {
  handleOutputsGet(req('?source=exec&limit=2'), { list: () => rows.slice(0, 1) });
  expect(debug.events(5)).toContainEqual(expect.objectContaining({
    category: 'outputs.route', event: 'listed', data: expect.objectContaining({ count: 1, source: 'exec', limit: 2 }),
  }));
});

test('url entries expose their link but no file path', async () => {
  const response = await handleOutputsGet(req(), { list: () => [{ ...rows[0]!, path: undefined, url: 'https://example.test/doc' }] });
  expect((await response.json() as { outputs: unknown[] }).outputs[0]).toMatchObject({ url: 'https://example.test/doc' });
});
