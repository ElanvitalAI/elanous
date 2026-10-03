import { expect, test, mock } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { QueryClient } from '@tanstack/react-query';
import { NexusProvider } from '@/nexus/hooks/use-nexus-context';
import { NodeRunPanel } from './NodeRunPanel';
import { MissingUpstreamError, type NexusClient, type WorkflowRunEvent } from '@/nexus/client';

const done = (ok: boolean, output: unknown): WorkflowRunEvent[] => [
  { type: 'node_done', nodeId: 'n', result: { ok, output, durationMs: 1250, ...(ok ? {} : { error: 'broken' }) } },
];

async function mount(events: WorkflowRunEvent[], readOnly = false, initialPin = false, putFails = false, options: {
  health?: unknown; runId?: string; runEvents?: WorkflowRunEvent[]; runMode?: 'only' | 'from' | 'full'; runError?: Error;
  runList?: Array<{ runId: string; startedAt: number; mode?: 'only' | 'from' | 'full'; events: WorkflowRunEvent[] }>;
} = {}) {
  const calls = { read: mock(async () => ({ workflow: 'wf', pins: initialPin ? { n: { nodeId: 'n', value: 'saved', updatedAt: 'now' } } : {} })),
    put: mock(async (_name: string, _nodeId: string, _value: unknown) => {
      if (putFails) throw new Error('save denied');
      return { workflow: 'wf', pin: { nodeId: 'n', value: _value, updatedAt: 'now' } };
    }),
    remove: mock(async () => ({ workflow: 'wf', removed: 1 })),
    run: mock(async (_name: string, _args: string, _opts?: { onlyNode?: string; fromNode?: string; fromRunId?: string }) => {
      if (options.runError) throw options.runError;
      return { ok: true as const, runId: 'started', mode: options.runMode };
    }),
    health: mock(async () => {
      if (options.health instanceof Error) throw options.health;
      return options.health ?? {};
    }),
    runs: mock(async () => ({ runs: options.runList ? options.runList.map((r) => ({ runId: r.runId, workflowName: 'wf', startedAt: r.startedAt, status: 'failed' }))
      : options.runId ? [{ runId: options.runId, workflowName: 'wf', startedAt: 1, status: 'failed' }] : [] })),
    detail: mock(async (id?: string) => {
      const listed = options.runList?.find((r) => r.runId === id);
      return listed ? { runId: listed.runId, mode: listed.mode, events: listed.events } : { runId: options.runId, events: options.runEvents ?? events };
    }),
  };
  const client = {
    getWorkflowPins: calls.read,
    putWorkflowPin: calls.put,
    deleteWorkflowPin: calls.remove,
    runWorkflow: calls.run,
    getHealth: calls.health,
    getWorkflowRuns: calls.runs,
    getWorkflowRun: calls.detail,
  } as unknown as NexusClient;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['nexus', 'workflow-pins', 'wf'], {
    workflow: 'wf', pins: initialPin ? { n: { nodeId: 'n', value: 'saved', updatedAt: 'now' } } : {},
  });
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<NexusProvider client={client} queryClient={qc}>
      <NodeRunPanel workflowName="wf" nodeId="n" events={events} readOnly={readOnly} />
    </NexusProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  const text = () => {
    const visit = (node: unknown): string => {
      if (node === null || node === undefined) return '';
      if (Array.isArray(node)) return node.map(visit).join('');
      if (typeof node === 'string') return node;
      if (typeof node !== 'object' || !('children' in node)) return '';
      const children = node.children;
      return Array.isArray(children) ? children.map(visit).join('') : '';
    };
    return visit(renderer.toJSON());
  };
  const button = (label: string) => renderer.root.findAllByType('button').find((b) => b.children.includes(label));
  const close = async () => { await act(async () => renderer.unmount()); qc.clear(); };
  const click = async (label: string) => { await act(async () => button(label)!.props.onClick()); };
  return { calls, text, button, click, close, renderer };
}

