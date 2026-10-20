import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { GRAPH_SPECS } from '../self-implement/graph-templates.js';
import type { GraphOverlaySpec } from '../self-implement/graph-overlay-yaml.js';
import { freezeCheckHolds, intakeTakesQueue, readJourneyEdge, routeJourneyEdge, setJourneyOverlaysForTesting } from './graph-journey-route.js';

afterEach(() => setJourneyOverlaysForTesting(undefined));

const base = GRAPH_SPECS['self-implement']!;
const intakeEdge = base.edges.findIndex((edge) => edge.from === 'intake');

describe('HARNESS-FULL-GRAPH 2판 — 경로를 그래프가 정한다', () => {
  test('ARG L1 실 경로 선택: 관측한 host 상태만 when 간선을 타고 optional node를 건너뛴다', () => {
    const profile = {
      ...base,
      nodes: base.nodes.map(node => node.nodeId === 'plan'
        ? { ...node, skipWhen: 'substrate == local' } : node),
      edges: base.edges,
    };
    expect(readJourneyEdge('decompose', 'local', { substrate: 'pod' }, { base: profile, overlays: [] }))
      .toMatchObject({ to: 'pool-admit', via: 'when', condition: 'substrate == pod' });
    expect(readJourneyEdge('decompose', 'local', { substrate: 'local' }, { base: profile, overlays: [] }))
      .toMatchObject({ to: 'implement', via: 'outcome' });
    expect(readJourneyEdge('decompose', 'local', {}, { base: profile, overlays: [] }).to).toBe('implement');
    expect(readJourneyEdge('author', 'next', { substrate: 'local' }, { base: profile, overlays: [] }))
      .toMatchObject({ to: 'decompose', skippedNode: 'plan', skipCondition: 'substrate == local' });
    expect(readJourneyEdge('author', 'next', {}, { base: profile, overlays: [] }).to).toBe('plan');
  });

  test('ARG L1 같은 출발의 참 조건 둘은 기존 무조건 갈래로 내리고 모호함을 남긴다', () => {
    const profile = { ...base, edges: [...base.edges,
      { from: 'decompose', to: 'implement', when: 'machines >= 1' },
    ] };
    expect(readJourneyEdge('decompose', 'local', { substrate: 'pod', machines: 1 }, { base: profile, overlays: [] }))
      .toMatchObject({ to: 'implement', ambiguousConditions: ['substrate == pod', 'machines >= 1'] });
  });

  test('ARG L1 연속 선택 노드는 모두 생략하고 각각 관측한다', () => {
    const profile = { ...base, nodes: base.nodes.map(node =>
      node.nodeId === 'author' || node.nodeId === 'plan'
        ? { ...node, skipWhen: 'substrate == local' } : node) };
    const events: { event: string; data: Record<string, unknown> | undefined }[] = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> | undefined });
    });
    try {
      const route = routeJourneyEdge('dispatch', 'fresh', { substrate: 'local' }, { base: profile, overlays: [] });
      expect(route).toMatchObject({ to: 'decompose', skippedNodes: [
        { node: 'author', condition: 'substrate == local' },
        { node: 'plan', condition: 'substrate == local' },
      ] });
      expect(events.filter(row => row.event === 'node-skipped').map(row => row.data?.node))
        .toEqual(['author', 'plan']);
    } finally { log.mockRestore(); }
  });

  test('ARG L1 미관측 조건은 기본 경로와 그 사유를 함께 남긴다', () => {
    const events: { event: string; data: Record<string, unknown> | undefined }[] = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => {
      events.push({ event, data: data as Record<string, unknown> | undefined });
    });
    try {
      const route = routeJourneyEdge('decompose', 'local', {}, { base, overlays: [] });
      expect(route).toMatchObject({ to: 'implement', unobservedConditions: ['substrate == pod'] });
      expect(events.find(row => row.event === 'edge-unobserved')?.data)
        .toMatchObject({ from: 'decompose', fallback: 'implement', conditions: ['substrate == pod'] });
    } finally { log.mockRestore(); }
  });

  test('ARG L1 참 조건과 미관측 조건이 공존하면 기본 경로를 고른다', () => {
    const profile = { ...base, edges: [...base.edges,
      { from: 'decompose', to: 'pool-admit', when: 'machines >= 1' },
    ] };
    expect(readJourneyEdge('decompose', 'local', { substrate: 'pod' }, { base: profile, overlays: [] }))
      .toMatchObject({ to: 'implement', unobservedConditions: ['machines >= 1'] });
  });

  test('ARG L1 다른 출구가 있는 선택 노드는 런타임에서도 생략하지 않는다', () => {
    const profile = { ...base,
      nodes: base.nodes.map(node => node.nodeId === 'plan' ? { ...node, skipWhen: 'substrate == local' } : node),
      edges: [...base.edges, { from: 'plan', to: 'implement', when: 'machines >= 1' }],
    };
    expect(readJourneyEdge('author', 'next', { substrate: 'local' }, { base: profile, overlays: [] }))
      .toMatchObject({ to: 'plan' });
  });

  test('ARG L1 필수 gate 실패 결과를 조건 간선이 덮지 않는다', () => {
    const profile = { ...base, edges: [...base.edges,
      { from: 'gate', to: 'review', when: 'substrate == pod' },
    ] };
    expect(readJourneyEdge('gate', 'fail', { substrate: 'pod' }, { base: profile, overlays: [] }))
      .toMatchObject({ to: 'rework', via: 'outcome' });
  });

  test('ARG L1 결과 map은 선언 순서상 앞선 무조건 to보다 우선한다', () => {
    const profile = { ...base, edges: [
      { from: 'gate', to: 'review' },
      ...base.edges,
    ] };
    expect(readJourneyEdge('gate', 'fail', {}, { base: profile, overlays: [] }))
      .toMatchObject({ to: 'rework', via: 'outcome' });
  });

  test('ARG L1 fallback 출구가 있는 선택 노드는 런타임에서도 생략하지 않는다', () => {
    const profile = { ...base,
      nodes: base.nodes.map(node => node.nodeId === 'plan' ? { ...node, skipWhen: 'substrate == local' } : node),
      edges: base.edges.map(edge => edge.from === 'plan'
        ? { ...edge, fallback: [{ node: 'implement', requires: ['probe'] }] } : edge),
    };
    expect(readJourneyEdge('author', 'next', { substrate: 'local' }, { base: profile, overlays: [] }))
      .toMatchObject({ to: 'plan' });
  });

  test('ARG L1 체크인 그래프의 Pod 생산 진입점은 when을 소비하고 local 기본 경로는 보존한다', () => {
    setJourneyOverlaysForTesting([]);
    expect(readJourneyEdge('decompose', 'pod', { substrate: 'pod' }))
      .toMatchObject({ to: 'pool-admit', via: 'when', condition: 'substrate == pod' });
    expect(readJourneyEdge('decompose', 'local', { substrate: 'local' }))
      .toMatchObject({ to: 'implement', via: 'outcome' });
  });
  test('⭐ 기본 YAML(풀세트)은 오늘 코드와 «같은 길»을 낸다', () => {
    setJourneyOverlaysForTesting([]);
    expect(routeJourneyEdge('intake', 'queued').to).toBe('queue');
    expect(routeJourneyEdge('intake', 'direct').to).toBe('launch-gate');
    expect(routeJourneyEdge('decompose', 'pod').to).toBe('pool-admit');
    expect(routeJourneyEdge('decompose', 'local').to).toBe('implement');
    expect(routeJourneyEdge('dispatch', 'fresh', { source: 'fresh' }).to).toBe('author');
    expect(routeJourneyEdge('dispatch', 'pr-source', { source: 'pr' }).to).toBe('pool-admit');
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

  const freezeEdge = base.edges.findIndex((edge) => edge.from === 'freeze-check');
  const approvalRequired: GraphOverlaySpec = {
    overlayId: 'test-approval-required', target: 'self-implement', stage: 'launch', appliesWhen: 'freeze == open',
    // merge 는 이 간선에서만 닿으므로 fallback 으로 도달성을 남겨야 위상 검사를 통과한다.
    patch: [
      { op: 'replace', path: `/edges/${freezeEdge}/map/open`, value: 'hold' },
      { op: 'add', path: `/edges/${freezeEdge}/fallback`, value: [{ node: 'merge', requires: [] }] },
    ],
  } as GraphOverlaySpec;

  test('freeze-check overlay routes open to hold', () => {
    expect(freezeEdge).toBeGreaterThanOrEqual(0);
    setJourneyOverlaysForTesting([approvalRequired]);
    const route = routeJourneyEdge('freeze-check', 'open', { freeze: 'open' });
    expect(route).toMatchObject({ to: 'hold', source: 'graph', overlays: ['test-approval-required'] });
    expect(freezeCheckHolds('open', route)).toBe(true);
    expect(freezeCheckHolds('frozen', route)).toBe(false);
    expect(freezeCheckHolds('taken', route)).toBe(false);
  });

  test('code-default keeps the admission', () => {
    setJourneyOverlaysForTesting([]);
    for (const label of ['open', 'frozen', 'taken'] as const) {
      expect(freezeCheckHolds(label, routeJourneyEdge('freeze-check', label, { freeze: label }))).toBe(false);
    }
    expect(freezeCheckHolds('open', { source: 'code-default', to: null })).toBe(false);
    expect(freezeCheckHolds('open', { source: 'code-default', to: 'hold' })).toBe(false);
  });
});
