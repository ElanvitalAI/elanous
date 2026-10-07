import { afterEach, expect, test } from 'bun:test';
import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import ChatPage from '@/app/chat/page';
import { ChatPanel } from './ChatPanel';
import { ChatLayout } from './ChatLayout';
import { ChatConversationList } from './ChatConversationList';
import { ChatCurrentProject } from './ChatCurrentProject';
import { _resetSessionsServiceSingletonForTest } from '@/lib/sessions-service';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | undefined;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  _resetSessionsServiceSingletonForTest();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: Window }).window;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete (globalThis as { document?: Document }).document;
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

async function mount(show: boolean, entries: Array<{ id: string; title: string; preview: string; updatedAt: string; messageCount: number; source: string; active: boolean; createdAt: string }> = [], width = 412) {
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { innerWidth: width, location: { search: '' }, sessionStorage: { getItem: () => null }, localStorage: storage }) });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: new EventTarget() });
  let projectId: string | null = 'p';
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = { fetchJson: async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (path === '/v1/projects') return { projects: [{ id: 'p', name: '일', createdAt: '' }, { id: 'q', name: '개인', createdAt: '' }] };
    if (init?.method === 'PATCH') {
      projectId = (JSON.parse(init.body as string) as { projectId: string | null }).projectId;
      return { ok: true };
    }
    if (path.includes('?ifExists=1')) return { meta: { projectId }, messages: [] };
    return { sessions: entries, messages: [] };
  }, sessionStoreEventsUrl: () => '', voiceWsUrl: () => '', connectAcp: () => { throw Error('offline'); } };
  let selected = 'one';
  function Host() {
    const [sessionId, setSessionId] = useState('one');
    selected = sessionId;
    const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' }, sessionId, setSessionId, setConfig: () => {} };
    return <DaemonContext.Provider value={daemon}>{show ? <ChatPage /> : <ChatPanel />}</DaemonContext.Provider>;
  }
  await act(async () => { tree = create(<Host />); });
  return { root: tree!.root, getSelected: () => selected, calls, getProject: () => projectId };
}

test('/chat keeps desktop column and moves the mobile drawer button into the status menu without replacing chat', async () => {
  const { root } = await mount(true, [], 390);
  const desktop = root.findAllByType('aside')[0]!;
  expect(desktop.props.className).toBe('hidden');
  expect(desktop.findAllByType(ChatConversationList)).toHaveLength(1);
  expect(root.findAllByType(ChatLayout)).toHaveLength(1);
  const chat = root.findByType(ChatLayout);
  const status = root.findByProps({ 'data-elanous-mobile-chat-status': '' });
  expect(status.props.className).toContain('h-10 min-h-10');
  expect(status.findAllByProps({ 'aria-label': '채팅 메뉴' })).toHaveLength(1);
  expect(root.findByType(ChatLayout).props.mobileSimple).toBe(true);
  expect(root.findAllByProps({ 'data-elanous-chat-compact-header': '' })).toHaveLength(0);
  await act(async () => status.findByProps({ 'aria-label': '채팅 메뉴' }).props.onClick());
  expect(root.findByProps({ id: 'chat-mobile-menu' }).findAllByProps({ 'aria-label': '대화 목록' })).toHaveLength(1);
  expect(root.findAllByType('button').filter((b) => b.props['aria-controls'] === 'chat-conversation-drawer')).toHaveLength(1);
  const toggle = root.findByProps({ 'aria-controls': 'chat-conversation-drawer' });
  expect(toggle.props.className).toBeTruthy();
  await act(async () => toggle.props.onClick());
  const drawer = root.findByProps({ id: 'chat-conversation-drawer' });
  expect(drawer.props['aria-modal']).toBe('true');
  expect(drawer.parent!.props.className).toBe('fixed inset-0 z-50');
  expect(root.findAllByType(ChatConversationList)).toHaveLength(2);
  expect(root.findByType(ChatLayout)).toBe(chat);
  await act(async () => root.findAllByType('button').find((b) => b.props.className?.includes('inset-0 bg-black/50'))!.props.onClick());
  expect(root.findAllByProps({ id: 'chat-conversation-drawer' })).toHaveLength(0);
  expect(root.findByType(ChatLayout)).toBe(chat);
});

