import { afterEach, expect, test } from 'bun:test';
import { useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import ChatPage from '@/app/chat/page';
import { ChatPanel } from './ChatPanel';
import { ChatLayout } from './ChatLayout';
import { ChatConversationList } from './ChatConversationList';
import { _resetSessionsServiceSingletonForTest } from '@/lib/sessions-service';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | undefined;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  _resetSessionsServiceSingletonForTest();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: Window }).window;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete (globalThis as { document?: Document }).document;
});

async function mount(show: boolean, entries: Array<{ id: string; title: string; preview: string; updatedAt: string; messageCount: number; source: string; active: boolean; createdAt: string }> = [], width = 412) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { innerWidth: width, location: { search: '' }, sessionStorage: { getItem: () => null } }) });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: new EventTarget() });
  const client = { fetchJson: async () => ({ sessions: entries, messages: [] }), sessionStoreEventsUrl: () => '', voiceWsUrl: () => '', connectAcp: () => { throw Error('offline'); } };
  let selected = 'one';
  function Host() {
    const [sessionId, setSessionId] = useState('one');
    selected = sessionId;
    const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' }, sessionId, setSessionId, setConfig: () => {} };
    return <DaemonContext.Provider value={daemon}>{show ? <ChatPage /> : <ChatPanel />}</DaemonContext.Provider>;
  }
  await act(async () => { tree = create(<Host />); });
  return { root: tree!.root, getSelected: () => selected };
}

test('/chat has a fixed desktop column and a mobile button opening a dismissible drawer without replacing chat', async () => {
  const { root } = await mount(true);
  const desktop = root.findAllByType('aside')[0]!;
  expect(desktop.props.className).toBe('hidden');
  expect(desktop.findAllByType(ChatConversationList)).toHaveLength(1);
  expect(root.findAllByType(ChatLayout)).toHaveLength(1);
  const chat = root.findByType(ChatLayout);
  const toggle = root.findAllByType('button').find((b) => b.props['aria-controls'] === 'chat-conversation-drawer')!;
  const compactHeader = root.findByProps({ 'data-elanous-chat-compact-header': '' });
  expect(compactHeader.findAllByProps({ 'aria-label': '대화 목록' })).toHaveLength(1);
  expect(compactHeader.findAllByProps({ 'aria-label': '채팅 더보기' })).toHaveLength(1);
  expect(root.findAllByType('button').filter((b) => b.props['aria-controls'] === 'chat-conversation-drawer')).toHaveLength(1);
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
  await act(async () => root.findAllByType('button').find((b) => b.props['aria-controls'] === 'chat-conversation-drawer')!.props.onClick());
  const drawer = root.findByProps({ id: 'chat-conversation-drawer' });
  const before = root.findByType(ChatLayout);
  await act(async () => drawer.findAllByType('li')[0]!.findByType('button').props.onClick());
  expect(getSelected()).toBe('older');
  expect(root.findAllByProps({ id: 'chat-conversation-drawer' })).toHaveLength(0);
  expect(root.findByType(ChatLayout)).not.toBe(before);
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

test('workspace-style ChatPanel keeps the original chat without conversation navigation', async () => {
  const { root } = await mount(false);
  expect(root.findAllByType(ChatLayout)).toHaveLength(1);
  expect(root.findAllByType(ChatConversationList)).toHaveLength(0);
});
