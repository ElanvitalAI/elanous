// Lineage 소스 어댑터 테스트 — observation(⑥·L1) 순수 매핑 + mount. 순수(무 I/O).
import { afterEach, describe, test, expect } from 'bun:test';
import { harnessRunsToLineage, observationRowsToLineage, mountBuiltinLineageSources, setHarnessRunTimelineReaderForTest } from './sources.js';
import { listLineageSources, resetLineageRegistryForTest } from './registry.js';
import { buildLineageTimeline } from './timeline.js';
import { LINEAGE_STORE_KINDS } from './types.js';

describe('observationRowsToLineage — logs 행 → LineageEntry(⑥ L1)', () => {
  test('category[event] + data 요약 → observation 엔트리', () => {
    const out = observationRowsToLineage([
      { category: 'mission.grounding', event: 'corpus', data: '{"code":12,"skills":5}', ts: '2026-07-20T13:00:00Z' },
      { category: 'intent.gate', event: 'domain.resolved', data: '{"domain":"coding"}', ts: '2026-07-20T13:01:00Z' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.store).toBe('observation');
    expect(out[0]!.at).toBe('2026-07-20T13:00:00Z');
    expect(out[0]!.summary).toContain('mission.grounding[corpus]');
    expect(out[0]!.summary).toContain('skills');
    expect(out[1]!.summary).toContain('intent.gate[domain.resolved]');
  });

  test('data 없어도 category[event] 만으로 요약', () => {
    const out = observationRowsToLineage([{ category: 'mission.exec.context', event: 'wm-inject', data: null, ts: '2026-07-20T13:00:00Z' }]);
    expect(out[0]!.summary).toBe('mission.exec.context[wm-inject]');
  });

  test('data 60자 절단', () => {
    const long = 'x'.repeat(200);
    const out = observationRowsToLineage([{ category: 'c', event: 'e', data: long, ts: 't' }]);
    expect(out[0]!.summary.length).toBeLessThanOrEqual('c[e] '.length + 60);
  });

  test('빈 입력 → []', () => {
    expect(observationRowsToLineage([])).toEqual([]);
  });
});

describe('harness runs reach the mounted historian through missionId', () => {
  afterEach(() => {
    setHarnessRunTimelineReaderForTest();
    resetLineageRegistryForTest();
  });

  test('buildLineageTimeline(missionId) includes matching harness shards without an orchestration key', () => {
    setHarnessRunTimelineReaderForTest((missionId) => missionId === 'apm-historian'
      ? [{ runId: 'run-00000000-0000-4000-8000-000000000301', executedAt: '2026-08-16T10:00:00.000Z', orchestrationId: 'orch-301', shardId: 'shard-1', pieceIndex: 0, pieceTotal: 1 }]
      : []);
    mountBuiltinLineageSources();

    const timeline = buildLineageTimeline('apm-historian');
    expect(timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ store: 'observation', at: '2026-08-16T10:00:00.000Z', summary: expect.stringContaining('run-00000000-0000-4000-8000-000000000301') }),
      expect.objectContaining({ summary: expect.stringContaining('1 pieces') }),
    ]));
    expect(buildLineageTimeline('orch-301')).toEqual([]);
  });

  test('maps harness projection time and shard metadata without changing a lineage store kind', () => {
    expect(harnessRunsToLineage([{ runId: 'run-00000000-0000-4000-8000-000000000302', executedAt: '2026-08-16T10:00:00.000Z', orchestrationId: 'orch-302', shardId: 'shard-2', pieceIndex: 1, pieceTotal: 2 }]))
      .toEqual([expect.objectContaining({ store: 'observation', at: '2026-08-16T10:00:00.000Z', seq: 1, summary: expect.stringContaining('shard shard-2 · 2 pieces') })]);
  });

  test('shows terminal graph unit orphans in the harness lineage entry', () => {
    const entries = harnessRunsToLineage([{
      runId: 'run-00000000-0000-4000-8000-000000000303',
      executedAt: '2026-10-20T01:00:00.000Z',
      unitVisits: { terminal: true, enterCount: 1, exitCount: 0, orphanCount: 1, orphanUnitVisits: [{ childRunId: 'child-303', graphId: 'self-implement', nodeId: 'decompose', unit: 'fabric-decompose', enteredAt: '2026-10-20T01:00:01.000Z' }] },
    }]);
    expect(entries[0]!.summary).toContain('graph.unit orphan 1');
  });
});

describe('observation 은 6번째 store kind + mount 됨', () => {
  test('LINEAGE_STORE_KINDS 에 observation 포함(6-way)', () => {
    expect(LINEAGE_STORE_KINDS).toContain('observation');
    expect(LINEAGE_STORE_KINDS).toHaveLength(6);
  });
  test('mountBuiltinLineageSources 후 observation 소스 마운트됨', () => {
    mountBuiltinLineageSources();
    const kinds = listLineageSources().map((s) => s.kind);
    expect(kinds).toContain('observation');
  });
});
