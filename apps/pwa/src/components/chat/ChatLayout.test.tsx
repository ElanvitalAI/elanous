import { afterEach, expect, test } from 'bun:test';
import { useLayoutEffect, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { ChatLayout } from './ChatLayout';
import { assertTuiSeatAskRestartContract } from '../../../../../test/seat-ask-tui-restart-contract';
import { ChatPanel } from './ChatPanel';
import { ChatHistory } from './ChatHistory';
import { ChatInput } from './ChatInput';
import { ChatQueueChips } from './ChatQueueChips';
import { NowSpeakButton } from './NowSpeakButton';
import { ChatDropOverlay } from './ChatDropOverlay';
import { BudgetPill } from './BudgetPill';
import { VoiceCostPill } from './VoiceCostPill';
import { SessionPill } from './SessionPill';
import { ChatCurrentProject } from './ChatCurrentProject';
import { MobileChatStatus } from './MobileChatStatus';
import { SeatsNowStrip } from './SeatsNowStrip';
import { ChatApprovalsChip } from './ChatApprovalsChip';
import { ChatDecisionsChip } from './ChatDecisionsChip';
import { ChatPendingDecision } from './ChatPendingDecision';
import { HideInPublicCapture } from '@/lib/public-capture';
import { SHARE_PREFILL_KEY } from '@/lib/share-prefill';
import { MAX_CHAT_FILE_BYTES, MAX_CHAT_FILES } from '@/lib/chat-paste-drop';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalFetch = globalThis.fetch;
let tree: ReactTestRenderer | undefined;

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: Window }).window;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete (globalThis as { document?: Document }).document;
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

async function mount(opts: { acp: boolean; prefill?: string; width?: number; capture?: boolean; leading?: boolean; deferred?: boolean; mobileSimple?: boolean; actions?: boolean }) {
  const sessionStorage = storage();
  const localStorage = storage();
  if (opts.prefill) sessionStorage.setItem(SHARE_PREFILL_KEY, opts.prefill);
  const events = new EventTarget();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: Object.assign(events, { sessionStorage, localStorage, innerWidth: opts.width ?? 1200, location: { search: opts.capture ? '?capture=public' : '' } }),
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: new EventTarget() });
  const requests: Array<{ method: string; body: unknown }> = [];
  const streams: unknown[] = [];
  const turns: Array<{ resolve: (result: { sessionId: string; text: string; stopReason: string }) => void; reject: (reason: Error) => void; signal: AbortSignal }> = [];
  const uploads: Array<{ file: Blob; filename: string }> = [];
  let inbound: ((payload: unknown) => Promise<unknown>) | undefined;
  const acp = {
    on: () => () => {},
    onAny: () => () => {},
    onRequest: (method: string, handler: (payload: unknown) => Promise<unknown>) => {
      if (method === 'elanous/ask/request') inbound = handler;
      return () => { inbound = undefined; };
    },
    close: () => {},
    send: async (method: string, body: unknown) => {
      requests.push({ method, body });
      return { stopReason: 'end_turn' };
    },
  };
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const form = init?.body as FormData;
    const file = form.get('file') as Blob;
    const filename = form.get('filename') as string;
    uploads.push({ file, filename });
    const id = `upload-${uploads.length}`;
    if (filename === 'fail.txt') return { ok: false, status: 500, text: async () => 'failed' } as Response;
    return { ok: true, json: async () => ({
      id, filename, size: file.size,
      mediaType: file.type, downloadUrl: `/v1/attachments/${id}`,
    }) } as Response;
  }) as typeof fetch;
  const client = {
    connectAcp: () => { if (!opts.acp) throw new Error('no ACP'); return acp; },
    voiceWsUrl: () => '',
    voiceCost: async () => ({}),
    fetchJson: async () => ({ messages: [] }),
    fetchResponse: async (path: string) => new Response(JSON.stringify(path === '/v1/decisions?status=open' ? { decisions: opts.actions ? [{ id: 'd1', title: '결정', situation: '상황', options: [{ id: 'yes', label: '진행' }], recommendation: { option: 'yes', why: '필요' } }] : [] } : { items: opts.actions ? [{ graphId: 'g', runId: 'r', nodeId: 'n', message: '승인', since: '', path: [], recent: [] }] : [] }), { status: 200 }),
    subscribeChatEvents: () => () => {},
    subscribeChatFeedbackEvents: () => () => {},
    promptStream: async (body: unknown, options?: { signal?: AbortSignal }) => {
      streams.push(body);
      if (opts.deferred) return new Promise<{ sessionId: string; text: string; stopReason: string }>((resolve, reject) => {
        turns.push({ resolve, reject, signal: options!.signal! });
      });
      return { sessionId: 'session-1', text: 'reply', stopReason: 'end_turn' };
    },
  };
  const daemon = {
    client: client as never,
    config: { baseUrl: 'http://localhost:31415', token: '', provider: 'anthropic' },
    sessionId: 'session-1',
    setSessionId: () => {},
    setConfig: () => {},
  };
  await act(async () => {
    tree = create(<DaemonContext.Provider value={daemon}><ChatLayout {...(opts.leading ? { leading: <button aria-label="대화 목록">☰</button> } : {})} {...(opts.mobileSimple ? { mobileSimple: true, mobileActivity: { kind: 'active' as const, run: { subjectId: 'task', runId: 'run-1', origin: 'system' as const, progressLine: '구현 중', progressStatus: 'running' as const, href: '/observatory' }, extraLiveCount: 0 }, conversationButton: <button aria-label="대화 목록">☰</button> } : {})} /></DaemonContext.Provider>);
  });
  const input = tree!.root.findByType(ChatInput);
  return { requests, streams, turns, uploads, input, sessionStorage, receiveAsk: (payload: unknown) => inbound!(payload) };
}

