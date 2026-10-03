import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { DaemonClient, type CodexLoginStatus } from '@/lib/daemon-client';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import type { LlmProvidersResponse, NexusClient } from '@/nexus/client';
import SetupPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const initialLoginGet = async (): Promise<CodexLoginStatus> => ({ state: 'idle' });
const originalLoginGet = DaemonClient.prototype.getCodexLogin;
const originalLoginStart = DaemonClient.prototype.startCodexLogin;
let tree: ReactTestRenderer | undefined;

beforeEach(() => {
  DaemonClient.prototype.getCodexLogin = initialLoginGet;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
});

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  navigated.length = 0;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: Window }).window;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete (globalThis as { document?: Document }).document;
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete (globalThis as { navigator?: Navigator }).navigator;
  DaemonClient.prototype.getCodexLogin = originalLoginGet;
  DaemonClient.prototype.startCodexLogin = originalLoginStart;
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

const snapshot: LlmProvidersResponse = {
  activeProvider: 'auto',
  providers: [
    { provider: 'openai', label: 'OpenAI', description: 'API key', apiKeyLabel: 'key', flow: 'apiKey', recommended: true, hasSavedKey: false },
    { provider: 'openai-codex', label: 'OpenAI Codex', description: '구독 로그인', apiKeyLabel: '', flow: 'codex', recommended: false, hasSavedKey: false },
  ],
};

const navigated: string[] = [];
function mount(getLlmProviders: () => Promise<LlmProvidersResponse>) {
  const client = {
    getLlmProviders,
    getChildLlmPreference: async () => ({ providers: [], resolved: { mode: 'pinned', chain: [], budgetGate: { minHeadroomPercent: 15, onShortfall: 'proceed' } } }),
  } as unknown as NexusClient;
  return create(
    <AppRouterContext.Provider value={{ push: (path: string) => { navigated.push(path); } } as never}>
      <NexusProvider client={client}><SetupPage /></NexusProvider>
    </AppRouterContext.Provider>,
  );
}

function setupBrowser(hostname: string, blockPopup = false) {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  const intervals = new Map<number, () => void>();
  const tabs: Array<{ location: { href: string }; close: () => void }> = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { hostname, protocol: 'http:', host: hostname }, addEventListener: () => {}, removeEventListener: () => {},
      setInterval: (callback: () => void, ms: number) => { if (ms === 2000) intervals.set(1, callback); return ms; },
      clearInterval: (id: number) => { if (id === 1) intervals.delete(1); },
      open: () => { if (blockPopup) return null; const tab = { location: { href: '' }, close: () => {} }; tabs.push(tab); return tab; },
      requestAnimationFrame: () => 0,
    },
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: () => null } });
  return { intervals, tabs };
}

async function selectCodex() {
  await act(async () => { tree = mount(async () => snapshot); });
  await act(async () => { tree!.root.findByProps({ 'data-testid': 'provider-card-openai-codex' }).props.onClick(); });
  return tree!.root.findAllByType('button').find(node => node.props.children === 'ChatGPT 로 로그인')!;
}

test('loopback opens the returned browser URL in a new tab, then polls ok to the next step', async () => {
  const { intervals, tabs } = setupBrowser('localhost');
  const modes: string[] = [];
  let state: CodexLoginStatus = { state: 'idle' };
  DaemonClient.prototype.getCodexLogin = async () => state;
  DaemonClient.prototype.startCodexLogin = async (mode) => {
    modes.push(mode);
    state = { state: 'pending', mode, authorizeUrl: 'https://auth.openai.com/oauth/authorize?state=public' };
    return state;
  };
  const login = await selectCodex();
  expect(JSON.stringify(tree!.toJSON())).not.toContain('터미널');
  await act(async () => { await login.props.onClick(); });
  expect(modes).toEqual(['browser']);
  expect(tabs[0]?.location.href).toContain('https://auth.openai.com/oauth/authorize');
  expect(JSON.stringify(tree!.toJSON())).toContain('로그인을 마치면 이 화면이 다음으로 넘어갑니다');
  state = { state: 'ok', mode: 'browser' };
  await act(async () => { await intervals.get(1)!(); });
  expect(navigated).toContain('/setup/done');
});

