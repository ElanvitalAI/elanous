import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AppJobError, createAppJobLedger, createAppJobs, createAppJobsGenerateAction, handleAppJobRequest,
  type AppGenerationBackend,
} from './app-jobs.js';
import { createAppActions } from './app-actions.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(options: { notify?: (event: { appSlug: string; jobId: string; status: 'completed' | 'failed'; resultKey?: string }) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'app-jobs-'));
  roots.push(root);
  const ledger = createAppJobLedger(join(root, 'jobs.sqlite'));
  let nextId = 0;
  const jobs = createAppJobs({
    ledger, pollIntervalMs: 0, id: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
    now: () => new Date('2026-11-07T00:00:00.000Z'),
    saveResult: async ({ appSlug, jobId, url }) => url === 'https://cdn.higgsfield.ai/result.mp4'
      ? { key: `apps/${appSlug}/generated/${jobId}.mp4` } : undefined,
    ...(options.notify ? { notify: options.notify } : {}),
  });
  return { root, ledger, jobs };
}

async function terminalStatus(jobs: ReturnType<typeof createAppJobs>, appSlug: string, jobId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = jobs.get({ appSlug, jobId });
    if (job?.status === 'completed' || job?.status === 'failed') return job;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('job did not reach a terminal state');
}

function completedBackend(): AppGenerationBackend {
  return {
    async submit(input) {
      expect(input.prompt).toBe('Create an editorial product clip');
      expect(input.image).toEqual(new Uint8Array([1, 2, 3]));
      expect(input.mimeType).toBe('image/png');
      return 'provider-request-1';
    },
    async poll(id) {
      expect(id).toBe('provider-request-1');
      return { status: 'completed', resultUrl: 'https://cdn.higgsfield.ai/result.mp4' };
    },
  };
}

test('SIM-FAKE-HIGGSFIELD: app generation persists metadata, stores result, emits SSE events, and notifies without payload leakage', async () => {
  const notifications: unknown[] = [];
  const { ledger, jobs, root } = fixture({ notify: event => { notifications.push(event); } });
  const actions = createAppActions({
    secrets: { async resolve({ reference }) { return reference.endsWith('key_id') ? 'sim-key-id' : 'sim-key-secret'; } },
    readImageObject: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }),
    generate: createAppJobsGenerateAction({ jobs, ledger, backendForCredentials: () => completedBackend() }),
  });
  const queued = await actions.run({
    appSlug: 'shop-studio', actionName: 'makeAd',
    declaration: { builtin: 'generate', async: true, spend: 'owner-confirm', uses: ['cred:higgsfield.key_id', 'cred:higgsfield.secret'] },
    payload: { text: 'Create an editorial product clip', image: 'products/input.png', confirmSpend: true },
  });
  expect(queued.status).toBe('queued');
  if (queued.status !== 'queued') throw new Error('expected queued job');
  const jobId = queued.jobId;
  expect(queued.eventsUrl).toBe(`/v1/apps/shop-studio/jobs/${jobId}/events`);
  const complete = await terminalStatus(jobs, 'shop-studio', jobId);
  expect(complete).toMatchObject({ status: 'completed', resultKey: `apps/shop-studio/generated/${jobId}.mp4` });
  expect(ledger.events({ appSlug: 'shop-studio', jobId }).map(event => event.status)).toEqual(['queued', 'running', 'completed']);
  expect(notifications).toEqual([{ appSlug: 'shop-studio', jobId, status: 'completed', resultKey: `apps/shop-studio/generated/${jobId}.mp4` }]);

  const persisted = readFileSync(join(root, 'jobs.sqlite'));
  expect(persisted.toString()).not.toContain('Create an editorial product clip');
  expect(persisted.toString()).not.toContain('provider-request-1');
  expect(JSON.stringify(ledger.events({ appSlug: 'shop-studio', jobId }))).not.toContain('result.mp4');
  jobs.close();
});

test('SIM-FAKE-HIGGSFIELD: generation selects an ephemeral backend from the requesting app credentials', async () => {
  const { ledger, jobs } = fixture();
  const usedCredentials: string[] = [];
  const base = completedBackend();
  const actions = createAppActions({
    secrets: { async resolve({ appSlug, reference }) { return `${appSlug}-${reference.endsWith('key_id') ? 'id' : 'secret'}`; } },
    readImageObject: async () => ({ bytes: new Uint8Array([1]), mimeType: 'image/png' }),
    generate: createAppJobsGenerateAction({ jobs, ledger, backendForCredentials(credentials) {
      usedCredentials.push(`${credentials.keyId}:${credentials.secret}`);
      return base;
    } }),
  });
  await actions.run({ appSlug: 'shop-studio', declaration: {
    builtin: 'generate', async: true, spend: 'owner-confirm', uses: ['cred:higgsfield.key_id', 'cred:higgsfield.secret'],
  }, payload: { text: 'test', image: 'input.png', confirmSpend: true } });
  await actions.run({ appSlug: 'another-app', declaration: {
    builtin: 'generate', async: true, spend: 'owner-confirm', uses: ['cred:higgsfield.key_id', 'cred:higgsfield.secret'],
  }, payload: { text: 'test', image: 'input.png', confirmSpend: true } });
  expect(usedCredentials).toEqual(['shop-studio-id:shop-studio-secret', 'another-app-id:another-app-secret']);
  jobs.close();
});

