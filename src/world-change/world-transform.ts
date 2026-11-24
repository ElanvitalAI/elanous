// COORD-WORLD-TRANSFORM — 목표 역산 루프: 목표 + 현재 세계 측정 → 변형안 3(재배치/개조/신설) → 선택 → 적용 → 원장 기록.
// 사람 개입 없이(0) 지표를 회복시키는 것이 판정식; apply 는 세계에 실제로 변형을 가하는 주입점(시험은 더블).
import { recordWorldChange, type WorldChangeAction, type WorldChangeHandle, type WorldChangeEntry } from './world-change-ledger.js';

export interface WorldSnapshot {
  at: string;
  world: 'sim' | 'ops';
  metrics: Record<string, number>;
  /** 고장 주입 — 첫 고장이 변형 대상 구성요소를 정한다. */
  failures: Array<{ component: string; kind: string }>;
}

export interface WorldGoal {
  /** 되찾으려는 지표 키. */
  metric: string;
  target: number;
  /** 회복 기한(예: 폴러 고장 → 2h). */
  withinMs: number;
  label?: string;
}

export interface WorldTransformProposal {
  action: WorldChangeAction;
  handle: WorldChangeHandle;
  what: string;
  why: string;
  /** 상대 비용(단위 없는 계수 — 클수록 비싸다). */
  cost: number;
  /** 0..1 — 클수록 위험. */
  risk: number;
  revert: string[];
  score: number;
}

export interface WorldTransformApplyResult { snapshot: WorldSnapshot; tookMs: number }

export interface WorldTransformRun {
  status: 'recovered' | 'failed' | 'nothing-to-do';
  proposal: WorldTransformProposal | null;
  proposals: WorldTransformProposal[];
  elapsedMs: number;
  before: number;
  after: number;
  ledgerId: string | null;
  /** 판정식: 이 루프는 사람 손을 전혀 요구하지 않는다. */
  humanInterventions: 0;
}

/** 위험은 비용의 두 배 가중 — 같은 지표 회복이라면 싸고 안전한 변형이 이긴다. */
const RISK_WEIGHT = 2;
const score = (cost: number, risk: number): number => 1 / (1 + cost + RISK_WEIGHT * risk);

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** 목표 역산: 지표 격차가 있으면 변형안 3(재배치/개조/신설)을 각각 비용·위험·되돌리기와 함께 낸다. 이미 달성이면 빈 목록. */
export function planWorldTransforms(goal: WorldGoal, snapshot: WorldSnapshot): WorldTransformProposal[] {
  const current = snapshot.metrics[goal.metric] ?? 0;
  const gap = goal.target - current;
  if (gap <= 0) return [];
  const component = snapshot.failures[0]?.component ?? goal.metric;
  const why = `${goal.metric} ${round3(current)} → ${goal.target} (격차 ${round3(gap)})`;
  return [
    {
      action: 'relocate', handle: 'seat',
      what: `${component}을(를) 건강한 자리로 재배치한다`,
      why, cost: 1, risk: 0.35,
      revert: ['재배치 이전 배치로 되돌린다', '원장에 되돌리기 표시한다'],
      score: score(1, 0.35),
    },
    {
      action: 'modify', handle: 'device',
      what: `${component}을(를) 제자리에서 수리·개조한다`,
      why, cost: 2, risk: 0.2,
      revert: ['수리 전 구성 스냅숏으로 복원한다', '원장에 되돌리기 표시한다'],
      score: score(2, 0.2),
    },
    {
      action: 'create', handle: 'structure',
      what: `${component} 대체 구성요소를 신설해 교체한다`,
      why, cost: 5, risk: 0.1,
      revert: ['신설 구성요소를 제거한다', '원장에 되돌리기 표시한다'],
      score: score(5, 0.1),
    },
  ];
}

/** 최고 점수안 선택 — 점수가 같으면 배열 순서(재배치→개조→신설) 우선. 빈 목록이면 null. */
export function selectWorldTransform(proposals: readonly WorldTransformProposal[]): WorldTransformProposal | null {
  let best: WorldTransformProposal | null = null;
  for (const p of proposals) if (!best || p.score > best.score) best = p;
  return best;
}

/** 목표 역산 루프 한 바퀴: 변형안 생성 → 선택 → 적용(apply 주입) → 원장 기록 → 회복 판정. */
export function runWorldTransformLoop(opts: {
  goal: WorldGoal;
  snapshot: WorldSnapshot;
  ledgerFile: string;
  /** 원장 at 스탬프(기본 현재 시각). */
  at?: string;
  apply: (proposal: WorldTransformProposal, snapshot: WorldSnapshot) => WorldTransformApplyResult;
}): WorldTransformRun {
  const { goal, snapshot, ledgerFile, apply } = opts;
  const before = snapshot.metrics[goal.metric] ?? 0;
  const proposals = planWorldTransforms(goal, snapshot);
  if (proposals.length === 0) {
    return { status: 'nothing-to-do', proposal: null, proposals: [], elapsedMs: 0, before, after: before, ledgerId: null, humanInterventions: 0 };
  }
  const selected = selectWorldTransform(proposals)!;
  const { snapshot: afterSnap, tookMs } = apply(selected, snapshot);
  const after = afterSnap.metrics[goal.metric] ?? 0;
  const entry: WorldChangeEntry = recordWorldChange(ledgerFile, {
    at: opts.at ?? new Date().toISOString(),
    goal: `${goal.metric} ≥ ${goal.target}${goal.label ? ` — ${goal.label}` : ''}`,
    handle: selected.handle,
    action: selected.action,
    what: selected.what,
    why: selected.why,
    revert: selected.revert,
    metricsBefore: { [goal.metric]: before },
    world: snapshot.world,
  });
  const recovered = after >= goal.target && tookMs <= goal.withinMs;
  return { status: recovered ? 'recovered' : 'failed', proposal: selected, proposals, elapsedMs: tookMs, before, after, ledgerId: entry.id, humanInterventions: 0 };
}
