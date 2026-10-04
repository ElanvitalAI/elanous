import { afterEach, expect, test } from 'bun:test';
import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { ChatLayout } from './ChatLayout';
import { ChatInput } from './ChatInput';
import { ChatHistory } from './ChatHistory';
import { assertTuiSeatAskRestartContract } from '../../../../../test/seat-ask-tui-restart-contract';
import type { AttachmentMeta } from '@/lib/upload-attachment';
import { CARD_FOLLOWUP_STORAGE_KEY } from '@/lib/card-followup-client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalFetch = globalThis.fetch;
const originalDebug = console.debug;
const originalSetTimeout = globalThis.setTimeout;
let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  console.debug = originalDebug;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: Window }).window;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete (globalThis as { document?: Document }).document;
});
const image: AttachmentMeta = { id: 'image-1', filename: 'card.jpg', mediaType: 'image/jpeg', size: 3, downloadUrl: '/card.jpg' };
const pdf: AttachmentMeta = { ...image, id: 'pdf-1', filename: 'doc.pdf', mediaType: 'application/pdf', path: '/tmp/doc.pdf' };

async function mount(sessionId = 'session-1') {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const streams: Array<{ userText: string; userContent?: unknown[] }> = [];
  const responses: Array<(value: Response) => void> = [];
  const client = {
    voiceWsUrl: () => '', voiceCost: async () => ({}),
    connectAcp: () => { throw new Error('no ACP'); },
    fetchJson: async () => ({ messages: [] }),
    subscribeChatEvents: () => () => {}, subscribeChatFeedbackEvents: () => () => {},
    fetchResponse: (path: string, init?: RequestInit) => {
      if (!path.startsWith('/v1/card-followup')) return Promise.resolve(Response.json({ items: [], decisions: [], seats: [], messages: [] }));
      calls.push({ path, init });
      return new Promise<Response>((resolve) => responses.push(resolve));
    },
    promptStream: async (body: { userText: string; userContent?: unknown[] }) => {
      streams.push(body);
      return { sessionId: 'session-1', text: 'normal reply', stopReason: 'end_turn' };
    },
  };
  globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
  const values = new Map<string, string>();
  const sessionStorage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { sessionStorage, localStorage: sessionStorage, location: { search: '' } }) });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: Object.assign(new EventTarget(), { visibilityState: 'visible' }) });
  function Host() {
    const [activeSessionId, setSessionId] = useState(sessionId || sessionStorage.getItem('elanous.daemon.sessionId') || '');
    return <DaemonContext.Provider value={{ client: client as never, config: { baseUrl: 'http://localhost', token: '', provider: 'anthropic' }, sessionId: activeSessionId, setSessionId: (id) => { sessionStorage.setItem('elanous.daemon.sessionId', id); setSessionId(id); }, setConfig: () => {} }}><ChatLayout /></DaemonContext.Provider>;
  }
  await act(async () => { tree = create(<Host />); });
  const reload = async () => {
    await act(async () => { tree!.unmount(); });
    await act(async () => { tree = create(<Host />); });
  };
  const input = () => tree!.root.findByType(ChatInput);
  const messages = () => tree!.root.findByType(ChatHistory).props.messages as Array<{ role: string; text: string }>;
  const send = async (text: string, attachments: AttachmentMeta[]) => {
    if (attachments.length) await act(async () => { input().props.onAttached(attachments); });
    // Keep the submit pending while the injected POST / GET waits for a test response.
    await act(async () => { void input().props.onSubmit(text); });
  };
  const reply = async (body: object, status = 200) => { await act(async () => { responses.shift()!(Response.json(body, { status })); }); };
  return { calls, streams, messages, send, reply, input, reload, storage: sessionStorage };
}

test('TUI reconnect recovers CTO seat answers and overdue notices', assertTuiSeatAskRestartContract);

