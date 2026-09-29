import { afterEach, expect, spyOn, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import type { LlmProvidersResponse, NexusClient } from '@/nexus/client';
import SetupPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
let tree: ReactTestRenderer | undefined;

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: Window }).window;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete (globalThis as { document?: Document }).document;
});

const snapshot: LlmProvidersResponse = {
  activeProvider: 'auto',
  providers: [
    { provider: 'openai', label: 'OpenAI', description: 'API key', apiKeyLabel: 'key', flow: 'apiKey', recommended: true, hasSavedKey: false },
    { provider: 'openai-codex', label: 'OpenAI Codex', description: '구독 로그인', apiKeyLabel: '', flow: 'codex', recommended: false, hasSavedKey: false },
  ],
};

function mount(getLlmProviders: () => Promise<LlmProvidersResponse>) {
  const client = {
    getLlmProviders,
    getChildLlmPreference: async () => ({ providers: [], resolved: { mode: 'pinned', chain: [], budgetGate: { minHeadroomPercent: 15, onShortfall: 'proceed' } } }),
  } as unknown as NexusClient;
  return create(
    <AppRouterContext.Provider value={{ push: () => {} } as never}>
      <NexusProvider client={client}><SetupPage /></NexusProvider>
    </AppRouterContext.Provider>,
  );
}

test('loading reserves three provider cards and updates elapsed seconds every second', async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const clock = spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1000);
  const callbacks = new Map<number, () => void>();
  let nextId = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { setInterval: (fn: () => void, delay: number) => { expect(delay).toBe(1000); callbacks.set(++nextId, fn); return nextId; }, clearInterval: (id: number) => { callbacks.delete(id); } },
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
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setInterval, clearInterval, requestAnimationFrame: () => 0 } });
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