test('TUI reconnect recovers CTO seat answers and overdue notices', assertTuiSeatAskRestartContract);

test('pending composer queues FIFO, holds one turn at a time, and chips remove or clear queued turns', async () => {
  const { streams, turns, input } = await mount({ acp: false, deferred: true });
  const send = async (text: string) => {
    await act(async () => { input.findByType('textarea').props.onChange({ target: { value: text } }); });
    await act(async () => { input.findAllByType('button').at(-1)!.props.onClick(); });
  };
  const chips = () => tree!.root.findByType(ChatQueueChips);
  expect(chips().props.queue).toEqual([]);
  await send('first');
  expect(input.findByType('textarea').props.disabled).toBeFalsy();
  await send('second');
  await send('third');
  expect(streams).toHaveLength(1);
  expect(chips().props.queue.map((entry: { text: string }) => entry.text)).toEqual(['second', 'third']);
  await act(async () => { chips().props.onRemove(chips().props.queue[1].id); });
  expect(chips().props.queue.map((entry: { text: string }) => entry.text)).toEqual(['second']);
  await act(async () => { turns[0]!.resolve({ sessionId: 'session-1', text: 'ok', stopReason: 'end_turn' }); });
  expect(streams).toHaveLength(2);
  expect(streams[1]).toEqual({ sessionId: 'session-1', userText: 'second', provider: 'anthropic' });
  expect(chips().props.queue).toEqual([]);
  await send('fourth');
  await act(async () => { chips().props.onClear(); });
  await act(async () => { turns[1]!.resolve({ sessionId: 'session-1', text: 'ok', stopReason: 'end_turn' }); });
  expect(streams).toHaveLength(2);
});

