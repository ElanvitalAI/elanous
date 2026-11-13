import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import * as realNavigation from 'next/navigation';
import * as realLink from 'next/link';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import { PWA_ROLE_KEY } from './pwa-role';
import { useOperator } from './use-operator';

const originalNavigation = { ...realNavigation };
const originalLink = { ...realLink };
mock.module('next/navigation', () => ({ usePathname: () => '/chat', useRouter: () => ({ push: () => {} }), useSearchParams: () => new URLSearchParams() }));
mock.module('next/link', () => ({ default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => createElement('a', { href, ...props }, children) }));
const { SidebarNav } = await import('../components/shell/SidebarNav');
afterAll(() => {
  mock.module('next/navigation', () => originalNavigation);
  mock.module('next/link', () => originalLink);
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
let renderer: ReactTestRenderer | undefined;

function Probe() {
  return createElement('span', { 'data-operator': useOperator() });
}

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return renderer!.root.findByType('span').props['data-operator'] as boolean;
}

afterEach(async () => {
  if (renderer) await act(async () => { renderer!.unmount(); });
  renderer = undefined;
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: Window }).window;
});

test('useOperator uses readOperator /v1/me and only accepts exact true', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { protocol: 'https:', host: 'example.test' } },
  });
  for (const [status, body, expected] of [
    [200, { operator: true }, true],
    [200, { operator: 'true' }, false],
    [200, {}, false],
    [404, { operator: true }, false],
  ] as const) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe('https://example.test/v1/me');
      expect(init?.cache).toBe('no-store');
      return { ok: status === 200, json: async () => body } as Response;
    }) as unknown as typeof fetch;
    await act(async () => { renderer = create(createElement(Probe)); });
    expect(await settle()).toBe(expected);
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
  }
  globalThis.fetch = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
  await act(async () => { renderer = create(createElement(Probe)); });
  expect(await settle()).toBe(false);
});

test('SidebarNav stays role-driven without an operator section and remembers group collapse', async () => {
  const stored = new Map<string, string>([[PWA_ROLE_KEY, 'general']]);
  const listeners = new Map<string, Set<(event: StorageEvent) => void>>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { protocol: 'https:', host: 'example.test' },
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => { stored.set(key, value); },
      },
      addEventListener: (name: string, listener: (event: StorageEvent) => void) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(listener);
      },
      removeEventListener: (name: string, listener: (event: StorageEvent) => void) => { listeners.get(name)?.delete(listener); },
    },
  });
  // #35204 여섯 화면 다이어트 뒤 사이드바는 역할·기기 설정으로만 거른다 — 운영 문은 사이드바가 아니라
  //  페이지 수준(/ops/release · live-run 자원 보기)과 운영자→오너 역할 기본값(operator-role)이 맡는다.
  //  공급자 응답이 operator:true 여도 운영 칸이 사이드바로 돌아오면 이 시험이 잡는다(가짜 fetch 는 걸어둔다).
  let operator = true;
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ operator }) } as Response)) as unknown as typeof fetch;
  await act(async () => { renderer = create(createElement(SidebarNav)); });
  const root = () => renderer!.root.findByType('nav');
  const links = () => root().findAllByType('a').map((link) => link.props.href as string);
  expect(root().findAllByProps({ 'aria-label': '운영🔒' })).toHaveLength(0);
  expect(links()).toEqual(expect.arrayContaining(['/chat', '/board', '/term', '/editor', '/settings']));
  expect(links()).not.toContain('/vault'); // «자료» 는 오너 전용 — 역할 거름이 그대로 산다.
  expect(links()).not.toContain('/loops'); // #35204: /loops 경로 자체가 물렀다(운영 창구는 /ops/release 직접 진입).
  expect(links()).not.toContain('/bots');
  expect(links()).not.toContain('/ceo');
  expect(links()).not.toContain('/exec');
  expect(links()).not.toContain('/ops/release');
  expect(links()).not.toContain('/ops/checklist');
  // NAV1b: a group with one visible item renders that item alone (no group header) — «대화» here has only /chat.
  expect(root().findAllByType('button').filter((button) => button.props['aria-controls'] === 'nav-group-talk')).toHaveLength(0);
  // «만들기» 는 보이는 항목이 둘(터미널·그래프)이라 머리 단추가 있다 — 접었다 펴도 기억한다(elanous.nav.collapsedGroups).
  const make = root().findAllByType('button').find((button) => button.props['aria-controls'] === 'nav-group-make')!;
  expect(make.props['aria-expanded']).toBe(true);
  await act(async () => { make.props.onClick(); });
  expect(stored.get('elanous.nav.collapsedGroups')).toContain('make');
  expect(links()).not.toContain('/term');
  await act(async () => { renderer!.unmount(); renderer = create(createElement(SidebarNav)); });
  expect(root().findAllByType('button').find((button) => button.props['aria-controls'] === 'nav-group-make')!.props['aria-expanded']).toBe(false);
  await act(async () => { const m = root().findAllByType('button').find((button) => button.props['aria-controls'] === 'nav-group-make')!; m.props.onClick(); });
  expect(links()).toContain('/term');
  await act(async () => { renderer!.unmount(); renderer = create(createElement(() => SidebarNav({ compact: true }))); });
  expect(links()).toContain('/chat');
  expect(links()).not.toContain('/exec');
  operator = false;
  await act(async () => { for (const listener of listeners.get('storage') ?? []) listener({ key: null } as StorageEvent); });
  expect(root().findAllByProps({ 'aria-label': '운영🔒' })).toHaveLength(0);
});

test('useOperator starts false and discards a response after unmount', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { protocol: 'http:', host: 'example.test' } },
  });
  let answer!: (value: Response) => void;
  globalThis.fetch = (() => new Promise<Response>((resolve) => { answer = resolve; })) as unknown as typeof fetch;
  await act(async () => { renderer = create(createElement(Probe)); });
  expect(renderer!.root.findByType('span').props['data-operator']).toBe(false);
  await act(async () => { renderer!.unmount(); });
  renderer = undefined;
  await act(async () => { answer({ ok: true, json: async () => ({ operator: true }) } as Response); });
});
