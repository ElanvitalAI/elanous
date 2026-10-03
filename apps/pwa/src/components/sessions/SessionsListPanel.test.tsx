import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import * as realNavigation from 'next/navigation';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';

const originalNavigation = { ...realNavigation };
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalEventSource = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
const pushed: string[] = [];
const deleted: string[] = [];
const selected: string[] = [];
const id = 'dialogue-1234';
const card = {
  id, title: '오늘의 이야기', source: 'cli', origin: 'pwa',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  messageCount: 2, preview: '안녕하세요', active: true,
};
let tree: ReactTestRenderer | undefined;
let empty = false;
let confirmed = false;
let confirmationText = '';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
mock.module('next/navigation', () => ({
  ...originalNavigation,
  useRouter: () => ({ push: (path: string) => pushed.push(path) }),
}));
const { SessionsListPanel } = await import('./SessionsListPanel');

afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  empty = false;
  confirmed = false;
  confirmationText = '';
  pushed.length = 0;
  deleted.length = 0;
  selected.length = 0;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: Window }).window;
  if (originalEventSource) Object.defineProperty(globalThis, 'EventSource', originalEventSource);
  else delete (globalThis as { EventSource?: typeof EventSource }).EventSource;
});
afterAll(() => mock.module('next/navigation', () => originalNavigation));

async function renderPanel() {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { confirm: (message: string) => { confirmationText = message; return confirmed; } },
  });
  const daemon = {
    config: { baseUrl: '', token: '', provider: '' },
    sessionId: id,
    setSessionId: (next: string) => selected.push(next),
    setConfig: () => {},
    client: {
      sessionStoreEventsUrl: () => '',
      fetchJson: async (path: string, options?: { method?: string }) => {
        if (options?.method === 'DELETE') { deleted.push(path); return { ok: true }; }
        if (path === `/v1/sessions/store/${id}`) return { messages: [] };
        return { sessions: empty ? [] : [card], total: empty ? 0 : 1 };
      },
    } as never,
  };
  await act(async () => { tree = create(createElement(DaemonContext.Provider, { value: daemon }, createElement(SessionsListPanel))); });
  return tree!;
}

function visibleText(node: ReactTestRenderer): string {
  return node.root.findAll(() => true).flatMap((element) => element.children.filter((child): child is string => typeof child === 'string')).join(' ');
}

test('목록의 제목·검색·빈 상태는 대화로 표시한다', async () => {
  empty = true;
  const panel = await renderPanel();
  expect(visibleText(panel)).toContain('대화 목록');
  expect(visibleText(panel)).toContain('대화가 없습니다.');
  expect(panel.root.findByProps({ type: 'search' }).props['aria-label']).toBe('대화 검색');
  expect(panel.root.findByProps({ type: 'search' }).props.placeholder).toBe('대화 검색 (제목·내용·id)');
});

test('목록 행의 이어가기·지우기 문면과 기존 ID·콜백을 유지한다', async () => {
  const panel = await renderPanel();
  expect(visibleText(panel)).toContain('대화 목록');
  expect(visibleText(panel)).toContain('대화중');
  const buttons = () => panel.root.findAllByType('button');
  expect(buttons().find((button) => button.props.title === '대화 지우기(복구 불가)')).toBeDefined();
  await act(async () => buttons().find((button) => button.children.includes('이어가기'))!.props.onClick());
  expect(selected.at(-1)).toBe(id);
  expect(pushed).toEqual(['/chat']);
  await act(async () => buttons().find((button) => button.props.title === '대화 지우기(복구 불가)')!.props.onClick());
  expect(deleted).toEqual([]);
  expect(confirmationText).toContain('이 대화를 지울까요? 복구할 수 없습니다.');
  confirmed = true;
  await act(async () => buttons().find((button) => button.props.title === '대화 지우기(복구 불가)')!.props.onClick());
  expect(deleted).toEqual([`/v1/sessions/store/${id}`]);
});
