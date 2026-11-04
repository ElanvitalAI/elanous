import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient } from '@tanstack/react-query';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { createNexusClient } from '@/nexus/client';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import LiveRunPage from './page';

const AUTO_FOLLOW_VALUE = '__auto_follow_latest__';
const client = createNexusClient({
  baseUrl: 'http://daemon',
  fetchImpl: (async () => new Response(JSON.stringify({ entries: [], finished: [] }), { status: 200 })) as unknown as typeof fetch,
});
const router = { replace: () => {} };
let root: ReactTestRenderer | undefined;
let queryClient: QueryClient | undefined;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  queryClient?.clear();
  queryClient = undefined;
});

test('no run query routes to latest-run auto-follow mode', async () => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root = create(
      <AppRouterContext.Provider value={router as never}>
        <SearchParamsContext.Provider value={new URLSearchParams()}>
          <NexusProvider client={client} queryClient={queryClient}>
            <LiveRunPage />
          </NexusProvider>
        </SearchParamsContext.Provider>
      </AppRouterContext.Provider>,
    );
    await Bun.sleep(10);
  });
  expect(root!.root.findByType('select').props.value).toBe(AUTO_FOLLOW_VALUE);
  expect(root!.root.findByProps({ role: 'status' })).toBeTruthy();
});

test('auto-follow route keeps the no-daemon guidance when Nexus is unavailable', async () => {
  await act(async () => {
    root = create(
      <AppRouterContext.Provider value={router as never}>
        <SearchParamsContext.Provider value={new URLSearchParams()}>
          <LiveRunPage />
        </SearchParamsContext.Provider>
      </AppRouterContext.Provider>,
    );
  });
  expect(root!.root.findByType('h1').children.join('')).toBe('런 장면');
  expect(root!.root.findByType('p').children.join('')).toContain('데몬에 연결되면 최근 하니스 런을 자동으로 따라갑니다.');
});
