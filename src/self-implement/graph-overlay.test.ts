import { describe, expect, test } from 'bun:test';
import { applyOverlay, overlayPreservesNodeSet, type GraphOverlay } from './graph-overlay.js';
import { GRAPH_TEMPLATES, type GraphTemplate } from './graph-templates.js';
import { decideTemplate, overlayDecisionObservation, resolveGraphAuthority } from './graph-authority.js';
import { pickSupervisorHealOverlay } from './heal-triage.js';
import type { GraphOverlaySpec } from './graph-overlay-yaml.js';

const research = GRAPH_TEMPLATES['research-loop'] as GraphTemplate;
const implement = GRAPH_TEMPLATES['self-implement'] as GraphTemplate;
const reworkAtTwo: GraphTemplate = {
  ...implement,
  nodes: implement.nodes.map((node) => node.nodeId === 'rework' ? { ...node, maxVisits: 2 } : node),
};

describe('RFC §5 4단계 — 상황 오버레이', () => {
  test('max_visits 만 바꾸는 오버레이는 통과하고 노드 집합을 «안 바꾼다»', () => {
    const result = applyOverlay(research, { overlayId: 'patient', maxVisits: { investigate: 9 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(overlayPreservesNodeSet(research, result.template)).toBe(true);
    expect(result.template.nodes.find((n) => n.nodeId === 'investigate')?.maxVisits).toBe(9);
    // 판이 원장에서 구분되게 오버레이 이름이 version 에 남는다.
    expect(result.template.version).toBe(`${research.version}+patient`);
  });

  test('성공 maxVisits 패치는 바뀐 노드의 전후값을 함께 남긴다', () => {
    const result = applyOverlay(reworkAtTwo, { overlayId: 'rework-patient', maxVisits: { rework: 5 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patches).toEqual([{ overlayId: 'rework-patient', field: 'maxVisits', node: 'rework', before: 2, after: 5 }]);
  });

  test('같은 maxVisits 선언은 패치로 세지 않는다', () => {
    const before = reworkAtTwo.nodes.find((node) => node.nodeId === 'rework')?.maxVisits;
    const result = applyOverlay(reworkAtTwo, { overlayId: 'same', maxVisits: { rework: before! } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patches).toEqual([]);
  });

  test('routes 패치는 출발 노드의 목적지 전후값을 함께 남긴다', () => {
    const before = implement.edges.implement ?? [];
    const after = [...before, before[0]!];
    const result = applyOverlay(implement, { overlayId: 'route', routes: { implement: after } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patches).toEqual([{ overlayId: 'route', field: 'routes', node: 'implement', before, after }]);
  });

  test('없는 노드를 대면 거절한다 — 조용히 무시하지 않고 patches도 만들지 않는다', () => {
    const result = applyOverlay(research, { overlayId: 'bad', maxVisits: { nonexistent: 3 } });
    expect(result).toEqual({ ok: false, rejections: [{ kind: 'unknown-node', overlayId: 'bad', node: 'nonexistent', field: 'maxVisits' }] });
    expect('patches' in result).toBe(false);
  });

  test('없는 목적지로 라우트를 돌리면 거절한다', () => {
    const result = applyOverlay(research, { overlayId: 'bad2', routes: { judge: ['open-pr', 'nonexistent'] } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections).toEqual([{ kind: 'unknown-destination', overlayId: 'bad2', from: 'judge', to: 'nonexistent' }]);
  });

  test('max_visits 0 은 거절한다 — 「한 번도 못 간다」는 노드를 남기지 않는다', () => {
    const result = applyOverlay(research, { overlayId: 'zero', maxVisits: { judge: 0 } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections[0]).toEqual({ kind: 'non-positive-max-visits', overlayId: 'zero', node: 'judge', value: 0 });
  });

  test('⭐ RFC 의 「구조는 안 바뀐다」가 «절반만» 참임을 보인다 — 목적지만 돌려도 종료가 고립된다', () => {
    // 노드 «집합»은 그대로다. 그런데 착지(open-pr→merge)로 가는 유일한 길을 끊었다.
    const overlay: GraphOverlay = { overlayId: 'loop-forever', routes: { judge: ['investigate'] } };
    const result = applyOverlay(research, overlay);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const [rejection] = result.rejections;
    expect(rejection.kind).toBe('breaks-graph');
    if (rejection.kind !== 'breaks-graph') return;
    expect(rejection.defects.some((d) => d.kind === 'unreachable-node' && d.node === 'merge')).toBe(true);
    expect(rejection.defects.some((d) => d.kind === 'unreachable-node' && d.node === 'open-pr')).toBe(true);
    expect(rejection.defects.some((d) => d.kind === 'inescapable-cycle')).toBe(true);
  });

  test('implement-loop 에도 같은 계약이 선다 — merge 로 가는 길을 끊으면 거절된다', () => {
    const withoutMerge = Object.fromEntries(
      Object.entries(implement.edges).map(([from, to]) => [from, to.filter((d) => d !== 'merge')]),
    );
    const result = applyOverlay(implement, { overlayId: 'no-merge', routes: withoutMerge });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections[0]?.kind).toBe('breaks-graph');
  });

  test('값 없는 오버레이는 성공해도 빈 patches를 낸다', () => {
    const result = applyOverlay(research, { overlayId: 'empty' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patches).toEqual([]);
  });

  test('권위가 꺼지면 appliedPatches는 빈 배열이다', () => {
    const decision = decideTemplate({
      goalType: 'implement', authority: resolveGraphAuthority({ flag: false }), overlays: [], state: {}, stage: 'launch',
    });
    expect(decision.appliedPatches).toEqual([]);
  });

  test('여러 거절이 한꺼번에 모인다 — 첫 것만 내고 멈추지 않는다', () => {
    const result = applyOverlay(research, { overlayId: 'many', maxVisits: { nope: 2, judge: -1 } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejections.map((r) => r.kind).sort()).toEqual(['non-positive-max-visits', 'unknown-node']);
  });
});

describe('0.2.32 칸 GRAPH-SUPERVISOR-PICK — 슈퍼바이저가 «선언된» 오버레이 중에서 고른다', () => {
  /** 사람(칸 문면)이 stop-heal-ladder 선언에서 골랐을 답 — stop_class 갈래별 하나씩. */
  const humanChoices = [
    { stopClass: 'env-unrelated', overlayId: 'stop-heal-ladder-env-unrelated' },
    { stopClass: 'main-sync', overlayId: 'stop-heal-ladder-main-sync' },
    { stopClass: 'pod-died', overlayId: 'stop-heal-ladder-pod-died' },
    { stopClass: 'evidence-uncovered', overlayId: 'stop-heal-ladder-evidence-uncovered' },
    // 이 넷 밖의 갈래는 선언이 없다 — 사람도 고르지 않는다.
    { stopClass: 'review-repeat', overlayId: undefined },
  ] as const;

  test('칸 판정선: 사람이 고른 것과 일치율 — 다섯 갈래 전부 일치한다', () => {
    const agreed = humanChoices.filter(({ stopClass, overlayId }) =>
      pickSupervisorHealOverlay({ state: { stop_class: stopClass }, graphId: 'self-implement' }).overlayId === overlayId,
    );
    // 일치율 = 일치 갈래 수 / 전체 갈래 수. 칸 판정은 전부 일치를 요구한다.
    expect(agreed.length).toBe(humanChoices.length);
  });

  test('graphs/overlays 선언에서 골라 outcome+근거 한 줄을 낸다', () => {
    const pick = pickSupervisorHealOverlay({ state: { stop_class: 'main-sync' }, graphId: 'self-implement' });
    expect(pick.outcome).toBe('picked');
    expect(pick.overlayId).toBe('stop-heal-ladder-main-sync');
    // 근거는 «한 줄»이다 — triageFailure 와 같은 outcome+evidence 계약.
    expect(pick.evidence).toHaveLength(1);
  });

  test('같은 입력·같은 선언은 언제나 같은 답을 고른다 — 결정론', () => {
    const first = pickSupervisorHealOverlay({ state: { stop_class: 'pod-died' }, graphId: 'self-implement' });
    const second = pickSupervisorHealOverlay({ state: { stop_class: 'pod-died' }, graphId: 'self-implement' });
    expect(second).toEqual(first);
  });

  test('고르기만 한다 — 결과에 템플릿·노드·패치가 없다(능력표 ③b: 새 노드를 짓지 않음)', () => {
    const pick = pickSupervisorHealOverlay({ state: { stop_class: 'evidence-uncovered' }, graphId: 'self-implement' });
    expect(Object.keys(pick).sort()).toEqual(['evidence', 'outcome', 'overlayId']);
  });

  test('stage: heal 선언만 후보다 — 다른 단계를 겨눈 선언은 고르지 않는다', () => {
    const declared: readonly GraphOverlaySpec[] = [
      { overlayId: 'fx-runtime', target: 'self-implement', stage: 'runtime', appliesWhen: 'stop_class == a', patch: [] },
      { overlayId: 'fx-heal', target: 'self-implement', stage: 'heal', appliesWhen: 'stop_class == a', patch: [] },
    ];
    const pick = pickSupervisorHealOverlay({ state: { stop_class: 'a' }, graphId: 'self-implement' }, () => declared);
    expect(pick.outcome).toBe('picked');
    expect(pick.overlayId).toBe('fx-heal');
  });

  test('조건이 맞는 선언이 없으면 고르지 않는다 — 다른 그래프를 겨눈 선언도 마찬가지', () => {
    const declared: readonly GraphOverlaySpec[] = [
      { overlayId: 'fx-other-graph', target: 'research-loop', stage: 'heal', appliesWhen: 'stop_class == a', patch: [] },
    ];
    const pick = pickSupervisorHealOverlay({ state: { stop_class: 'a' }, graphId: 'self-implement' }, () => declared);
    expect(pick.outcome).toBe('no-applicable-candidate');
    expect(pick.overlayId).toBeUndefined();
    expect(pick.evidence).toHaveLength(1);
  });

  test('선언이 없거나 읽지 못하면 no-declared-candidate — 조용히 삼키지 않고 이유를 남긴다', () => {
    const empty = pickSupervisorHealOverlay({ state: {}, graphId: 'self-implement' }, () => []);
    expect(empty.outcome).toBe('no-declared-candidate');
    expect(empty.evidence).toHaveLength(1);
    const thrown = pickSupervisorHealOverlay(
      { state: {}, graphId: 'self-implement' },
      () => {
        throw new Error('boom');
      },
    );
    expect(thrown.outcome).toBe('no-declared-candidate');
    expect(thrown.evidence).toHaveLength(1);
  });

  test('배선: stage heal 판에 슈퍼바이저 판단·근거가 graph-overlay-decision 원장 칸으로 나간다', () => {
    const state = { stop_class: 'main-sync' };
    const decision = decideTemplate({
      goalType: 'implement', authority: resolveGraphAuthority({}), overlays: [], state, stage: 'heal',
    });
    expect(decision.supervisorPick).toBeDefined();
    const pick = decision.supervisorPick!;
    expect(pick.outcome).toBe('picked');
    expect(pick.overlayId).toBe('stop-heal-ladder-main-sync');
    expect(pick.evidence).toHaveLength(1);
    // 원장 칸 형식은 overlayDecisionObservation 기계를 그대로 거친 것과 같다 —
    // 배선이 곧 「순수 고르기 → 관측 기계」라는 등식을 같은 state 로 값으로 재현한다.
    const chosen = pickSupervisorHealOverlay({ state });
    expect(pick).toEqual(overlayDecisionObservation({
      outcome: chosen.outcome,
      ...(chosen.overlayId !== undefined ? { overlayId: chosen.overlayId } : {}),
      evidence: chosen.evidence,
      state,
    }));
    // stop_class 는 OVERLAY_STATE_KEYS 밖 — 값이 아니라 이름이 stateExtraKeys 로 남는다.
    expect(pick.state).toEqual({});
    expect(pick.stateExtraKeys).toEqual(['stop_class']);
  });

  test('배선 보존: 다른 단계(launch·runtime)는 supervisorPick 칸이 없다 — 기본 동작 그대로', () => {
    for (const stage of ['launch', 'runtime'] as const) {
      const decision = decideTemplate({
        goalType: 'implement', authority: resolveGraphAuthority({}), overlays: [], state: { stop_class: 'main-sync' }, stage,
      });
      expect('supervisorPick' in decision).toBe(false);
      expect(decision.appliedPatches).toEqual([]);
    }
  });
});
