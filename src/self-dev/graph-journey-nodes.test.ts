import { afterEach, describe, expect, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { GRAPH_SPECS, GRAPH_TEMPLATES } from '../self-implement/graph-templates.js';
import { edgeMapOf } from '../self-implement/graph-yaml.js';
import { enterJourneyNode, ensureJourneyKey, exitJourneyNode, JOURNEY_KEY_ENV, JOURNEY_NODE_IDS, journeyJoinFields, withJourneyNode, withJourneyNodeSync } from './graph-journey-nodes.js';

type Row = { category: string; event: string; data: Record<string, unknown> };
function capture(fn: () => void): Row[] {
  const rows: Row[] = [];
  const original = debug.log;
  (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
    rows.push({ category, event, data: (data ?? {}) as Record<string, unknown> });
  }) as typeof debug.log;
  try { fn(); } finally { (debug as { log: typeof debug.log }).log = original; }
  return rows;
}

afterEach(() => { delete process.env[JOURNEY_KEY_ENV]; });

describe('HARNESS-FULL-GRAPH 여정 노드', () => {
  test('여정 노드는 전부 implement-loop 에 «선언»돼 있다 (원장이 declared 로 판정한다)', () => {
    const declared = new Set(GRAPH_TEMPLATES['self-implement']!.nodes.map((n) => n.nodeId));
    expect(JOURNEY_NODE_IDS.filter((id) => !declared.has(id))).toEqual([]);
  });

  test('진입은 기존 노드와 «같은 사건» pipeline-node-entry 로, 출구는 outcome 을 단 pipeline-node-exit 로 남는다', () => {
    const key = ensureJourneyKey();
    const rows = capture(() => {
      enterJourneyNode('freeze-check', { provenance: 'test' });
      exitJourneyNode('freeze-check', { provenance: 'test', outcome: 'open' });
    });
    expect(rows.map((r) => [r.category, r.event])).toEqual([
      ['self-implement', 'pipeline-node-entry'],
      ['self-implement', 'pipeline-node-exit'],
    ]);
    for (const row of rows) {
      expect(row.data).toMatchObject({ graphId: 'self-implement', node: 'freeze-check', nodeDeclarationStatus: 'declared', phase: 'journey', journeyKey: key });
    }
    expect(rows[1]!.data.outcome).toBe('open');
  });

  test('조인 키는 한 번 만들어지고 다시 부르면 같은 값이다 · 없으면 조인 칸이 비어 있다', () => {
    expect(journeyJoinFields()).toEqual({});
    const key = ensureJourneyKey();
    expect(key.startsWith('jrn-')).toBe(true);
    expect(ensureJourneyKey()).toBe(key);
    expect(journeyJoinFields()).toEqual({ journeyKey: key });
  });

  test('⭐ 출구 라벨이 선언에서 종결 `stopped` 로 가면 stopped 진입이 남는다 — 거절 런도 선언된 종결점에서 끝난다', () => {
    const rows = capture(() => {
      exitJourneyNode('launch-gate', { provenance: 'test', outcome: 'refuse' });
      exitJourneyNode('launch-gate', { provenance: 'test', outcome: 'pass' });
    });
    expect(rows.map((r) => [r.event, r.data.node, r.data.provenance])).toEqual([
      ['pipeline-node-exit', 'launch-gate', 'test'],
      ['pipeline-node-entry', 'stopped', 'launch-gate:refuse'],
      ['pipeline-node-exit', 'launch-gate', 'test'],
    ]);
    expect(rows[1]!.data.nodeDeclarationStatus).toBe('declared');
  });

  test('⭐ 노드 안 작업이 던지면 출구 `error` 를 남기고 예외는 그대로 간다', async () => {
    let rows: Row[] = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      rows.push({ category, event, data: (data ?? {}) as Record<string, unknown> });
    }) as typeof debug.log;
    try {
      await expect(withJourneyNode('cleanup', { provenance: 'test' }, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
      expect(() => withJourneyNodeSync('freeze-check', { provenance: 'test' }, () => { throw new Error('sync boom'); })).toThrow('sync boom');
      expect(await withJourneyNode('cleanup', { provenance: 'test' }, async () => 7)).toBe(7);
    } finally { (debug as { log: typeof debug.log }).log = original; }
    rows = rows.filter((r) => r.event === 'pipeline-node-exit');
    expect(rows.map((r) => [r.data.node, r.data.outcome, r.data.error])).toEqual([
      ['cleanup', 'error', 'boom'],
      ['freeze-check', 'error', 'sync boom'],
    ]);
  });

  test('관측이 던져도 호출자는 죽지 않는다 (fail-soft)', () => {
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = (() => { throw new Error('boom'); }) as typeof debug.log;
    try { expect(() => enterJourneyNode('intake', { provenance: 'test' })).not.toThrow(); }
    finally { (debug as { log: typeof debug.log }).log = original; }
  });

  test('분기는 «데이터»다 — 출구 라벨이 YAML map 의 값으로 다음 노드를 정한다(기본 = 풀세트)', () => {
    const spec = GRAPH_SPECS['self-implement']!;
    const route = (from: string, label: string) => spec.edges.find((e) => e.from === from && e.map?.[label] !== undefined)?.map?.[label];
    expect(route('decompose', 'pod')).toBe('pool-admit');
    expect(route('decompose', 'local')).toBe('implement');
    expect(route('freeze-check', 'open')).toBe('merge');
    expect(route('freeze-check', 'frozen')).toBe('hold');
    expect(route('intake', 'direct')).toBe('launch-gate');
    expect(route('intake', 'queued')).toBe('queue');
    expect(spec.entryNode).toBe('intake');
    expect(edgeMapOf(spec).merge).toEqual(['cleanup']);
  });
});
