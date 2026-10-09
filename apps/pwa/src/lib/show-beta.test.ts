import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createElement, Fragment } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { PWA_ROLE_EVENT, PWA_ROLE_KEY } from './pwa-role';
import { PwaRolePicker } from '../components/shell/PwaRolePicker';
import { SidebarNav } from '../components/shell/SidebarNav';
import { MobileBottomTabs } from '../components/shell/MobileBottomTabs';
import { SHOW_BETA_EVENT, SHOW_BETA_KEY, useShowBeta } from './show-beta';

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const previousAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
const store = new Map<string, string>();
const listeners = new Map<string, Set<(event: Event) => void>>();
let readFails = false;
let writeFails = false;
let tree: ReactTestRenderer | undefined;
let secondTree: ReactTestRenderer | undefined;
let first: ReturnType<typeof useShowBeta>;
let second: ReturnType<typeof useShowBeta>;

function First(): null { first = useShowBeta(); return null; }
function Second(): null { second = useShowBeta(); return null; }
function mount(): void { act(() => { tree = create(createElement(First)); secondTree = create(createElement(Second)); }); }

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  store.clear();
  listeners.clear();
  readFails = false;
  writeFails = false;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: {
      getItem: (key: string) => { if (readFails) throw Error('blocked'); return store.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (writeFails) throw Error('blocked'); store.set(key, value); },
      removeItem: (key: string) => { if (writeFails) throw Error('blocked'); store.delete(key); },
    },
    addEventListener: (kind: string, listener: (event: Event) => void) => { (listeners.get(kind) ?? listeners.set(kind, new Set()).get(kind)!).add(listener); },
    removeEventListener: (kind: string, listener: (event: Event) => void) => { listeners.get(kind)?.delete(listener); },
    dispatchEvent: (event: Event) => { for (const listener of listeners.get(event.type) ?? []) listener(event); return true; },
  } });
});