test('status, duration, failure error, expandable output, and no-history state', async () => {
  const success = await mount(done(true, { answer: 1 }));
  expect(success.text()).toContain('성공 · 1.25초');
  expect(success.text()).toContain('출력');
  expect(success.text()).toContain('answer');
  expect(success.renderer.root.findAllByType('details')).toHaveLength(1);
  expect(success.renderer.root.findByType('details').props.open).toBeUndefined();
  await success.close();

  const failed = await mount(done(false, null));
  expect(failed.text()).toContain('실패 · 1.25초');
  expect(failed.text()).toContain('broken');
  expect(failed.renderer.root.findAllByProps({ role: 'alert' }).some((item) => item.props.className.includes('text-error') && item.children.includes('broken'))).toBe(true);
  expect(failed.calls.run).toHaveBeenCalledTimes(0);
  await failed.close();

  const absent = await mount([]);
  expect(absent.text()).toContain('아직 실행 기록이 없습니다');
  expect(absent.button('이 출력 고정')).toBeUndefined();
  await absent.close();
});

test('truncated output has an entire-view action', async () => {
  const panel = await mount(done(true, 'x'.repeat(4_001)));
  expect(panel.text()).toContain('전체 보기');
  expect(panel.text()).not.toContain('x'.repeat(4_001));
  await act(async () => panel.button('전체 보기')!.props.onClick());
  expect(panel.text()).toContain('x'.repeat(4_001));
  await act(async () => panel.button('접기')!.props.onClick());
  expect(panel.text()).not.toContain('x'.repeat(4_001));
  await panel.close();
});

test('pin uses the original output once; unpin deletes once; neither triggers a run', async () => {
  const value = { answer: 42 };
  const panel = await mount(done(true, value));
  expect(panel.text()).toContain('다음 실행부터 이 노드는 실제로 돌지 않고 이 값을 씁니다.');
  await act(async () => panel.button('이 출력 고정')!.props.onClick());
  expect(panel.calls.put).toHaveBeenCalledTimes(1);
  expect(panel.calls.put).toHaveBeenCalledWith('wf', 'n', value, undefined);
  expect(panel.calls.run).toHaveBeenCalledTimes(0);
  await panel.close();

  const pinned = await mount([], false, true);
  expect(pinned.text()).toContain('고정됨');
  await act(async () => pinned.button('고정 풀기')!.props.onClick());
  expect(pinned.calls.remove).toHaveBeenCalledTimes(1);
  expect(pinned.calls.remove).toHaveBeenCalledWith('wf', 'n');
  expect(pinned.calls.run).toHaveBeenCalledTimes(0);
  await pinned.close();
});

test('read-only hides pin actions but keeps result; mutation failure shows error on pin row', async () => {
  const readonly = await mount(done(true, 'output'), true, true);
  expect(readonly.text()).toContain('성공');
  expect(readonly.text()).toContain('고정됨');
  expect(readonly.renderer.root.findAllByType('details')).toHaveLength(1);
  expect(readonly.button('고정 풀기')).toBeUndefined();
  expect(readonly.button('이 노드만 시험')).toBeUndefined();
  expect(readonly.button('실패 노드부터 다시')).toBeUndefined();
  expect(readonly.button('이 출력 고정')).toBeUndefined();
  expect(readonly.calls.run).toHaveBeenCalledTimes(0);
  await readonly.close();

  const readonlyUnpinned = await mount(done(true, 'output'), true);
  expect(readonlyUnpinned.button('이 출력 고정')).toBeUndefined();
  expect(readonlyUnpinned.button('고정 풀기')).toBeUndefined();
  await readonlyUnpinned.close();

  const failed = await mount(done(true, 'output'), false, false, true);
  await act(async () => failed.button('이 출력 고정')!.props.onClick());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(failed.text()).toContain('고정 변경 실패: save denied');
  expect(failed.renderer.root.findAllByProps({ role: 'alert' }).some((item) => item.props.className.includes('text-error') && item.children.join('').includes('save denied'))).toBe(true);
  await failed.close();
});

