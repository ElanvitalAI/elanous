import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { CompactTopBar } from './CompactTopBar';
import { AppShell } from './AppShell';
import { InstallBanner } from '@/components/install-banner';
import { MobileBottomTabs } from './MobileBottomTabs';
import ChatPage from '@/app/chat/page';
import { MobileChatStatus } from '@/components/chat/MobileChatStatus';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { WorkspaceProvider } from '@/components/workspace/WorkspaceProvider';
import { TopBar } from './TopBar';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { DaemonClient } from '@/lib/daemon-client';
import { ThemeProvider, THEMES } from '@/components/providers/ThemeProvider';
import { COMPACT_MAX_WIDTH } from '@/lib/compact-mode';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const previousAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
let width = COMPACT_MAX_WIDTH;
const listeners = new Map<string, Set<() => void>>();
const store = new Map<string, string>();
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  width = COMPACT_MAX_WIDTH;
  store.clear();
  listeners.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    get innerWidth() { return width; },
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    },
    addEventListener: (kind: string, listener: () => void) => { (listeners.get(kind) ?? listeners.set(kind, new Set()).get(kind)!).add(listener); },
    removeEventListener: (kind: string, listener: () => void) => { listeners.get(kind)?.delete(listener); },
    dispatchEvent: (event: { type: string; detail?: unknown }) => { (listeners.get(event.type) ?? new Set()).forEach((listener) => (listener as (event: unknown) => void)(event)); return true; },
    location: { search: '', href: 'https://example.test/chat' },
    sessionStorage: { getItem: () => null },
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    navigator: { standalone: false },
  } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: window.localStorage });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { wakeLock: { request: async () => ({ released: false, addEventListener() {}, release: async () => {} }) } } });
});

afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = undefined;
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else delete (globalThis as { window?: unknown }).window;
  if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
  if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
  else delete (globalThis as { document?: unknown }).document;
  if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
  else delete (globalThis as { navigator?: unknown }).navigator;
  if (previousAct === undefined) delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  else (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousAct;
});

