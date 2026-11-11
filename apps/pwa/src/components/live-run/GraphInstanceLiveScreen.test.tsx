import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { environmentManager, focusManager, QueryClient } from '@tanstack/react-query';
import { createNexusClient } from '@/nexus/client';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import { GraphInstanceLiveScreen, graphInstanceRefreshInterval, matchingGraphInstanceView } from './GraphInstanceLiveScreen';

const graph = JSON.parse(readFileSync(resolve(import.meta.dir, '../../../../../plugins/graph-instance-view/fixtures/graph.view.json'), 'utf8')) as unknown;
const resource = JSON.parse(readFileSync(resolve(import.meta.dir, '../../../../../plugins/graph-instance-view/fixtures/resource.view.json'), 'utf8')) as unknown;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('PWA reads the contracted graph instance route with the selected key and shared JSON body', async () => {
  const calls: string[] = [];
  const client = createNexusClient({ baseUrl: 'https://nexus.test', token: 'test-token', fetchImpl: (async (input) => {
    calls.push(String(input));
    return Response.json(graph);
  }) as typeof fetch });
  const value = await client.getGraphInstanceView({ source: 'graph', runId: 'graph-demo-1', graphId: 'research-flow' });
  expect(calls).toEqual(['https://nexus.test/v1/graph-instance-view?source=graph&runId=graph-demo-1&graphId=research-flow']);
  expect(matchingGraphInstanceView(value, { source: 'graph', runId: 'graph-demo-1', graphId: 'research-flow' })?.nodes).toHaveLength(4);
  expect(matchingGraphInstanceView(value, { source: 'graph', runId: 'another-run', graphId: 'research-flow' })).toBeNull();
  expect(matchingGraphInstanceView({ ...(value as object), schemaVersion: 2 }, { source: 'graph', runId: 'graph-demo-1' })).toBeNull();
});

test('resource read omits runId and graphId and accepts only the resource view', async () => {
  const calls: string[] = [];
  const client = createNexusClient({ baseUrl: 'https://nexus.test', fetchImpl: (async (input) => {
    calls.push(String(input));
    return Response.json(resource);
  }) as typeof fetch });
  const value = await client.getGraphInstanceView({ source: 'resource' });
  expect(calls).toEqual(['https://nexus.test/v1/graph-instance-view?source=resource']);
  expect(matchingGraphInstanceView(value, { source: 'resource' })?.nodes).toHaveLength(10);
  expect(matchingGraphInstanceView(value, { source: 'resource', runId: 'ignore-me', graphId: 'ignore-me' })?.nodes).toHaveLength(10);
  expect(matchingGraphInstanceView({ ...(value as object), instance: { ...(resource as { instance: object }).instance, runId: 'other-fleet' } }, { source: 'resource' })).toBeNull();
  expect(matchingGraphInstanceView(value, { source: 'harness' })).toBeNull();
  await client.getGraphInstanceView({ source: 'resource', runId: 'ignore-me', graphId: 'ignore-me' });
  expect(calls[1]).toBe('https://nexus.test/v1/graph-instance-view?source=resource');
});

test('waiting and transient errors poll again; completed views stop polling', () => {
  // Source: GraphInstanceLiveScreen polling contract, four-second refresh while active or recovering.
  const view = matchingGraphInstanceView(graph, { source: 'graph', runId: 'graph-demo-1', graphId: 'research-flow' })!;
  expect(graphInstanceRefreshInterval({ ...view, instance: { ...view.instance, state: 'waiting' } }, 'graph', false)).toBe(4000);
  expect(graphInstanceRefreshInterval(null, 'graph', true)).toBe(4000);
  expect(graphInstanceRefreshInterval({ ...view, instance: { ...view.instance, state: 'done' } }, 'graph', false)).toBe(false);
});

test('malformed nested view data is rejected before rendering', () => {
  const key = { source: 'graph' as const, runId: 'graph-demo-1', graphId: 'research-flow' };
  expect(matchingGraphInstanceView({ ...(graph as object), progress: { completed: 1, total: 2 } }, key)).toBeNull();
  expect(matchingGraphInstanceView({ ...(graph as object), nodes: [{ id: 'broken' }] }, key)).toBeNull();
  expect(matchingGraphInstanceView({ ...(graph as object), instance: { ...(graph as { instance: object }).instance, state: 'unexpected' } }, key)).toBeNull();
  expect(matchingGraphInstanceView({ ...(resource as object), nodes: [{ id: 'mbp', label: 'mbp', state: 'on', resource: { hostKind: 'moon', tasks: [] } }] }, { source: 'resource' })).toBeNull();
});

// Source: the production screen's four-second polling contract; real QueryClient timers and fixture responses.
async function observeScreen(first: Response, second: Response) {
  let calls = 0;
  const client = createNexusClient({ baseUrl: 'https://nexus.test', fetchImpl: (async () => ++calls === 1 ? first : second) as unknown as typeof fetch });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  environmentManager.setIsServer(() => false);
  focusManager.setFocused(true);
  let root: ReturnType<typeof create> | undefined;
  try {
    await act(async () => {
      root = create(createElement(NexusProvider, { client, queryClient, children: createElement(GraphInstanceLiveScreen, { instanceKey: { source: 'graph', runId: 'graph-demo-1', graphId: 'research-flow' } }) }));
    });
    await Bun.sleep(50);
    await act(async () => {});
    const initial = JSON.stringify(root!.toJSON());
    await Bun.sleep(4200);
    await act(async () => {});
    return { initial, final: JSON.stringify(root!.toJSON()), calls };
  } finally {
    if (root) await act(async () => root!.unmount());
    queryClient.clear();
    focusManager.setFocused(undefined);
    environmentManager.setIsServer(() => true);
  }
}

test('actual screen moves from waiting to approved progress on its polling timer', async () => {
  const waiting = { ...(graph as object), instance: { ...(graph as { instance: object }).instance, state: 'waiting' }, statusLine: '승인 대기' };
  const done = { ...(graph as object), instance: { ...(graph as { instance: object }).instance, state: 'done' }, statusLine: '승인 뒤 완료' };
  const result = await observeScreen(Response.json(waiting), Response.json(done));
  expect(result.initial).toContain('승인 대기');
  expect(result.final).toContain('승인 뒤 완료');
  // Source: #36555 Terra review — one initial read plus one scheduled refresh.
  expect(result.calls).toBeGreaterThanOrEqual(2);
}, 12000);

test('actual screen retries a transient first read failure and recovers', async () => {
  const result = await observeScreen(new Response('temporary', { status: 503 }), Response.json(graph));
  expect(result.initial).toContain('인스턴스 원장을 읽지 못했습니다');
  expect(result.final).toContain('그래프 노드와 간선');
  // Source: #36555 Terra review — one failed read plus one recovery read.
  expect(result.calls).toBeGreaterThanOrEqual(2);
}, 12000);

test('actual screen rejects malformed JSON v1 and later renders a valid snapshot', async () => {
  const malformed = { ...(graph as object), instance: { ...(graph as { instance: object }).instance, state: 'unexpected' } };
  const result = await observeScreen(Response.json(malformed), Response.json(graph));
  expect(result.initial).toContain('응답 JSON v1이 일치하지 않습니다');
  expect(result.final).toContain('그래프 노드와 간선');
  // Source: #36555 Terra review — malformed snapshot followed by one valid scheduled read.
  expect(result.calls).toBeGreaterThanOrEqual(2);
}, 12000);