test('switching conversation drops old entries and drains only new entries after the old turn ends', async () => {
  const sessionStorage = storage();
  const localStorage = storage();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: Object.assign(new EventTarget(), { sessionStorage, localStorage, innerWidth: 1200, location: { search: '' } }),
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: new EventTarget() });
  const streams: Array<{ sessionId: string; userText: string }> = [];
  const turns: Array<{ resolve: (result: { sessionId: string; text: string; stopReason: string }) => void }> = [];
  const client = {
    connectAcp: () => { throw new Error('no ACP'); },
    voiceWsUrl: () => '', voiceCost: async () => ({}),
    fetchJson: async () => ({ messages: [] }),
    subscribeChatEvents: () => () => {},
    subscribeChatFeedbackEvents: () => () => {},
    promptStream: (body: { sessionId: string; userText: string }) => {
      streams.push(body);
      return new Promise<{ sessionId: string; text: string; stopReason: string }>((resolve) => turns.push({ resolve }));
    },
  };
  let selectSession!: (id: string) => void;
  const committedQueues: string[][] = [];
  function Host() {
    const [sessionId, setSessionId] = useState('old');
    selectSession = setSessionId;
    useLayoutEffect(() => {
      if (sessionId === 'new') committedQueues.push(tree!.root.findByType(ChatQueueChips).props.queue.map((entry: { text: string }) => entry.text));
    }, [sessionId]);
    return <DaemonContext.Provider value={{
      client: client as never,
      config: { baseUrl: 'http://localhost:31415', token: '', provider: 'anthropic' },
      sessionId, setSessionId, setConfig: () => {},
    }}><ChatLayout /></DaemonContext.Provider>;
  }
  await act(async () => { tree = create(<Host />); });
  const input = () => tree!.root.findByType(ChatInput);
  const chips = () => tree!.root.findByType(ChatQueueChips);
  await act(async () => { input().props.onSubmit('first'); });
  await act(async () => { input().props.onSubmit('old queued'); });
  expect(chips().props.queue.map((entry: { text: string }) => entry.text)).toEqual(['old queued']);
  await act(async () => { selectSession('new'); });
  expect(committedQueues).toEqual([[]]);
  expect(chips().props.queue).toEqual([]);
  await act(async () => { input().props.onSubmit('new question'); });
  await act(async () => { input().props.onSubmit('new follow-up'); });
  expect(chips().props.queue.map((entry: { text: string }) => entry.text)).toEqual(['new question', 'new follow-up']);
  expect(streams.map(({ sessionId, userText }) => ({ sessionId, userText }))).toEqual([{ sessionId: 'old', userText: 'first' }]);
  await act(async () => { turns[0]!.resolve({ sessionId: 'old', text: 'ok', stopReason: 'end_turn' }); });
  expect(streams.map(({ sessionId, userText }) => ({ sessionId, userText }))).toEqual([
    { sessionId: 'old', userText: 'first' }, { sessionId: 'new', userText: 'new question' },
  ]);
  expect(chips().props.queue.map((entry: { text: string }) => entry.text)).toEqual(['new follow-up']);
  await act(async () => { turns[1]!.resolve({ sessionId: 'new', text: 'ok', stopReason: 'end_turn' }); });
  expect(streams.map(({ sessionId, userText }) => ({ sessionId, userText }))).toEqual([
    { sessionId: 'old', userText: 'first' }, { sessionId: 'new', userText: 'new question' },
    { sessionId: 'new', userText: 'new follow-up' },
  ]);
  await act(async () => { turns[2]!.resolve({ sessionId: 'new', text: 'ok', stopReason: 'end_turn' }); });
  await act(async () => { input().props.onSubmit('after switch'); });
  expect(streams.at(-1)).toMatchObject({ sessionId: 'new', userText: 'after switch' });
});

test('each completed turn starts exactly the next queued turn in FIFO order', async () => {
  const { input, streams, turns } = await mount({ acp: false, deferred: true });
  await act(async () => { input.props.onSubmit('first'); });
  await act(async () => { input.props.onSubmit('second'); input.props.onSubmit('third'); });
  expect(streams).toHaveLength(1);
  await act(async () => { turns[0]!.resolve({ sessionId: 'session-1', text: 'ok', stopReason: 'end_turn' }); });
  expect(streams).toHaveLength(2);
  expect((streams[1] as { userText: string }).userText).toBe('second');
  await act(async () => { turns[1]!.resolve({ sessionId: 'session-1', text: 'ok', stopReason: 'end_turn' }); });
  expect(streams).toHaveLength(3);
  expect((streams[2] as { userText: string }).userText).toBe('third');
  await act(async () => { turns[2]!.resolve({ sessionId: 'session-1', text: 'ok', stopReason: 'end_turn' }); });
  expect(streams).toHaveLength(3);
});

test('failed or stopped turn still drains queue; pending attachments and meta commands stay out', async () => {
  const { streams, turns, input } = await mount({ acp: false, deferred: true });
  await act(async () => { input.props.onSubmit('first'); });
  await act(async () => { input.props.onSubmit('after failure'); });
  await act(async () => { turns[0]!.reject(new Error('network')); });
  expect(streams).toHaveLength(2);
  expect((streams[1] as { userText: string }).userText).toBe('after failure');
  await act(async () => { input.props.onSubmit('after stop'); });
  await act(async () => { tree!.root.findByProps({ 'data-elanous-action': 'chat-stop' }).props.onClick(); });
  expect(turns[1]!.signal.aborted).toBe(true);
  expect(tree!.root.findByType(ChatQueueChips).props.queue).toHaveLength(1);
  await act(async () => { turns[1]!.reject(new Error('aborted')); });
  expect((streams[2] as { userText: string }).userText).toBe('after stop');
  await act(async () => { input.props.onSubmit(':help'); input.props.onSubmit('/help'); });
  expect(tree!.root.findByType(ChatQueueChips).props.queue).toEqual([]);
  expect(streams).toHaveLength(3);
  expect(input.props.prefill.text).toBe('/help');
  await act(async () => { input.props.onAttached([{ id: 'file', filename: 'a.txt', size: 1, mediaType: 'text/plain', downloadUrl: '' }]); });
  await act(async () => { input.props.onSubmit('with file'); });
  expect(tree!.root.findByType(ChatQueueChips).props.queue).toEqual([]);
  expect(input.props.attachments).toHaveLength(1);
});

