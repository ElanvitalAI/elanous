import { expect, test } from 'bun:test';
import { deliverCapsuleResult } from './call-result-delivery.js';

const input = { capsuleId: 'mcp-1', sessionId: 's1', kind: 'mcp' as const, startedAt: 10, endedAt: 20,
  status: 'ok' as const, output: 'full private result', summary: 'MCP completed' };

test('stores full result before sending a bounded summary frame to the same session', async () => {
  const calls: unknown[] = [];
  await deliverCapsuleResult(input, {
    store: async (record) => { calls.push(['store', record]); },
    emit: async (event) => { calls.push(['emit', event]); },
  });
  expect(calls).toEqual([
    ['store', { capsuleId: 'mcp-1', sessionId: 's1', status: 'ok', output: 'full private result' }],
    ['emit', { type: 'capsule-done', capsuleId: 'mcp-1', sessionId: 's1', kind: 'mcp', startedAt: 10, endedAt: 20, status: 'ok', summary: 'MCP completed' }],
  ]);
});

test('storage failure never emits a completion that would lose the result', async () => {
  const calls: string[] = [];
  await expect(deliverCapsuleResult(input, { store: () => { throw Error('storage failed'); }, emit: () => { calls.push('emit'); } })).rejects.toThrow('storage failed');
  expect(calls).toEqual([]);
});

test('frame failure propagates to retry after the result is stored', async () => {
  const calls: string[] = [];
  await expect(deliverCapsuleResult(input, { store: () => { calls.push('stored'); }, emit: () => { throw Error('frame failed'); } })).rejects.toThrow('frame failed');
  expect(calls).toEqual(['stored']);
});

test('invalid identity or time has no side effects', async () => {
  const calls: string[] = [];
  const sink = { store: () => { calls.push('store'); }, emit: () => { calls.push('emit'); } };
  await expect(deliverCapsuleResult({ ...input, sessionId: '' }, sink)).rejects.toThrow(RangeError);
  await expect(deliverCapsuleResult({ ...input, endedAt: 9 }, sink)).rejects.toThrow(RangeError);
  expect(calls).toEqual([]);
});