test('generate jobs reject missing owner confirmation and invalid images before provider submission', () => {
  const { jobs } = fixture();
  let calls = 0;
  const backend: AppGenerationBackend = { async submit() { calls += 1; return 'never'; }, async poll() { return { status: 'queued' }; } };
  expect(() => jobs.submit({ appSlug: 'shop-studio', prompt: 'prompt', image: new Uint8Array([1]), mimeType: 'image/png', backend, ownerConfirmed: false }))
    .toThrow(AppJobError);
  expect(() => jobs.submit({ appSlug: 'shop-studio', prompt: 'prompt', image: new Uint8Array([1]), mimeType: 'text/plain', backend, ownerConfirmed: true }))
    .toThrow(AppJobError);
  expect(calls).toBe(0);
  jobs.close();
});

test('provider and result-storage errors become stable failure codes and cannot leak provider text', async () => {
  const { ledger, jobs } = fixture();
  const backend: AppGenerationBackend = {
    async submit() { return 'provider-request-2'; },
    async poll() { return { status: 'completed', resultUrl: 'https://untrusted.invalid/result.mp4' }; },
  };
  const job = jobs.submit({ appSlug: 'shop-studio', prompt: 'private prompt', image: new Uint8Array([2]), mimeType: 'image/jpeg', backend, ownerConfirmed: true });
  const failed = await terminalStatus(jobs, 'shop-studio', job.id);
  expect(failed).toMatchObject({ status: 'failed', errorCode: 'result-unavailable' });
  expect(JSON.stringify(ledger.events({ appSlug: 'shop-studio', jobId: job.id }))).not.toContain('untrusted.invalid');
  jobs.close();
});

test('interrupted queued and running jobs fail explicitly when the durable worker restarts', () => {
  const root = mkdtempSync(join(tmpdir(), 'app-jobs-restart-'));
  roots.push(root);
  const path = join(root, 'jobs.sqlite');
  const first = createAppJobLedger(path);
  const queuedId = '00000000-0000-4000-8000-000000000011';
  const runningId = '00000000-0000-4000-8000-000000000012';
  first.create({ id: queuedId, appSlug: 'shop-studio', now: '2026-11-07T00:00:00.000Z' });
  first.create({ id: runningId, appSlug: 'shop-studio', now: '2026-11-07T00:00:00.000Z' });
  first.transition({ appSlug: 'shop-studio', jobId: runningId, status: 'running', now: '2026-11-07T00:00:01.000Z' });
  first.close();

  const ledger = createAppJobLedger(path);
  const jobs = createAppJobs({ ledger, saveResult: async () => undefined, now: () => new Date('2026-11-07T00:01:00.000Z') });
  expect(jobs.get({ appSlug: 'shop-studio', jobId: queuedId })).toMatchObject({ status: 'failed', errorCode: 'provider-failed' });
  expect(jobs.get({ appSlug: 'shop-studio', jobId: runningId })).toMatchObject({ status: 'failed', errorCode: 'provider-failed' });
  jobs.close();
});

test('job status and event stream are owner-authorized and scoped to the app slug', async () => {
  const { ledger, jobs } = fixture();
  const backend: AppGenerationBackend = {
    async submit() { return 'provider-request-3'; },
    async poll() { return { status: 'completed', resultUrl: 'https://cdn.higgsfield.ai/result.mp4' }; },
  };
  const job = jobs.submit({ appSlug: 'shop-studio', prompt: 'prompt', image: new Uint8Array([1]), mimeType: 'image/png', backend, ownerConfirmed: true });
  await terminalStatus(jobs, 'shop-studio', job.id);
  const runtime = { jobs, ledger, authorize: (request: Request, slug: string) => request.headers.get('authorization') === `Bearer ${slug}-owner` };
  const unauthorized = await handleAppJobRequest(new Request(`http://nexus.invalid/v1/apps/shop-studio/jobs/${job.id}`), runtime);
  expect(unauthorized?.status).toBe(401);
  const crossApp = await handleAppJobRequest(new Request(`http://nexus.invalid/v1/apps/other-app/jobs/${job.id}`, {
    headers: { authorization: 'Bearer other-app-owner' },
  }), runtime);
  expect(crossApp?.status).toBe(404);
  const status = await handleAppJobRequest(new Request(`http://nexus.invalid/v1/apps/shop-studio/jobs/${job.id}`, {
    headers: { authorization: 'Bearer shop-studio-owner' },
  }), runtime);
  expect(await status?.json()).toMatchObject({ job: { id: job.id, appSlug: 'shop-studio', status: 'completed' } });
  const events = await handleAppJobRequest(new Request(`http://nexus.invalid/v1/apps/shop-studio/jobs/${job.id}/events`, {
    headers: { authorization: 'Bearer shop-studio-owner' },
  }), runtime);
  expect(events?.headers.get('content-type')).toContain('text/event-stream');
  const body = await events?.text();
  expect(body).toContain('event: job');
  expect(body).toContain('"status":"completed"');
  jobs.close();
});

test('SSE rereads events when completion races the first event poll', async () => {
  const jobId = '00000000-0000-4000-8000-000000000021';
  let eventReads = 0;
  const terminalEvent = {
    id: 2, jobId, appSlug: 'shop-studio', status: 'completed' as const,
    occurredAt: '2026-11-07T00:00:01.000Z', resultKey: `apps/shop-studio/generated/${jobId}.mp4`,
  };
  const response = await handleAppJobRequest(new Request(`http://nexus.invalid/v1/apps/shop-studio/jobs/${jobId}/events`, {
    headers: { authorization: 'Bearer shop-studio-owner' },
  }), {
    authorize: () => true,
    jobs: { get: () => ({ id: jobId, appSlug: 'shop-studio', status: 'completed', createdAt: '', updatedAt: '', resultKey: terminalEvent.resultKey }) },
    ledger: { events: () => ++eventReads === 1 ? [] : [terminalEvent] },
  });
  const body = await response?.text();
  expect(eventReads).toBe(2);
  expect(body).toContain('"status":"completed"');
});
