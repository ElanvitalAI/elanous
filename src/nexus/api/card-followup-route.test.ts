import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultAttachmentBaseDir, resolveAttachmentPath } from '../../boot/attachment-store.js';
import { NotACardError } from '../../card-followup/core.js';
import { debug } from '../../debug/log.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { createCardFollowupJobs, type CardFollowupJobs } from './card-followup-route.js';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const auth = { authorization: 'Bearer owner-token' };
const replies: [string, string, string] = ['요약', '전략', '초안'];
function fixture(deps: Parameters<typeof createCardFollowupJobs>[0] = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'card-followup-api-'));
  roots.push(rootDir);
  const jobs = createCardFollowupJobs({ rootDir, resolveAttachment: id => id === 'att-valid-1234' ? join(rootDir, 'photo.jpg') : null,
    ocr: async () => '비밀 명함 글', detect: () => ({ decision: 'card', signal: 'test' }),
    run: async () => ({ replies }), now: () => 1234, ...deps });
  return { rootDir, jobs };
}
function dispatch(jobs: CardFollowupJobs, path: string, init: RequestInit = {}) {
  const opts = { metaApi: { bearerToken: 'owner-token', noAuth: false }, cardFollowup: jobs } as unknown as NexusHttpServerOpts;
  return routeRequest(new Request(`http://nexus.test${path}`, init), opts, {} as never, null, createDevProxyRuntimeRef());
}
function post(jobs: CardFollowupJobs, attachmentId: unknown = 'att-valid-1234', context?: string) {
  return dispatch(jobs, '/v1/card-followup', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ attachmentId, ...(context ? { context } : {}) }) });
}
async function poll(jobs: CardFollowupJobs, id: string) {
  const response = await dispatch(jobs, `/v1/card-followup/${id}`, { headers: auth });
  return { response, body: await response?.json() as { id: string; status: string; replies?: string[]; error?: string } };
}
async function until(jobs: CardFollowupJobs, id: string, status: string) {
  for (let i = 0; i < 100; i++) {
    const result = await poll(jobs, id);
    if (result.body.status === status) return result;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error(`job did not reach ${status}`);
}

test('POST 202 → judging → running → done with three replies, context and private ledger', async () => {
  let releaseOcr!: (text: string) => void;
  let releaseRun!: (value: { replies: [string, string, string] }) => void;
  const ocr = new Promise<string>(resolve => { releaseOcr = resolve; });
  const run = new Promise<{ replies: [string, string, string] }>(resolve => { releaseRun = resolve; });
  const calls: unknown[] = [];
  const { jobs, rootDir } = fixture({ ocr: async () => ocr, detect: input => { calls.push(input); return { decision: 'card', signal: 'test' }; },
    run: async input => { calls.push(input); return run; } });
  const response = await post(jobs, 'att-valid-1234', '연락 맥락');
  expect(response?.status).toBe(202);
  const { id } = await response!.json() as { id: string };
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect((await poll(jobs, id)).body.status).toBe('judging');
  releaseOcr('비밀 명함 글');
  expect((await until(jobs, id, 'running')).body.status).toBe('running');
  expect(calls).toEqual([{ ocrText: '비밀 명함 글' }, { imagePath: join(rootDir, 'photo.jpg'), ocrText: '비밀 명함 글', rootDir, runId: id, context: '연락 맥락' }]);
  releaseRun({ replies });
  expect((await until(jobs, id, 'done')).body).toEqual({ id, status: 'done', replies });
  const path = join(rootDir, 'graph-runs', 'card-followup', `${id}.pwa.json`);
  expect(statSync(join(rootDir, 'graph-runs', 'card-followup')).mode & 0o777).toBe(0o700);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ id, status: 'done', replies });
  const events = debug.events(100).filter(e => e.category === 'card-followup.pwa' && (e.data as { id?: string } | undefined)?.id === id);
  expect(events.map(e => e.event)).toEqual(['started', 'done']);
  expect(JSON.stringify(events)).not.toContain('비밀 명함 글');
});