test('unmount aborts card polling and prevents further GETs or UI updates', async () => {
  const ui = await mount();
  await ui.send('', [image]);
  await ui.reply({ id: 'job-leave' }, 202);
  expect(ui.calls[1]?.path).toBe('/v1/card-followup/job-leave');
  const signal = ui.calls[1]?.init?.signal as AbortSignal;
  expect(signal.aborted).toBe(false);
  await act(async () => { tree!.unmount(); });
  tree = undefined;
  expect(signal.aborted).toBe(true);
  await ui.reply({ status: 'running' });
  expect(ui.calls).toHaveLength(2);
});

test('unmount during card start aborts POST and skips GET', async () => {
  const ui = await mount();
  await ui.send('', [image]);
  const signal = ui.calls[0]?.init?.signal as AbortSignal;
  expect(signal.aborted).toBe(false);
  await act(async () => { tree!.unmount(); });
  tree = undefined;
  expect(signal.aborted).toBe(true);
  await ui.reply({ id: 'job-leave' }, 202);
  expect(ui.calls).toHaveLength(1);
});

test('card observation contains phases and statuses but never the card text', async () => {
  const logs: unknown[][] = [];
  console.debug = (...args: unknown[]) => { logs.push(args); };
  const ui = await mount();
  await ui.send('CRM 명함', [image]);
  await ui.reply({ id: 'job-log' }, 202);
  await ui.reply({ status: 'done', replies: ['a', 'b', 'c'] });
  const cardLogs = logs.filter((args) => String(args[0]).includes('pwa.chat.card-followup'));
  expect(cardLogs.length).toBeGreaterThan(0);
  expect(JSON.stringify(cardLogs)).not.toContain('CRM 명함');
  expect(JSON.stringify(cardLogs)).toContain('done');
});

