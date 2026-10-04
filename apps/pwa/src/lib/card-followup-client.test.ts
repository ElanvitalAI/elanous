import { afterEach, expect, test } from 'bun:test';
import { CARD_FOLLOWUP_MAX_AGE_MS, CARD_FOLLOWUP_STORAGE_KEY, forgetCardFollowup, isCardRequest, readPendingCardFollowups, rememberCardFollowup, startCardFollowup, waitCardFollowup } from './card-followup-client';
import type { AttachmentMeta } from './upload-attachment';
import type { DaemonClient } from './daemon-client';

const image: AttachmentMeta = { id: 'photo', filename: 'card.jpg', mediaType: 'image/jpeg', size: 1, downloadUrl: '/photo' };
const pdf: AttachmentMeta = { ...image, id: 'pdf', mediaType: 'application/pdf' };
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const realNow = Date.now;
const realSetTimeout = globalThis.setTimeout;
afterEach(() => {
  Date.now = realNow;
  globalThis.setTimeout = realSetTimeout;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete (globalThis as { document?: Document }).document;
});

test('pending ids are conversation-scoped, expire at 15 minutes and never persist card contents', () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  const now = 2_000_000;
  expect(CARD_FOLLOWUP_MAX_AGE_MS).toBe(15 * 60 * 1000);
  rememberCardFollowup(storage, { sessionId: 'a', id: 'job-a', startedAt: now - 15 * 60 * 1000 + 1 }, now);
  rememberCardFollowup(storage, { sessionId: 'b', id: 'job-b', startedAt: now }, now);
  expect(readPendingCardFollowups(storage, 'a', now)).toEqual([{ sessionId: 'a', id: 'job-a', startedAt: now - 15 * 60 * 1000 + 1 }]);
  expect(readPendingCardFollowups(storage, 'a', now + 1)).toEqual([]);
  expect(readPendingCardFollowups(storage, 'b', now + 1)).toEqual([{ sessionId: 'b', id: 'job-b', startedAt: now }]);
  expect(JSON.parse(data.get(CARD_FOLLOWUP_STORAGE_KEY)!)).toEqual([{ sessionId: 'b', id: 'job-b', startedAt: now }]);
  forgetCardFollowup(storage, 'a', 'job-b', now + 1);
  expect(readPendingCardFollowups(storage, 'b', now + 1)).toHaveLength(1);
  forgetCardFollowup(storage, 'b', 'job-b', now + 1);
  expect(data.has(CARD_FOLLOWUP_STORAGE_KEY)).toBe(false);
  storage.setItem(CARD_FOLLOWUP_STORAGE_KEY, '{broken');
  expect(readPendingCardFollowups(storage, 'a', now)).toEqual([]);
});

test('only one image with empty or keyword-only text enters card path; preserves context', () => {
  expect(isCardRequest('', [image])).toEqual({ ok: true, attachmentId: 'photo' });
  expect(isCardRequest(' \n ', [image])).toEqual({ ok: true, attachmentId: 'photo' });
  expect(isCardRequest(' 명함 전략, CRM 메일 초안 ', [image])).toEqual({ ok: true, attachmentId: 'photo', context: '명함 전략, CRM 메일 초안' });
  expect(isCardRequest('crm,메일초안', [image])).toEqual({ ok: true, attachmentId: 'photo', context: 'crm,메일초안' });
  for (const [text, files] of [['이 사진 뭐야', [image]], ['', [image, image]], ['', [pdf]], ['', [image, pdf]], ['', []], ['명함 보내줘', [image]]] as const) {
    expect(isCardRequest(text, files)).toEqual({ ok: false });
  }
});

test('start posts attachment id and optional context to injected daemon client; rejects HTTP error', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = { fetchResponse: async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return new Response(JSON.stringify({ id: 'job-1' }), { status: 202 });
  } } as Pick<DaemonClient, 'fetchResponse'>;
  expect(await startCardFollowup(client, 'photo')).toBe('job-1');
  expect(await startCardFollowup(client, 'photo', '전략')).toBe('job-1');
  expect(calls.map(({ path, init }) => [path, init?.method, JSON.parse(String(init?.body))])).toEqual([
    ['/v1/card-followup', 'POST', { attachmentId: 'photo' }],
    ['/v1/card-followup', 'POST', { attachmentId: 'photo', context: '전략' }],
  ]);
  await expect(startCardFollowup({ fetchResponse: async () => new Response('', { status: 400 }) } as Pick<DaemonClient, 'fetchResponse'>, 'bad')).rejects.toThrow('400');
});

