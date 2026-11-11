import { afterAll, expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRemoteChecklist, requestChecklistClaim } from './release-checklist-remote.js';
import { checklistOutput } from './release-checklist-read-cli.js';
import type { Checklist } from '../release-loop/checklist.js';
import { createFakeFetchDevice } from '../ux-sim/fake-fetch.js';

const root = mkdtempSync(join(tmpdir(), 'seat-self-serve-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const snapshot: Checklist = { version: '0.3.10', released: '0.3.9', dev: '0.3.10', history: [], items: [
  { id: 'CELL-A', title: 'Remote work', status: 'yellow', updatedAt: '2026-11-11T00:00:00Z', updatedBy: 'OP' },
  { id: 'CELL-B', title: 'Taken', status: 'yellow', owner: 'TC', updatedAt: '2026-11-11T00:00:00Z', updatedBy: 'OP' },
] };

test('nineteen remote tabs read the same authenticated HQ snapshot without local items=[]', async () => {
  const tokenFile = join(root, 'nexus-token');
  writeFileSync(tokenFile, 'private-token\n', { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  const calls: Array<{ url: string; token: string | null }> = [];
  const fakeFetch = async (input: URL, init: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), token: new Headers(init?.headers).get('authorization') });
    return Response.json(snapshot);
  };
  const results = await Promise.all(Array.from({ length: 19 }, () => readRemoteChecklist('0.3.10', {
    url: 'https://mbp.tailnet-example.ts.net:31415', tokenFile, fetch: fakeFetch,
  })));
  expect(results.every(result => result?.items.length === snapshot.items.length)).toBe(true);
  expect(calls).toHaveLength(19);
  expect(calls.every(call => call.token === 'Bearer private-token' && call.url.endsWith('/v1/release/checklist?version=0.3.10'))).toBe(true);
});

test('remote read fails closed on missing/private-token, auth and malformed snapshot', async () => {
  const tokenFile = join(root, 'bad-token');
  writeFileSync(tokenFile, 'private-token', { mode: 0o600 });
  chmodSync(tokenFile, 0o644);
  await expect(readRemoteChecklist('0.3.10', { url: 'https://nexus.test', tokenFile })).rejects.toThrow('not private');
  chmodSync(tokenFile, 0o600);
  await expect(readRemoteChecklist('0.3.10', { url: 'http://remote.test', tokenFile })).rejects.toThrow('HTTPS');
  await expect(readRemoteChecklist('0.3.10', { url: 'https://nexus.test', tokenFile, fetch: async () => new Response('', { status: 401 }) })).rejects.toThrow('HTTP 401');
  await expect(readRemoteChecklist('0.3.10', { url: 'https://nexus.test', tokenFile, fetch: async () => Response.json({ version: '0.3.10', items: [] }) })).rejects.toThrow('invalid snapshot');
  for (const invalid of [
    { ...snapshot, released: undefined },
    { ...snapshot, items: [{ ...snapshot.items[0], owner: 0 }] },
    { ...snapshot, items: [{ ...snapshot.items[0], status: 'unknown' }] },
    { ...snapshot, items: [{ ...snapshot.items[0], status: ['yellow'] }] },
    { ...snapshot, items: [{ ...snapshot.items[0], priority: ['P0'] }] },
  ]) {
    await expect(readRemoteChecklist('0.3.10', { url: 'https://nexus.test', tokenFile, fetch: async () => Response.json(invalid) })).rejects.toThrow('invalid snapshot');
  }
});

test('claim request sends OP mail only for an unowned yellow cell', () => {
  const sent: Array<{ from: string; body: string }> = [];
  const post = (from: string, body: string) => { sent.push({ from, body }); };
  requestChecklistClaim(snapshot, 'CELL-A', 'R-PROXY', post);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ from: 'R-PROXY', body: expect.stringContaining('0.3.10 CELL-A') });
  expect(() => requestChecklistClaim(snapshot, 'CELL-B', 'R-PROXY', post)).toThrow('not available');
  expect(() => requestChecklistClaim(snapshot, 'MISSING', 'R-PROXY', post)).toThrow('not found');
  expect(sent).toHaveLength(1);
});

test('release checklist status renders the remote board when the local host has no cells', async () => {
  const tokenFile = join(root, 'cli-token');
  writeFileSync(tokenFile, 'private-token', { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  const oldUrl = process.env.ELANOUS_NEXUS_URL;
  const oldFile = process.env.ELANOUS_NEXUS_TOKEN_FILE;
  process.env.ELANOUS_NEXUS_URL = 'https://mbp.tailnet-example.ts.net:31415';
  process.env.ELANOUS_NEXUS_TOKEN_FILE = tokenFile;
  const device = createFakeFetchDevice([{ url: '/v1/release/checklist', response: Response.json(snapshot) }]);
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')); });
  try {
    await checklistOutput('0.3.10', {}, 'status', false);
    expect(lines.join('\n')).toContain('🟡 2');
    expect(device.calls()).toHaveLength(1);
  } finally {
    log.mockRestore();
    device.restore();
    if (oldUrl === undefined) delete process.env.ELANOUS_NEXUS_URL; else process.env.ELANOUS_NEXUS_URL = oldUrl;
    if (oldFile === undefined) delete process.env.ELANOUS_NEXUS_TOKEN_FILE; else process.env.ELANOUS_NEXUS_TOKEN_FILE = oldFile;
  }
});
