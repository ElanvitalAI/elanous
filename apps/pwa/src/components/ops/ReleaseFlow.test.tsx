import { describe, expect, test } from 'bun:test';
import { useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import type { OpsResult, ReleaseRun } from '@/lib/ops-api';
import { nodeState, nodeTime, ReleaseFlow, ReleaseNodeDetail, shardProgress } from './ReleaseFlow';

// 원장 실측 상태값(done · failed · running)과 path 순서와 다른 nodes 순서를 일부러 섞는다.
const run: ReleaseRun = {
  runId: 'r1', version: '0.2.19', status: 'running', startedAt: '2026-10-07T00:00:00Z',
  path: ['prepare', 'gate', 'publish', 'verify'],
  nodes: [
    { nodeId: 'verify', ok: null, summary: '' },
    { nodeId: 'gate', ok: null, summary: '샤드 7/24 진행' },
    { nodeId: 'prepare', ok: true, summary: '판 준비 끝' },
    { nodeId: 'publish', ok: null, summary: '' },
  ],
};
const failed: ReleaseRun = { ...run, status: 'failed', nodes: run.nodes.map((node) => node.nodeId === 'gate'
  ? { ...node, ok: false, summary: 'gate 실패: 3 tests failed\n두 번째 줄' } : node) };
type Node = { children: Array<string | Node> };
const textOf = (node: Node): string => node.children.map((child) => typeof child === 'string' ? child : textOf(child)).join('');
const flow = (r: ReleaseRun, opened: string | null = null) =>
  renderToStaticMarkup(<ReleaseFlow run={r} openedNodeId={opened} onNode={() => {}} now={Date.parse('2026-10-07T01:00:00Z')} />);

describe('RELEASE-LIVE2 release node flow', () => {
  test('chain follows path order (not nodes order) and every node carries a state word, not only a colour', () => {
    const html = flow(run);
    const order = run.path.map((id) => html.indexOf(`title="${id}"`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(run.path.map((id) => nodeState(run, id))).toEqual(['done', 'current', 'pending', 'pending']);
    expect(html.match(/data-node-state="([a-z]+)"/g)).toEqual([
      'data-node-state="done"', 'data-node-state="current"', 'data-node-state="pending"', 'data-node-state="pending"']);
    for (const word of ['끝남', '지금', '남음']) expect(html).toContain(word);
    expect(html.match(/aria-current="step"/g)?.length).toBe(1);
  });
  test('a failed run shows 실패 on the failed node and no 지금 step', () => {
    const html = flow(failed);
    expect(nodeState(failed, 'gate')).toBe('failed');
    expect(nodeState(failed, 'publish')).toBe('pending');
    expect(html).toContain('실패');
    expect(html).not.toContain('aria-current="step"');
  });
  test('times: missing → 시각 미기록 · present optional fields → clock and minutes', () => {
    expect(flow(run).match(/시각 미기록/g)?.length).toBe(4);
    expect(nodeTime(undefined, 0)).toBe('시각 미기록');
    const timed = nodeTime({ nodeId: 'x', ok: true, summary: '', startedAt: '2026-10-07T00:00:00Z', endedAt: '2026-10-07T00:12:00Z' }, 0);
    expect(timed).toBe('09:00–09:12 · 12분');
    expect(nodeTime({ nodeId: 'x', ok: null, summary: '', startedAt: '2026-10-07T15:00:00Z' }, Date.parse('2026-10-07T15:05:00Z'))).toBe('00:00 시작 · 5분');
    expect(timed).not.toContain('미기록');
  });
  test('shard progress is parsed from the summary when present and omitted otherwise', () => {
    expect(shardProgress('샤드 7/24 진행')).toEqual({ done: 7, total: 24 });
    expect(shardProgress('shards 24/24 green')).toEqual({ done: 24, total: 24 });
    expect(shardProgress('판 준비 끝')).toBeNull();
    expect(shardProgress('샤드 30/24')).toBeNull();
    const html = flow(run);
    expect(html).toContain('샤드 7/24');
    expect(html.match(/샤드 \d+\/\d+/g)?.length).toBe(2); // aria-label + visible text on the gate node only
  });
  test('clicking a node opens its detail: full summary, failed first line emphasised, log tail', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const log: OpsResult<{ log: string }> = { kind: 'ready', data: { log: 'start\nError: shard 3 failed\nend' } };
    function Harness() {
      const [opened, setOpened] = useState<string | null>(null);
      return <><ReleaseFlow run={failed} openedNodeId={opened} onNode={setOpened} />
        {opened && <ReleaseNodeDetail run={failed} nodeId={opened} log={log} />}</>;
    }
    let tree: ReturnType<typeof create> | undefined;
    await act(async () => { tree = create(<Harness />); });
    expect(tree!.root.findAllByProps({ 'aria-label': '노드 상세' })).toHaveLength(0);
    const gate = tree!.root.findAllByType('button').find((button) => button.findAllByProps({ title: 'gate' }).length > 0)!;
    await act(async () => { gate.props.onClick(); });
    const detail = tree!.root.findByProps({ 'aria-label': '노드 상세' });
    const text = textOf(detail.findByType('header') as unknown as Node);
    expect(text).toContain('gate');
    expect(text).toContain('실패');
    expect(detail.findByProps({ role: 'alert' }).props.children).toBe('gate 실패: 3 tests failed');
    expect(textOf(detail as unknown as Node)).toContain('두 번째 줄');
    const lines = detail.findByProps({ 'aria-label': '노드 로그' }).findAllByType('span');
    expect(lines.map((line) => line.props.children)).toEqual(['start', 'Error: shard 3 failed', 'end']);
    expect(lines[1]!.props.className).toContain('font-semibold');
    expect(lines[0]!.props.className).not.toContain('font-semibold');
    await act(async () => { tree!.unmount(); });
  });
});

describe('GATE-LIVE-OBS gate shard table', () => {
  const counts = { pending: 2, running: 1, done: 1, retry: 0, timeout: 1, failed: 0 };
  const gated: ReleaseRun = { ...run, gateShards: {
    version: '0.2.19', updatedAt: '2026-10-07T00:59:00Z',
    shards: [
      { id: 'pod-3', state: 'done', rc: 0 },
      { id: 'pod-1', state: 'pending', waitReason: 'CPU 부족 31.2/32', plannedMin: 15 },
      { id: 'pod-2', state: 'pending', waitReason: 'CPU 부족 31.2/32', plannedMin: 15 },
      { id: 'pod-0', state: 'running', plannedMin: 20 },
      { id: 'pod-4', state: 'timeout', rc: 124 },
    ],
    summary: { total: 5, counts, waitReasons: [{ reason: 'CPU 부족 31.2/32', count: 2 }], etaMin: 75, staleMin: 1 },
  } };
  const detail = (r: ReleaseRun) => renderToStaticMarkup(<ReleaseNodeDetail run={r} nodeId="gate" log={null} now={Date.parse('2026-10-07T01:00:00Z')} />);

  test('the current gate chip shows the shard tally instead of the summary-parsed n/m', () => {
    const html = flow(gated);
    expect(html).toContain('조각 5 · 잘림 1 · 대기 2 · 돌기 1 · 끝 1');
    expect(html).not.toContain('샤드 7/24');
  });
  test('gate detail lists every shard with a state word, worst first, plus wait reasons and the estimate', () => {
    const html = detail(gated);
    const states = [...(html.match(/data-shard-state="([a-z]+)"/g) ?? [])];
    expect(states).toEqual(['timeout', 'pending', 'pending', 'running', 'done'].map((s) => `data-shard-state="${s}"`));
    for (const word of ['잘림', '대기', '돌기', '끝']) expect(html).toContain(word);
    expect(html).toContain('대기 2</span> — CPU 부족 31.2/32');
    expect(html).toContain('남은 약 1시간 15분');
    expect(html).not.toContain('갱신 없음');
  });
  test('no shard file → the old view, unchanged; a stale file warns', () => {
    expect(detail(run)).not.toContain('게이트 조각');
    const stale = { ...gated, gateShards: { ...gated.gateShards!, summary: { ...gated.gateShards!.summary, staleMin: 22, etaMin: null } } };
    const html = detail(stale);
    expect(html).toContain('⚠️ 22분째 갱신 없음');
    expect(html).toContain('남은 시간 추정 불가');
  });
});

test('GATE-LIVE-OBS eta text: overrun beats the plan estimate, and 0 minutes with shards still open is not «남은 조각 없음»', async () => {
  const { etaText } = await import('./GateShards');
  expect(etaText(0, { overrunMin: 19, open: 1 })).toBe('계획보다 19분 넘게 도는 중 — 남은 시간 추정 불가');
  expect(etaText(0, { open: 2 })).toBe('곧 끝남(계획상)');
  expect(etaText(0)).toBe('남은 조각 없음');
  expect(etaText(75)).toBe('남은 약 1시간 15분');
});

test('GATE-LIVE-OBS: a done shard with rc 1 reads «끝 · 실패 보고», not a green pass', async () => {
  const { GateShardsPanel, shardTally } = await import('./GateShards');
  const gate = { version: '0.2.20', updatedAt: '2026-10-08T00:00:00Z',
    shards: [{ id: 'pod-20', state: 'done' as const, rc: 1 }, { id: 'pod-21', state: 'done' as const, rc: 0 }],
    summary: { total: 2, counts: { pending: 0, running: 0, done: 2, retry: 0, timeout: 0, failed: 0 }, waitReasons: [], etaMin: 0, staleMin: 0 } };
  expect(shardTally(gate)).toBe('조각 2 · 끝 2(실패 보고 1)');
  const html = renderToStaticMarkup(<GateShardsPanel gate={gate} />);
  expect(html).toContain('! 끝 · 실패 보고');
  expect(html.indexOf('pod-20')).toBeLessThan(html.indexOf('pod-21'));
  expect(html).not.toContain('통과');
});