test('blocked popup exposes the pending authorization URL as a clickable recovery link without a futile mode switch', async () => {
  const { intervals, tabs } = setupBrowser('localhost', true);
  const modes: string[] = [];
  let state: CodexLoginStatus = { state: 'idle' };
  const url = 'https://auth.openai.com/oauth/authorize?state=public';
  DaemonClient.prototype.getCodexLogin = async () => state;
  DaemonClient.prototype.startCodexLogin = async (mode) => {
    modes.push(mode);
    state = { state: 'pending', mode, authorizeUrl: url };
    return state;
  };
  const login = await selectCodex();
  await act(async () => { await login.props.onClick(); });
  expect(modes).toEqual(['browser']);
  expect(tabs).toHaveLength(0);
  expect(tree!.root.findByType('a').props.href).toBe(url);
  expect(tree!.root.findByType('a').props.target).toBe('_blank');
  expect(JSON.stringify(tree!.toJSON())).toContain('새 탭이 차단되었습니다');
  // Recovery while the browser login is pending: switch to the device code (no waiting for the 5-minute timeout).
  expect(tree!.root.findAllByType('button').some(node => node.props.children === '기기 코드로 바꾸기')).toBe(true);
  expect(tree!.root.findAllByType('button').some(node => String(node.props.children).includes('다른 방식으로'))).toBe(false);
  await act(async () => { await intervals.get(1)!(); });
  expect(tree!.root.findByType('a').props.href).toBe(url);
  expect(modes).toEqual(['browser']);
});

test('returning to setup restores the browser login URL without starting a second attempt', async () => {
  setupBrowser('localhost');
  const url = 'https://auth.openai.com/oauth/authorize?state=public';
  DaemonClient.prototype.getCodexLogin = async () => ({ state: 'pending', mode: 'browser', authorizeUrl: url });
  DaemonClient.prototype.startCodexLogin = async () => { throw new Error('unexpected second attempt'); };
  await act(async () => { tree = mount(async () => snapshot); });
  expect(tree!.root.findByType('a').props.href).toBe(url);
  expect(tree!.root.findAllByType('button').some(node => String(node.props.children).includes('다른 방식으로'))).toBe(false);
});

test('returning to setup resumes an in-progress daemon login and advances on completion', async () => {
  const { intervals } = setupBrowser('phone.tailnet.test');
  let state: CodexLoginStatus = { state: 'pending', mode: 'device', userCode: 'RESUME-1234', verificationUrl: 'https://auth.openai.com/codex/device' };
  DaemonClient.prototype.getCodexLogin = async () => state;
  await act(async () => { tree = mount(async () => snapshot); });
  expect(tree!.root.findByProps({ 'data-testid': 'codex-user-code' }).props.children).toBe('RESUME-1234');
  state = { state: 'ok', mode: 'device' };
  await act(async () => { intervals.get(1)!(); });
  expect(navigated).toContain('/setup/done');
});

test('remote HTTP device without Clipboard API shows manual-copy guidance and offers retry plus alternate login on failure', async () => {
  const { intervals, tabs } = setupBrowser('phone.tailnet.test');
  const modes: string[] = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  let state: CodexLoginStatus = { state: 'idle' };
  DaemonClient.prototype.getCodexLogin = async () => state;
  DaemonClient.prototype.startCodexLogin = async (mode) => {
    modes.push(mode);
    state = mode === 'device'
      ? { state: 'pending', mode, userCode: 'ABCD-EFGH', verificationUrl: 'https://auth.openai.com/codex/device' }
      : { state: 'pending', mode, authorizeUrl: 'https://auth.openai.com/oauth/authorize?state=public' };
    return state;
  };
  const login = await selectCodex();
  await act(async () => { await login.props.onClick(); });
  expect(modes).toEqual(['device']);
  expect(tabs).toHaveLength(0);
  expect(tree!.root.findByProps({ 'data-testid': 'codex-user-code' }).props.children).toBe('ABCD-EFGH');
  expect(tree!.root.findByType('a').props.href).toBe('https://auth.openai.com/codex/device');
  await act(async () => { await tree!.root.findAllByType('button').find(node => node.props.children === '복사')!.props.onClick(); });
  expect(JSON.stringify(tree!.toJSON())).toContain('위 코드를 직접 선택해 복사해주세요.');
  state = { state: 'error', mode: 'device', error: 'timeout' };
  await act(async () => { await intervals.get(1)!(); });
  expect(JSON.stringify(tree!.toJSON())).toContain('5분 안에 로그인이 끝나지 않았습니다');
  // Remote device: the browser login's callback would land on this phone's own localhost, so no browser alternative.
  expect(tree!.root.findAllByType('button').some(node => String(node.props.children).includes('다른 방식으로'))).toBe(false);
  await act(async () => { await tree!.root.findAllByType('button').find(node => node.props.children === '다시 시도')!.props.onClick(); });
  expect(modes).toEqual(['device', 'device']);
  expect(tabs).toHaveLength(0);
});

