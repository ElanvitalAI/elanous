import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { currentNodeId, ReleaseRunsContent, ReleaseRunsView } from './ReleaseRunsView';
import ReleasePage from '../../app/ops/release/page';
import type { ReleaseRun, OpsResult } from '@/lib/ops-api';

// Put a global back exactly as it was (descriptor, not value) — re-defining it with `{ value }` leaves a
// non-writable global behind, and the next file in the same bun process then fails on a plain assignment.
function restoreGlobal(name: 'window' | 'document', descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

const run: ReleaseRun = {
  runId: 'r1', version: '0.2.9', status: 'running', startedAt: '2026-10-02T00:00:00Z',
  path: ['first', 'waiting', 'last'], nodes: [
    { nodeId: 'last', ok: null, summary: '마지막' }, { nodeId: 'waiting', ok: null, summary: '진행 중' }, { nodeId: 'first', ok: true, summary: '완료' },
  ],
};
function render(result: OpsResult<ReleaseRun[]> | null, openedNodeId: string | null = null, log: OpsResult<{ log: string }> | null = null): string {
  return renderToStaticMarkup(<ReleaseRunsContent result={result} version="0.2.9" selectedRun={result?.kind === 'ready' ? result.data.find((item) => item.runId === 'r1') ?? null : null} openedNodeId={openedNodeId} log={log}
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
  test('renders status/time, node flow in path order with state words and one current step', () => {
    const html = render({ kind: 'ready', data: [run] });
    expect(html).toContain('dateTime="2026-10-02T00:00:00Z"');
    expect(html).toMatch(/2026\. 10\. 2\. 09:00 KST/);
    expect(html).toContain('running');
    expect(html.indexOf('title="first"')).toBeLessThan(html.indexOf('title="waiting"'));
    expect(html.indexOf('title="waiting"')).toBeLessThan(html.indexOf('title="last"'));
    expect(html).toContain('끝남'); expect(html).toContain('지금'); expect(html).toContain('남음');
    expect(html.match(/aria-current="step"/g)?.length).toBe(1);
    expect(render({ kind: 'ready', data: [{ ...run, nodes: run.nodes.map((node) => ({ ...node, ok: false })) }] })).toContain('실패');
  });
  test('run list converts UTC across the date boundary to KST while retaining the source datetime', () => {
    const markup = render({ kind: 'ready', data: [{ ...run, startedAt: '2026-10-02T16:45:00Z' }] });
    expect(markup).toContain('aria-label="시작 시각 (KST)"');
    expect(markup).toContain('dateTime="2026-10-02T16:45:00Z"');
    expect(markup).toMatch(/2026\. 10\. 3\. 01:45 KST/);
    expect(markup).not.toContain('2026-10-02T16:45:00Z</time>');
  });
  test('opened node shows a detail panel with the summary and a contained horizontally scrollable monospaced log', () => {
    const html = render({ kind: 'ready', data: [run] }, 'waiting', { kind: 'ready', data: { log: 'full log tail' } });
    expect(html).toContain('full log tail');
    expect(html).toContain('aria-label="노드 상세"');
    expect(html).toContain('overflow-auto');
    expect(html).toContain('font-mono');
    expect(html).toContain('aria-expanded="true"');
    expect(render({ kind: 'ready', data: [run] })).not.toContain('full log tail');
  });
  test('selected version scopes run list without a second call and suggests other versions', () => {
    const html = renderToStaticMarkup(<ReleaseRunsContent result={{ kind: 'ready', data: [run, { ...run, runId: 'r2', version: '0.2.8' }] }}
      version="0.2.9" versions={['0.2.8', '0.2.9']} selectedRun={run} openedNodeId={null} log={null}
      onVersion={() => {}} onRun={() => {}} onNode={() => {}} />);
    expect(html).toContain('value="0.2.8"');
    expect(html).not.toContain('r2');
    expect(html).toContain('0.2.9 · running');
  });
  test('a run outside the chosen version cannot appear as the node flow', () => {
    const html = renderToStaticMarkup(<ReleaseRunsContent result={{ kind: 'ready', data: [run] }}
      version="0.2.9" selectedRun={{ ...run, runId: 'another', version: '0.2.8' }} openedNodeId={null} log={null}
      onVersion={() => {}} onRun={() => {}} onNode={() => {}} />);
    expect(html).not.toContain('aria-label="노드 진행"');
    expect(html).toContain('aria-label="런 목록"');
  });
  test('client effect polls running runs every 10 seconds, pauses while hidden, stops after completion and on 403', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
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
      const polledStrip = tree!.root.findByProps({ 'aria-label': '발행 진행' });
      expect(polledStrip.findAllByType('span').some((span) => span.children.some((child) => typeof child === 'string' && child.includes('끝남')))).toBe(true);
      expect(tree!.root.findByProps({ 'aria-label': '노드 흐름' }).findAllByProps({ title: 'waiting' })).toHaveLength(1);
      await act(async () => { tree!.unmount(); });
      response = 'forbidden';
      await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ReleaseRunsView /></DaemonContext.Provider>); });
      expect(JSON.stringify(tree!.toJSON())).toContain('운영자만 볼 수 있습니다');
      expect(timers.size).toBe(0);
      expect(calls).toHaveLength(7);
    } finally {
      if (tree) await act(async () => { tree!.unmount(); });
      restoreGlobal('window', originalWindow);
      restoreGlobal('document', originalDocument);
    }
  });
  test('selected run stays identical in strip and flow after polling a different latest run', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const timers = new Map<number, () => void>();
    let timerId = 0;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      location: { search: '' },
      setInterval: (fn: () => void) => { const id = ++timerId; timers.set(id, fn); return id; },
      clearInterval: (id: number) => { timers.delete(id); },
    } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
      hidden: false, addEventListener: () => {}, removeEventListener: () => {},
    } });
    const latest = { ...run, runId: 'latest', startedAt: new Date(Date.now() - 60_000).toISOString() };
    const selected = { ...run, runId: 'selected', startedAt: new Date(Date.now() - 120_000).toISOString(),
      status: 'failed', nodes: run.nodes.map((node) => node.nodeId === 'waiting'
        ? { ...node, ok: false, summary: '선택 런 실패', startedAt: '2026-10-02T16:45:00Z', endedAt: '2026-10-02T17:00:00Z' }
        : node) };
    let runs = [latest, selected];
    const calls: string[] = [];
    const client = { fetchResponse: async (path: string) => { calls.push(path); return new Response(JSON.stringify(runs)); } };
    const daemon = { config: { baseUrl: '', token: '', provider: '' }, setConfig: () => {}, client: client as never, sessionId: 'test', setSessionId: () => {} };
    let tree: ReturnType<typeof create> | undefined;
    try {
      await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ReleaseRunsView /></DaemonContext.Provider>); });
      expect(calls).toEqual(['/v1/ops/release/runs']);
      expect(timers.size).toBe(1);
      const strip = () => tree!.root.findByProps({ 'aria-label': '발행 진행' });
      const flow = () => tree!.root.findByProps({ 'aria-label': '노드 흐름' });
      const sameRun = (id: string) => {
        expect(strip().props['data-run-id']).toBe(id);
        expect(tree!.root.findByProps({ 'aria-label': '노드 진행' }).props['data-run-id']).toBe(id);
      };
      const chips = () => strip().findByProps({ 'aria-label': '발행 노드 순서' }).findAllByType('span')
        .filter((chip) => chip.props.className?.includes('rounded-full')).map((chip) => chip.children.join(''));
      sameRun('latest');
      expect(chips()).toEqual(['✓ first', 'waiting', 'last']);
      expect(flow().findAllByType('li').map((node) => node.props['data-node-state'])).toEqual(['done', 'current', 'pending']);
      const buttons = tree!.root.findByProps({ 'aria-label': '런 목록' }).findAllByType('button');
      await act(async () => { buttons[1]!.props.onClick(); });
      expect(tree!.root.findByProps({ 'aria-label': '런 목록' }).findAllByType('button')[1]!.props['aria-pressed']).toBe(true);
      sameRun('selected');
      expect(strip().findAllByType('p').some((p) => p.children.join('') === '상태: failed')).toBe(true);
      expect(chips()).toEqual(['✓ first', '✗ waiting', 'last']);
      expect(flow().findAllByType('li').map((node) => node.props['data-node-state'])).toEqual(['done', 'failed', 'pending']);
      expect(flow().findAllByType('span').some((span) => span.children.includes('01:45–02:00 · 15분'))).toBe(true);
      runs = [latest, { ...selected, status: 'completed', nodes: selected.nodes.map((node) => ({ ...node, ok: true })) }];
      await act(async () => { for (const tick of [...timers.values()]) tick(); });
      expect(calls).toEqual(['/v1/ops/release/runs', '/v1/ops/release/runs']);
      sameRun('selected');
      expect(strip().findByType('p').children.join('')).toBe('상태: completed');
      expect(chips()).toEqual(['✓ first', '✓ waiting', '✓ last']);
      expect(flow().findAllByType('li').map((node) => node.props['data-node-state'])).toEqual(['done', 'done', 'done']);
      expect(tree!.root.findByProps({ 'aria-label': '런 목록' }).findAllByType('button')[1]!.props['aria-pressed']).toBe(true);
    } finally {
      if (tree) await act(async () => { tree!.unmount(); });
      restoreGlobal('window', originalWindow);
      restoreGlobal('document', originalDocument);
    }
  });
  test('seat strip deep link opens the requested run even when its version is not the first run version', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: '?run=r1' }, setInterval: () => 1, clearInterval: () => {} } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: false, addEventListener: () => {}, removeEventListener: () => {} } });
    const calls: string[] = [];
    const other = { ...run, runId: 'older', version: '0.3.0', status: 'done', nodes: run.nodes.map((node) => ({ ...node, ok: true })) };
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
      const strip = tree!.root.findByProps({ 'aria-label': '발행 진행' });
      const flow = tree!.root.findByProps({ 'aria-label': '노드 흐름' });
      expect(strip.props['data-run-id']).toBe('r1');
      expect(tree!.root.findByProps({ 'aria-label': '노드 진행' }).props['data-run-id']).toBe('r1');
      expect(strip.findByProps({ 'aria-label': '발행 노드 순서' }).findAllByType('span')
        .filter((chip) => chip.props.className?.includes('rounded-full')).map((chip) => chip.children.join(''))).toEqual(['✓ first', 'waiting', 'last']);
      expect(strip.findByType('p').children.join('')).toBe('상태: running');
      expect(flow.findAllByType('li').map((node) => node.props['data-node-state'])).toEqual(['done', 'current', 'pending']);
      expect(flow.findAllByProps({ title: 'waiting' })).toHaveLength(1);
    } finally {
      if (tree) await act(async () => { tree!.unmount(); });
      restoreGlobal('window', originalWindow);
      restoreGlobal('document', originalDocument);
    }
  });
  test('the strip and flow follow the same run across latest, list selection and version changes', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: '' }, setInterval: () => 1, clearInterval: () => {} } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: false, addEventListener: () => {}, removeEventListener: () => {} } });
    const recent = { ...run, runId: 'recent', version: '0.3.0', startedAt: new Date(Date.now() - 60_000).toISOString(), path: ['recent-node'], nodes: [{ nodeId: 'recent-node', ok: null, summary: '최근' }] };
    const older = { ...run, runId: 'older', startedAt: new Date(Date.now() - 120_000).toISOString(), path: ['older-node'], nodes: [{ nodeId: 'older-node', ok: null, summary: '이전' }] };
    const sameVersion = { ...run, runId: 'same-version', version: '0.3.0', startedAt: new Date(Date.now() - 180_000).toISOString(), path: ['same-version-node'], nodes: [{ nodeId: 'same-version-node', ok: null, summary: '같은 판' }] };
    const client = { fetchResponse: async (path: string) => new Response(JSON.stringify(path.includes('version=') ? path.includes('0.3.0') ? [sameVersion, recent] : path.includes('0.4.0') ? [] : [older] : [older, sameVersion, recent])) };
    const daemon = { config: { baseUrl: '', token: '', provider: '' }, setConfig: () => {}, client: client as never, sessionId: 'test', setSessionId: () => {} };
    let tree: ReturnType<typeof create> | undefined;
    try {
      await act(async () => { tree = create(<DaemonContext.Provider value={daemon}><ReleaseRunsView /></DaemonContext.Provider>); });
      const stripNode = () => tree!.root.findByProps({ 'aria-label': '발행 노드 순서' });
      const flowNode = () => tree!.root.findByProps({ 'aria-label': '노드 흐름' });
      const sameRun = (id: string) => {
        expect(tree!.root.findByProps({ 'aria-label': '발행 진행' }).props['data-run-id']).toBe(id);
        expect(tree!.root.findByProps({ 'aria-label': '노드 진행' }).props['data-run-id']).toBe(id);
      };
      sameRun('recent');
      expect(stripNode().findAllByType('span').some((chip) => chip.children.includes('recent-node'))).toBe(true);
      expect(flowNode().findAllByProps({ title: 'recent-node' })).toHaveLength(1);
      const otherButton = tree!.root.findByProps({ 'aria-label': '런 목록' }).findAllByType('button').find((button) => button.props['aria-pressed'] === false)!;
      await act(async () => { otherButton.props.onClick(); });
      sameRun('same-version');
      expect(stripNode().findAllByType('span').some((chip) => chip.children.includes('same-version-node'))).toBe(true);
      expect(flowNode().findAllByProps({ title: 'same-version-node' })).toHaveLength(1);
      await act(async () => { tree!.root.findByProps({ 'aria-label': '판' }).props.onChange({ target: { value: '0.2.9' } }); });
      sameRun('older');
      expect(stripNode().findAllByType('span').some((chip) => chip.children.includes('older-node'))).toBe(true);
      expect(flowNode().findAllByProps({ title: 'older-node' })).toHaveLength(1);
      expect(flowNode().findAllByProps({ title: 'recent-node' })).toHaveLength(0);
      await act(async () => { tree!.root.findByProps({ 'aria-label': '판' }).props.onChange({ target: { value: '0.4.0' } }); });
      expect(tree!.root.findAllByProps({ 'aria-label': '발행 진행' })).toHaveLength(0);
      expect(tree!.root.findAllByProps({ 'aria-label': '노드 흐름' })).toHaveLength(0);
    } finally {
      if (tree) await act(async () => { tree!.unmount(); });
      restoreGlobal('window', originalWindow);
      restoreGlobal('document', originalDocument);
    }
  });
  test('403 has exactly one visible sentence and no controls or run data', () => {
    expect(render({ kind: 'forbidden' })).toBe('<p>운영자만 볼 수 있습니다</p>');
    expect(render({ kind: 'ready', data: [run] }, 'waiting', { kind: 'forbidden' })).toBe('<p>운영자만 볼 수 있습니다</p>');
  });
});
