import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { COMPACT_MAX_WIDTH } from '@/lib/compact-mode';
import { PWA_ROLE_KEY } from '@/lib/pwa-role';
import * as operatorModule from '@/lib/use-operator';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { DaemonClient } from '@/lib/daemon-client';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { NAV_SHOW_HIDDEN_KEY, NAV_SHOW_LABS_KEY } from './sidebar-nav-items';
import { NAV_PREFS_EVENT } from './nav-visibility-prefs';
import { userIntentLogger } from '@/lib/user-intent-logger';

import { MobileBottomTabs } from './MobileBottomTabs';
import { AppShell } from './AppShell';
import { SidebarNav } from './SidebarNav';

let operator = false;

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const previousAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
let width = COMPACT_MAX_WIDTH;
let pathname = '/chat';
const store = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();
let tree: ReactTestRenderer | undefined;
const operatorSpy = spyOn(operatorModule, 'useOperator').mockImplementation(() => operator);
const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as never;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  width = COMPACT_MAX_WIDTH;
  pathname = '/chat';
  operator = false;
  store.clear();
  listeners.clear();
  store.set(PWA_ROLE_KEY, 'owner');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    get innerWidth() { return width; },
    localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } },
    addEventListener: (kind: string, listener: () => void) => { (listeners.get(kind) ?? listeners.set(kind, new Set()).get(kind)!).add(listener); },
    removeEventListener: (kind: string, listener: () => void) => { listeners.get(kind)?.delete(listener); },
    dispatchEvent: (event: { type: string }) => { listeners.get(event.type)?.forEach((listener) => listener()); return true; },
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    navigator: { standalone: false },
  } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: window.localStorage });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {} } });
});