test('poll returns terminal statuses and reports intermediate phases', async () => {
  const statuses = ['judging', 'running', 'done'] as const;
  const paths: string[] = [];
  const events: string[] = [];
  const client = { fetchResponse: async (path: string) => {
    paths.push(path);
    const status = statuses[paths.length - 1];
    return Response.json({ status, ...(status === 'done' ? { replies: ['①요약', '②전략', '③초안'] } : {}) });
  } } as Pick<DaemonClient, 'fetchResponse'>;
  expect(await waitCardFollowup(client, 'job/1', { intervalMs: 0, onStatus: (status) => events.push(status) })).toEqual({ status: 'done', replies: ['①요약', '②전략', '③초안'] });
  expect(paths).toEqual(Array(3).fill('/v1/card-followup/job%2F1'));
  expect(events).toEqual([...statuses]);
  for (const status of ['not-card', 'failed'] as const) {
    expect(await waitCardFollowup({ fetchResponse: async () => Response.json({ status }) } as Pick<DaemonClient, 'fetchResponse'>, 'job')).toEqual({ status });
  }
});

test('start passes abort signal to the injected POST', async () => {
  const controller = new AbortController();
  let received: AbortSignal | null | undefined;
  const client = { fetchResponse: async (_path: string, init?: RequestInit) => {
    received = init?.signal;
    return Response.json({ id: 'job' }, { status: 202 });
  } } as Pick<DaemonClient, 'fetchResponse'>;
  expect(await startCardFollowup(client, 'photo', undefined, controller.signal)).toBe('job');
  expect(received).toBe(controller.signal);
});

test('abort stops a hidden-tab wait without issuing a GET', async () => {
  const page = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: page });
  const controller = new AbortController();
  let gets = 0;
  const client = { fetchResponse: async () => { gets++; return Response.json({ status: 'done' }); } } as Pick<DaemonClient, 'fetchResponse'>;
  const result = waitCardFollowup(client, 'job', { signal: controller.signal });
  controller.abort();
  await expect(result).rejects.toThrow();
  page.visibilityState = 'visible';
  page.dispatchEvent(new Event('visibilitychange'));
  expect(gets).toBe(0);
});

test('hidden tab performs zero GETs until visible, then resumes', async () => {
  const document = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  let gets = 0;
  const client = { fetchResponse: async () => { gets++; return Response.json({ status: 'not-card' }); } } as Pick<DaemonClient, 'fetchResponse'>;
  const result = waitCardFollowup(client, 'job', { intervalMs: 0 });
  await Promise.resolve();
  expect(gets).toBe(0);
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  expect(await result).toEqual({ status: 'not-card' });
  expect(gets).toBe(1);
});

test('ten minute ceiling fails even when GET remains running', async () => {
  let now = 100;
  Date.now = () => now;
  const client = { fetchResponse: async () => { now += 10 * 60 * 1000; return Response.json({ status: 'running' }); } } as Pick<DaemonClient, 'fetchResponse'>;
  const statuses: string[] = [];
  expect(await waitCardFollowup(client, 'job', { intervalMs: 0, onStatus: (status) => statuses.push(status) })).toEqual({ status: 'failed' });
  expect(statuses).toEqual(['running', 'failed']);
});

test('ten minute wall clock cap aborts a stalled GET and returns failed', async () => {
  let advance!: () => void;
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    if (ms === 10 * 60 * 1000) advance = fn;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  let pollSignal: AbortSignal | undefined;
  const client = { fetchResponse: async (_path: string, init: RequestInit) => {
    pollSignal = init.signal as AbortSignal;
    return new Promise<Response>(() => {});
  } } as Pick<DaemonClient, 'fetchResponse'>;
  const result = waitCardFollowup(client, 'job');
  expect(pollSignal?.aborted).toBe(false);
  advance();
  expect(await result).toEqual({ status: 'failed' });
  expect(pollSignal?.aborted).toBe(true);
});
