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

test('SidebarNav gates operations separately from role/Labs and remembers group collapse', async () => {
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
  let operator = false;
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ operator }) } as Response)) as unknown as typeof fetch;
  await act(async () => { renderer = create(createElement(SidebarNav)); });
  const root = () => renderer!.root.findByType('nav');
  expect(root().findAllByProps({ 'aria-label': '운영🔒' })).toHaveLength(0);
  operator = true;
  await act(async () => { for (const listener of listeners.get('storage') ?? []) listener({ key: null } as StorageEvent); });
  expect(root().findAllByProps({ 'aria-label': '운영🔒' })).toHaveLength(1);
  expect(root().findAllByType('a').map((link) => link.props.href)).toContain('/bots');
  expect(root().findAllByType('a').map((link) => link.props.href)).toContain('/ops/release');
  expect(root().findAllByType('a').map((link) => link.props.href)).toContain('/ops/checklist');
  // NAV1b: a group with one visible item renders that item alone (no group header) — «대화» here has only /chat.
  expect(root().findAllByType('button').filter((button) => button.props['aria-controls'] === 'nav-group-talk')).toHaveLength(0);
  expect(root().findAllByType('a').map((link) => link.props.href)).toContain('/chat');
  const ops = root().findAllByType('button').find((button) => button.props['aria-controls'] === 'nav-group-ops')!;
  expect(ops.props['aria-expanded']).toBe(true);
  await act(async () => { ops.props.onClick(); });
  expect(stored.get('elanous.nav.collapsedGroups')).toContain('ops');
  expect(root().findAllByType('a').map((link) => link.props.href)).not.toContain('/ops/checklist');
  await act(async () => { renderer!.unmount(); renderer = create(createElement(SidebarNav)); });
  expect(root().findAllByType('button').find((button) => button.props['aria-controls'] === 'nav-group-ops')!.props['aria-expanded']).toBe(false);
  await act(async () => { const o = root().findAllByType('button').find((button) => button.props['aria-controls'] === 'nav-group-ops')!; o.props.onClick(); });
  await act(async () => { renderer!.unmount(); renderer = create(createElement(() => SidebarNav({ compact: true }))); });
  expect(root().findAllByType('a').map((link) => link.props.href)).toContain('/chat');
  expect(root().findAllByType('a').map((link) => link.props.href)).not.toContain('/exec');
  // LOOP-VIEW1 put /loops first in the ops group, so the collapsed compact rail shows it instead of /ops/release.
  expect(root().findAllByType('a').map((link) => link.props.href)).toContain('/loops');
  expect(root().findAllByType('a').map((link) => link.props.href)).not.toContain('/ops/checklist');
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