afterEach(() => {
  act(() => { tree?.unmount(); secondTree?.unmount(); });
  tree = undefined;
  secondTree = undefined;
  for (const set of listeners.values()) expect(set.size).toBe(0);
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else delete (globalThis as { window?: unknown }).window;
  if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
  else delete (globalThis as { document?: unknown }).document;
  if (previousAct === undefined) delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  else (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousAct;
});

test('the general-only switch updates desktop and mobile beta menus and badges immediately', () => {
  store.set(PWA_ROLE_KEY, 'general');
  const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as never;
  act(() => { tree = create(createElement(PathnameContext.Provider, { value: '/chat' },
    createElement(AppRouterContext.Provider, { value: router },
      createElement(Fragment, null, createElement(PwaRolePicker), createElement(SidebarNav), createElement(MobileBottomTabs))))); });
  const root = tree!.root;
  const sidebar = () => root.findAllByType('nav').find((node) => node.props['aria-label'] !== '아래 탭')!;
  const hrefs = () => sidebar().findAllByType('a').map((link) => link.props.href);
  const sheet = () => root.findByProps({ role: 'dialog' });
  const open = (label: string) => act(() => root.findByProps({ 'aria-label': '아래 탭' }).findAllByType('button').find((node) => node.props['aria-label'] === label)!.props.onClick({ currentTarget: null }));
  const close = () => act(() => sheet().findAllByProps({ 'aria-label': '메뉴 닫기' })[0]!.props.onClick());
  expect(hrefs()).toEqual(['/today', '/chat', '/live', '/term', '/editor', '/market', '/settings']);
  expect(root.findAllByProps({ role: 'switch' })).toHaveLength(1);
  expect(root.findByProps({ role: 'switch' }).props.checked).toBe(false);
  expect(root.findByProps({ 'aria-label': '아래 탭' }).findAllByType('a').find((link) => link.props['aria-label'] === '오늘')?.props.href).toBe('/today');
  act(() => root.findByProps({ role: 'switch' }).props.onChange({ currentTarget: { checked: true } }));
  expect(root.findByProps({ role: 'switch' }).props.checked).toBe(true);
  for (const path of ['/exec', '/field', '/trace', '/autopilot', '/vault', '/intake']) {
    expect(hrefs()).toContain(path);
    expect(sidebar().findAllByType('a').find((link) => link.props.href === path)!.findAllByType('span').some((node) => node.children.includes('실험'))).toBe(true);
  }
  for (const path of ['/approvals', '/scheduler', '/ops/release', '/design-check']) expect(hrefs()).not.toContain(path);
  expect(sidebar().findAllByType('a').find((link) => link.props.href === '/settings')!.findAllByType('span').some((node) => node.children.includes('실험'))).toBe(false);
  // NAV2c (#23048): «오늘» holds /today ⊕ the beta /intake → a sheet, with the beta badge on /intake only
  open('오늘');
  expect(sheet().findAllByType('a').map((link) => link.props.href)).toEqual(['/today', '/intake']);
  expect(sheet().findAllByType('a').find((link) => link.props.href === '/intake')!.findAllByType('span').some((node) => node.children.includes('실험'))).toBe(true);
  close();
  open('대화');
  expect(sheet().findAllByType('a').map((link) => link.props.href)).toEqual(['/chat', '/exec']);
  expect(sheet().findAllByType('a').find((link) => link.props.href === '/exec')!.findAllByType('span').some((node) => node.children.includes('실험'))).toBe(true);
  close();
  open('더보기');
  expect(sheet().findAllByType('a').map((link) => link.props.href)).toEqual(['/vault', '/field', '/market', '/settings']);
  close();
  act(() => root.findByProps({ role: 'switch' }).props.onChange({ currentTarget: { checked: false } }));
  expect(hrefs()).toEqual(['/today', '/chat', '/live', '/term', '/editor', '/market', '/settings']);
  expect(root.findByProps({ 'aria-label': '아래 탭' }).findAllByType('a').find((link) => link.props['aria-label'] === '오늘')?.props.href).toBe('/today');
  act(() => { store.set(PWA_ROLE_KEY, 'contributor'); window.dispatchEvent(new Event(PWA_ROLE_EVENT)); });
  expect(root.findAllByProps({ role: 'switch' })).toHaveLength(0);
  expect(hrefs()).toContain('/exec');
  expect(sidebar().findAllByType('a').find((link) => link.props.href === '/exec')!.findAllByType('span').some((node) => node.children.includes('실험'))).toBe(false);
  act(() => { store.set(PWA_ROLE_KEY, 'owner'); window.dispatchEvent(new Event(PWA_ROLE_EVENT)); });
  expect(root.findAllByProps({ role: 'switch' })).toHaveLength(0);
  expect(hrefs()).toContain('/scheduler');
});

test('defaults off, synchronizes every mounted hook and remembers opt-in across mounts', () => {
  mount();
  expect(first.showBeta).toBe(false);
  act(() => first.setShowBeta(true));
  expect(store.get(SHOW_BETA_KEY)).toBe('1');
  expect(second.showBeta).toBe(true);
  act(() => { tree?.unmount(); secondTree?.unmount(); });
  mount();
  expect(first.showBeta).toBe(true);
  act(() => second.setShowBeta(false));
  expect(store.has(SHOW_BETA_KEY)).toBe(false);
  expect(first.showBeta).toBe(false);
});

test('storage changes re-read the device choice in all hooks', () => {
  mount();
  act(() => { store.set(SHOW_BETA_KEY, '1'); window.dispatchEvent(Object.assign(new Event('storage'), { key: SHOW_BETA_KEY })); });
  expect(first.showBeta).toBe(true);
  expect(second.showBeta).toBe(true);
  act(() => { store.delete(SHOW_BETA_KEY); window.dispatchEvent(Object.assign(new Event('storage'), { key: SHOW_BETA_KEY })); });
  expect(first.showBeta).toBe(false);
  expect(second.showBeta).toBe(false);
});

test('unreadable storage defaults off; a blocked write still synchronizes the current tab', () => {
  store.set(SHOW_BETA_KEY, '1');
  readFails = true;
  writeFails = true;
  mount();
  expect(first.showBeta).toBe(false);
  act(() => first.setShowBeta(true));
  expect(second.showBeta).toBe(true);
  expect(listeners.get(SHOW_BETA_EVENT)?.size).toBe(2);
  expect(store.get(SHOW_BETA_KEY)).toBe('1');
  act(() => second.setShowBeta(false));
  expect(first.showBeta).toBe(false);
});