test('pending queue caps at five and keeps overflow in composer', async () => {
  const { input, streams } = await mount({ acp: false, deferred: true });
  await act(async () => { input.props.onSubmit('first'); });
  for (let i = 1; i <= 6; i++) await act(async () => { input.props.onSubmit(`line ${i}`); });
  expect(tree!.root.findByType(ChatQueueChips).props.queue).toHaveLength(5);
  expect(input.props.prefill.text).toBe('line 6');
  expect(streams).toHaveLength(1);
});

test('compact header fits one 44px row with navigation, session, and expandable preserved controls', async () => {
  await mount({ acp: false, width: 412, leading: true });
  const root = tree!.root;
  const header = root.findByProps({ 'data-elanous-chat-compact-header': '' });
  expect(header.props.className).toContain('h-11 max-h-11');
  expect(header.props.className).toContain('min-w-0');
  expect(header.props.className).toContain('whitespace-nowrap');
  expect(header.findAllByProps({ 'aria-label': '대화 목록' })).toHaveLength(1);
  expect(header.findAllByType(SessionPill)).toHaveLength(1);
  expect(header.findAllByType(ChatCurrentProject)).toHaveLength(1);
  expect(header.findByProps({ 'aria-label': '현재 대화 프로젝트' }).props.className).toContain('max-w-[24vw]');
  expect(header.findAllByType(NowSpeakButton)).toHaveLength(1);
  expect(header.findAllByProps({ 'data-elanous-action': 'chat-now-speak' })).toHaveLength(1);
  expect(header.findAllByProps({ 'aria-label': '채팅 더보기' })).toHaveLength(1);
  expect(header.findAllByType(BudgetPill)).toHaveLength(0);
  const pillSlot = header.findByType(SessionPill).parent!;
  expect(pillSlot.props.className).toContain('min-w-0 flex-1');
  expect(pillSlot.props.className).toContain('[&>div>div:first-child]:overflow-hidden');
  expect(pillSlot.props.className).toContain('overflow-hidden');
  expect(pillSlot.props.className).toContain('span]:truncate');
  const more = header.findByProps({ 'aria-label': '채팅 더보기' });
  await act(async () => more.props.onClick());
  const popup = root.findByProps({ id: 'chat-header-more' });
  expect(popup.findAllByType(ChatCurrentProject)).toHaveLength(0);
  expect(popup.findAllByType(BudgetPill)).toHaveLength(1);
  expect(popup.findAllByType(VoiceCostPill)).toHaveLength(1);
  expect(popup.findAllByType(HideInPublicCapture)).toHaveLength(2);
  expect(popup.findAllByProps({ 'data-elanous-action': 'chat-voice-toggle' })).toHaveLength(1);
  expect(more.props['aria-expanded']).toBe(true);
  await act(async () => more.props.onClick());
  expect(root.findAllByProps({ id: 'chat-header-more' })).toHaveLength(0);
  await act(async () => more.props.onClick());
  const outside = new Event('pointerdown');
  Object.defineProperty(outside, 'target', { value: {} });
  await act(async () => { document.dispatchEvent(outside); });
  expect(root.findAllByProps({ id: 'chat-header-more' })).toHaveLength(0);
});

test('390px standalone chat has one status row with live work and menu-only controls', async () => {
  await mount({ acp: false, width: 390, mobileSimple: true });
  const root = tree!.root;
  const status = root.findByType(MobileChatStatus);
  expect(root.findAllByProps({ 'data-elanous-mobile-chat-status': '' })).toHaveLength(1);
  expect(root.findByProps({ 'data-elanous-mobile-chat-status': '' }).findAllByType('span').map((span) => span.children.join(''))).toEqual(['지금 도는 일 · 구현 중', '대기 결정 · 0']);
  expect(status.props.activity.run.progressLine).toBe('구현 중');
  expect(root.findAllByProps({ 'data-elanous-chat-compact-header': '' })).toHaveLength(0);
  expect(root.findAllByType(SeatsNowStrip)).toHaveLength(0);
  expect(root.findAllByProps({ 'aria-label': '채팅 메뉴' })).toHaveLength(1);
  expect(root.findAllByType(SessionPill)).toHaveLength(0);
  expect(root.findAllByType(ChatCurrentProject)).toHaveLength(0);
  expect(root.findAllByType(NowSpeakButton)).toHaveLength(0);
  await act(async () => root.findByProps({ 'aria-label': '채팅 메뉴' }).props.onClick());
  const menu = root.findByProps({ id: 'chat-mobile-menu' });
  expect(menu.findAllByType(SessionPill)).toHaveLength(1);
  expect(menu.findAllByType(ChatCurrentProject)).toHaveLength(1);
  expect(menu.findAllByType(NowSpeakButton)).toHaveLength(1);
  expect(menu.findAllByProps({ 'aria-label': '대화 목록' })).toHaveLength(1);
  expect(menu.findByProps({ 'aria-label': '채팅 이동' }).findAllByType('a').map((link) => link.props.href)).toEqual(['/', '/workspace', '/settings']);
  expect(root.findByType(ChatApprovalsChip).props.mobileOpen).toBe(false);
  expect(root.findByType(ChatDecisionsChip).props.mobileOpen).toBe(false);
  expect(root.findByType(ChatHistory).props.mobileSimple).toBe(true);
  expect(root.findAllByType(ChatPendingDecision)).toHaveLength(0);
});

