import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { currentNodeId, ReleaseRunsContent, ReleaseRunsView } from './ReleaseRunsView';
import ReleasePage from '../../app/ops/release/page';
import type { ReleaseRun, OpsResult } from '@/lib/ops-api';

const run: ReleaseRun = {
  runId: 'r1', version: '0.2.9', status: 'running', startedAt: '2026-10-02T00:00:00Z',
  path: ['first', 'waiting', 'last'], nodes: [
    { nodeId: 'last', ok: null, summary: '마지막' }, { nodeId: 'waiting', ok: null, summary: '진행 중' }, { nodeId: 'first', ok: true, summary: '완료' },
  ],
};
function render(result: OpsResult<ReleaseRun[]> | null, openedNodeId: string | null = null, log: OpsResult<{ log: string }> | null = null): string {
  return renderToStaticMarkup(<ReleaseRunsContent result={result} version="0.2.9" selectedRunId="r1" openedNodeId={openedNodeId} log={log}
    onVersion={() => {}} onRun={() => {}} onNode={() => {}} />);
}
describe('OPS1 release runs', () => {
  test('direct release route mounts the release runs view', () => {
    const page = ReleasePage();
    expect(page).toMatchObject({ type: ReleaseRunsView });
  });
  test('current is first null in path order, falling back to last path node', () => {
    expect(currentNodeId(run)).toBe('waiting');
    expect(currentNodeId({ ...run, nodes: run.nodes.map((node) => ({ ...node, ok: true })) })).toBe('last');
  });
  test('renders status/time, node rows in path order, icons and one current marker', () => {
    const html = render({ kind: 'ready', data: [run] });
    expect(html).toContain('2026-10-02T00:00:00Z');
    expect(html).toContain('running');
    expect(html.indexOf('first')).toBeLessThan(html.indexOf('waiting'));
    expect(html.indexOf('waiting')).toBeLessThan(html.indexOf('last'));
    expect(html).toContain('✅'); expect(html).toContain('⏳'); expect(html).toContain('진행 중');
    expect(html.match(/지금 위치/g)?.length).toBe(1);
    expect(render({ kind: 'ready', data: [{ ...run, nodes: run.nodes.map((node) => ({ ...node, ok: false })) }] })).toContain('❌');
  });
  test('expanded node shows a contained horizontally scrollable monospaced log', () => {
    const html = render({ kind: 'ready', data: [run] }, 'waiting', { kind: 'ready', data: { log: 'full log tail' } });
    expect(html).toContain('full log tail');
    expect(html).toContain('overflow-x-auto');
    expect(html).toContain('font-mono');
    expect(html).toContain('aria-expanded="true"');
    expect(render({ kind: 'ready', data: [run] })).not.toContain('full log tail');
  });
  test('selected version scopes run list without a second call and suggests other versions', () => {
    const html = renderToStaticMarkup(<ReleaseRunsContent result={{ kind: 'ready', data: [run, { ...run, runId: 'r2', version: '0.2.8' }] }}
      version="0.2.9" versions={['0.2.8', '0.2.9']} selectedRunId={null} openedNodeId={null} log={null}
      onVersion={() => {}} onRun={() => {}} onNode={() => {}} />);
    expect(html).toContain('value="0.2.8"');
    expect(html).not.toContain('r2');
    expect(html).toContain('0.2.9 · running');
  });
  test('client effect polls running runs every 10 seconds, pauses while hidden, stops after completion and on 403', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const timers = new Map<number, () => void>();
    let timerId = 0;
    const listeners = new Map<string, () => void>();
    const doc = { hidden: false, addEventListener: (key: string, fn: () => void) => { listeners.set(key, fn); }, removeEventListener: (key: string) => { listeners.delete(key); } };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { setInterval: (fn: () => void, ms: number) => { expect(ms).toBe(10_000); const id = ++timerId; timers.set(id, fn); return id; }, clearInterval: (id: number) => { timers.delete(id); } } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
    const calls: string[] = [];
    let response: unknown = [run];
    const client = { fetchResponse: async (path: string) => { calls.push(path); return new Response(JSON.stringify(response), { status: response === 'forbidden' ? 403 : response === 'temporary-error' ? 503 : 200 }); } };
    const daemon = { config: { baseUrl: '', token: '', provider: '' }, setConfig: () => {}, client: client as never, sessionId: 'test', setSessionId: () => {} };
    let tree: ReturnType<typeof create> | undefined;
    try {
      await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ReleaseRunsView /></DaemonContext.Provider>); });
      expect(calls).toEqual(['/v1/ops/release/runs']);
      expect(timers.size).toBe(1);
      response = { log: 'selected node tail' };
      await act(async () => { tree!.root.findAllByType('button').find((button) => button.props['aria-expanded'] === false && button.children.some((child) => typeof child !== 'string'))!.props.onClick(); });
      expect(calls[1]).toBe('/v1/ops/release/runs/r1/nodes/first/log');
      expect(JSON.stringify(tree!.toJSON())).toContain('selected node tail');
      response = [run];
      doc.hidden = true;
      await act(async () => { for (const tick of timers.values()) tick(); });
      expect(calls).toHaveLength(2);
      doc.hidden = false;
      await act(async () => { listeners.get('visibilitychange')?.(); });
      expect(calls).toHaveLength(3);
      response = 'temporary-error';
      await act(async () => { for (const tick of timers.values()) tick(); });
      expect(JSON.stringify(tree!.toJSON())).toContain('503');
      expect(timers.size).toBe(1);
      response = [run];
      await act(async () => { for (const tick of timers.values()) tick(); });
      expect(calls).toHaveLength(5);
      response = [{ ...run, status: 'completed' }];
      await act(async () => { for (const tick of timers.values()) tick(); });
      expect(timers.size).toBe(0);
      expect(calls).toHaveLength(6);
      await act(async () => { tree!.unmount(); });
      response = 'forbidden';
      await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ReleaseRunsView /></DaemonContext.Provider>); });
      expect(JSON.stringify(tree!.toJSON())).toContain('운영자만 볼 수 있습니다');
      expect(timers.size).toBe(0);
      expect(calls).toHaveLength(7);
    } finally {
      if (tree) await act(async () => { tree!.unmount(); });
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    }
  });
  test('seat strip deep link opens the requested run even when its version is not the first run version', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: '?run=r1' }, setInterval: () => 1, clearInterval: () => {} } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: false, addEventListener: () => {}, removeEventListener: () => {} } });
    const calls: string[] = [];
    const other = { ...run, runId: 'older', version: '0.3.0' };
    const client = { fetchResponse: async (path: string) => {
      calls.push(path);
      return new Response(JSON.stringify([other, run]), { status: 200 });
    } };
    const daemon = { config: { baseUrl: '', token: '', provider: '' }, setConfig: () => {}, client: client as never, sessionId: 'test', setSessionId: () => {} };
    let tree: ReturnType<typeof create> | undefined;
    try {
      await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ReleaseRunsView /></DaemonContext.Provider>); });
      expect(calls).toEqual(['/v1/ops/release/runs']);
      expect(tree!.root.findByProps({ 'aria-label': '판' }).props.value).toBe('0.2.9');
      expect(tree!.root.findAllByType('button').filter((button) => button.props['aria-pressed'] === true)).toHaveLength(1);
      expect(JSON.stringify(tree!.toJSON())).toContain('진행 중');
    } finally {
      if (tree) await act(async () => { tree!.unmount(); });
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    }
  });
  test('403 has exactly one visible sentence and no controls or run data', () => {
    expect(render({ kind: 'forbidden' })).toBe('<p>운영자만 볼 수 있습니다</p>');
    expect(render({ kind: 'ready', data: [run] }, 'waiting', { kind: 'forbidden' })).toBe('<p>운영자만 볼 수 있습니다</p>');
  });
});
