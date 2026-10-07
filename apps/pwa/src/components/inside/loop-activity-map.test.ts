import { expect, test } from 'bun:test';
import type { LoopRow } from '@/components/loops/loop-status';
import { activityEdgeKey, activityEdges, activityNodes, activityTraceTarget, applyLoopOwners, EDGE_HIGHLIGHT_MS, isRoundTrip, journeyEdges, journeyAliases, journeyResponseEdges, journeyStages, nearDetail, newlySeenEdges, PACKET_SHAPES, zoomTier } from './loop-activity-map';
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

// LOOP-INTERACT 조각 C — 서버 `src/nexus/api/loop-edges.ts` 의 hand·launch·move 응답 꼴 그대로.
const journey = [
  { at: '2026-10-05T08:50:00Z', kind: 'hand' as const, from: 'loop:orchestrator', to: 'agent:task-agent', ref: 'card-1', cell: 'RELEASE-LIVE2', mode: 'live' as const, tick: 'run-tick1' },
  { at: '2026-10-05T09:11:00Z', kind: 'launch' as const, from: 'agent:task-agent', to: 'TC', ref: 'card-1' },
  { at: '2026-10-05T09:12:00Z', kind: 'run' as const, from: 'TC', to: 'loop:run-abc123', ref: 'run-abc123' },
  { at: '2026-10-05T09:40:00Z', kind: 'run' as const, from: 'loop:run-abc123', to: 'pr:24700', ref: 'run-abc123' },
  { at: '2026-10-05T09:50:00Z', kind: 'move' as const, from: 'agent:task-agent', to: 'release:RELEASE-LIVE2', ref: 'card-1', move: 'green-proposal' },
];

test('hand, launch and move edges survive the client filter; unknown kinds still drop; ?ref= responses keep old steps', () => {
  const kept = activityEdges({ edges: [...journey, { ...journey[0]!, kind: 'unknown' }] }, now);
  expect(kept.map(e => e.kind)).toEqual(['launch', 'run', 'run', 'move']);
  expect(journeyResponseEdges({ edges: journey }, now).map(e => e.kind)).toEqual(['hand', 'launch', 'run', 'run', 'move']);
  expect(kept.find(e => e.kind === 'move')).toMatchObject({ move: 'green-proposal' });
  expect(activityEdges({ edges: [{ ...journey[0]!, at: '2026-10-05T09:30:00Z', broken: true }] }, now)[0]).toMatchObject({ kind: 'hand', broken: true, mode: 'live' });
});

test('fixed nodes stand without edges and new prefixes get public labels', () => {
  const nodes = activityNodes([row({ id: 'loop:orchestrator', name: '오케스트레이터', owner: 'MK', verdict: '살아 있음' })], journey);
  expect(nodes.filter(n => n.type === 'seat' || n.type === 'hub').map(n => n.label))
    .toEqual(['COO', 'CMO', 'CTO', 'CXO', '조율', 'TASK-AGENT', '런 묶음', '발행 루프', '수호자']);
  expect(nodes.find(n => n.id === 'loop:orchestrator')).toMatchObject({ type: 'hub', label: '조율', verdict: '살아 있음' });
  expect(nodes.find(n => n.id === 'pr:24700')?.label).toBe('PR #24700');
  expect(nodes.find(n => n.id === 'release:RELEASE-LIVE2')?.label).toBe('발행 · RELEASE-LIVE2');
  expect(activityNodes([], [{ ...journey[0]!, to: 'agent:other' }]).find(n => n.id === 'agent:other')?.label).toBe('에이전트 · other');
  expect(activityTraceTarget('agent:task-agent', journey[1])).toBe('/trace?q=card-1');
});

