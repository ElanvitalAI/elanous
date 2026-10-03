import { expect, test } from 'bun:test';
import type { DaemonClient } from './daemon-client';
import { getOutputs, type OutputItem } from './outputs-api';

test('getOutputs assembles optional limit and source on the owner endpoint', async () => {
  const paths: string[] = [];
  const response: { outputs: OutputItem[] } = { outputs: [{ kind: 'report', kindLabel: '한 장 보고서', title: '보고', source: 'exec', at: '2026-10-03T00:00:00Z' }] };
  const client = { fetchJson: async (path: string) => { paths.push(path); return response; } } as unknown as DaemonClient;
  expect(await getOutputs(client)).toEqual(response);
  expect(await getOutputs(client, { limit: 200, source: 'field-feed' })).toEqual(response);
  expect(await getOutputs(client, { source: 'exec' })).toEqual(response);
  expect(paths).toEqual(['/v1/outputs', '/v1/outputs?limit=200&source=field-feed', '/v1/outputs?source=exec']);
});

test('getOutputs propagates read failures to the screen', async () => {
  const client = { fetchJson: async () => { throw new Error('offline'); } } as unknown as DaemonClient;
  await expect(getOutputs(client)).rejects.toThrow('offline');
});
