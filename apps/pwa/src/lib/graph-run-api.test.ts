import { describe, expect, test } from 'bun:test';
import { NexusApiError } from '@/nexus/client';
import { getGraphRun, graphRunLine, graphRunNodeStatuses, startGraphRun, type GraphRun, type GraphRunClient } from './graph-run-api';

/** 진짜 NexusClient 처럼 2xx 면 본문, 아니면 NexusApiError 를 던진다. */
const reply = (value: unknown, status = 200) => async () => {
  if (status >= 400) throw new NexusApiError(status, '/v1/graphs', value);
  return value as never;
};
const client = (answer: () => Promise<never>, calls: string[] = []): GraphRunClient => ({
  startRunGraphRun: async (id) => { calls.push(`start ${id}`); return answer(); },
  getRunGraphRun: async (id, runId) => { calls.push(`get ${id} ${runId}`); return answer(); },
});

const running: GraphRun = {
  graphId: 'demo-review-mine', runId: 'ed-1-abcdef', status: 'running', path: ['plan', 'build', 'review', 'build'],
  nodes: [
    { nodeId: 'plan', ok: true, executed: true, startedAt: '2026-10-08T00:00:00Z', endedAt: '2026-10-08T00:00:03Z' },
    { nodeId: 'build', ok: true, executed: true },
    { nodeId: 'review', ok: true, executed: true },
  ],
  currentNode: { nodeId: 'build', startedAt: '2026-10-08T00:00:10Z' },
};

describe('CGE-RUN graph run client', () => {
  test('start: 202 → runId · 422 → issues · 403 → forbidden · network → error', async () => {
    const calls: string[] = [];
    expect(await startGraphRun(client(reply({ id: 'g', runId: 'ed-1-abcdef', demo: true }), calls), 'demo-review-mine'))
      .toEqual({ kind: 'started', runId: 'ed-1-abcdef' });
    expect(calls).toEqual(['start demo-review-mine']);
    expect(await startGraphRun(client(reply({ error: 'not-runnable', issues: ['끝 노드가 없다'] }, 422)), 'g'))
      .toEqual({ kind: 'not-runnable', issues: ['끝 노드가 없다'] });
    expect(await startGraphRun(client(reply({ error: 'forbidden' }, 403)), 'g')).toEqual({ kind: 'forbidden' });
    expect((await startGraphRun(client(async () => { throw new Error('down'); }), 'g')).kind).toBe('error');
  });

  test('per-node status: finished nodes by ok, the current node is running, a revisited node shows its latest state', async () => {
    expect(await getGraphRun(client(reply(running)), 'demo-review-mine', 'ed-1-abcdef')).toEqual(running);
    expect(graphRunNodeStatuses(running)).toEqual({
      plan: { status: 'done', durationMs: 3000 }, build: { status: 'running' }, review: { status: 'done' },
    });
    expect(graphRunLine(running)).toBe('데모 실행 · 도는 중 build · 지난 노드 3');
    const done: GraphRun = { ...running, status: 'done', currentNode: undefined, path: ['plan', 'build', 'review', 'build', 'review', 'done'],
      nodes: [...running.nodes, { nodeId: 'build', ok: true, executed: true }, { nodeId: 'review', ok: true, executed: true }, { nodeId: 'done', ok: true, executed: false }] };
    expect(Object.values(graphRunNodeStatuses(done)).every((entry) => entry.status === 'done')).toBe(true);
    expect(graphRunLine(done)).toBe('데모 실행 · 성공 · 거친 노드 6(다시 지남 2)');
    const failed: GraphRun = { ...running, status: 'failed', currentNode: undefined, nodes: [...running.nodes, { nodeId: 'build', ok: false, executed: true, error: 'exit 1' }] };
    expect(graphRunNodeStatuses(failed).build).toEqual({ status: 'failed', error: 'exit 1' });
    expect(graphRunLine(failed)).toBe('데모 실행 · 실패 build — exit 1');
    expect(graphRunLine({ ...running, status: 'budget-exceeded', currentNode: undefined })).toBe('데모 실행 · 방문 한도 초과 build — max_visits 를 늘려 저장하고 다시 실행');
  });
});
