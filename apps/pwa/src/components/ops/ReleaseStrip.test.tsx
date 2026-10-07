import { expect, test } from 'bun:test';
import { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReleaseRun } from '@/lib/ops-api';
import { latestReleaseRun, ReleaseStrip } from './ReleaseStrip';

const now = Date.parse('2026-10-06T12:00:00Z');
const run: ReleaseRun = {
  runId: 'recent', status: 'running', startedAt: '2026-10-06T11:52:00Z', version: '0.2.9',
  path: ['gate', 'publish', 'announce'], nodes: [
    { nodeId: 'announce', ok: null, summary: '대기' },
    { nodeId: 'publish', ok: null, summary: '진행' },
    { nodeId: 'gate', ok: true, summary: '통과' },
  ],
};
const ready = (runs: ReleaseRun[]) => ({ kind: 'ready' as const, data: runs });
const html = (runs: ReleaseRun[]) => renderToStaticMarkup(<ReleaseStrip result={ready(runs)} onSelect={() => {}} now={now} />);

test('가장 최근 startedAt 런의 판·현재 노드·순번·경과를 표시하고 칩은 path 순서다', () => {
  const old = { ...run, runId: 'old', version: '0.2.8', startedAt: '2026-10-06T11:00:00Z' };
  expect(latestReleaseRun(ready([run, old]), now)?.runId).toBe('recent');
  const markup = html([old, run]);
  expect(markup).toContain('발행 0.2.9');
  expect(markup).toContain('publish (2/3)');
  expect(markup).toContain('경과 8분');
  expect(markup.indexOf('✓ gate')).toBeLessThan(markup.indexOf('publish</span>'));
  expect(markup.indexOf('publish</span>')).toBeLessThan(markup.indexOf('announce</span>'));
  expect(markup).toContain('aria-current="step"');
  expect(markup).toContain('opacity-50');
});

test('현재 실패 노드 또는 실패·막힘 상태에서 summary 첫 줄만 보인다', () => {
  const failed = { ...run, nodes: run.nodes.map((node) => node.nodeId === 'publish' ? { ...node, ok: false, summary: '인증 실패\n민감한 로그' } : node) };
  expect(html([failed])).toContain('막힘: 인증 실패');
  expect(html([failed])).not.toContain('민감한 로그');
  expect(html([{ ...run, status: 'blocked', nodes: run.nodes.map((node) => node.nodeId === 'publish' ? { ...node, summary: '승인 대기\n상세' } : node) }])).toContain('막힘: 승인 대기');
  expect(html([run])).not.toContain('막힘:');
});

test('24시간 초과 완료/실패한 최신 런은 숨기고 더 오래된 진행 중 런으로 대체하지 않는다', () => {
  for (const status of ['done', 'completed', 'failed', 'success', 'error']) {
    const finished = { ...run, status, startedAt: '2026-10-05T11:59:59Z' };
    expect(html([{ ...run, startedAt: '2026-10-04T11:00:00Z' }, finished])).toBe('');
  }
  expect(html([{ ...run, status: 'completed', startedAt: '2026-10-05T12:00:00Z' }])).toContain('발행 0.2.9');
});

test('알 수 없는 상태는 그대로 두고 칩만 가로 스크롤하며 클릭하면 선택된 런을 전달한다', () => {
  const unknown = { ...run, status: 'future-pause' };
  const selected: ReleaseRun[] = [];
  const element = ReleaseStrip({ result: ready([unknown]), now, onSelect: (value) => { selected.push(value); } });
  expect(element).not.toBeNull();
  const markup = html([unknown]);
  expect(markup).toContain('상태: future-pause');
  expect(markup).toContain('min-w-0 flex-1 overflow-x-auto whitespace-nowrap');
  expect(markup).toContain('shrink-0 whitespace-nowrap');
  expect(markup).toContain('✓ gate');
  if (isValidElement<{ children: ReactNode }>(element)) {
    const button = Children.toArray(element.props.children)[0];
    if (isValidElement<{ onClick: () => void }>(button)) button.props.onClick();
  }
  expect(selected).toEqual([unknown]);
});
