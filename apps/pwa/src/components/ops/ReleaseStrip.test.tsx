import { expect, test } from 'bun:test';
import { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReleaseRun } from '@/lib/ops-api';
import { finishedMinutes, latestReleaseRun, ReleaseStrip } from './ReleaseStrip';

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

test('선택된 런이 있으면 최신 자동 런보다 우선해 동일한 런의 노드와 상태를 보인다', () => {
  const older = { ...run, runId: 'older', version: '0.2.8', status: 'done', startedAt: '2026-10-06T10:00:00Z', path: ['older-node'], nodes: [{ nodeId: 'older-node', ok: true, summary: '완료' }] };
  const markup = renderToStaticMarkup(<ReleaseStrip result={ready([run, older])} selectedRun={older} onSelect={() => {}} now={now} />);
  expect(markup).toContain('발행 0.2.8');
  expect(markup).toContain('✓ older-node');
  expect(markup).toContain('끝남');
  expect(markup).not.toContain('publish');
});

test('현재 실패 노드 또는 실패·막힘 상태에서 summary 첫 줄만 보인다', () => {
  const failed = { ...run, nodes: run.nodes.map((node) => node.nodeId === 'publish' ? { ...node, ok: false, summary: '인증 실패\n민감한 로그' } : node) };
  expect(html([failed])).toContain('막힘: 인증 실패');
  expect(html([failed])).not.toContain('민감한 로그');
  expect(html([{ ...run, status: 'blocked', nodes: run.nodes.map((node) => node.nodeId === 'publish' ? { ...node, summary: '승인 대기\n상세' } : node) }])).toContain('막힘: 승인 대기');
  expect(html([run])).not.toContain('막힘:');
});

test('done 런의 실패 노드는 경고로 보이고 running·failed 런은 막힘을 유지한다', () => {
  const nodes = run.nodes.map((node) => node.nodeId === 'publish' ? { ...node, ok: false, summary: 'npm-publish 시간초과\n민감한 로그' } : node);
  const done = renderToStaticMarkup(<ReleaseStrip result={ready([])} selectedRun={{ ...run, status: 'done', nodes }} onSelect={() => {}} now={now} />);
  expect(done).toContain('상태: done');
  expect(done).toContain('role="status"');
  expect(done).toContain('text-amber-700');
  expect(done).toContain('경고: 노드 실패 보고 · 런은 끝남');
  expect(done).not.toContain('막힘:');
  expect(done).not.toContain('text-red-600');
  expect(done).not.toContain('민감한 로그');
  for (const status of ['running', 'failed']) {
    const markup = html([{ ...run, status, nodes }]);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('text-red-600');
    expect(markup).toContain('막힘: npm-publish 시간초과');
    expect(markup).not.toContain('경고: 노드 실패 보고 · 런은 끝남');
    expect(markup).not.toContain('민감한 로그');
  }
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

test('RELEASE-STRIP-DONE: 끝난 런은 «끝남 · 걸린 시간 X분»(마지막 노드 끝 − 런 시작)이고 지금 노드·늘어나는 경과가 없다', () => {
  const nodes = [
    { nodeId: 'gate', ok: true, summary: '통과', startedAt: '2026-10-06T01:00:00Z', endedAt: '2026-10-06T01:20:00Z' },
    { nodeId: 'npm-publish', ok: false, summary: '시간초과', startedAt: '2026-10-06T01:20:00Z', endedAt: '2026-10-06T01:47:30Z' },
  ];
  for (const status of ['done', 'failed', 'completed']) {
    const finished = { ...run, status, version: '0.2.19', startedAt: '2026-10-06T01:00:00Z', path: ['gate', 'npm-publish', 'announce'], nodes };
    const at = (t: number) => renderToStaticMarkup(<ReleaseStrip result={ready([])} selectedRun={finished} onSelect={() => {}} now={t} />);
    const markup = at(now);
    expect(markup).toContain('발행 0.2.19');
    expect(markup).toContain('· 끝남 · 걸린 시간 47분');
    expect(markup).not.toContain('경과');
    expect(markup).not.toContain('(2/3)');
    expect(markup).not.toContain('aria-current');
    expect(at(now + 600 * 60_000)).toBe(markup);
  }
  // times missing → plain «끝남»
  const bare = renderToStaticMarkup(<ReleaseStrip result={ready([])} selectedRun={{ ...run, status: 'done' }} onSelect={() => {}} now={now} />);
  expect(bare).toContain('· 끝남</span>');
  expect(bare).not.toContain('걸린 시간');
  expect(bare).not.toContain('경과');
  expect(finishedMinutes({ ...run, startedAt: 'garbage', nodes })).toBeNull();
});

test('RELEASE-STRIP-DONE: 도는 런은 그대로 «노드 (n/m) · 경과 X분»이고 끝남을 보이지 않는다', () => {
  const markup = html([run]);
  expect(markup).toContain('publish (2/3)');
  expect(markup).toContain('경과 8분');
  expect(markup).not.toContain('끝남 ·');
  expect(markup).not.toContain('걸린 시간');
});
