import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { ChatInput } from '@/components/chat/ChatInput';
import { SHARE_PREFILL_KEY } from '@/lib/share-prefill';
import SharePage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
let tree: ReactTestRenderer | undefined;

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount(); });
  tree = undefined;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: Window }).window;
});

test('share page GET writes a one-shot prefill displayed by the mounted chat input', async () => {
  const values = new Map<string, string>();
  const sessionStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: Object.assign(new EventTarget(), { sessionStorage }),
  });
  const daemon = {
    config: { baseUrl: '', token: '', provider: '' },
    client: {} as never,
    sessionId: '',
    setConfig: () => {},
    setSessionId: () => {},
  };
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const router = { replace: (_path: string) => {} };
  const shared = 'Shared from another app';
  await act(async () => {
    tree = create(
      <AppRouterContext.Provider value={router as never}>
        <SearchParamsContext.Provider value={new URLSearchParams({ text: shared })}>
          <DaemonContext.Provider value={daemon}><SharePage /></DaemonContext.Provider>
        </SearchParamsContext.Provider>
      </AppRouterContext.Provider>,
    );
  });
  expect(values.get(SHARE_PREFILL_KEY)).toBe(shared);
  await act(async () => { tree!.unmount(); });
  tree = undefined;
  await act(async () => {
    tree = create(<DaemonContext.Provider value={daemon}><ChatInput onSubmit={() => {}} /></DaemonContext.Provider>);
  });
  expect(tree!.root.findByType('textarea').props.value).toBe(shared);
  expect(values.has(SHARE_PREFILL_KEY)).toBe(false);
});