test('POST responds before background OCR begins', async () => {
  let ocrCalls = 0;
  const { jobs } = fixture({ ocr: async () => { ocrCalls++; return '비밀 명함 글'; } });
  const response = await post(jobs);
  expect(response?.status).toBe(202);
  expect(ocrCalls).toBe(0);
  const { id } = await response!.json() as { id: string };
  expect((await until(jobs, id, 'done')).body).toEqual({ id, status: 'done', replies });
  expect(ocrCalls).toBe(1);
});

test('non-card detection and NotACardError both resolve as not-card without calling graph unnecessarily', async () => {
  let graphCalls = 0;
  for (const decision of ['skip', 'ambiguous'] as const) {
    const { jobs } = fixture({ detect: () => ({ decision, signal: 'test' }), run: async () => { graphCalls++; return { replies }; } });
    const first = await post(jobs);
    const id = (await first!.json() as { id: string }).id;
    expect((await until(jobs, id, 'not-card')).body).toMatchObject({ id, status: 'not-card' });
  }
  expect(graphCalls).toBe(0);
  const { jobs: second } = fixture({ run: async () => { throw new NotACardError('not a card'); } });
  const nextId = (await (await post(second))!.json() as { id: string }).id;
  expect((await until(second, nextId, 'not-card')).body).toMatchObject({ id: nextId, status: 'not-card' });
  expect(debug.events(100).filter(e => e.category === 'card-followup.pwa' && (e.data as { id?: string } | undefined)?.id === nextId).map(e => e.event)).toEqual(['started', 'not-card']);
});

test('unexpected graph failure stores a fixed error code, never the exception text (it may carry card text)', async () => {
  const firstLine = `비밀 명함 글${'x'.repeat(210)}`;
  const { jobs, rootDir } = fixture({ run: async () => { throw new Error(`${firstLine}\n다른 상세`); } });
  const id = (await (await post(jobs))!.json() as { id: string }).id;
  const result = await until(jobs, id, 'failed');
  expect(result.body).toEqual({ id, status: 'failed', error: 'card-followup-failed' });
  const ledger = readFileSync(join(rootDir, 'graph-runs', 'card-followup', `${id}.pwa.json`), 'utf8');
  expect(JSON.parse(ledger)).toMatchObject({ id, status: 'failed', error: 'card-followup-failed' });
  expect(ledger).not.toContain('비밀 명함 글');
  expect(ledger).not.toContain('다른 상세');
  const events = debug.events(100).filter(e => e.category === 'card-followup.pwa' && (e.data as { id?: string } | undefined)?.id === id);
  expect(events.map(e => e.event)).toEqual(['started', 'failed']);
  expect(JSON.stringify(events)).not.toContain('비밀 명함 글');
});