test('390px approval and decision share one chip; opening reveals both actionable lists', async () => {
  await mount({ acp: false, width: 390, mobileSimple: true, actions: true });
  const root = tree!.root;
  expect(root.findByType(MobileChatStatus).props.decisions).toBe(1);
  expect(root.findAllByProps({ 'aria-controls': 'chat-mobile-actions' })).toHaveLength(1);
  const chip = root.findByProps({ 'aria-controls': 'chat-mobile-actions' });
  expect(chip.props['aria-expanded']).toBe(false);
  expect(root.findAllByProps({ 'aria-controls': 'chat-approvals-panel' })).toHaveLength(0);
  expect(root.findAllByProps({ 'aria-controls': 'chat-decisions-panel' })).toHaveLength(0);
  await act(async () => chip.props.onClick());
  expect(root.findByProps({ 'aria-controls': 'chat-mobile-actions' }).props['aria-expanded']).toBe(true);
  expect(root.findAllByProps({ id: 'chat-approvals-panel' })).toHaveLength(1);
  expect(root.findAllByProps({ id: 'chat-decisions-panel' })).toHaveLength(1);
});

test('public capture still hides both money pills in compact more menu', async () => {
  await mount({ acp: false, width: 412, capture: true });
  await act(async () => tree!.root.findByProps({ 'aria-label': '채팅 더보기' }).props.onClick());
  const popup = tree!.root.findByProps({ id: 'chat-header-more' });
  expect(popup.findAllByType(BudgetPill)).toHaveLength(0);
  expect(popup.findAllByType(VoiceCostPill)).toHaveLength(0);
  expect(popup.findAllByProps({ 'data-elanous-action': 'chat-voice-toggle' })).toHaveLength(1);
});

test('390px standalone status menu still masks cost controls in public capture', async () => {
  await mount({ acp: false, width: 390, mobileSimple: true, capture: true });
  const root = tree!.root;
  await act(async () => root.findByProps({ 'aria-label': '채팅 메뉴' }).props.onClick());
  expect(root.findByProps({ id: 'chat-mobile-menu' }).findAllByType(BudgetPill)).toHaveLength(0);
  expect(root.findByProps({ id: 'chat-mobile-menu' }).findAllByType(VoiceCostPill)).toHaveLength(0);
});

test('wide header preserves the existing session, money pills, and voice button without compact controls', async () => {
  await mount({ acp: false, width: 1200, leading: true });
  const root = tree!.root;
  expect(root.findAllByProps({ 'data-elanous-chat-compact-header': '' })).toHaveLength(0);
  expect(root.findAllByProps({ 'aria-label': '대화 목록' })).toHaveLength(0);
  expect(root.findAllByProps({ 'aria-label': '채팅 더보기' })).toHaveLength(0);
  expect(root.findByType(ChatHistory).props.mobileSimple).toBe(false);
  expect(root.findAllByType(ChatPendingDecision)).toHaveLength(1);
  expect(root.findAllByType(SessionPill)).toHaveLength(1);
  expect(root.findAllByType(ChatCurrentProject)).toHaveLength(1);
  expect(root.findAllByProps({ 'aria-label': '현재 대화 프로젝트' })).toHaveLength(1);
  expect(root.findAllByType(NowSpeakButton)).toHaveLength(1);
  expect(root.findAllByProps({ 'data-elanous-action': 'chat-now-speak' })).toHaveLength(1);
  expect(root.findAllByType(BudgetPill)).toHaveLength(1);
  expect(root.findAllByType(VoiceCostPill)).toHaveLength(1);
  expect(root.findAllByProps({ 'data-elanous-action': 'chat-voice-toggle' })).toHaveLength(1);
});