test('mobile drawer selection switches the chat and closes the drawer', async () => {
  const { root, getSelected } = await mount(true, [{ id: 'older', title: '이전 대화', preview: '본문', updatedAt: new Date().toISOString(), messageCount: 2, source: 'cli', active: false, createdAt: '' }]);
  await act(async () => root.findByProps({ 'aria-label': '채팅 메뉴' }).props.onClick());
  await act(async () => root.findAllByType('button').find((b) => b.props['aria-controls'] === 'chat-conversation-drawer')!.props.onClick());
  const drawer = root.findByProps({ id: 'chat-conversation-drawer' });
  const before = root.findByType(ChatLayout);
  await act(async () => drawer.findAllByType('li')[0]!.findByType('button').props.onClick());
  expect(getSelected()).toBe('older');
  expect(root.findAllByProps({ id: 'chat-conversation-drawer' })).toHaveLength(0);
  expect(root.findByType(ChatLayout)).not.toBe(before);
});

test('1024px standalone chat retains the original header and controls', async () => {
  const { root } = await mount(true, [], 1024);
  expect(root.findAllByProps({ 'data-elanous-mobile-chat-status': '' })).toHaveLength(0);
  expect(root.findAllByProps({ 'aria-label': '채팅 메뉴' })).toHaveLength(0);
  expect(root.findAllByType(ChatCurrentProject)).toHaveLength(1);
  expect(root.findAllByType('aside')).toHaveLength(1);
  expect(root.findByType(ChatLayout).props.mobileSimple).toBeUndefined();
  expect(root.findByType(ChatLayout).props.mobileActivity).toBeUndefined();
});

test('wide standalone chat preserves its fixed left list and original header', async () => {
  const { root } = await mount(true, [], 1200);
  expect(root.findAllByType('aside')).toHaveLength(1);
  expect(root.findByType('aside').props.className).toContain('w-[260px] shrink-0 border-r border-border md:block');
  expect(root.findAllByProps({ 'data-elanous-chat-compact-header': '' })).toHaveLength(0);
  expect(root.findAllByProps({ 'aria-label': '채팅 더보기' })).toHaveLength(0);
  expect(root.findAllByProps({ 'aria-controls': 'chat-conversation-drawer' })).toHaveLength(1);
  expect(root.findByType(ChatLayout).props.leading).toBeUndefined();
});

test('standalone chat header displays the stored project and switches it through the session PATCH endpoint', async () => {
  const { root, calls, getProject } = await mount(true, [], 1200);
  const select = root.findByProps({ 'aria-label': '현재 대화 프로젝트' });
  expect(select.props.value).toBe('p');
  expect(select.findAllByType('option').find((option) => option.props.value === 'p')?.props.children).toBe('일');
  await act(async () => select.props.onChange({ target: { value: 'q' } }));
  expect(getProject()).toBe('q');
  expect(calls.findLast(({ init }) => init?.method === 'PATCH')?.path).toBe('/v1/sessions/store/one');
  expect(select.props.value).toBe('q');
});

test('changing conversations during a project PATCH shows the new conversation’s stored project', async () => {
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { innerWidth: 1200, location: { search: '' }, sessionStorage: { getItem: () => null }, localStorage: storage }) });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: new EventTarget() });
  let finishPatch: (() => void) | undefined;
  const client = { fetchJson: async (path: string, init?: RequestInit) => {
    if (path === '/v1/projects') return { projects: [{ id: 'p', name: '일', createdAt: '' }, { id: 'q', name: '개인', createdAt: '' }] };
    if (init?.method === 'PATCH') return await new Promise((resolve) => { finishPatch = () => resolve({ ok: true }); });
    if (path.includes('?ifExists=1')) return { meta: { projectId: path.includes('/two?') ? 'q' : 'p' }, messages: [] };
    return { sessions: [], messages: [] };
  }, sessionStoreEventsUrl: () => '', voiceWsUrl: () => '', connectAcp: () => { throw Error('offline'); } };
  let switchTo: ((id: string) => void) | undefined;
  function Host() {
    const [sessionId, setSessionId] = useState('one');
    switchTo = setSessionId;
    const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' }, sessionId, setSessionId, setConfig: () => {} };
    return <DaemonContext.Provider value={daemon}><ChatCurrentProject /></DaemonContext.Provider>;
  }
  await act(async () => { tree = create(<Host />); });
  const header = () => tree!.root.findByProps({ 'aria-label': '현재 대화 프로젝트' });
  expect(header().props.value).toBe('p');
  await act(async () => { header().props.onChange({ target: { value: '' } }); });
  expect(finishPatch).toBeDefined();
  await act(async () => { switchTo!('two'); });
  expect(header().props.value).toBe('q');
  expect(header().props.disabled).toBe(false);
  await act(async () => { finishPatch!(); });
  expect(header().props.value).toBe('q');
});

test('workspace-style ChatPanel keeps the original chat without conversation navigation', async () => {
  const { root } = await mount(false);
  expect(root.findAllByType(ChatLayout)).toHaveLength(1);
  expect(root.findAllByType(ChatConversationList)).toHaveLength(0);
});