test('unsupported or unreadable health disables both actions and sends no run even if handlers fire', async () => {
  for (const health of [{}, { workflowRunModes: false }, { workflowRunModes: 'true' }, new Error('offline')]) {
    const panel = await mount(done(false, null), false, false, false, { health, runId: 'last' });
    expect(panel.calls.health).toHaveBeenCalledTimes(1);
    expect(panel.button('이 노드만 시험')!.props.disabled).toBe(true);
    expect(panel.button('실패 노드부터 다시')!.props.disabled).toBe(true);
    expect(panel.text()).toContain('서버가 아직 이 기능을 지원하지 않습니다');
    await panel.click('이 노드만 시험');
    await panel.click('실패 노드부터 다시');
    expect(panel.calls.run).toHaveBeenCalledTimes(0);
    await panel.close();
  }
});

test('supported node test sends onlyNode and optional last run id; retry only on last failed node', async () => {
  const fresh = await mount([], false, false, false, { health: { workflowRunModes: true }, runMode: 'only' });
  expect(fresh.button('이 노드만 시험')!.props.disabled).toBe(false);
  expect(fresh.button('실패 노드부터 다시')!.props.disabled).toBe(true);
  await fresh.click('이 노드만 시험');
  expect(fresh.calls.run).toHaveBeenCalledWith('wf', '', { onlyNode: 'n' });
  expect(fresh.text()).not.toContain('서버가 전체 실행으로 처리했습니다');
  await fresh.close();

  const failed = await mount(done(false, null), false, false, false,
    { health: { workflowRunModes: true }, runId: 'last', runEvents: done(false, null), runMode: 'only' });
  expect(failed.button('실패 노드부터 다시')!.props.disabled).toBe(false);
  await failed.click('이 노드만 시험');
  await failed.click('실패 노드부터 다시');
  expect(failed.calls.run).toHaveBeenNthCalledWith(1, 'wf', '', { onlyNode: 'n' });
  expect(failed.calls.run).toHaveBeenNthCalledWith(2, 'wf', '', { fromNode: 'n', fromRunId: 'last' });
  await failed.close();

  const success = await mount(done(false, null), false, false, false,
    { health: { workflowRunModes: true }, runId: 'last', runEvents: done(true, 'fixed') });
  expect(success.button('실패 노드부터 다시')!.props.disabled).toBe(true);
  await success.click('실패 노드부터 다시');
  expect(success.calls.run).toHaveBeenCalledTimes(0);
  await success.close();
});

test('test warns on missing or full mode; missing upstream lists nodes; read-only has zero run buttons', async () => {
  for (const mode of [undefined, 'full'] as const) {
    const panel = await mount([], false, false, false, { health: { workflowRunModes: true }, runMode: mode });
    await panel.click('이 노드만 시험');
    expect(panel.text()).toContain('서버가 전체 실행으로 처리했습니다');
    await panel.close();
  }
  const missing = await mount([], false, false, false, {
    health: { workflowRunModes: true },
    runError: new MissingUpstreamError('/v1/workflows/wf/run', { error: 'missing-upstream', nodes: ['a', 'b'] }),
  });
  await missing.click('이 노드만 시험');
  expect(missing.text()).toContain('먼저 고정하거나 한 번 전체 실행이 필요한 노드: a, b');
  await missing.close();

  const readonly = await mount(done(false, null), true, false, false, { health: { workflowRunModes: true }, runId: 'last' });
  expect(readonly.button('이 노드만 시험')).toBeUndefined();
  expect(readonly.button('실패 노드부터 다시')).toBeUndefined();
  expect(readonly.calls.run).toHaveBeenCalledTimes(0);
  await readonly.close();
});

test('«retry from» skips a newer single-node test run and uses the newest run that has upstream outputs (W4b live)', async () => {
  const panel = await mount([], false, false, false, {
    health: { workflowRunModes: true }, runMode: 'from',
    runList: [
      { runId: 'test-only', startedAt: 2, mode: 'only', events: done(false, null) },
      { runId: 'full-run', startedAt: 1, mode: 'full', events: done(false, null) },
    ],
  });
  // the source walk fetches the newest detail (mode 'only'), steps back, fetches the next — wait for it to settle
  for (let i = 0; i < 30 && panel.button('실패 노드부터 다시')?.props.disabled; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  expect(panel.button('실패 노드부터 다시')?.props.disabled).toBe(false);
  await panel.click('실패 노드부터 다시');
  expect(panel.calls.run).toHaveBeenLastCalledWith('wf', '', { fromNode: 'n', fromRunId: 'full-run' });
  await panel.close();
});
