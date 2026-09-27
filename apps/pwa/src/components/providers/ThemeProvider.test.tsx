import { createRequire } from 'node:module';

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { restoreModuleMocksAfterAll } from '@/lib/testing/restore-module-mocks';
import { createReactHookHarness } from '@/lib/testing/react-hook-harness';
import type { NexusClient, PutSwitchResult, SwitchWire } from '@/nexus/client';

const require = createRequire(import.meta.url);
const harness = createReactHookHarness(require('react'));

let client: Pick<NexusClient, 'getSwitch' | 'putSwitch'> | null = null;

function themeSwitch(value: string): SwitchWire {
  return {
    id: 'dashboard.theme.active',
    scope: 'global',
    kind: 'enum',
    label: 'Theme',
    description: 'Shared dashboard theme',
    default: 'catppuccin-mocha',
    hotApplicable: true,
    value,
  };
}

function hotSwitchWrite(switchId = 'dashboard.theme.active'): PutSwitchResult {
  return { outcome: 'hot', switchId };
}

// R-TST23 — 아래 mock.module 은 프로세스 전역이다. 원본을 잡아 두고 파일 끝에 되돌린다(`@/lib/testing/restore-module-mocks`).
await restoreModuleMocksAfterAll([
  '@/nexus/hooks/use-nexus-context',
  '@/lib/debug',
], (specifier) => import(specifier));

mock.module('@/nexus/hooks/use-nexus-context', () => ({
  useOptionalNexusClient: () => client,
}));
mock.module('@/lib/debug', () => ({ debugLog: () => {} }));

const storage = new Map<string, string>();
const priorWindow = (globalThis as { window?: unknown }).window;
const priorDocument = (globalThis as { document?: unknown }).document;
const priorLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
const documentElement = { dataset: {} as Record<string, string> };
const localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
};

(globalThis as { window?: unknown }).window = { localStorage };
(globalThis as { localStorage?: unknown }).localStorage = localStorage;
(globalThis as { document?: unknown }).document = { documentElement };

afterAll(() => {
  harness.unmount();
  if (priorWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = priorWindow;
  if (priorDocument === undefined) delete (globalThis as { document?: unknown }).document;
  else (globalThis as { document?: unknown }).document = priorDocument;
  if (priorLocalStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
  else (globalThis as { localStorage?: unknown }).localStorage = priorLocalStorage;
});

beforeEach(() => {
  harness.unmount();
  storage.clear();
  documentElement.dataset = {};
  client = null;
});

async function renderThemeProvider(settle = true) {
  const { ThemeProvider } = await import('./ThemeProvider');
  harness.render(() => ThemeProvider({ children: null }));
  if (settle) await harness.settle();
  return harness.find((element) => 'value' in element.props && 'themes' in (element.props.value as Record<string, unknown>)).props.value as {
    theme: string;
    setTheme: (theme: 'catppuccin-mocha' | 'mocha-pastel-accent' | 'catppuccin-latte' | 'rose-pine-dawn' | 'nord-light' | 'elanous-pastel-default') => void;
  };
}

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve: resolve! };
}

describe('ThemeProvider daemon theme switch', () => {
  test('prefers a valid daemon theme over localStorage after mount', async () => {
    storage.set('elanous.pwa.theme', 'catppuccin-latte');
    client = {
      getSwitch: async () => ({ switch: themeSwitch('nord-light') }),
      putSwitch: async () => hotSwitchWrite(),
    };

    const value = await renderThemeProvider();

    expect(value.theme).toBe('nord-light');
    expect(documentElement.dataset.theme).toBe('nord-light');
    expect(storage.get('elanous.pwa.theme')).toBe('nord-light');
  });

  test('keeps a user theme change when a prior daemon lookup resolves late', async () => {
    const daemonTheme = deferred<{ switch: SwitchWire }>();
    client = {
      getSwitch: () => daemonTheme.promise,
      putSwitch: async () => hotSwitchWrite(),
    };

    const value = await renderThemeProvider(false);
    harness.act(() => value.setTheme('rose-pine-dawn'));
    daemonTheme.resolve({ switch: themeSwitch('nord-light') });
    await harness.settle();

    expect(documentElement.dataset.theme).toBe('rose-pine-dawn');
    expect(storage.get('elanous.pwa.theme')).toBe('rose-pine-dawn');
  });

  test('writes a user theme change to the daemon switch and localStorage', async () => {
    const putCalls: Array<[string, { value: unknown }]> = [];
    client = {
      getSwitch: async () => ({ switch: themeSwitch('catppuccin-mocha') }),
      putSwitch: async (id, body) => {
        putCalls.push([id, body]);
        return hotSwitchWrite(id);
      },
    };

    const value = await renderThemeProvider();
    harness.act(() => value.setTheme('rose-pine-dawn'));
    await harness.settle();

    expect(putCalls).toEqual([['dashboard.theme.active', { value: 'rose-pine-dawn' }]]);
    expect(documentElement.dataset.theme).toBe('rose-pine-dawn');
    expect(storage.get('elanous.pwa.theme')).toBe('rose-pine-dawn');
  });

  test('keeps local theme changes when the daemon lookup fails', async () => {
    client = {
      getSwitch: async (): Promise<{ switch: SwitchWire }> => { throw new Error('daemon unavailable'); },
      putSwitch: async (): Promise<PutSwitchResult> => { throw new Error('daemon unavailable'); },
    };

    const value = await renderThemeProvider();
    harness.act(() => value.setTheme('nord-light'));
    await harness.settle();

    expect(documentElement.dataset.theme).toBe('nord-light');
    expect(storage.get('elanous.pwa.theme')).toBe('nord-light');
  });
});
