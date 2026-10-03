import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { routeRequest } from './http-server.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { ExecRequestStore } from '../../exec-requests/store.js';
import { ExecRequestRunner } from '../../exec-requests/runner.js';
import { handleExecRequests } from './exec-requests.js';
import type { GraphRunState } from '../../graph-runner/runner.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const wait = async (condition: () => boolean) => {
  for (let i = 0; i < 100; i++) { if (condition()) return; await Bun.sleep(5); }
  throw new Error('background graph run did not finish');
};

test('POST attachments persist from upload and field folders, rejecting missing and escaped paths before creating a request', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'exec-attachments-')));
  roots.push(root);
  const upload = join(root, 'uploads');
  const field = join(root, 'field', 'event');
  const outside = join(root, 'other');
  for (const dir of [upload, field, outside]) mkdirSync(dir, { recursive: true });
  const photo = join(upload, 'photo.png');
  const note = join(field, 'note.txt');
  const secret = join(outside, 'secret.txt');
  writeFileSync(photo, 'photo'); writeFileSync(note, 'field'); writeFileSync(secret, 'secret');
  writeFileSync(join(root, 'uploads-fake.txt'), 'sibling');
  symlinkSync(secret, join(upload, 'escape.txt'));
  const store = new ExecRequestStore(root);
  const runner = new ExecRequestRunner({ store, root, graphs: async () => [], plan: async () => [] });
  const post = (attachments?: unknown) => handleExecRequests(new Request('http://localhost/v1/exec-requests', {
    method: 'POST', body: JSON.stringify({ text: '확인', ...(attachments === undefined ? {} : { attachments }) }),
  }), runner, upload, join(root, 'field'));

  for (const invalid of [secret, join(upload, 'escape.txt'), join(upload, '..', 'other', 'secret.txt'),
    join(upload, 'missing.txt'), field, join(root, 'uploads-fake.txt'), 'photo.png']) {
    const before = store.list().length;
    const response = await post([{ name: 'okay', path: photo }, { name: 'bad', path: invalid }]);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'attachment-outside' });
    expect(store.list()).toHaveLength(before);
  }
  expect((await post([{ name: 'bad' }])).status).toBe(400);
  expect((await post({ name: 'bad', path: photo })).status).toBe(400);
  expect(store.list()).toHaveLength(0);

  const accepted = await post([{ name: '촬영', path: photo }, { name: '메모', path: note }]);
  expect(accepted.status).toBe(202);
  const { id } = await accepted.json() as { id: string };
  const expected = [{ name: '촬영', path: realpathSync(photo) }, { name: '메모', path: realpathSync(note) }];
  expect(new ExecRequestStore(root).get(id)?.attachments).toEqual(expected);
  const detail = await handleExecRequests(new Request(`http://localhost/v1/exec-requests/${id}`), runner, upload, join(root, 'field'));
  expect((await detail.json() as { attachments: unknown }).attachments).toEqual(expected);
  const without = await post();
  const plain = await without.json() as { id: string };
  expect(new ExecRequestStore(root).get(plain.id)?.attachments).toBeUndefined();
});

