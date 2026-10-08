import { describe, expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import type { GraphCanvasContext } from './GraphCanvasEditor';
import { GraphRunControl, nodeStatusOf, runBlockedReason } from './GraphRunControl';
import type { GraphRun, GraphRunClient } from '@/lib/graph-run-api';

const ctx = (over: Partial<GraphCanvasContext> = {}): GraphCanvasContext =>
  ({ graphId: 'demo-review-mine', yaml: '', valid: true, saved: true, graph: {} as never, ...over });
type Node = { children: Array<string | Node> | null };
const text = (node: Node | null): string => !node ? '' : (node.children ?? []).map((c) => typeof c === 'string' ? c : text(c)).join('');

describe('CGE-RUN run control', () => {
  test('runs only a saved, valid graph — and says why not', () => {
    expect(runBlockedReason(ctx())).toBeNull();
    expect(runBlockedReason(ctx({ valid: false }))).toBe('검증을 통과해야 실행할 수 있습니다');
    expect(runBlockedReason(ctx({ saved: false }))).toContain('저장한 뒤 실행할 수 있습니다');
  });

  test('start → poll → per-node colours reach the canvas, and the line says «데모 실행»', async () => {
    const run: GraphRun = { graphId: 'demo-review-mine', runId: 'ed-1-abcdef', status: 'running', path: ['plan', 'build'],
      nodes: [{ nodeId: 'plan', ok: true, executed: true }], currentNode: { nodeId: 'build', startedAt: '2026-10-08T00:00:00Z' } };
    const client: GraphRunClient = {
      startRunGraphRun: async () => ({ id: 'demo-review-mine', runId: 'ed-1-abcdef', demo: true }),
      getRunGraphRun: async () => run,
    };
    const seen: Array<Record<string, string> | undefined> = [];
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<GraphRunControl context={ctx()} client={client} onStatus={(s) => seen.push(s)} />); });
    await act(async () => { tree.root.findByType('button').props.onClick(); await Bun.sleep(5); });
    await act(async () => { await Bun.sleep(1_100); });
    expect(seen.at(-1)).toEqual({ plan: 'done', build: 'running' });
    expect(text(tree.toJSON() as Node)).toContain('데모 실행 · 도는 중 build');
    expect(nodeStatusOf({ ...run, status: 'done', currentNode: undefined })).toEqual({ plan: 'done' });
    act(() => tree.unmount());
  });

  test('a refused start shows the server issues instead of a silent failure', async () => {
    const { NexusApiError } = await import('@/nexus/client');
    const client: GraphRunClient = {
      startRunGraphRun: async () => { throw new NexusApiError(422, '/v1/graphs/x/run', { issues: ["끝 노드 'review' 는 실행할 수 없다"] }); },
      getRunGraphRun: async () => null,
    };
    let tree!: ReturnType<typeof create>;
    await act(async () => { tree = create(<GraphRunControl context={ctx()} client={client} onStatus={() => {}} />); });
    await act(async () => { tree.root.findByType('button').props.onClick(); await Bun.sleep(5); });
    expect(text(tree.toJSON() as Node)).toContain("끝 노드 'review' 는 실행할 수 없다");
    act(() => tree.unmount());
  });
});

test('a failed read does not freeze the control — it keeps polling and gives up loudly after repeated misses', async () => {
  let reads = 0;
  const client: GraphRunClient = {
    startRunGraphRun: async () => ({ id: 'demo-review-mine', runId: 'ed-1-abcdef' }),
    getRunGraphRun: async () => { reads += 1; throw new Error('daemon restarting'); },
  };
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<GraphRunControl context={ctx()} client={client} onStatus={() => {}} />); });
  await act(async () => { tree.root.findByType('button').props.onClick(); await Bun.sleep(5); });
  for (let i = 0; i < 5; i++) await act(async () => { await Bun.sleep(1_050); });
  expect(reads).toBe(5);
  expect(text(tree.toJSON() as Node)).toContain('런 상태를 5번 연속 읽지 못했습니다');
  expect(tree.root.findByType('button').props.disabled).toBe(false);
  act(() => tree.unmount());
}, 15_000);