test('stale session adoption keeps the first question and streamed answer on the mounted chat', async () => {
  const sessionStorage = storage();
  const localStorage = storage();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: Object.assign(new EventTarget(), { sessionStorage, localStorage, location: { search: '' } }),
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
  let failLoad!: (error: Error) => void;
  let issueSession!: (id: string) => void;
  let finishPrompt!: (result: unknown) => void;
  let selectSession!: (id: string) => void;
  let hostSessionId = '';
  const sent: Array<{ method: string; body: unknown }> = [];
  const chunkHandlers = new Set<(frame: unknown) => void>();
  const sessionHandlers = new Set<(id: string) => void>();
  let staleLeases = 0;
  let promptPending = false;
  let staleClosed = false;
  const ready = (async () => {
    sent.push({ method: 'session/load', body: { sessionId: 'stale' } });
    try { await new Promise<void>((_, reject) => { failLoad = reject; }); } catch { /* unknown session */ }
    sent.push({ method: 'session/new', body: {} });
    const issued = await new Promise<string>((resolve) => { issueSession = resolve; });
    for (const handler of sessionHandlers) handler(issued);
    return issued;
  })();
  const deliverChunk = (text: string) => {
    for (const cb of chunkHandlers) cb({ params: {
      sessionId: 'issued', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    } });
  };
  const client = {
    connectAcp: ({ sessionId, onSession }: { sessionId: string; onSession?: (id: string) => void }) => {
      if (sessionId === 'stale') {
        staleLeases += 1;
        if (onSession) sessionHandlers.add(onSession);
        const ownedHandlers = new Set<(frame: unknown) => void>();
        let released = false;
        return {
          ready,
          on: (kind: string, cb: (frame: unknown) => void) => {
            if (kind === 'sessionUpdate') { ownedHandlers.add(cb); chunkHandlers.add(cb); }
            return () => { ownedHandlers.delete(cb); chunkHandlers.delete(cb); };
          },
          onAny: () => () => {},
          onRequest: () => () => {},
          close: () => {
            if (released) return;
            released = true;
            staleLeases -= 1;
            if (onSession) sessionHandlers.delete(onSession);
            for (const cb of ownedHandlers) chunkHandlers.delete(cb);
            if (staleLeases === 0 && !promptPending) staleClosed = true;
          },
          send: async (method: string, body: unknown) => {
            sent.push({ method, body });
            if (method !== 'session/prompt') return {};
            promptPending = true;
            return new Promise((resolve) => {
              finishPrompt = (result) => {
                promptPending = false;
                resolve(result);
                if (staleLeases === 0) staleClosed = true;
              };
            });
          },
        };
      }
      return {
        ready: Promise.resolve(sessionId),
        on: () => () => {}, onAny: () => () => {}, onRequest: () => () => {},
        close: () => {}, send: async () => ({}),
      };
    },
    voiceWsUrl: () => '', voiceCost: async () => ({}),
    fetchJson: async () => ({ messages: [] }),
    subscribeChatEvents: () => () => {},
    subscribeChatFeedbackEvents: () => () => {},
  };
  function Host() {
    const [sessionId, setSessionId] = useState('stale');
    hostSessionId = sessionId;
    selectSession = setSessionId;
    return <DaemonContext.Provider value={{
      client: client as never,
      config: { baseUrl: 'http://localhost:31415', token: '', provider: 'anthropic' },
      sessionId, setSessionId, setConfig: () => {},
    }}><ChatPanel /></DaemonContext.Provider>;
  }
  await act(async () => { tree = create(<Host />); });
  const question = 'Reply with only the number that is one more than 2378.';
  await act(async () => { tree!.root.findByType(ChatInput).findByType('textarea').props.onChange({ target: { value: question } }); });
  await act(async () => { tree!.root.findByType(ChatInput).findAllByType('button').at(-1)!.props.onClick(); });
  expect(hostSessionId).toBe('stale');
  await act(async () => { failLoad(new Error('unknown session')); });
  expect(sent.map(({ method }) => method)).toContain('session/new');
  await act(async () => { issueSession('issued'); });
  expect(hostSessionId).toBe('issued');
  expect(staleClosed).toBe(false);
  expect(sent).toContainEqual({ method: 'session/prompt', body: {
    sessionId: 'issued', prompt: [{ type: 'text', text: question }],
  } });
  await act(async () => { deliverChunk('23'); });
  expect(tree!.root.findByType(ChatHistory).props.messages.at(-1).text).toBe('23');
  await act(async () => { deliverChunk('79'); finishPrompt({ stopReason: 'end_turn' }); });
  expect(hostSessionId).toBe('issued');
  expect(staleClosed).toBe(true);
  const messages = tree!.root.findByType(ChatHistory).props.messages as Array<{ role: string; text: string }>;
  expect(messages.map(({ role, text }) => ({ role, text }))).toContainEqual({ role: 'user', text: question });
  expect(messages.map(({ role, text }) => ({ role, text }))).toContainEqual({ role: 'assistant', text: '2379' });
  expect(messages.some(({ text }) => text.startsWith('error:'))).toBe(false);
  await act(async () => { selectSession('other-session'); });
  expect(tree!.root.findByType(ChatHistory).props.messages).toEqual([]);
});