test('image-only card shows progress, POSTs id, and replaces progress with three distinct answers', async () => {
  const ui = await mount();
  await ui.send('', [image]);
  expect(ui.calls[0]?.path).toBe('/v1/card-followup');
  expect(JSON.parse(String(ui.calls[0]?.init?.body))).toEqual({ attachmentId: 'image-1' });
  expect(ui.messages().map((m) => m.text)).toContain('명함 읽는 중… 조사 중…');
  await ui.reply({ id: 'job-1' }, 202);
  expect(ui.calls[1]?.path).toBe('/v1/card-followup/job-1');
  await ui.reply({ status: 'done', replies: ['① 요약', '② 전략', '③ 팔로업 초안'] });
  expect(ui.messages().filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual(['① 요약', '② 전략', '③ 팔로업 초안']);
  expect(ui.streams).toHaveLength(0);
});

test('a new conversation adopts an id before submitting, reloads its pending job and displays three answers', async () => {
  const ui = await mount('');
  await ui.send('CRM 명함', [image]);
  const owner = ui.storage.getItem('elanous.daemon.sessionId');
  expect(owner).toBeTruthy();
  expect(ui.calls[0]?.path).toBe('/v1/card-followup');
  await ui.reply({ id: 'job-no-session' }, 202);
  expect(ui.calls[1]?.path).toBe('/v1/card-followup/job-no-session');
  const saved = ui.storage.getItem(CARD_FOLLOWUP_STORAGE_KEY)!;
  expect(JSON.parse(saved)).toEqual([{ sessionId: owner, id: 'job-no-session', startedAt: expect.any(Number) }]);
  expect(saved).not.toContain('CRM 명함');
  await ui.reload();
  expect(ui.messages().map((m) => m.text)).toContain('명함 읽는 중… 조사 중…');
  expect(ui.calls[2]?.path).toBe('/v1/card-followup/job-no-session');
  await ui.reply({ status: 'running' }); // the old, aborted GET resolves without touching the reloaded UI
  await ui.reply({ status: 'done', replies: ['first', 'second', 'third'] });
  expect(ui.messages().filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual(['first', 'second', 'third']);
  expect(ui.storage.getItem(CARD_FOLLOWUP_STORAGE_KEY)).toBeNull();
  expect(ui.streams).toHaveLength(0);
});

test('new card job uses the 15-minute deadline and retains its id until terminal status', async () => {
  const ui = await mount();
  await ui.send('', [image]);
  const timers: number[] = [];
  globalThis.setTimeout = ((fn: () => void, ms: number, ...args: unknown[]) => {
    timers.push(ms);
    return originalSetTimeout(fn, ms, ...args);
  }) as typeof setTimeout;
  await ui.reply({ id: 'job-long' }, 202);
  expect(timers).toContain(15 * 60 * 1000);
  expect(ui.storage.getItem(CARD_FOLLOWUP_STORAGE_KEY)).toContain('job-long');
  await ui.reply({ status: 'done', replies: ['one', 'two', 'three'] });
  expect(ui.storage.getItem(CARD_FOLLOWUP_STORAGE_KEY)).toBeNull();
});

test('keyword context POSTs exactly user text and not-card follows original vision turn with attachment once', async () => {
  const ui = await mount();
  await ui.send('명함 전략', [image]);
  expect(JSON.parse(String(ui.calls[0]?.init?.body))).toEqual({ attachmentId: 'image-1', context: '명함 전략' });
  await ui.reply({ id: 'job-2' }, 202);
  await ui.reply({ status: 'not-card' });
  expect(ui.messages().filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['명함 전략']);
  expect(ui.messages().some((m) => m.text.includes('명함 읽는 중'))).toBe(false);
  expect(ui.streams).toHaveLength(1);
  expect(ui.streams[0]?.userText).toBe('명함 전략');
  expect(ui.streams[0]?.userContent).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image' })]));
});

test('failed response and network error replace progress with retry text', async () => {
  for (const mode of ['failed', 'network'] as const) {
    const ui = await mount();
    await ui.send('', [image]);
    if (mode === 'failed') {
      await ui.reply({ id: 'job-3' }, 202);
      await ui.reply({ status: 'failed' });
      expect(ui.storage.getItem(CARD_FOLLOWUP_STORAGE_KEY)).toBeNull();
    } else await ui.reply({ error: 'unavailable' }, 503);
    expect(ui.messages().filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual(['명함 정리에 실패했습니다 — 다시 보내 주세요']);
    expect(ui.streams).toHaveLength(0);
    await act(async () => { tree!.unmount(); });
    tree = undefined;
  }
});

test('reload resumes only this conversation and attaches exactly three answers without saving card text', async () => {
  const ui = await mount();
  await ui.send('CRM 명함', [image]);
  await ui.reply({ id: 'resume-1' }, 202);
  const saved = ui.storage.getItem(CARD_FOLLOWUP_STORAGE_KEY)!;
  expect(JSON.parse(saved)).toEqual([{ sessionId: 'session-1', id: 'resume-1', startedAt: expect.any(Number) }]);
  expect(saved).not.toContain('CRM 명함');
  expect(saved).not.toContain('card.jpg');
  await act(async () => { tree!.unmount(); });
  tree = undefined;
  const calls: string[] = [];
  let finish!: (response: Response) => void;
  const client = {
    voiceWsUrl: () => '', voiceCost: async () => ({}), connectAcp: () => { throw new Error('no ACP'); },
    fetchJson: async () => ({ messages: [{ role: 'user', content: 'earlier' }] }), subscribeChatEvents: () => () => {}, subscribeChatFeedbackEvents: () => () => {},
    fetchResponse: (path: string) => {
      if (!path.startsWith('/v1/card-followup')) return Promise.resolve(Response.json({ items: [], decisions: [], seats: [] }));
      calls.push(path);
      return new Promise<Response>((resolve) => { finish = resolve; });
    },
  };
  const render = async (sessionId: string) => {
    await act(async () => { tree = create(<DaemonContext.Provider value={{ client: client as never, config: { baseUrl: 'http://localhost', token: '', provider: 'anthropic' }, sessionId, setSessionId: () => {}, setConfig: () => {} }}><ChatLayout /></DaemonContext.Provider>); });
  };
  await render('other');
  expect(calls).toEqual([]);
  expect(tree!.root.findByType(ChatHistory).props.messages.map((m: { text: string }) => m.text)).toEqual(['earlier']);
  await act(async () => { tree!.unmount(); });
  const page = document as Document & { visibilityState: string };
  page.visibilityState = 'hidden';
  await render('session-1');
  expect(calls).toEqual([]);
  expect(tree!.root.findByType(ChatHistory).props.messages.map((m: { text: string }) => m.text)).toEqual(['earlier', '명함 읽는 중… 조사 중…']);
  await act(async () => { page.visibilityState = 'visible'; page.dispatchEvent(new Event('visibilitychange')); });
  expect(calls).toEqual(['/v1/card-followup/resume-1']);
  await act(async () => { finish(Response.json({ status: 'done', replies: ['one', 'two', 'three'] })); });
  expect(tree!.root.findByType(ChatHistory).props.messages.map((m: { text: string }) => m.text)).toEqual(['earlier', 'one', 'two', 'three']);
  expect(ui.storage.getItem(CARD_FOLLOWUP_STORAGE_KEY)).toBeNull();
});

test('fast resumed answers preserve equal-text older history when job identity cannot be proven', async () => {
  const values = new Map([[CARD_FOLLOWUP_STORAGE_KEY, JSON.stringify([{ sessionId: 'session-1', id: 'job-fast', startedAt: Date.now() }])]]);
  const localStorage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { sessionStorage: localStorage, localStorage, location: { search: '' } }) });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: Object.assign(new EventTarget(), { visibilityState: 'visible' }) });
  let finishHistory!: (value: { messages: { role: string; content: string }[] }) => void;
  const client = {
    voiceWsUrl: () => '', voiceCost: async () => ({}), connectAcp: () => { throw new Error('no ACP'); },
    fetchJson: () => new Promise((resolve) => { finishHistory = resolve; }),
    subscribeChatEvents: () => () => {}, subscribeChatFeedbackEvents: () => () => {},
    fetchResponse: async (path: string) => path.startsWith('/v1/card-followup')
      ? Response.json({ status: 'done', replies: ['one', 'two', 'three'] })
      : Response.json({ items: [], seats: [], decisions: [] }),
  };
  await act(async () => { tree = create(<DaemonContext.Provider value={{ client: client as never, config: { baseUrl: 'http://localhost', token: '', provider: 'anthropic' }, sessionId: 'session-1', setSessionId: () => {}, setConfig: () => {} }}><ChatLayout /></DaemonContext.Provider>); });
  const texts = () => tree!.root.findByType(ChatHistory).props.messages.map((m: { text: string }) => m.text);
  expect(texts()).toEqual(['one', 'two', 'three']);
  await act(async () => { finishHistory({ messages: [
    { role: 'user', content: 'earlier' }, { role: 'assistant', content: 'one' },
    { role: 'assistant', content: 'older reply' }, { role: 'assistant', content: 'one' },
    { role: 'assistant', content: 'two' }, { role: 'assistant', content: 'three' },
  ] }); });
  expect(texts()).toEqual(['earlier', 'one', 'older reply', 'one', 'two', 'three', 'one', 'two', 'three']);
  expect(localStorage.getItem(CARD_FOLLOWUP_STORAGE_KEY)).toBeNull();
});