test('journeyEdges reads tick → TASK-AGENT → run → PR → green in time order, live only', () => {
  const shuffled = [journey[3]!, journey[4]!, journey[0]!, { ...journey[0]!, mode: 'shadow' as const, at: '2026-10-05T08:40:00Z' }, journey[2]!, journey[1]!,
    { ...journey[1]!, ref: 'other-card' }];
  expect(journeyEdges(shuffled, 'card-1')).toEqual(journey);
  expect(journeyStages(shuffled, 'card-1').map(s => s.state)).toEqual(['done', 'done', 'done', 'done', 'done']);
  expect(journeyStages(journey.slice(0, 2), 'card-1').map(s => s.state)).toEqual(['done', 'done', 'current', 'pending', 'pending']);
  expect(journeyStages([{ ...journey[0]!, broken: true }], 'card-1').map(s => s.state)).toEqual(['failed', 'pending', 'pending', 'pending', 'pending']);
  expect(journeyStages([], 'card-1').map(s => s.key)).toEqual(['tick', 'agent', 'run', 'pr', 'land']);
  // JOURNEY-EMPTY-STATE: 사건 0 이면 «지금»(●) 없이 다섯 단계 모두 «남음»(○) — 간선 있는 여정 판정은 그대로(위 셋)
  expect(journeyStages([], 'card-1').map(s => s.state)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending']);
  expect(journeyStages([{ ...journey[0]!, ref: 'other-card' }], 'card-1').every(s => s.state === 'pending')).toBe(true);
});

test('two zoom tiers split at 0.8 and near detail keeps at most five recent actions', () => {
  expect(zoomTier(0.5)).toBe('far');
  expect(zoomTier(0.79)).toBe('far');
  expect(zoomTier(0.8)).toBe('near');
  expect(zoomTier(1)).toBe('near');
  const many = Array.from({ length: 8 }, (_, i) => ({ ...journey[1]!, at: `2026-10-05T09:0${i}:00Z`, ref: `c${i}` }));
  const detail = nearDetail('agent:task-agent', many, { running: 2 }, id => id === 'TC' ? 'CTO' : id);
  expect(detail.recent).toHaveLength(5);
  expect(detail.recent[0]).toBe('발사 → CTO');
  expect(detail).toMatchObject({ running: 2, waiting: null, now: null });
});

test('request paired with a reverse report or decision on the same ref travels as a round trip', () => {
  const ask = { at: '2026-10-05T09:59:00Z', kind: 'request' as const, from: 'OP', to: 'TC', ref: 'q1' };
  expect(isRoundTrip(ask, [ask])).toBe(false);
  expect(isRoundTrip(ask, [ask, { ...ask, kind: 'report', from: 'TC', to: 'OP' }])).toBe(true);
  expect(isRoundTrip({ ...ask, kind: 'decision', from: 'TC', to: 'OP' }, [ask])).toBe(true);
  expect(isRoundTrip(journey[1]!, journey)).toBe(false);
  expect(new Set(Object.values(PACKET_SHAPES)).size).toBe(Object.keys(PACKET_SHAPES).length);
});

test('리허설 2-c 실물 꼴: 넘김·발사 ref 가 TA 카드여도 cell 로 wish 여정에 묶이고, PR 이 있으면 빈 «런» 단계도 끝남', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 9, 7, 6, m)).toISOString();
  const edges = [
    { at: at(56), kind: 'card', from: 'surface:wish', to: 'card:wish-1', ref: 'wish-1' },
    { at: at(57), kind: 'hand', from: 'loop:orchestrator', to: 'agent:task-agent', ref: 'ta-1', cell: 'wish-1-1', mode: 'live' },
    { at: at(57), kind: 'launch', from: 'agent:task-agent', to: 'UX', ref: 'ta-1' },
    { at: at(88), kind: 'run', from: 'loop:run-child', to: 'pr:24738', ref: 'run-child' },
    { at: at(58), kind: 'hand', from: 'loop:orchestrator', to: 'agent:task-agent', ref: 'ta-other', cell: 'wish-2-1', mode: 'live' },
  ] as unknown as Parameters<typeof journeyStages>[0];
  expect([...journeyAliases(edges, 'wish-1')]).toEqual(['wish-1', 'ta-1']);
  expect(journeyStages(edges, 'wish-1').map(s => s.state)).toEqual(['done', 'done', 'done', 'done', 'current']);
});