afterEach(() => {
  if (tree) act(() => tree?.unmount());
  tree = undefined;
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else delete (globalThis as { window?: unknown }).window;
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
  if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
  else delete (globalThis as { document?: unknown }).document;
  if (previousAct === undefined) delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  else (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousAct;
});
afterAll(() => operatorSpy.mockRestore());

function mount(component: React.ReactNode = createElement(MobileBottomTabs)) {
  act(() => { tree = create(createElement(PathnameContext.Provider, { value: pathname }, createElement(AppRouterContext.Provider, { value: router }, component))); });
  return tree!.root;
}
function bottomNav() { return tree!.root.findByProps({ 'aria-label': '아래 탭' }); }
function open(name: string) {
  const button = bottomNav().findAllByType('button').find((node) => node.props['aria-label'] === name)!;
  act(() => button.props.onClick({ currentTarget: null }));
  return tree!.root.findByProps({ role: 'dialog' });
}

test('retained mobile links emit route intent for direct tabs and sheet destinations', () => {
  const emit = spyOn(userIntentLogger, 'emit').mockResolvedValue({ ok: true });
  try {
    mount();
    const chat = bottomNav().findAllByType('a').find((node) => node.props.href === '/chat')!;
    act(() => chat.props.onClick({ currentTarget: { nodeName: 'A' }, defaultPrevented: false, preventDefault() {} }));
    expect(emit).toHaveBeenCalledWith({
      surface: 'pwa',
      intent: { layer: 'navigation', kind: 'pwa.navigation.bottom_tab_open', target: { kind: 'route', id: '/chat' } },
      surface_state: { route: '/chat' },
    });

    const sheet = open('만들기');
    const term = sheet.findAllByType('a').find((node) => node.props.href === '/term')!;
    act(() => term.props.onClick({ currentTarget: { nodeName: 'A' }, defaultPrevented: false, preventDefault() {} }));
    expect(emit).toHaveBeenCalledWith({
      surface: 'pwa',
      intent: { layer: 'navigation', kind: 'pwa.navigation.bottom_tab_open', target: { kind: 'route', id: '/term' } },
      surface_state: { route: '/chat' },
    });
  } finally {
    emit.mockRestore();
  }
});

test('compact AppShell reserves space for retained tabs and more, wide shell has no bottom tabs or spacing', () => {
  const config = { baseUrl: '', token: '', provider: '' };
  const daemon = { config, client: new DaemonClient(config), sessionId: 's', setSessionId() {}, setConfig() {} };
  mount(createElement(DaemonContext.Provider, { value: daemon }, createElement(ThemeProvider, null,
    createElement(AppShell, { activity: { kind: 'quiet' }, children: createElement('p', null, 'body') }))));
  expect(bottomNav().findAllByType('button').map((node) => node.props['aria-label'])).toEqual(['실행', '만들기', '더보기']);
  expect(bottomNav().findAllByType('a').map((node) => [node.props['aria-label'], node.props.href])).toEqual([['대화', '/chat']]);
  expect(bottomNav().props.className).toContain('h-[calc(3.5rem+env(safe-area-inset-bottom))]');
  expect(bottomNav().props.className).toContain('pb-[env(safe-area-inset-bottom)]');
  expect(bottomNav().findByType('div').props.className).toContain('h-full');
  expect(bottomNav().findAllByType('button').every((node) => node.props.className.includes('text-xs'))).toBe(true);
  expect(bottomNav().findAllByType('span').map((node) => node.children.join(''))).toEqual(['대화', '실행', '만들기', '더보기']);
  expect(bottomNav().findAllByType('svg')).toHaveLength(4);
  expect(open('실행').findAllByType('a').map((node) => node.props.href)).toEqual(['/live-run', '/board']);
  const main = tree!.root.findByType('main');
  expect(main.props.className).toBe('flex-1 overflow-auto min-w-0');
  width = COMPACT_MAX_WIDTH + 1;
  act(() => listeners.get('resize')?.forEach((listener) => listener()));
  expect(tree!.root.findAllByProps({ 'aria-label': '아래 탭' })).toHaveLength(0);
  expect(tree!.root.findByType('main').props.className).toBe('flex-1 overflow-auto min-w-0');
});

test('active group follows retained direct and nested routes, including more', () => {
  pathname = '/live-run/adaptive';
  mount();
  expect(bottomNav().findByProps({ 'aria-label': '실행' }).props.className).toContain('text-primary');
  act(() => tree!.unmount());
  pathname = '/settings';
  mount();
  expect(bottomNav().findByProps({ 'aria-label': '더보기' }).props.className).toContain('text-primary');
  expect(bottomNav().findByProps({ 'aria-label': '실행' }).props.className).not.toContain('text-primary');
});

test('retained more sheet groups files and settings without retired operations routes', () => {
  mount();
  const more = open('더보기');
  expect(more.findAllByType('section').map((node) => node.props['aria-label'])).toEqual(['자료', '설정']);
  const settings = more.findByProps({ 'aria-label': '설정' });
  expect(settings.findAllByType('a').map((node) => node.props.href)).toEqual(['/settings', '/credentials']);
  expect(more.findAllByType('h2').map((node) => node.children.join(''))).toEqual(['설정']);
  expect(more.findAllByType('a').map((node) => node.props.href)).not.toContain('/ops/release');
  act(() => tree!.unmount());
  operator = true;
  mount();
  expect(open('더보기').findAllByType('section').map((node) => node.props['aria-label'])).toEqual(['자료', '설정']);
  expect(tree!.root.findByProps({ role: 'dialog' }).findAllByType('a').map((node) => node.props.href)).not.toContain('/ops/release');
  expect(tree!.root.findByProps({ role: 'dialog' }).findAllByType('a').map((node) => node.props.href)).toContain('/vault');
  const operatorHrefs = tree!.root.findByProps({ role: 'dialog' }).findAllByType('a').map((node) => node.props.href);
  expect(operatorHrefs).not.toContain('/ops/checklist');
  expect(operatorHrefs).not.toContain('/ceo');
});

test('single visible item navigates directly without a sheet, and role/Labs hide forbidden items', () => {
  store.set(PWA_ROLE_KEY, 'general');
  mount();
  const nav = bottomNav();
  expect(nav.findAllByType('a').map((node) => node.props.href)).toContain('/chat');
  expect(nav.findAllByType('a').map((node) => node.props.href)).not.toContain('/live-run');
  expect(tree!.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  // EDITOR-NAV-PUBLIC: 만들기 = 터미널 ⊕ 편집기 — 둘이라 시트로 연다(역할을 안 고른 기기에도 편집기가 보인다).
  expect(open('만들기').findAllByType('a').map((node) => node.props.href)).toEqual(['/term', '/editor']);
  act(() => tree!.root.findByProps({ 'aria-label': '메뉴 닫기', className: 'rounded-md p-2' }).props.onClick());
  const more = open('더보기');
  expect(more.findAllByType('section').map((node) => node.props['aria-label'])).toEqual(['설정']);
  expect(more.findAllByType('a').map((node) => node.props.href)).toContain('/settings');
  expect(more.findAllByType('a').map((node) => node.props.href)).not.toContain('/ops/release');
  act(() => tree!.unmount());
  store.set(PWA_ROLE_KEY, 'owner');
  mount();
  expect(open('만들기').findAllByType('a').map((node) => node.props.href)).toEqual(['/term', '/editor', '/apps', '/design-check']);
  act(() => { store.set(NAV_SHOW_LABS_KEY, '1'); window.dispatchEvent(new Event(NAV_PREFS_EVENT)); });
  expect(tree!.root.findByProps({ role: 'dialog' }).findAllByType('a').map((node) => node.props.href)).toEqual(['/term', '/editor', '/apps', '/design-check']);
  act(() => { store.set(NAV_SHOW_HIDDEN_KEY, '1'); window.dispatchEvent(new Event(NAV_PREFS_EVENT)); });
  expect(tree!.root.findByProps({ role: 'dialog' }).findAllByType('a').map((node) => node.props.href)).not.toContain('/control');
  act(() => tree!.root.findByProps({ role: 'dialog' }).findByProps({ 'aria-label': '메뉴 닫기', className: 'rounded-md p-2' }).props.onClick());
  expect(open('더보기').findAllByType('a').map((node) => node.props.href)).not.toContain('/control');
});

test('sidebar renders a single visible item without the duplicate group heading', () => {
  mount(createElement(SidebarNav));
  const files = tree!.root.findByProps({ 'aria-label': '자료' });
  expect(files.findAllByType('button')).toHaveLength(0);
  expect(files.findAllByType('a').map((node) => node.props.href)).toEqual(['/vault']);
  expect(files.findAllByType('a')[0]!.children.filter((child) => child === 'Obsidian 노트')).toHaveLength(1);
  expect(files.findAllByType('a')[0]!.findAllByType('svg')).toHaveLength(1);
  expect(files.findAll((node) => node.children.includes('자료'))).toHaveLength(0);
});
