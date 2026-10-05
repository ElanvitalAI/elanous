import { expect, test } from 'bun:test';
import type { LoopRow } from '@/components/loops/loop-status';
import { activityEdgeKey, activityEdges, activityNodes, activityTraceTarget, applyLoopOwners, EDGE_HIGHLIGHT_MS, newlySeenEdges } from './loop-activity-map';
import { leaksInternal } from './public-text';

const now = Date.parse('2026-10-05T10:00:00Z');
const row = (patch: Partial<LoopRow> = {}): LoopRow => ({
  id: 'schedule:morning', name: '아침 루프', layer: 'ops', owner: 'OP', mode: 'daemon', lastRun: null, verdict: '늦음', ...patch,
});
const edge = { at: '2026-10-05T09:59:00Z', kind: 'run' as const, from: 'OP', to: 'loop:run-123abc', ref: 'run-123abc' };

test('registry graph job ownership joins the existing verdict rows without guessing owners', () => {
  const rows = applyLoopOwners([row({ owner: '미지정' }), row({ id: 'loop:retro', owner: '미지정' })], [
    { id: 'morning-graph', title: '아침', owner: 'OP', enabled: true, lastRun: null, jobs: ['morning'] },
    { id: 'retro', title: '회고', owner: 'UX', enabled: true, lastRun: null, jobs: [] },
  ], now);
  expect(rows.map(r => [r.owner, r.verdict])).toEqual([['OP', '늦음'], ['UX', '늦음'], ['OP', '판정 불가']]);
  expect(applyLoopOwners([row({ owner: 'OP' })], [], now).map(r => r.owner)).toEqual(['미지정']);
  expect(applyLoopOwners([], [{ id: 'unarmed', title: '대기 그래프', owner: 'TC', enabled: false, lastRun: null, jobs: [] }], now))
    .toEqual([{ id: 'loop:unarmed', name: '대기 그래프', layer: '그래프', owner: 'TC', mode: '등록', lastRun: null, verdict: '꺼짐' }]);
  expect(applyLoopOwners([], [{ id: 'failed', title: '실패한 그래프', owner: null, enabled: true,
    lastRun: { at: '2026-10-05T09:58:00Z', status: 'failed' }, jobs: [] }], now)[0]).toMatchObject({ owner: '미지정', verdict: '실패' });
});

test('four seats and owned loops use registry verdict; missing owner and incident-only targets remain distinct', () => {
  const nodes = activityNodes([row(), row({ id: 'loop:retro', name: '회고', owner: '미지정', verdict: '꺼짐' }),
    row({ id: 'schedule:failed', owner: 'UX', verdict: '실패' })], [edge]);
  expect(nodes.filter(n => n.type === 'seat').map(n => n.label)).toEqual(['COO', 'CMO', 'CTO', 'CXO']);
  expect(nodes.find(n => n.id === 'schedule:morning')).toMatchObject({ owner: 'OP', verdict: '늦음' });
  expect(nodes.find(n => n.id === 'schedule:failed')).toMatchObject({ owner: 'UX', verdict: '실패' });
  expect(nodes.find(n => n.id === 'loop:retro')).toMatchObject({ owner: '미지정', verdict: '꺼짐' });
  expect(nodes.find(n => n.id === 'loop:run-123abc')).toMatchObject({ type: 'other', label: '런 · run-123abc' });
});

test('edge response filters stale, future, malformed and private display text without inventing edges', () => {
  const edges = activityEdges({ edges: [edge, { ...edge, at: '2026-10-05T08:00:00Z' },
    { ...edge, at: '2026-10-05T10:01:00Z' }, { ...edge, kind: 'unknown' }] }, now);
  expect(edges).toEqual([edge]);
  expect(activityEdges({ edges: [] }, now)).toEqual([]);
  expect(() => activityEdges({ bad: true }, now)).toThrow('간선 조회 실패');
  expect(leaksInternal(JSON.stringify(activityNodes([row({ name: 'OP /home/alice/private' })], edges).map(n => n.label)))).toEqual([]);
});

test('initial history stays dim; only events first seen on a later poll highlight for 1.5 seconds', () => {
  const first = newlySeenEdges(null, [edge], now);
  expect(first[activityEdgeKey(edge)]).toBe(now - EDGE_HIGHLIGHT_MS);
  const second = newlySeenEdges(first, [edge, { ...edge, ref: 'run-second' }], now + 5_000);
  expect(second[activityEdgeKey(edge)]).toBe(now - EDGE_HIGHLIGHT_MS);
  expect(second[activityEdgeKey({ ...edge, ref: 'run-second' })]).toBe(now + 5_000);
  expect(newlySeenEdges({}, [edge], now)[activityEdgeKey(edge)]).toBe(now);
  expect(EDGE_HIGHLIGHT_MS).toBe(1_500);
});

test('node and edge targets encode trace location; no raw ref becomes an arbitrary URL', () => {
  expect(activityTraceTarget('loop:retro')).toBe('/trace?q=retro');
  expect(activityTraceTarget('schedule:morning')).toBe('/trace?q=morning');
  expect(activityTraceTarget('loop:run-123abc')).toBe('/trace?level=L2&run=run-123abc');
  expect(activityTraceTarget('OP', edge)).toBe('/trace?level=L2&run=run-123abc');
  expect(activityTraceTarget('card:demo')).toBe('/trace?q=demo');
  expect(activityTraceTarget('OP', { ...edge, kind: 'card', ref: 'demo' })).toBe('/trace?q=demo');
  expect(activityTraceTarget('OP', { ...edge, kind: 'request', ref: 'https://invalid.test/' })).toBe('/trace');
});
