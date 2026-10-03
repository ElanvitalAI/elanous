import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { NexusProvider } from './use-nexus-context';
import { useDeleteWorkflowPin, usePutWorkflowPin, useWorkflowPins } from './use-workflow-pins';
import { createNexusClient } from '../client';

test('pin hooks read through the client and invalidate their workflow query on save and delete', async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const body = method === 'GET'
      ? { workflow: 'demo', pins: {} }
      : method === 'PUT'
        ? { workflow: 'demo', pin: { nodeId: 'n/a', value: { answer: 1 }, updatedAt: 'now', note: 'test' } }
        : { workflow: 'demo', removed: 1 };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const client = createNexusClient({ baseUrl: 'http://localhost', fetchImpl });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let save!: ReturnType<typeof usePutWorkflowPin>;
  let remove!: ReturnType<typeof useDeleteWorkflowPin>;
  function Probe() {
    useWorkflowPins('demo');
    save = usePutWorkflowPin();
    remove = useDeleteWorkflowPin();
    return null;
  }
  renderToStaticMarkup(createElement(NexusProvider, { client, queryClient: qc, children: createElement(Probe) }));
  const key = ['nexus', 'workflow-pins', 'demo'];
  const query = qc.getQueryCache().find({ queryKey: key });
  expect(query).toBeDefined();
  expect(await query!.fetch()).toEqual({ workflow: 'demo', pins: {} });
  expect(calls[0]).toEqual({ url: 'http://localhost/v1/workflows/demo/pins', method: 'GET' });
  expect(await save.mutateAsync({ name: 'demo', nodeId: 'n/a', value: { answer: 1 }, note: 'test' })).toEqual({
    workflow: 'demo', pin: { nodeId: 'n/a', value: { answer: 1 }, updatedAt: 'now', note: 'test' },
  });
  expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
  await qc.resetQueries({ queryKey: key });
  expect(await remove.mutateAsync({ name: 'demo', nodeId: 'n/a' })).toEqual({ workflow: 'demo', removed: 1 });
  expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
  expect(calls.filter((call) => call.method !== 'GET')).toEqual([
    { url: 'http://localhost/v1/workflows/demo/pins/n%2Fa', method: 'PUT', body: { value: { answer: 1 }, note: 'test' } },
    { url: 'http://localhost/v1/workflows/demo/pins/n%2Fa', method: 'DELETE' },
  ]);
});
