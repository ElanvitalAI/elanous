import { afterEach, describe, expect, test } from 'bun:test';
import { GRAPH_SPECS } from '../self-implement/graph-templates.js';
import type { GraphOverlaySpec } from '../self-implement/graph-overlay-yaml.js';
import { intakeTakesQueue, routeJourneyEdge, setJourneyOverlaysForTesting } from './graph-journey-route.js';

afterEach(() => setJourneyOverlaysForTesting(undefined));

const base = GRAPH_SPECS['self-implement']!;
const intakeEdge = base.edges.findIndex((edge) => edge.from === 'intake');

describe('HARNESS-FULL-GRAPH 2판 — 경로를 그래프가 정한다', () => {
  test('⭐ 기본 YAML(풀세트)은 오늘 코드와 «같은 길»을 낸다', () => {
    setJourneyOverlaysForTesting([]);
    expect(routeJourneyEdge('intake', 'queued').to).toBe('queue');
    expect(routeJourneyEdge('intake', 'direct').to).toBe('launch-gate');
    expect(routeJourneyEdge('decompose', 'pod').to).toBe('pool-admit');
    expect(routeJourneyEdge('decompose', 'local').to).toBe('implement');
    expect(routeJourneyEdge('freeze-check', 'open').to).toBe('merge');
    expect(routeJourneyEdge('freeze-check', 'frozen').to).toBe('hold');
    expect(routeJourneyEdge('intake', 'queued').source).toBe('graph');
  });

  test('그래프가 모르는 라벨은 «코드 기본»으로 간다고 값으로 말한다', () => {
    setJourneyOverlaysForTesting([]);
    expect(routeJourneyEdge('intake', 'no-such-label')).toMatchObject({ to: null, source: 'code-default' });
    expect(routeJourneyEdge('no-such-node', 'queued')).toMatchObject({ to: null, source: 'code-default' });
  });

  test('⭐ launch 오버레이가 간선 값을 바꾸면 «길이 바뀐다» — 이 환경은 늘 대기열로(조건이 맞을 때만)', () => {
    expect(intakeEdge).toBeGreaterThanOrEqual(0);
    const alwaysQueue: GraphOverlaySpec = {
      overlayId: 'test-always-queue', target: 'self-implement', stage: 'launch', appliesWhen: 'seat == OP',
      patch: [{ op: 'replace', path: `/edges/${intakeEdge}/map/direct`, value: 'queue' }],
    } as GraphOverlaySpec;
    setJourneyOverlaysForTesting([alwaysQueue]);
    expect(routeJourneyEdge('intake', 'direct', { seat: 'OP' })).toMatchObject({ to: 'queue', source: 'graph', overlays: ['test-always-queue'] });
    expect(routeJourneyEdge('intake', 'direct', { seat: 'TC' })).toMatchObject({ to: 'launch-gate', overlays: [] });
  });

  test('⛔ 노드를 «도달 불가»로 만드는 건너뛰기는 거절된다 — 기본 = 풀세트(위상 검사 · RFC §3)', () => {
    const skipQueue: GraphOverlaySpec = {
      overlayId: 'test-skip-queue', target: 'self-implement', stage: 'launch', appliesWhen: 'seat == OP',
      patch: [{ op: 'replace', path: `/edges/${intakeEdge}/map/queued`, value: 'launch-gate' }],
    } as GraphOverlaySpec;
    setJourneyOverlaysForTesting([skipQueue]);
    expect(routeJourneyEdge('intake', 'queued', { seat: 'OP' })).toMatchObject({ to: 'queue', overlays: [] });
  });

  test('위상을 깨는 오버레이는 거절되고 기준 길이 남는다', () => {
    const broken: GraphOverlaySpec = {
      overlayId: 'test-broken', target: 'self-implement', stage: 'launch', appliesWhen: 'seat == OP',
      patch: [{ op: 'replace', path: `/edges/${intakeEdge}/map/queued`, value: 'no-such-node' }],
    } as GraphOverlaySpec;
    setJourneyOverlaysForTesting([broken]);
    expect(routeJourneyEdge('intake', 'queued', { seat: 'OP' })).toMatchObject({ to: 'queue', overlays: [] });
  });

  test('⭐ 입구 대기열 갈래 = 그래프 답 ∧ 전제 — 기본 YAML 에서 오늘 코드(shouldQueue ∧ 자리)와 «같은 표»', () => {
    setJourneyOverlaysForTesting([]);
    for (const label of ['queued', 'direct'] as const) {
      for (const eligible of [true, false]) {
        const today = label === 'queued' && eligible;
        expect({ label, eligible, take: intakeTakesQueue(label, routeJourneyEdge('intake', label), eligible) }).toEqual({ label, eligible, take: today });
      }
    }
    // 그래프가 direct→queue 로 바꾸면 길이 바뀐다 · 전제가 없으면 못 넘는다 · 그래프가 답을 못 내면 코드 라벨.
    expect(intakeTakesQueue('direct', { source: 'graph', to: 'queue' }, true)).toBe(true);
    expect(intakeTakesQueue('direct', { source: 'graph', to: 'queue' }, false)).toBe(false);
    expect(intakeTakesQueue('queued', { source: 'code-default', to: null }, true)).toBe(true);
  });
});
