import { expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { createElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { createNexusClient, MissingUpstreamError, NexusApiError } from '../client';
import type { ReactNode } from 'react';
import { NexusProvider } from './use-nexus-context';
import { useWorkflowRunModes } from './use-workflow-run-modes';

async function probe(health: unknown, status = 200) {
  const calls: string[] = [];
  const client = createNexusClient({ baseUrl: 'http://fake', fetchImpl: (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify(health), { status });
  }) as typeof fetch });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const seen: boolean[] = [];
  function View() { seen.push(useWorkflowRunModes()); return null; }
  let root!: ReturnType<typeof create>;
  await act(async () => { root = create(createElement(NexusProvider, { client, queryClient: qc, children: [createElement(View, { key: 'a' }), createElement(View, { key: 'b' })] as ReactNode })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(async () => root.unmount());
  qc.clear();
  return { calls, seen };
}

test('health is fetched once and only literal true enables workflow run modes', async () => {
  for (const [health, status, supported] of [
    [{ workflowRunModes: true }, 200, true], [{ workflowRunModes: false }, 200, false],
    [{}, 200, false], [{ workflowRunModes: 'true' }, 200, false], [{ error: 'offline' }, 503, false],
  ] as const) {
    const { calls, seen } = await probe(health, status);
    expect(calls).toEqual(['http://fake/v1/health']);
    expect(seen.at(-1)).toBe(supported);
  }
});

test('run wire preserves legacy body, sends selected fields verbatim, returns mode and typed missing-upstream nodes', async () => {
  const bodies: unknown[] = [];
  let missing = false;
  const client = createNexusClient({ baseUrl: 'http://fake', fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(missing
      ? { error: 'missing-upstream', nodes: ['a', 'b'] }
      : { ok: true, runId: 'r', mode: 'full' }), { status: missing ? 400 : 200 });
  }) as typeof fetch });
  expect((await client.runWorkflow('wf', 'hello')).mode).toBe('full');
  await client.runWorkflow('wf', 'hello', { dryRun: true, onlyNode: 'n', fromRunId: 'old' });
  await client.runWorkflow('wf', '', { fromNode: 'n', fromRunId: 'old' });
  expect(bodies).toEqual([
    { arguments: 'hello' },
    { arguments: 'hello', dryRun: true, onlyNode: 'n', fromRunId: 'old' },
    { arguments: '', fromNode: 'n', fromRunId: 'old' },
  ]);
  missing = true;
  try {
    await client.runWorkflow('wf', '', { onlyNode: 'n' });
    throw new Error('expected missing-upstream');
  } catch (error) {
    expect(error).toBeInstanceOf(NexusApiError);
    expect(error).toBeInstanceOf(MissingUpstreamError);
    expect((error as MissingUpstreamError).status).toBe(400);
    expect((error as MissingUpstreamError).nodes).toEqual(['a', 'b']);
  }
});