test('device code copies with Clipboard API and offers manual copy when clipboard rejects', async () => {
  setupBrowser('phone.tailnet.test');
  const copied: string[] = [];
  let rejectCopy = false;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (text: string) => {
      if (rejectCopy) throw new Error('permission denied');
      copied.push(text);
    } } },
  });
  DaemonClient.prototype.getCodexLogin = async () => ({ state: 'pending', mode: 'device', userCode: 'COPY-1234', verificationUrl: 'https://auth.openai.com/codex/device' });
  await act(async () => { tree = mount(async () => snapshot); });
  const copy = tree!.root.findAllByType('button').find(node => node.props.children === '복사')!;
  await act(async () => { await copy.props.onClick(); });
  expect(copied).toEqual(['COPY-1234']);
  expect(JSON.stringify(tree!.toJSON())).toContain('코드를 복사했습니다.');
  rejectCopy = true;
  await act(async () => { await copy.props.onClick(); });
  expect(JSON.stringify(tree!.toJSON())).toContain('위 코드를 직접 선택해 복사해주세요.');
});

test('loading reserves three provider cards and updates elapsed seconds every second', async () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const clock = spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1000);
  const callbacks = new Map<number, () => void>();
  let nextId = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { protocol: 'http:', host: 'localhost', hostname: 'localhost' }, addEventListener: () => {}, removeEventListener: () => {}, setInterval: (fn: () => void, delay: number) => { if (delay === 1000) callbacks.set(++nextId, fn); return delay === 1000 ? nextId : 2000; }, clearInterval: (id: number) => { callbacks.delete(id); } },
  });
  try {
    await act(async () => { tree = mount(() => new Promise(() => {})); });
    const status = tree!.root.findByProps({ role: 'status' });
    expect(status.findAllByProps({ className: 'h-24 animate-pulse rounded border border-border bg-card p-3' })).toHaveLength(3);
    expect(status.findByType('p').props.children.join('')).toContain('공급자 확인 중 · 0초');
    expect(callbacks.size).toBe(1);
    await act(async () => { callbacks.values().next().value!(); });
    expect(status.findByType('p').props.children.join('')).toContain('공급자 확인 중 · 1초');
    await act(async () => { tree!.unmount(); });
    tree = undefined;
    expect(callbacks.size).toBe(0);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    clock.mockRestore();
  }
});

test('subscription shortcut selects the catalog codex flow and child preferences stay collapsed', async () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { protocol: 'http:', host: 'localhost', hostname: 'localhost' }, addEventListener: () => {}, removeEventListener: () => {}, setInterval, clearInterval, requestAnimationFrame: () => 0 } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: () => null } });
  await act(async () => { tree = mount(async () => snapshot); });
  expect(tree!.root.findAllByType('details')).toHaveLength(2);
  const shortcut = tree!.root.findAllByType('button').find((button) => String(button.props.children).includes('구독 로그인 보기'))!;
  expect(shortcut).toBeDefined();
  await act(async () => { shortcut.props.onClick(); });
  expect(tree!.root.findByProps({ 'data-testid': 'provider-card-openai-codex' }).props['aria-pressed']).toBe(true);
  const advanced = tree!.root.findAllByType('details').find((node) => node.findAllByType('summary').some((summary) => summary.props.children === '고급 · 자식 LLM 선호'))!;
  expect(advanced.props.open).toBeUndefined();
  expect(advanced.findAllByProps({ 'data-testid': 'child-llm-preference-card' })).toHaveLength(1);
});