test('HTTP owner contract: 202 planning, recent list, detail results, bearer-only bytes, and anonymous 401', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'exec-api-')));
  roots.push(root);
  const store = new ExecRequestStore(root);
  const runner = new ExecRequestRunner({ store, root,
    graphs: async () => [{ id: 'actual', title: 'actual', description: '', path: join(root, 'actual.yaml') }],
    plan: async () => [{ seat: 'CMO', title: '한 장', graphId: 'actual', inputs: {} }],
    run: (async (_path: string, opts: { runId: string; deps: { root: string } }) => {
      const dir = join(opts.deps.root, 'graph-runs', 'actual');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${opts.runId}.json.임원 보고 한 장.pdf`);
      writeFileSync(path, '%PDF-real-graph');
      const state: GraphRunState = { graphId: 'actual', runId: opts.runId, status: 'done', path: ['make'],
        nodes: [{ nodeId: 'make', ok: true, exit: 0, executed: true, output: JSON.stringify({ artifacts: [
          { file: path, title: '한 장' }, { url: 'https://example.org/verified', title: '원본' },
        ] }) }],
        executed: 1, dryRun: false, statePath: join(dir, `${opts.runId}.json`) };
      writeFileSync(state.statePath, JSON.stringify(state));
      return state;
    }) as typeof import('../../graph-runner/runner.js').runGraph,
  });
  const bus = new NexusEventBus();
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  state.bus = bus;
  const opts = { state, registry: new TabRegistry(state), eventBus: bus,
    metaApi: { bearerToken: 'owner-secret', noAuth: false }, execRequests: runner };
  const call = (path: string, method = 'GET', body?: unknown, auth: 'owner' | 'same-origin' | 'none' = 'owner') => routeRequest(
    new Request(`http://localhost${path}`, { method,
      headers: new Headers(auth === 'owner' ? { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' }
        : auth === 'same-origin' ? { origin: 'http://localhost', 'sec-fetch-site': 'same-origin' } : { 'sec-fetch-site': 'cross-site' }),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }), opts, { requestIP: () => ({ address: auth === 'same-origin' ? '127.0.0.1' : '203.0.113.1' }) } as never,
    null, createDevProxyRuntimeRef());
  for (const path of ['/v1/exec-requests', '/v1/exec-requests/missing', '/v1/exec-requests/missing/files/one.pdf']) {
    expect((await call(path, 'GET', undefined, 'none'))?.status).toBe(401);
  }
  expect((await call('/v1/exec-requests', 'POST', { text: '한 줄' }, 'none'))?.status).toBe(401);
  expect((await call('/v1/exec-requests', 'POST', { text: '' }))?.status).toBe(400);
  const response = await call('/v1/exec-requests', 'POST', { text: '한 줄' });
  expect(response?.status).toBe(202);
  const accepted = await response!.json() as { id: string; status: string };
  expect(accepted.status).toBe('planning');
  await wait(() => store.get(accepted.id)?.status === 'done');
  const list = await (await call('/v1/exec-requests'))!.json() as { items: Array<Record<string, unknown>> };
  expect(list.items[0]).toEqual({ id: accepted.id, text: '한 줄', createdAt: expect.any(String), status: 'done',
    seats: [{ seat: 'CMO', title: '한 장', status: 'done' }], resultCount: 2 });
  const detail = await (await call(`/v1/exec-requests/${accepted.id}`))!.json() as { results: Array<{ seat: string; kind: string; title: string; url: string }> };
  expect(detail.results[0]?.seat).toBe('CMO');
  expect(detail.results[0]?.kind).toBe('pdf');
  expect(detail.results[0]?.title).toBe('한 장');
  expect(detail.results[1]).toEqual({ seat: 'CMO', kind: 'link', title: '원본', url: 'https://example.org/verified' });
  const runId = store.get(accepted.id)!.seats[0]!.runId;
  const filePath = join(root, 'graph-runs', 'actual', `${runId}.json.임원 보고 한 장.pdf`);
  const fileName = `${runId}--${createHash('sha256').update(filePath).digest('hex')}--${runId}.json.임원 보고 한 장.pdf`;
  expect(detail.results[0]?.url).toBe(`/v1/exec-requests/${accepted.id}/files/${encodeURIComponent(fileName)}`);
  expect((await call(detail.results[0]!.url, 'GET', undefined, 'none'))?.status).toBe(401);
  expect((await call(detail.results[0]!.url, 'GET', undefined, 'same-origin'))?.status).toBe(401);
  const bytes = await call(detail.results[0]!.url);
  expect(bytes?.headers.get('content-type')).toBe('application/pdf');
  expect(await bytes?.text()).toBe('%PDF-real-graph');
  expect((await call(`/v1/exec-requests/${accepted.id}/files/other.pdf`))?.status).toBe(404);
  expect((await call('/v1/graphs', 'GET', undefined, 'none'))?.status).toBe(401);
  expect((await call('/v1/graphs'))?.status).toBe(200);
  expect((await call('/v1/health', 'GET', undefined, 'none'))?.status).toBe(200);
});