test('mounted chat sends ACP session/prompt with sessionId and prompt only', async () => {
  const { input, requests, streams } = await mount({ acp: true });
  await act(async () => { input.findByType('textarea').props.onChange({ target: { value: 'hello' } }); });
  await act(async () => { input.findAllByType('button').at(-1)!.props.onClick(); });
  expect(requests).toContainEqual({ method: 'session/prompt', body: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'hello' }] } });
  expect(streams).toHaveLength(0);
});

// PCH-1(#22785) — 모르는 `/명령`(TUI 이름 포함)은 LLM 으로 보내지 않는다. 경로처럼 생긴 글(두 번째 `/`)만 평문으로 간다.
test('mounted chat handles /help and unsupported slash locally, and leaves path-like text for ACP', async () => {
  const { input, requests, streams } = await mount({ acp: true });
  await act(async () => { input.findByType('textarea').props.onChange({ target: { value: '/help' } }); });
  await act(async () => { input.findAllByType('button').at(-1)!.props.onClick(); });
  expect(requests.filter((request) => request.method === 'session/prompt')).toHaveLength(0);
  expect(streams).toHaveLength(0);
  await act(async () => { input.findByType('textarea').props.onChange({ target: { value: '/run-skill test' } }); });
  await act(async () => { input.findAllByType('button').at(-1)!.props.onClick(); });
  expect(requests.filter((request) => request.method === 'session/prompt')).toHaveLength(0);
  await act(async () => { input.findByType('textarea').props.onChange({ target: { value: '/tmp/a/b' } }); });
  await act(async () => { input.findAllByType('button').at(-1)!.props.onClick(); });
  expect(requests).toContainEqual({ method: 'session/prompt', body: {
    sessionId: 'session-1', prompt: [{ type: 'text', text: '/tmp/a/b' }],
  } });
});

test('mounted chat falls back to SSE when ACP is unavailable', async () => {
  const { input, requests, streams } = await mount({ acp: false });
  await act(async () => { input.findByType('textarea').props.onChange({ target: { value: 'fallback' } }); });
  await act(async () => { input.findAllByType('button').at(-1)!.props.onClick(); });
  expect(requests).toHaveLength(0);
  expect(streams).toEqual([{ sessionId: 'session-1', userText: 'fallback', provider: 'anthropic' }]);
});

test('share text is displayed in the mounted composer and consumed once', async () => {
  const { sessionStorage } = await mount({ acp: true, prefill: 'Shared question' });
  const textarea = tree!.root.findByType('textarea');
  expect(textarea.props.value).toBe('Shared question');
  expect(sessionStorage.getItem(SHARE_PREFILL_KEY)).toBeNull();
});

test('outer chat paste preserves text and uploads file items as queued attachments', async () => {
  const { uploads, input } = await mount({ acp: true });
  const area = tree!.root.findByType(ChatLayout).findByType('div');
  const screenshot = new File(['png'], '', { type: 'image/png' });
  let prevented = 0;
  const preventDefault = () => { prevented++; };
  await act(async () => { area.props.onPaste({ clipboardData: {
    items: [{ kind: 'string', getAsFile: () => null }], files: [],
  }, preventDefault }); });
  expect(prevented).toBe(0);
  expect(uploads).toHaveLength(0);
  await act(async () => { area.props.onPaste({ clipboardData: {
    items: [{ kind: 'file', getAsFile: () => screenshot }], files: [screenshot],
  }, preventDefault }); });
  expect(prevented).toBe(1);
  expect(uploads).toHaveLength(1);
  expect(uploads[0]!.filename).toMatch(/^paste-\d+\.png$/);
  expect(input.props.attachments.map((entry: { filename: string }) => entry.filename)).toEqual([uploads[0]!.filename]);
  const oversized = new File(['huge'], 'huge.png', { type: 'image/png' });
  Object.defineProperty(oversized, 'size', { value: MAX_CHAT_FILE_BYTES + 1 });
  await act(async () => { area.props.onPaste({ clipboardData: {
    items: [{ kind: 'file', getAsFile: () => oversized }], files: [oversized],
  }, preventDefault }); });
  expect(prevented).toBe(2);
  expect(uploads).toHaveLength(1);
});

