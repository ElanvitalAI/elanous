import { expect, test } from 'bun:test';
import {
  createNexusClient,
  NexusApiError,
  type WorkflowHistoryResponse,
  type WorkflowHistoryVersionResponse,
} from './client';

test('workflow history GETs encode both path parameters and preserve the response envelopes', async () => {
  const name = 'with/slash?and=space &';
  const id = 'id/with?query#fragment';
  const list: WorkflowHistoryResponse = {
    versions: [{ id, createdAt: '2026-10-01T00:00:00.000Z', size: 17 }],
  };
  const version: WorkflowHistoryVersionResponse = { yaml: 'name: before\n' };
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return Response.json(requests.length === 1 ? list : version);
  }) as typeof fetch;
  const client = createNexusClient({ baseUrl: 'http://localhost:31415/', token: 'owner', fetchImpl });

  expect(await client.getWorkflowHistory(name)).toEqual(list);
  expect(await client.getWorkflowHistoryVersion(name, id)).toEqual(version);
  expect(requests.map(({ url }) => url)).toEqual([
    'http://localhost:31415/v1/workflows/with%2Fslash%3Fand%3Dspace%20%26/history',
    'http://localhost:31415/v1/workflows/with%2Fslash%3Fand%3Dspace%20%26/history/id%2Fwith%3Fquery%23fragment',
  ]);
  for (const { init } of requests) {
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toEqual({ authorization: 'Bearer owner' });
  }
});

test('workflow history keeps the existing NexusApiError handling for missing versions', async () => {
  const body = { error: 'not_found', name: 'demo', id: 'missing' };
  const client = createNexusClient({
    baseUrl: 'http://localhost:31415',
    fetchImpl: (async () => Response.json(body, { status: 404 })) as unknown as typeof fetch,
  });
  try {
    await client.getWorkflowHistoryVersion('demo', 'missing');
    throw new Error('expected NexusApiError');
  } catch (error) {
    expect(error).toBeInstanceOf(NexusApiError);
    expect((error as NexusApiError).status).toBe(404);
    expect((error as NexusApiError).path).toBe('/v1/workflows/demo/history/missing');
    expect((error as NexusApiError).body).toEqual(body);
  }
});