describe('CompactTopBar', () => {
  test('shows only menu, current screen and more in a single short row; sheet retains every TopBar action and wide choice', () => {
    let wide = false;
    const config = { baseUrl: '', token: '', provider: 'codex' };
    const daemon = { config, client: new DaemonClient(config), sessionId: 'session-1', setSessionId() {}, setConfig() {} };
    act(() => { renderer = create(createElement(DaemonContext.Provider, { value: daemon },
      createElement(ThemeProvider, null, createElement(PathnameContext.Provider, { value: '/term' },
        createElement(CompactTopBar, { onToggleSidebar() {}, sidebarOpen: false, setWide: (next: boolean) => { wide = next; } }))))); });
    const header = renderer!.root.findByType('header');
    expect(header.props.className).toContain('h-10');
    expect(header.props.className).toContain('max-h-11');
    expect(header.findAllByType('button').map((button) => button.props['aria-label'])).toEqual(['open menu', '더 보기']);
    expect(header.findAllByType('span').some((span) => span.children.includes('터미널'))).toBe(true);
    act(() => header.findAllByType('button')[1]!.props.onClick());
    const sheet = renderer!.root.findByProps({ role: 'dialog' });
    expect(sheet.findAllByType('button')).toHaveLength(12);
    expect(sheet.findAllByType('a')).toHaveLength(2);
    expect(sheet.findAllByType('button').filter((button) => button.props.title === 'click to copy')).toHaveLength(1);
    expect(sheet.findAllByType('button').filter((button) => THEMES.some((name) => button.findAllByType('span').some((span) => span.children.includes(name))))).toHaveLength(THEMES.length);
    expect(sheet.findAllByType('button').filter((button) => button.props['aria-label'] === '시트 닫기')).toHaveLength(1);
    expect(sheet.findAllByType('button').filter((button) => button.props['aria-label'] === '공유용 캡처')).toHaveLength(1);
    expect(sheet.findAllByType('a').filter((link) => link.props['aria-label'] === 'voice')).toHaveLength(1);
    const settings = sheet.findAllByType('button').filter((button) => button.props['aria-label'] === 'settings');
    expect(settings).toHaveLength(1);
    expect(settings[0]!.props['aria-expanded']).toBe(true);
    expect(sheet.findAllByType('button').filter((button) => button.props.title === 'click to copy')).toHaveLength(1);
    expect(sheet.findAllByType('button').filter((button) => button.props.title === 'click to copy')[0]!.findAllByType('span').some((span) => span.children.includes('session-1'))).toBe(true);
    expect(sheet.findAllByType('span').some((span) => span.children.includes('codex'))).toBe(true);
    expect(sheet.findAllByType('a').filter((link) => link.props.href === '/settings')).toHaveLength(1);
    for (const name of THEMES) {
      expect(sheet.findAllByType('button').filter((button) => button.findAllByType('span').some((span) => span.children.includes(name)))).toHaveLength(1);
    }
    const wakeLock = sheet.findAllByType('button').filter((button) => button.props.title === '화면 깨움 유지');
    expect(wakeLock).toHaveLength(1);
    act(() => wakeLock[0]!.props.onClick());
    expect(sheet.findAllByType('button').filter((button) => button.props.title === '화면 깨움 해제')).toHaveLength(1);
    const theme = sheet.findAllByType('button').find((button) => button.findAllByType('span').some((span) => span.children.includes('catppuccin-latte')))!;
    act(() => theme.props.onClick());
    expect(store.get('elanous.pwa.theme')).toBe('catppuccin-latte');
    act(() => settings[0]!.props.onClick());
    expect(sheet.findAllByType('button').filter((button) => button.props.title === 'click to copy')).toHaveLength(0);
    act(() => settings[0]!.props.onClick());
    expect(sheet.findAllByType('button').filter((button) => button.props.title === 'click to copy')).toHaveLength(1);
    expect(sheet.findAllByType('button').some((button) => button.children.includes('넓게 보기'))).toBe(true);
    const wideButton = sheet.findAllByType('button').find((button) => button.children.includes('넓게 보기'))!;
    act(() => wideButton.props.onClick());
    expect(wide).toBe(true);
    expect(renderer!.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });

  test('modal moves focus inside, wraps Tab in both directions, handles Escape and restores the trigger', () => {
    class FocusTarget {
      isConnected = true;
      visible = true;
      getClientRects() { return this.visible ? [{ width: 1 }] : []; }
      focus() { active = this; }
      contains(target: unknown) { return target === this || items.includes(target as FocusTarget); }
      querySelectorAll() { return items; }
    }
    let active: FocusTarget | null = null;
    const items = [new FocusTarget(), new FocusTarget()];
    const trigger = new FocusTarget();
    const sheet = new FocusTarget();
    const handlers = new Set<(event: { key: string; shiftKey?: boolean; preventDefault(): void }) => void>();
    const focusHandlers = new Set<(event: { target: FocusTarget }) => void>();
    const previousElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
    Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: FocusTarget });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
      get activeElement() { return active; },
      addEventListener: (name: string, fn: (event: never) => void) => {
        if (name === 'keydown') handlers.add(fn as (event: { key: string; shiftKey?: boolean; preventDefault(): void }) => void);
        if (name === 'focusin') focusHandlers.add(fn as (event: { target: FocusTarget }) => void);
      },
      removeEventListener: (name: string, fn: (event: never) => void) => {
        if (name === 'keydown') handlers.delete(fn as (event: { key: string; shiftKey?: boolean; preventDefault(): void }) => void);
        if (name === 'focusin') focusHandlers.delete(fn as (event: { target: FocusTarget }) => void);
      },
      documentElement: { dataset: {} },
    } });
    const config = { baseUrl: '', token: '', provider: '' };
    const daemon = { config, client: new DaemonClient(config), sessionId: 'session-1', setSessionId() {}, setConfig() {} };
    const key = (name: string, shiftKey = false) => {
      let prevented = false;
      act(() => handlers.forEach((handler) => handler({ key: name, shiftKey, preventDefault() { prevented = true; } })));
      return prevented;
    };
    try {
      act(() => { renderer = create(createElement(DaemonContext.Provider, { value: daemon },
        createElement(ThemeProvider, null, createElement(CompactTopBar, { onToggleSidebar() {}, sidebarOpen: false, setWide() {} }))), {
        createNodeMock: ({ type, props }) => (props as { role?: string; 'aria-label'?: string }).role === 'dialog' ? sheet : type === 'button' && (props as { 'aria-label'?: string })['aria-label'] === '더 보기' ? trigger : null,
      }); });
      active = trigger;
      act(() => renderer!.root.findByProps({ 'aria-label': '더 보기' }).props.onClick());
      expect(active).toBe(sheet);
      expect(key('Tab', true)).toBe(true);
      expect(active).toBe(items[1]);
      active = sheet;
      expect(key('Tab')).toBe(false);
      active = items[1]!;
      expect(key('Tab')).toBe(true);
      expect(active).toBe(items[0]);
      expect(key('Tab', true)).toBe(true);
      expect(active).toBe(items[1]);
      items[1]!.visible = false;
      active = items[0]!;
      expect(key('Tab')).toBe(true);
      expect(active).toBe(items[0]);
      items[1]!.visible = true;
      active = trigger;
      expect(key('Tab')).toBe(true);
      expect(active).toBe(items[0]);
      active = trigger;
      act(() => focusHandlers.forEach((handler) => handler({ target: trigger })));
      expect(active).toBe(items[0]);
      expect(key('Escape')).toBe(true);
      expect(renderer!.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
      expect(active).toBe(trigger);
      expect(handlers.size).toBe(0);
      expect(focusHandlers.size).toBe(0);
      act(() => renderer!.root.findByProps({ 'aria-label': '더 보기' }).props.onClick());
      act(() => renderer!.root.findByProps({ 'aria-label': '시트 닫기', className: 'rounded p-2' }).props.onClick());
      expect(active).toBe(trigger);
      active = new FocusTarget();
      act(() => renderer!.root.findByProps({ 'aria-label': '더 보기' }).props.onClick());
      act(() => renderer!.root.findByProps({ 'aria-label': '시트 닫기', className: 'rounded p-2' }).props.onClick());
      expect(active).toBe(trigger);
    } finally {
      if (previousElement) Object.defineProperty(globalThis, 'HTMLElement', previousElement);
      else delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
    }
  });

  test('wake lock remains requested across sheet close/reopen and compact/wide switches, then releases when turned off', async () => {
    let requests = 0;
    let releases = 0;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { wakeLock: { request: async () => {
      requests++;
      return { released: false, addEventListener() {}, async release() { if (!this.released) { this.released = true; releases++; } } };
    } } } });
    const config = { baseUrl: '', token: '', provider: '' };
    const daemon = { config, client: new DaemonClient(config), sessionId: 'session-1', setSessionId() {}, setConfig() {} };
    await act(async () => { renderer = create(createElement(DaemonContext.Provider, { value: daemon },
      createElement(ThemeProvider, null, createElement(AppRouterContext.Provider, { value: { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as never },
        createElement(AppShell, { activity: { kind: 'quiet' }, children: createElement('p', null, 'room') }))))); });
    const openSheet = () => act(() => renderer!.root.findByType(CompactTopBar).findByType('header').findAllByType('button')[1]!.props.onClick());
    openSheet();
    await act(async () => renderer!.root.findByProps({ role: 'dialog' }).findAllByType('button').find((b) => b.props.title === '화면 깨움 유지')!.props.onClick());
    expect(requests).toBe(1);
    act(() => renderer!.root.findByProps({ role: 'dialog' }).findAllByType('button').find((b) => b.props['aria-label'] === '시트 닫기')!.props.onClick());
    expect(releases).toBe(0);
    openSheet();
    expect(renderer!.root.findByProps({ role: 'dialog' }).findAllByType('button').some((b) => b.props.title === '화면 깨움 해제')).toBe(true);
    const wide = renderer!.root.findByProps({ role: 'dialog' }).findAllByType('button').find((b) => b.children.includes('넓게 보기'))!;
    act(() => wide.props.onClick());
    expect(renderer!.root.findByType(TopBar).findAllByType('button').some((b) => b.props.title === '화면 깨움 해제')).toBe(false);
    const settings = renderer!.root.findByType(TopBar).findAllByType('button').find((b) => b.props['aria-label'] === 'settings')!;
    act(() => settings.props.onClick());
    expect(renderer!.root.findByType(TopBar).findAllByType('button').some((b) => b.props.title === '화면 깨움 해제')).toBe(true);
    expect(releases).toBe(0);
    act(() => renderer!.root.findByType(TopBar).findAllByType('button').find((b) => b.children.includes('간소하게 보기'))!.props.onClick());
    openSheet();
    expect(renderer!.root.findByProps({ role: 'dialog' }).findAllByType('button').some((b) => b.props.title === '화면 깨움 해제')).toBe(true);
    expect(requests).toBe(1);
    expect(releases).toBe(0);
    await act(async () => renderer!.root.findByProps({ role: 'dialog' }).findAllByType('button').find((b) => b.props.title === '화면 깨움 해제')!.props.onClick());
    expect(store.get('elanous.pwa.wakeLockOn')).toBe('0');
    expect(releases).toBe(1);
  });

  test('connection activity remains accessible in the more sheet', () => {
    const config = { baseUrl: '', token: '', provider: '' };
    const daemon = { config, client: new DaemonClient(config), sessionId: 'session-1', setSessionId() {}, setConfig() {} };
    act(() => { renderer = create(createElement(DaemonContext.Provider, { value: daemon },
      createElement(ThemeProvider, null, createElement(CompactTopBar, { onToggleSidebar() {}, sidebarOpen: false, setWide() {}, activity: { kind: 'error', message: 'connection lost' } })))); });
    expect(renderer!.root.findByType('header').findAllByProps({ 'data-elanous-component': 'topbar-activity' })).toHaveLength(0);
    act(() => renderer!.root.findByType('header').findAllByType('button')[1]!.props.onClick());
    expect(renderer!.root.findByProps({ role: 'dialog' }).findAllByProps({ 'data-elanous-component': 'topbar-activity' })).toHaveLength(1);
  });

  test('workspace route names its active tab without adding a second header row', async () => {
    const config = { baseUrl: '', token: '', provider: '' };
    const daemon = { config, client: new DaemonClient(config), sessionId: 'session-1', setSessionId() {}, setConfig() {} };
    await act(async () => { renderer = create(createElement(DaemonContext.Provider, { value: daemon },
      createElement(ThemeProvider, null, createElement(PathnameContext.Provider, { value: '/workspace' },
        createElement(AppRouterContext.Provider, { value: { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as never },
          createElement(AppShell, { activity: { kind: 'quiet' }, children: createElement('p', null, 'room') })))))); });
    const workspace = renderer!.root.findByType(CompactTopBar);
    expect(renderer!.root.findAllByType(WorkspaceProvider)).toHaveLength(1);
    expect(workspace.findByType('header').findAllByType('span').some((span) => span.children.includes('여러 탭'))).toBe(true);
    expect(workspace.findByType('header').findAllByType('button')).toHaveLength(2);
  });

  test('menu toggles and the sheet dismisses without dropping the compact row', () => {
    const config = { baseUrl: '', token: '', provider: '' };
    const daemon = { config, client: new DaemonClient(config), sessionId: 'session-1', setSessionId() {}, setConfig() {} };
    let toggles = 0;
    act(() => { renderer = create(createElement(DaemonContext.Provider, { value: daemon },
      createElement(ThemeProvider, null, createElement(CompactTopBar, { onToggleSidebar: () => { toggles += 1; }, sidebarOpen: false, setWide() {} })))); });
    const header = renderer!.root.findByType('header');
    act(() => header.findAllByType('button')[0]!.props.onClick());
    expect(toggles).toBe(1);
    act(() => header.findAllByType('button')[1]!.props.onClick());
    expect(renderer!.root.findAllByProps({ role: 'dialog' })).toHaveLength(1);
    act(() => renderer!.root.findByProps({ 'aria-label': '시트 닫기', className: 'rounded p-2' }).props.onClick());
    expect(renderer!.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
    expect(renderer!.root.findByType('header').props.className).toContain('h-10');
  });

  test('AppShell chooses a compact row at the boundary and the existing TopBar above it', async () => {
    const config = { baseUrl: '', token: '', provider: '' };
    const daemon = { config, client: new DaemonClient(config), sessionId: 'session-1', setSessionId() {}, setConfig() {} };
    await act(async () => { renderer = create(createElement(DaemonContext.Provider, { value: daemon },
      createElement(ThemeProvider, null, createElement(AppRouterContext.Provider, { value: { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as never },
        createElement(AppShell, { activity: { kind: 'quiet' }, children: createElement('p', null, 'room') }))))); });
    expect(renderer!.root.findAllByType(CompactTopBar)).toHaveLength(1);
    expect(renderer!.root.findAllByType(TopBar)).toHaveLength(0);
    width = COMPACT_MAX_WIDTH + 1;
    act(() => listeners.get('resize')?.forEach((listener) => listener()));
    expect(renderer!.root.findAllByType(CompactTopBar)).toHaveLength(0);
    expect(renderer!.root.findAllByType(TopBar)).toHaveLength(1);
    width = COMPACT_MAX_WIDTH;
    act(() => listeners.get('resize')?.forEach((listener) => listener()));
    expect(renderer!.root.findAllByType(CompactTopBar)).toHaveLength(1);
    const more = renderer!.root.findByType('header').findAllByType('button')[1]!;
    act(() => more.props.onClick());
    const wide = renderer!.root.findByProps({ role: 'dialog' }).findAllByType('button').find((button) => button.children.includes('넓게 보기'))!;
    act(() => wide.props.onClick());
    expect(renderer!.root.findAllByType(CompactTopBar)).toHaveLength(0);
    expect(renderer!.root.findAllByType(TopBar)).toHaveLength(1);
    const compact = renderer!.root.findByType('header').findAllByType('button').find((button) => button.children.includes('간소하게 보기'))!;
    act(() => compact.props.onClick());
    expect(renderer!.root.findAllByType(CompactTopBar)).toHaveLength(1);
  });

  test('390px /chat composes one status row across AppShell and ChatPage without install banner', async () => {
    const config = { baseUrl: '', token: '', provider: '' };
    const daemon = { config, client: new DaemonClient(config), sessionId: 'session-1', setSessionId() {}, setConfig() {} };
    width = 390;
    await act(async () => { renderer = create(createElement(DaemonContext.Provider, { value: daemon },
      createElement(ThemeProvider, null, createElement(PathnameContext.Provider, { value: '/chat' },
        createElement(AppRouterContext.Provider, { value: { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as never },
          createElement(AppShell, { activity: { kind: 'quiet' }, children: createElement(ChatPage) })))))); });
    expect(renderer!.root.findAllByProps({ 'data-elanous-mobile-chat-status': '' })).toHaveLength(1);
    expect(renderer!.root.findAllByType(CompactTopBar)).toHaveLength(0);
    expect(renderer!.root.findAllByType(TopBar)).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ 'data-testid': 'install-banner' })).toHaveLength(0);
    expect(renderer!.root.findByType(ChatPanel).props.mobileSimple).toBe(true);
  });

  test('390px chat suppresses shell top rows but keeps bottom tabs (primary navigation); 1024px and other routes keep their shell', async () => {
    const config = { baseUrl: '', token: '', provider: '' };
    const daemon = { config, client: new DaemonClient(config), sessionId: 'session-1', setSessionId() {}, setConfig() {} };
    const mountShell = (path: string) => create(createElement(DaemonContext.Provider, { value: daemon },
      createElement(ThemeProvider, null, createElement(PathnameContext.Provider, { value: path },
        createElement(AppRouterContext.Provider, { value: { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as never },
          createElement(AppShell, { activity: { kind: 'quiet' }, children: createElement('p', null, 'room') }))))));
    width = 390;
    await act(async () => { renderer = mountShell('/chat'); });
    expect(renderer!.root.findAllByType(CompactTopBar)).toHaveLength(0);
    expect(renderer!.root.findAllByType(TopBar)).toHaveLength(0);
    expect(renderer!.root.findAllByType(MobileBottomTabs)).toHaveLength(1);
    expect(renderer!.root.findAllByType(InstallBanner)).toHaveLength(1);
    await act(async () => { renderer!.update(createElement(DaemonContext.Provider, { value: daemon },
      createElement(ThemeProvider, null, createElement(PathnameContext.Provider, { value: '/term' },
        createElement(AppRouterContext.Provider, { value: { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as never },
          createElement(AppShell, { activity: { kind: 'quiet' }, children: createElement('p', null, 'room') })))))); });
    expect(renderer!.root.findAllByType(CompactTopBar)).toHaveLength(1);
    expect(renderer!.root.findAllByType(MobileBottomTabs)).toHaveLength(1);
    width = 1024;
    act(() => listeners.get('resize')?.forEach((listener) => listener()));
    expect(renderer!.root.findAllByType(TopBar)).toHaveLength(1);
    expect(renderer!.root.findAllByType(CompactTopBar)).toHaveLength(0);
    await act(async () => { renderer!.update(createElement(DaemonContext.Provider, { value: daemon },
      createElement(ThemeProvider, null, createElement(PathnameContext.Provider, { value: '/chat' },
        createElement(AppRouterContext.Provider, { value: { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as never },
          createElement(AppShell, { activity: { kind: 'quiet' }, children: createElement('p', null, 'room') })))))); });
    expect(renderer!.root.findAllByType(TopBar)).toHaveLength(1);
    expect(renderer!.root.findAllByType(InstallBanner)).toHaveLength(1);
  });

  test('wide TopBar retains the original header and only offers compact view within the compact width', () => {
    const config = { baseUrl: '', token: '', provider: '' };
    const daemon = { config, client: new DaemonClient(config), sessionId: 'session-1', setSessionId() {}, setConfig() {} };
    let compactCalls = 0;
    width = COMPACT_MAX_WIDTH + 1;
    act(() => { renderer = create(createElement(DaemonContext.Provider, { value: daemon },
      createElement(ThemeProvider, null, createElement(TopBar, { onToggleSidebar() {}, sidebarOpen: false, onCompactView: () => { compactCalls += 1; } })))); });
    const bar = renderer!.root.findByType('header');
    expect(bar.props.className).toBe('flex h-9 shrink-0 items-center gap-1 border-b border-border bg-background px-2 text-xs');
    expect(bar.findAllByType('button').some((button) => button.children.includes('간소하게 보기'))).toBe(false);
    width = COMPACT_MAX_WIDTH;
    act(() => listeners.get('resize')?.forEach((listener) => listener()));
    const compactButton = renderer!.root.findByType('header').findAllByType('button').find((button) => button.children.includes('간소하게 보기'))!;
    expect(compactButton).toBeDefined();
    act(() => compactButton.props.onClick());
    expect(compactCalls).toBe(1);
  });
});