test('expired pending work is removed on open without a GET or a progress bubble', async () => {
  const values = new Map([[CARD_FOLLOWUP_STORAGE_KEY, JSON.stringify([{ sessionId: 'session-1', id: 'old-job', startedAt: Date.now() - 15 * 60 * 1000 }])]]);
  const localStorage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { sessionStorage: localStorage, localStorage, location: { search: '' } }) });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: Object.assign(new EventTarget(), { visibilityState: 'visible' }) });
  const calls: string[] = [];
  const client = {
    voiceWsUrl: () => '', voiceCost: async () => ({}), connectAcp: () => { throw new Error('no ACP'); },
    fetchJson: async () => ({ messages: [] }), subscribeChatEvents: () => () => {}, subscribeChatFeedbackEvents: () => () => {},
    fetchResponse: async (path: string) => { if (path.startsWith('/v1/card-followup')) calls.push(path); return Response.json({ items: [], seats: [], decisions: [] }); },
  };
  await act(async () => { tree = create(<DaemonContext.Provider value={{ client: client as never, config: { baseUrl: 'http://localhost', token: '', provider: 'anthropic' }, sessionId: 'session-1', setSessionId: () => {}, setConfig: () => {} }}><ChatLayout /></DaemonContext.Provider>); });
  expect(calls).toEqual([]);
  expect(tree!.root.findByType(ChatHistory).props.messages).toEqual([]);
  expect(localStorage.getItem(CARD_FOLLOWUP_STORAGE_KEY)).toBeNull();
});