test('outer chat only captures file drags/drops and queues successful uploads from a limited batch', async () => {
  const { uploads, input } = await mount({ acp: true });
  const area = tree!.root.findByType(ChatLayout).findByType('div');
  let prevented = 0;
  const preventDefault = () => { prevented++; };
  const text = { types: ['text/plain'], files: [] };
  await act(async () => {
    area.props.onDragOver({ dataTransfer: text, preventDefault });
    area.props.onDrop({ dataTransfer: text, preventDefault });
  });
  expect(prevented).toBe(0);
  const large = new File(['large'], 'large.bin');
  Object.defineProperty(large, 'size', { value: MAX_CHAT_FILE_BYTES + 1 });
  const files = [large, new File(['bad'], 'fail.txt'),
    ...Array.from({ length: MAX_CHAT_FILES + 1 }, (_, i) => new File(['ok'], `file-${i}.txt`))];
  const transfer = { types: ['Files', 'text/plain'], files };
  await act(async () => {
    area.props.onDragOver({ dataTransfer: transfer, preventDefault });
    area.props.onDrop({ dataTransfer: transfer, preventDefault });
  });
  expect(prevented).toBe(2);
  expect(uploads.map((upload) => upload.filename)).toEqual(files.slice(1, MAX_CHAT_FILES + 1).map((file) => file.name));
  expect(input.props.attachments.map((entry: { filename: string }) => entry.filename))
    .toEqual(files.slice(2, MAX_CHAT_FILES + 1).map((file) => file.name));
});

test('file drag overlay stays visible across children, closes on exit/drop/dragend, and ignores text', async () => {
  const { input, uploads } = await mount({ acp: true });
  const area = tree!.root.findByType(ChatLayout).findByType('div');
  const file = new File(['hello'], 'hello.txt');
  const transfer = { types: ['Files'], files: [file] };
  const text = { types: ['text/plain'], files: [] };
  const overlay = () => tree!.root.findAllByType(ChatDropOverlay);
  const preventDefault = () => {};

  expect(overlay()).toHaveLength(0);
  await act(async () => { area.props.onDragEnter({ dataTransfer: text }); });
  expect(overlay()).toHaveLength(0);
  await act(async () => { area.props.onDragEnter({ dataTransfer: transfer }); });
  expect(overlay()).toHaveLength(1);
  const surface = overlay()[0]!.findByType('div');
  expect(surface.props.className).toContain('pointer-events-none');
  expect(overlay()[0]!.findAllByType('p').map((p) => Array.isArray(p.props.children) ? p.props.children.join('') : p.props.children)).toEqual([
    '여기에 놓으면 첨부', `파일 ${MAX_CHAT_FILES}개까지 · 큰 파일은 빠집니다`,
  ]);
  await act(async () => { area.props.onDragEnter({ dataTransfer: transfer }); });
  await act(async () => { area.props.onDragLeave({ dataTransfer: transfer }); });
  expect(overlay()).toHaveLength(1);
  await act(async () => { area.props.onDragLeave({ dataTransfer: transfer }); });
  expect(overlay()).toHaveLength(0);

  await act(async () => { area.props.onDragEnter({ dataTransfer: transfer }); });
  await act(async () => { area.props.onDrop({ dataTransfer: transfer, preventDefault }); });
  expect(overlay()).toHaveLength(0);
  expect(uploads.map((entry) => entry.filename)).toEqual(['hello.txt']);
  expect(input.props.attachments.map((entry: { filename: string }) => entry.filename)).toEqual(['hello.txt']);

  await act(async () => { area.props.onDragEnter({ dataTransfer: transfer }); });
  await act(async () => { (globalThis.window as Window).dispatchEvent(new Event('dragend')); });
  expect(overlay()).toHaveLength(0);
});

test('Chat about this fills the composer after mount', async () => {
  const { sessionStorage, receiveAsk } = await mount({ acp: true });
  const { AskQuestionSheet } = await import('@/components/ask-user-question/AskQuestionSheet');
  let result!: Promise<unknown>;
  await act(async () => {
    result = receiveAsk({ id: 'ask-1', request: { questions: [
      { id: 'q1', header: 'Question', question: 'What now?', options: [] },
    ] } });
  });
  const sheet = tree!.root.findByType(AskQuestionSheet);
  await act(async () => { sheet.props.onChatAboutThis(); });
  expect(await result).toEqual({ answers: {}, cancelled: true });
  expect(tree!.root.findByType('textarea').props.value).toBe('[ Q: What now? ]\n\n');
  expect(sessionStorage.getItem(SHARE_PREFILL_KEY)).toBeNull();
});
