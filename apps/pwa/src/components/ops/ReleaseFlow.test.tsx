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
