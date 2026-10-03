import { afterEach, expect, spyOn, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { SeatsNowStrip } from './SeatsNowStrip';
import { ChatLayout } from './ChatLayout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
let timer: ReturnType<typeof spyOn> | undefined;
let clearTimer: ReturnType<typeof spyOn> | undefined;
let tree: ReactTestRenderer | undefined;

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  timer?.mockRestore();
  clearTimer?.mockRestore();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: Window }).window;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete (globalThis as { document?: Document }).document;
});

function setup(status = 200, text = '구현 확인', multiple = false) {
  let responseStatus = status;
  let hidden = false;
  let polls = 0;
  let intervalMs = 0;
  let interval: (() => void) | undefined;
  let cancelled = false;
  const doc = Object.assign(new EventTarget(), {});
  Object.defineProperty(doc, 'hidden', { get: () => hidden });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  timer = spyOn(globalThis, 'setInterval').mockImplementation((fn: TimerHandler, ms?: number) => { interval = fn as () => void; intervalMs = ms ?? 0; return 1 as never; });
  clearTimer = spyOn(globalThis, 'clearInterval').mockImplementation(() => { cancelled = true; interval = undefined; });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), {
    innerWidth: 412,
    location: { search: '', pathname: '/chat' },
    sessionStorage: { getItem: () => null },
  }) });
  const client = {
    fetchResponse: async (path: string, init: RequestInit) => {
      polls++;
      expect(path).toMatch(/^\/v1\/ops\/seats\?date=\d{4}-\d{2}-\d{2}$/);
      expect(init.method).toBe('GET');
      return { status: responseStatus, ok: responseStatus === 200, json: async () => ({ date: '2026-10-03', seats: [
        { seat: 'TC', now: { text, at: new Date(Date.now() - 5 * 60_000).toISOString() }, landed: null, blocked: null, pendingDecisions: null, checklist: null },
        ...(multiple ? [{ seat: 'UX', now: { text: '공개 준비', at: new Date(Date.now() - 30_000).toISOString() }, landed: null, blocked: null, pendingDecisions: null, checklist: null }] : []),
      ] }) } as Response;
    },
    voiceWsUrl: () => '', voiceCost: async () => ({}),
    fetchJson: async () => ({ messages: [] }),
    connectAcp: () => { throw new Error('no ACP'); },
    subscribeChatEvents: () => () => {},
    subscribeChatFeedbackEvents: () => () => {},
  };
  const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' }, sessionId: '', setSessionId: () => {}, setConfig: () => {} };
  return {
    mount: async (layout = false) => { await act(async () => { tree = create(<DaemonContext.Provider value={daemon}>{layout ? <ChatLayout /> : <SeatsNowStrip />}</DaemonContext.Provider>); }); },
    get polls() { return polls; }, get intervalMs() { return intervalMs; }, get cancelled() { return cancelled; },
    fail: () => { responseStatus = 500; },
    tick: async () => { await act(async () => { interval?.(); }); },
    hide: () => { hidden = true; doc.dispatchEvent(new Event('visibilitychange')); },
    show: async () => { hidden = false; await act(async () => { doc.dispatchEvent(new Event('visibilitychange')); }); },
  };
}

test('status strip reads via fake client and renders one clipped row with a complete title', async () => {
  const probe = setup();
  await probe.mount();
  expect(probe.polls).toBe(1);
  const strip = tree!.root.findByProps({ role: 'status', 'aria-label': '지금 자리들이 하는 일' });
  expect(strip.props.title).toBe('CTO 구현 확인 · 5분 전');
  expect(strip.findAllByType('span')).toHaveLength(1);
  expect(strip.props.className).toContain('h-8');
  expect(strip.props.className).toContain('text-ellipsis');
  expect(strip.props.className).toContain('overflow');
  expect(strip.props.className).not.toContain('overflow-x-auto');
});

test('multiple seats have one span each, separators, and clear stale data after a failed read', async () => {
  const probe = setup(200, '구현 확인', true);
  await probe.mount();
  const strip = tree!.root.findByProps({ role: 'status', 'aria-label': '지금 자리들이 하는 일' });
  expect(strip.props.title).toBe('CTO 구현 확인 · 5분 전 | CXO 공개 준비 · 방금');
  expect(strip.findAllByType('span')).toHaveLength(2);
  expect(strip.findAllByType('span')[1]!.props.children).toContain(' | ');
  probe.fail();
  await probe.tick();
  expect(tree!.toJSON()).toBeNull();
});

test('failure and empty result leave no DOM; polling skips hidden and cleans up on unmount', async () => {
  const probe = setup(500);
  await probe.mount();
  expect(tree!.toJSON()).toBeNull();
  expect(probe.intervalMs).toBe(60_000);
  probe.hide();
  await probe.tick();
  expect(probe.polls).toBe(1);
  await probe.show();
  expect(probe.polls).toBe(2);
  await probe.tick();
  expect(probe.polls).toBe(3);
  await act(async () => { tree!.unmount(); });
  tree = undefined;
  expect(probe.cancelled).toBe(true);
  await probe.tick();
  await probe.show();
  expect(probe.polls).toBe(3);
  const empty = setup(200, '');
  await empty.mount();
  expect(tree!.toJSON()).toBeNull();
});

test('compact and wide layout place exactly one strip immediately after the header', async () => {
  const probe = setup();
  await probe.mount(true);
  const layout = tree!.root.findByType(ChatLayout).findByType('div');
  const children = layout.children.filter((child): child is ReactTestRenderer['root'] => typeof child !== 'string');
  const header = children.findIndex((child) => child.props['data-elanous-chat-compact-header'] === '');
  expect(header).toBeGreaterThanOrEqual(0);
  expect(children[header + 1]!.type).toBe(SeatsNowStrip);
  expect(children.filter((child) => child.type === SeatsNowStrip)).toHaveLength(1);
  await act(async () => { tree!.unmount(); });
  tree = undefined;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
  await probe.mount(true);
  const wide = tree!.root.findByType(ChatLayout).findByType('div').children.filter((child): child is ReactTestRenderer['root'] => typeof child !== 'string');
  expect(wide[1]!.type).toBe(SeatsNowStrip);
  expect(wide.filter((child) => child.type === SeatsNowStrip)).toHaveLength(1);
});
