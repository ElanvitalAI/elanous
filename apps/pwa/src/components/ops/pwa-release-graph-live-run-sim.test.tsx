import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReleaseRunsContent, mergeReleaseGateProgress } from './ReleaseRunsView';
import { fromReleaseGateProgress, type ReleaseGateProgressEvent } from '@/lib/inside-events';
import type { ReleaseRun } from '@/lib/ops-api';
import { summarizeShards } from '../../../../../src/release-loop/gate-shards';

const runId = 'c073464a';
const graph = { nodes: [
  { nodeId: 'cutoff', kind: 'gate', needs: [] },
  { nodeId: 'pwa-build', kind: 'build', needs: ['cutoff'] },
  { nodeId: 'release-check', kind: 'check', needs: ['cutoff'] },
  { nodeId: 'publish', kind: 'publish', needs: ['pwa-build', 'release-check'] },
] };

function progress(data: Record<string, unknown>): ReleaseGateProgressEvent {
  const event = fromReleaseGateProgress({ kind: 'release.gate.progress', graphId: 'release-loop', runId, data });
  if (!event) throw new Error('release.gate.progress fixture rejected by production parser');
  return event;
}

function renderRun(events: ReleaseGateProgressEvent[], shards: NonNullable<ReleaseRun['gateShards']>['shards']): string {
  const updatedAt = '2026-11-07T06:43:04.000Z';
  const shardFile = { v: 1 as const, version: '0.3.6', updatedAt, shards };
  const run: ReleaseRun = {
    runId, version: '0.3.6', status: 'running', startedAt: '2026-11-07T06:43:00.000Z',
    path: graph.nodes.map((node) => node.nodeId), graph,
    nodes: [
      { nodeId: 'cutoff', ok: true, summary: '게이트 완료', startedAt: '2026-11-07T06:43:01.000Z', endedAt: '2026-11-07T06:43:02.000Z' },
      { nodeId: 'pwa-build', ok: null, summary: '빌드 중', startedAt: '2026-11-07T06:43:03.000Z' },
      { nodeId: 'release-check', ok: null, summary: '검사 중', startedAt: '2026-11-07T06:43:03.000Z' },
      { nodeId: 'publish', ok: null, summary: '대기' },
    ],
    gateShards: { ...shardFile, summary: summarizeShards(shardFile, Date.parse(updatedAt)) },
  };
  return renderToStaticMarkup(<ReleaseRunsContent result={{ kind: 'ready', data: [run] }} version="0.3.6"
    selectedRun={run} openedNodeId={null} log={null} gateProgress={events}
    onVersion={() => {}} onRun={() => {}} onNode={() => {}} />);
}

test('pwa-release-graph-live-run-sim: one c073464a cut run joins ledger and live events and renders all 81 radius invalidations', () => {
  const saved = Array.from({ length: 81 }, (_, index) => progress({
    phase: 'shard-decision', eventId: `ledger-${index}`, at: `2026-11-07T06:44:${String(index % 60).padStart(2, '0')}.000Z`,
    shard: `pod-${index}`, decision: 'rerun', reason: 'radius-invalidated', state: 'done', shardIndex: index + 1, shardTotal: 81,
  }));
  const live = saved.map((event) => progress({
    phase: event.phase, eventId: event.eventId, at: event.at, shard: event.shard, decision: event.decision,
    reason: event.reason, state: event.state, shardIndex: event.shardIndex, shardTotal: event.shardTotal,
  }));
  const merged = mergeReleaseGateProgress(saved, live);
  const shards = saved.map((event) => ({ id: event.shard!, state: 'done' as const }));
  const html = renderRun(merged, shards);

  expect(merged).toHaveLength(81);
  expect(merged.every((event) => event.runId === runId)).toBe(true);
  expect(html).toContain('data-run-id="c073464a"');
  expect(html).toContain('병렬 동시 노드 2');
  expect(html).toContain('노드 4 · needs 간선 4');
  expect(html).toContain('aria-label="전체 81개 조각이 radius-invalidated"');
  expect(html).toContain('전체 81조각 재실행 · 모두 radius-invalidated');
  expect(html).toContain('재사용 0 · 재실행 81 · 전체 81');
  expect(html.match(/data-shard-decision="rerun"/g)).toHaveLength(81);
  expect(html).toContain('radius-invalidated · 81');
});

test('pwa-release-graph-live-run-sim: shard ledger and progress events show mixed reuse, rerun reasons, and same-run timing', () => {
  const saved = [
    progress({ phase: 'shard-decision', eventId: 'mix-1', at: '2026-11-07T06:44:01.000Z', shard: 'pod-0', decision: 'reuse', reason: 'same-digest', state: 'done' }),
    progress({ phase: 'shard-decision', eventId: 'mix-2', at: '2026-11-07T06:44:02.000Z', shard: 'pod-1', decision: 'rerun', reason: 'radius-invalidated', state: 'done' }),
    progress({ phase: 'shard-decision', eventId: 'mix-3', at: '2026-11-07T06:44:03.000Z', shard: 'pod-2', decision: 'reuse', reason: 'same-digest', state: 'done' }),
    progress({ phase: 'shard-decision', eventId: 'mix-4', at: '2026-11-07T06:44:04.000Z', shard: 'pod-3', decision: 'rerun', reason: 'image-digest-drift', state: 'done' }),
  ];
  const live = saved.map((event) => progress({
    phase: event.phase, eventId: event.eventId, at: event.at, shard: event.shard, decision: event.decision,
    reason: event.reason, state: event.state,
  }));
  const html = renderRun(mergeReleaseGateProgress(saved, live), saved.map((event) => ({ id: event.shard!, state: 'done' as const })));

  expect(html).toContain('재사용 2 · 재실행 2 · 전체 4');
  expect(html).toContain('same-digest · 2');
  expect(html).toContain('radius-invalidated · 1');
  expect(html).toContain('image-digest-drift · 1');
  expect(html).toContain('data-run-id="c073464a"');
  expect(html).toContain('15:43–15:43 · 0분');
});
