import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { ChatMessageView } from './ChatMessage';
import { HarnessAskCard } from './HarnessAskCard';
import { assertTuiSeatAskRestartContract } from '../../../../../test/seat-ask-tui-restart-contract';
import { ChatLayout } from './ChatLayout';
import { ChatHistory } from './ChatHistory';
import { ChatInput } from './ChatInput';
import type { ChatMessage } from '@/lib/chat-runtime';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let tree: ReactTestRenderer | undefined;

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: Window }).window;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete (globalThis as { document?: Document }).document;
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

function fakeDaemon(fetchJson: (path: string) => Promise<unknown>) {
  return {
    client: { fetchJson } as never,
    config: { baseUrl: 'http://unused', token: '', provider: '' },
    sessionId: 's', setSessionId: () => {}, setConfig: () => {},
  };
}

function text(): string {
  return tree!.root.findByProps({ 'aria-label': '하니스 진행' }).children.map((node) =>
    typeof node === 'string' ? node : node.children.join('')).join(' ');
}

test('TUI reconnect recovers CTO seat answers and overdue notices', assertTuiSeatAskRestartContract);

test('meta block renders an updating card and polls at five seconds; settled status stops', async () => {
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  let nextTimer = 0;
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    delays.push(delay);
    timers.set(++nextTimer, callback);
    return nextTimer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof clearTimeout;
  const paths: string[] = [];
  const statuses = [
    { phase: 'launch-started', runId: '12345678-run', goalFile: '/private/goals/fix-button.md', elapsedSeconds: 32 },
    { phase: 'launch-settled', runId: '12345678-run', goalFile: '/private/goals/fix-button.md', elapsedSeconds: 68 },
  ];
  const daemon = fakeDaemon(async (path) => { paths.push(path); return statuses[paths.length - 1]; });
  const message: ChatMessage = {
    id: 'm', role: 'meta', text: '하니스 접수 · abcdef12', timestamp: 0,
    blocks: [{ kind: 'harness_ask', acceptanceId: 'abcdef12-long' }],
  };
  await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChatMessageView message={message} /></DaemonContext.Provider>); });
  expect(tree!.root.findByType(HarnessAskCard).props.acceptanceId).toBe('abcdef12-long');
  expect(paths).toEqual(['/v1/harness/ask-status?acceptanceId=abcdef12-long']);
  expect(text()).toContain('런 도는 중');
  expect(text()).toContain('런 12345678');
  expect(text()).toContain('fix-button.md');
  expect(text()).not.toContain('/private/');
  expect(text()).toContain('경과 32초');
  expect(delays).toEqual([5000]);
  await act(async () => { const tick = timers.get(1)!; timers.delete(1); tick(); });
  expect(paths).toHaveLength(2);
  expect(text()).toContain('런 끝');
  expect(text()).toContain('경과 1분');
  expect(timers.size).toBe(0);
});

test('404 stops with restart explanation; unmount cancels a scheduled poll', async () => {
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  globalThis.setTimeout = ((callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof clearTimeout;
  let calls = 0;
  const daemon = fakeDaemon(async () => {
    calls++;
    if (calls === 2) throw new Error('harness ask not found');
    return { phase: 'accepted', elapsedSeconds: 0 };
  });
  await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><HarnessAskCard acceptanceId="a" /></DaemonContext.Provider>); });
  expect(text()).toContain('접수됨');
  expect(text()).toContain('경과 0초');
  await act(async () => { const tick = timers.get(1)!; timers.delete(1); tick(); });
  expect(text()).toContain('접수 기록을 못 찾았습니다(데몬 재시작이면 사라질 수 있음)');
  expect(timers.size).toBe(0);
  await act(async () => { tree!.unmount(); });
  expect(calls).toBe(2);

  await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><HarnessAskCard acceptanceId="b" /></DaemonContext.Provider>); });
  expect(timers.size).toBe(1);
  await act(async () => { tree!.unmount(); });
  expect(timers.size).toBe(0);
  expect(calls).toBe(3);
});

test('mounted chat attaches the progress block to the acceptance message without an LLM turn', async () => {
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} } as unknown as Storage;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), {
    innerWidth: 1200, sessionStorage: storage, localStorage: storage, location: { search: '' },
  }) });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: new EventTarget() });
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const prompts: unknown[] = [];
  const client = {
    voiceWsUrl: () => '', voiceCost: async () => ({}),
    connectAcp: () => { throw new Error('no ACP'); },
    subscribeChatEvents: () => () => {}, subscribeChatFeedbackEvents: () => () => {},
    promptStream: async (body: unknown) => { prompts.push(body); return { sessionId: 's', text: 'reply', stopReason: 'end_turn' }; },
    fetchJson: async (path: string, init?: RequestInit) => {
      requests.push({ path, init });
      if (path === '/v1/harness/ask') return { acceptanceId: 'abcdefgh-1234' };
      if (path.startsWith('/v1/harness/ask-status')) return { phase: 'launch-settled', elapsedSeconds: 65 };
      return { messages: [] };
    },
  };
  const daemon = { ...fakeDaemon(client.fetchJson), client: client as never };
  await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ChatLayout /></DaemonContext.Provider>); });
  const input = tree!.root.findByType(ChatInput);
  await act(async () => { input.props.onSubmit('하니스로 버튼 고쳐'); });
  const messages = tree!.root.findByType(ChatHistory).props.messages as ChatMessage[];
  expect(messages.map(({ role }) => role)).toEqual(['user', 'meta']);
  expect(messages[1]!.text).toBe('하니스 접수 · abcdefgh');
  expect(messages[1]!.blocks).toEqual([{ kind: 'harness_ask', acceptanceId: 'abcdefgh-1234' }]);
  expect(tree!.root.findByType(HarnessAskCard).props.acceptanceId).toBe('abcdefgh-1234');
  expect(requests.filter(({ path }) => path === '/v1/harness/ask')).toHaveLength(1);
  expect(prompts).toHaveLength(0);
  await act(async () => { input.props.onSubmit('그냥 질문'); });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toMatchObject({ userText: '그냥 질문' });
});

test('polling stops at 60 minutes without scheduling another request', async () => {
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  globalThis.setTimeout = ((callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof clearTimeout;
  const realNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  let calls = 0;
  try {
    const daemon = fakeDaemon(async () => {
      calls++;
      return { phase: 'launch-started', elapsedSeconds: calls * 5 };
    });
    await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><HarnessAskCard acceptanceId="a" /></DaemonContext.Provider>); });
    expect(timers.size).toBe(1);
    now += 60 * 60 * 1000;
    await act(async () => { const tick = timers.get(1)!; timers.delete(1); tick(); });
    expect(calls).toBe(1);
    expect(timers.size).toBe(0);
  } finally { Date.now = realNow; }
});

test('failed launch stops without another poll', async () => {
  let calls = 0;
  const daemon = fakeDaemon(async () => { calls++; return { phase: 'launch-failed', elapsedSeconds: 12 }; });
  await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><HarnessAskCard acceptanceId="a" /></DaemonContext.Provider>); });
  expect(text()).toContain('발사 실패');
  expect(calls).toBe(1);
});