test('repeated ledger write failures settle as failed without an unhandled background rejection', async () => {
  let releaseOcr!: (text: string) => void;
  const ocr = new Promise<string>(resolve => { releaseOcr = resolve; });
  const { jobs, rootDir } = fixture({ ocr: async () => ocr });
  const response = await post(jobs);
  expect(response?.status).toBe(202);
  const { id } = await response!.json() as { id: string };
  const base = join(rootDir, 'graph-runs', 'card-followup');
  const parked = join(rootDir, 'parked-ledger');
  renameSync(base, parked);
  writeFileSync(base, 'blocked');
  try {
    releaseOcr('비밀 명함 글');
    for (let i = 0; i < 100; i++) {
      if (debug.events(100).some(e => e.category === 'card-followup.pwa' && e.event === 'failed' && (e.data as { id?: string } | undefined)?.id === id)) break;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    expect(debug.events(100).filter(e => e.category === 'card-followup.pwa' && (e.data as { id?: string } | undefined)?.id === id).map(e => e.event)).toEqual(['started', 'failed']);
    expect((await poll(jobs, id)).body).toEqual({ id, status: 'failed', error: 'card-followup-failed' });
  } finally {
    rmSync(base);
    renameSync(parked, base);
  }
  expect((await poll(jobs, id)).body).toEqual({ id, status: 'failed', error: 'card-followup-failed' });
  expect(JSON.parse(readFileSync(join(base, `${id}.pwa.json`), 'utf8')).status).toBe('judging');
});

test('invalid attachment cannot launch OCR, nonexistent job is 404, GET and POST are owner-only', async () => {
  let ocrCalls = 0;
  const { jobs } = fixture({ ocr: async () => { ocrCalls++; return null; } });
  expect((await post(jobs, '../outside'))?.status).toBe(400);
  expect(await (await post(jobs, '../outside'))?.json()).toEqual({ error: 'attachment-not-found' });
  expect(ocrCalls).toBe(0);
  expect((await dispatch(jobs, '/v1/card-followup', { method: 'POST', body: JSON.stringify({ attachmentId: 'att-valid-1234' }) }))?.status).toBe(401);
  expect((await dispatch(jobs, '/v1/card-followup/550e8400-e29b-41d4-a716-446655440000'))?.status).toBe(401);
  expect((await poll(jobs, '550e8400-e29b-41d4-a716-446655440000')).response?.status).toBe(404);
  expect((await poll(jobs, '../outside')).response?.status).toBe(404);
  expect((await dispatch(jobs, '/v1/card-followup/550e8400-e29b-41d4-a716-446655440000/extra', { headers: auth }))?.status).toBe(404);
  expect(ocrCalls).toBe(0);
});

test('default attachment resolver rejects paths outside the upload store before OCR', async () => {
  let ocrCalls = 0;
  const { jobs } = fixture({ resolveAttachment: resolveAttachmentPath, ocr: async () => { ocrCalls++; return null; } });
  const response = await post(jobs, '../outside');
  expect(response?.status).toBe(400);
  expect(await response?.json()).toEqual({ error: 'attachment-not-found' });
  expect(ocrCalls).toBe(0);
});

test('default resolver rejects a symlinked upload leading outside the attachment folder', async () => {
  let ocrCalls = 0;
  const { jobs, rootDir } = fixture({ resolveAttachment: resolveAttachmentPath, ocr: async () => { ocrCalls++; return null; } });
  const outside = join(rootDir, 'outside.jpg');
  writeFileSync(outside, 'outside');
  mkdirSync(defaultAttachmentBaseDir(), { recursive: true });
  const id = `att-card${Math.random().toString(36).slice(2)}-1234`;
  const link = join(defaultAttachmentBaseDir(), `${id}-photo.jpg`);
  symlinkSync(outside, link);
  try {
    const response = await post(jobs, id);
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: 'attachment-not-found' });
    expect(ocrCalls).toBe(0);
  } finally { rmSync(link, { force: true }); }
});

test('a running ledger from another daemon is read as daemon-restarted without altering disk', async () => {
  const { jobs, rootDir } = fixture();
  const id = '550e8400-e29b-41d4-a716-446655440000';
  const path = join(rootDir, 'graph-runs', 'card-followup', `${id}.pwa.json`);
  mkdirSync(join(rootDir, 'graph-runs', 'card-followup'), { recursive: true });
  writeFileSync(path, JSON.stringify({ id, status: 'running', updatedAt: 1234 }));
  expect((await poll(jobs, id)).body).toEqual({ id, status: 'failed', error: 'daemon-restarted' });
  expect(JSON.parse(readFileSync(path, 'utf8')).status).toBe('running');
  writeFileSync(path, JSON.stringify({ id, status: 'judging', updatedAt: 1234 }));
  expect((await poll(jobs, id)).body).toEqual({ id, status: 'failed', error: 'daemon-restarted' });
});