test('changing session in a mounted layout aborts the old GET and cannot show its answers in another conversation', async () => {
  const values = new Map([[CARD_FOLLOWUP_STORAGE_KEY, JSON.stringify([{ sessionId: 'session-1', id: 'job-old', startedAt: Date.now() }])]]);
  const localStorage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { sessionStorage: localStorage, localStorage, location: { search: '' } }) });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: Object.assign(new EventTarget(), { visibilityState: 'visible' }) });
  let select!: (id: string) => void;
  let finish!: (response: Response) => void;
  let signal!: AbortSignal;
  const client = {
    voiceWsUrl: () => '', voiceCost: async () => ({}), connectAcp: () => { throw new Error('no ACP'); },
    fetchJson: async () => ({ messages: [] }), subscribeChatEvents: () => () => {}, subscribeChatFeedbackEvents: () => () => {},
    fetchResponse: (path: string, init?: RequestInit) => {
      if (!path.startsWith('/v1/card-followup')) return Promise.resolve(Response.json({ items: [], seats: [], decisions: [] }));
      signal = init!.signal!;
      return new Promise<Response>((resolve) => { finish = resolve; });
    },
  };
  function Host() {
    const [sessionId, setSessionId] = useState('session-1');
    select = setSessionId;
    return <DaemonContext.Provider value={{ client: client as never, config: { baseUrl: 'http://localhost', token: '', provider: 'anthropic' }, sessionId, setSessionId, setConfig: () => {} }}><ChatLayout /></DaemonContext.Provider>;
  }
  await act(async () => { tree = create(<Host />); });
  expect(signal.aborted).toBe(false);
  await act(async () => { select('other'); });
  expect(signal.aborted).toBe(true);
  expect(tree!.root.findByType(ChatHistory).props.messages).toEqual([]);
  await act(async () => { finish(Response.json({ status: 'done', replies: ['old one', 'old two', 'old three'] })); });
  expect(tree!.root.findByType(ChatHistory).props.messages).toEqual([]);
  expect(localStorage.getItem(CARD_FOLLOWUP_STORAGE_KEY)).not.toBeNull();
});

test('normal text, two images, and PDF do not POST and preserve normal turn', async () => {
  for (const [text, attachments] of [['이 사진 뭐야', [image]], ['', [image, { ...image, id: 'second' }]], ['', [pdf]]] as const) {
    const ui = await mount();
    await ui.send(text, [...attachments]);
    expect(ui.calls).toHaveLength(0);
    expect(ui.streams).toHaveLength(1);
    expect(ui.messages().some((m) => m.text === '명함 읽는 중… 조사 중…')).toBe(false);
    await act(async () => { tree!.unmount(); });
    tree = undefined;
  }
});
